import { type Chain, CHAINS } from './chains.ts';
import { type Session, open } from './engines/index.ts';
import { type PublishedFile, israelHour, newest } from './files.ts';
import { NeedsRelay, network, relayState } from './http.ts';
import { type Localities, buildLocalities, cityName, loadLocalities } from './localities.ts';
import { type ChainStatus, type Stamp, chainStatus, mergeDeltas, planChain, priceMap } from './plan.ts';
import { mapLimit } from './pool.ts';
import { type BranchStamps, inBatches, parseStamps, rpc, server } from './server.ts';
import { type Branch, type PriceItem, branches, decode } from './xml.ts';

/**
 * One run of the downloader (docs/PRICES-CONTRACT.md, "Downloader"):
 *
 * 1. every chain's Stores file; the daily (`full`) run sends it to
 *    ingest_branches (cities found here), every run counts its branches;
 * 2. price_map_stamps: every branch the server knows, with what it has;
 * 3. per chain, the newest PriceFull of EVERY branch -> ingest_price_map(p_full = true)
 *    when it is newer than the server's map; then the newer Price (change)
 *    files, merged per branch -> ingest_price_map(p_full = false);
 * 4. report_chain_status for each chain as soon as it is done (a run cut by
 *    the job timeout still leaves a trace);
 * 5. the daily run also reads every branch's PriceFull for the product
 *    catalog -> ingest_products, with the chains each product was seen in.
 *
 * Chains run in parallel and one chain's failure never stops another. The
 * process exits non-zero when any chain is down or the run itself has a
 * problem (exitCode below), so a run that writes nothing is never green (P12).
 */

/** A barcode counts as a product when it is a GS1 code (8-14 digits); shorter codes are a chain's own. */
const isGs1 = (barcode: string) => barcode.length >= 8;
/** Before this hour (Israel time) an empty or short listing of a today-only chain means "not all published yet". */
const PUBLISHED_BY_HOUR = 9;
/** More listed branches than this share unknown to the server: the chain cannot be written (the server and the downloader disagree). */
const MAX_UNKNOWN = 0.2;
/** Fewer branches with a PriceFull than this share of the Stores file: the listing looks cut short. */
const MIN_LISTED = 0.8;
/** Failures in a row (downloads or writes) after which a chain is given up for this run (P52). */
export const giveUpAfter = (chain: Chain) => Math.max(5, 2 * chain.concurrency);
/** After the run's budget, work already started gets this long; then the chain is reported as cut off. */
export const GRACE_MS = 5 * 60_000;

export interface RunOptions {
  /** The daily run: send the branches, read every branch's PriceFull and send the product catalog. */
  full: boolean;
  /** Only these chains (default: all). */
  chains?: readonly string[];
  /** Stop starting new downloads after this many milliseconds (the job's own timeout is longer). */
  budgetMs: number;
  /** How long work already started may run past the budget (default GRACE_MS). */
  graceMs?: number;
  now?: () => Date;
  /** Seams for tests: the chains' file servers and the locality list. */
  open?: (chain: Chain) => Promise<Session>;
  localities?: () => Promise<Localities>;
}

export interface ChainReport {
  status: ChainStatus | 'not_published';
  error?: string;
  /** Branches in the chain's Stores file. */
  stores?: number;
  /** Branches with a PriceFull on the chain's server now. */
  listed?: number;
  /** Full maps sent / already current on the server. */
  sent?: number;
  current?: number;
  /** Full files the server did not take (held back as cut short, or not newer); their change files wait. */
  held?: string[];
  /** Branches whose change files were merged and sent, and how many files that was. */
  deltaBranches?: number;
  deltaFiles?: number;
  /** Branches priced (sent or current), as reported to the server. */
  priced?: number;
  downloads?: number;
  downloadedMB?: number;
  failed?: string[];
  /** Listed branches the server has no row for (e.g. Shufersal lists a few branches missing from its Stores file). */
  unknown?: string[];
  /** Payload sizes of ingest_price_map, in KB. */
  payloadKB?: { max: number; total: number };
  seconds?: number;
}

interface ProductSeen {
  item: PriceItem;
  chains: Set<string>;
}

/** A copy of a string that does not share memory with the text it was cut from. */
const own = (s: string) => Buffer.from(s, 'utf8').toString('utf8');

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Resolves when the time comes; `clear` lets the process exit before that. */
function timer(at: number): { reached: Promise<'time'>; clear: () => void } {
  let handle: NodeJS.Timeout | undefined;
  const reached = new Promise<'time'>((resolve) => {
    handle = setTimeout(() => resolve('time'), Math.max(0, at - Date.now()));
  });
  return { reached, clear: () => clearTimeout(handle) };
}

/** The chain's branches from its newest Stores file (null when it lists none). */
async function readStores(session: Session): Promise<Branch[] | null> {
  const storesFile = newest(await session.list('stores'), 'stores', null);
  if (!storesFile) return null;
  return [...branches(decode(await session.fetch(storesFile)))];
}

async function ingestBranches(chain: Chain, found: Branch[], localities: Localities): Promise<void> {
  const rows = found.map((b) => ({ ...b, city: cityName(localities, b.city, b.name, b.address, chain.id) }));
  await inBatches(rows, 500, (batch) => rpc('ingest_branches', { p_chain: chain.id, p_rows: batch }));
}

async function priceChain(
  chain: Chain,
  session: Session,
  stamps: BranchStamps,
  options: RunOptions,
  deadline: number,
  catalog: Map<string, ProductSeen> | null,
  stores: number,
  runProblems: string[],
): Promise<ChainReport> {
  const started = Date.now();
  const problems: string[] = [];
  const early = israelHour(options.now?.()) < PUBLISHED_BY_HOUR;
  let listingFailed = false;
  let plans: ReturnType<typeof planChain> = [];

  const idOf = (store: string) => (server.dry ? 0 : (stamps.byStore.get(`${chain.id}:${store}`)?.id ?? null));
  const stampOf = (store: string): Stamp | undefined => stamps.byStore.get(`${chain.id}:${store}`);

  // Products of this chain, kept apart until the chain is known to be ok. The kept strings are copied:
  // a regex match is a slice that keeps its whole file (~10 MB) alive, and a run reads ~1,000 files.
  const seen = catalog ? new Map<string, PriceItem>() : null;
  const onItem = seen
    ? (item: PriceItem) => {
        if (isGs1(item.barcode) && item.name && !seen.has(item.barcode)) {
          seen.set(own(item.barcode), { ...item, barcode: own(item.barcode), name: own(item.name), manufacturer: own(item.manufacturer), unit: own(item.unit) });
        }
      }
    : undefined;

  let tried = 0;
  let failed = 0;
  let downloads = 0;
  let bytes = 0;
  let sent = 0;
  let current = 0;
  let deltaBranches = 0;
  let deltaFiles = 0;
  let maxPayload = 0;
  let totalPayload = 0;
  let finished = 0;
  let cut = 0;
  let inARow = 0;
  let gaveUp = false;
  let skipped = 0;
  const held: string[] = [];
  const failures: string[] = [];
  const unknown: string[] = [];

  const succeeded = () => {
    inARow = 0;
  };
  const fail = (text: string) => {
    failed++;
    failures.push(text);
    if (++inARow >= giveUpAfter(chain)) gaveUp = true;
  };
  const fetchMap = async (file: PublishedFile, items?: (item: PriceItem) => void) => {
    const raw = await session.fetch(file);
    downloads++;
    bytes += raw.length;
    return priceMap(decode(raw), items);
  };
  /** ingest_price_map; its answer is the map's item count, 0 when the server wrote nothing (null in a dry run). */
  const send = async (id: number, stamp: string, prices: Record<string, number>, full: boolean): Promise<number | null> => {
    const payload = { p_branch_id: id, p_file_stamp: stamp, p_prices: prices, p_full: full };
    const size = Buffer.byteLength(JSON.stringify(prices));
    maxPayload = Math.max(maxPayload, size);
    totalPayload += size;
    const n = await rpc<unknown>('ingest_price_map', payload);
    return typeof n === 'number' ? n : null;
  };

  const priceBranch = async (plan: (typeof plans)[number]) => {
    const id = idOf(plan.store);
    if (id === null) {
      unknown.push(plan.store);
      return;
    }
    if (gaveUp) {
      skipped++;
      return;
    }
    if (Date.now() > deadline) {
      cut++;
      return;
    }
    if (plan.readFull) {
      tried++;
      let map: Record<string, number> | null = null;
      try {
        map = await fetchMap(plan.full, onItem);
      } catch (e) {
        fail(`${plan.store}: ${message(e).slice(0, 120)}`);
        // The change files build on the full list; without it they wait for the next run. A branch
        // read only for the catalog already has this list on the server, so its changes still apply.
        if (plan.sendFull) return;
      }
      if (map && plan.sendFull) {
        try {
          const n = await send(id, plan.full.stamp, map, true);
          succeeded();
          if (n === 0) {
            // The server kept its map (this file looks cut short, or it is not newer): the changes
            // would be merged into the old map under the new file's stamp, so they wait too.
            held.push(plan.store);
            return;
          }
          sent++;
        } catch (e) {
          fail(`${plan.store}: ${message(e).slice(0, 120)}`);
          return;
        }
      } else {
        if (map) succeeded();
        current++;
      }
    } else {
      current++;
    }
    if (plan.deltas.length > 0) {
      const results: { file: PublishedFile; map: Record<string, number> | null }[] = [];
      for (const file of plan.deltas) {
        tried++;
        try {
          results.push({ file, map: await fetchMap(file) });
          succeeded();
        } catch (e) {
          fail(`${plan.store} ${file.name}: ${message(e).slice(0, 100)}`);
          results.push({ file, map: null });
          break;
        }
      }
      const merged = mergeDeltas(results);
      if (merged.stamp && merged.applied > 0) {
        try {
          if ((await send(id, merged.stamp, merged.map, false)) !== 0) {
            deltaBranches++;
            deltaFiles += merged.applied;
          }
          succeeded();
        } catch (e) {
          fail(`${plan.store} changes: ${message(e).slice(0, 120)}`);
        }
      }
    }
  };

  const work = async (): Promise<'done' | 'not_published'> => {
    const fulls = await session.list('pricefull');
    let changes: PublishedFile[] = [];
    try {
      changes = await session.list('price');
    } catch (e) {
      listingFailed = true;
      problems.push(`Price listing: ${message(e)}`);
    }
    if (fulls.length === 0) {
      if (chain.todayOnly && early) return 'not_published';
      throw new Error('no PriceFull files listed');
    }
    plans = planChain(fulls, changes, stampOf, { readAll: options.full });
    await mapLimit(plans, chain.concurrency, async (plan) => {
      await priceBranch(plan);
      finished++;
    });
    return 'done';
  };

  // Work that started before the budget ran out gets GRACE_MS more; a hung server never runs into the job's timeout.
  const stop = timer(deadline + (options.graceMs ?? GRACE_MS));
  let outcome: 'done' | 'not_published' | 'time';
  try {
    outcome = await Promise.race([work(), stop.reached]);
  } finally {
    stop.clear();
  }
  if (outcome === 'not_published') return { status: 'not_published', error: 'nothing published yet today' };

  let status = chainStatus(listingFailed, tried, failed);
  if (outcome === 'time') {
    status = 'down';
    problems.push(
      plans.length ? `still working at the run's time limit with ${plans.length - finished} of ${plans.length} branches left` : "still listing at the run's time limit",
    );
  }
  if (cut > 0) {
    status = 'down';
    problems.push(`stopped at the run's time limit with ${cut} of ${plans.length} branches left`);
  }
  if (gaveUp) {
    status = 'down';
    problems.push(`gave up after ${giveUpAfter(chain)} failures in a row, ${skipped} branches not tried`);
  }
  if (failures.length > 0) problems.push(`${failures.length} failed: ${failures.slice(0, 3).join('; ')}`);
  if (!server.dry && plans.length > 0 && unknown.length > plans.length * MAX_UNKNOWN) {
    status = 'down';
    problems.push(`${unknown.length} of ${plans.length} listed branches are unknown to the server`);
  }
  const priced = sent + current;
  if (plans.length > 0 && priced === 0) {
    status = 'down';
    problems.push(`no branch was priced (${plans.length} listed)`);
  }
  if (held.length > 0) problems.push(`the server did not take ${held.length} full files: ${held.slice(0, 5).join(', ')}`);
  if (stores > 0 && plans.length < stores * MIN_LISTED && !(chain.todayOnly && early)) {
    // A listing that looks cut short leaves the chain usable, but fails the run so someone looks.
    const short = `only ${plans.length} of the ${stores} branches in the Stores file have a PriceFull`;
    problems.push(short);
    runProblems.push(`${chain.id}: ${short}`);
  }

  if (seen && status === 'ok') {
    for (const [barcode, item] of seen) {
      const known = catalog!.get(barcode);
      if (known) known.chains.add(chain.id);
      else catalog!.set(barcode, { item, chains: new Set([chain.id]) });
    }
  }

  return {
    status,
    error: problems.length ? problems.join(' | ').slice(0, 900) : undefined,
    listed: plans.length,
    sent,
    current,
    held: held.length ? held.slice(0, 50) : undefined,
    deltaBranches,
    deltaFiles,
    priced,
    downloads,
    downloadedMB: Math.round(bytes / 1e5) / 10,
    failed: failures.length ? failures.slice(0, 20) : undefined,
    unknown: unknown.length && !server.dry ? unknown.slice(0, 50) : undefined,
    payloadKB: { max: Math.round(maxPayload / 1024), total: Math.round(totalPayload / 1024) },
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

/** The product rows for ingest_products: per barcode, the chains (that were ok in this run) selling it. */
export function productRows(catalog: Map<string, ProductSeen>) {
  return [...catalog].map(([barcode, { item, chains }]) => ({
    barcode,
    name: item.name.slice(0, 200),
    manufacturer: item.manufacturer.slice(0, 120),
    quantity: item.quantity,
    unit: item.unit.slice(0, 30),
    weighted: item.weighted,
    chains: chains.size,
    chain_ids: [...chains].sort(),
  }));
}

export interface RunReport {
  job: 'prices';
  mode: 'full' | 'update';
  dry: boolean;
  chains: Record<string, ChainReport>;
  products?: { rows: number; common: number; chains: string[]; batches: number; maxBatchKB: number; note?: string };
  /** Problems of the run itself; any of them fails the run, except the notes in `notes`. */
  problems: string[];
  /** Worth knowing, not a failure (the locality list did not load, so coded cities were left as they were). */
  notes: string[];
  seconds: number;
}

export async function prices(options: RunOptions): Promise<RunReport> {
  const started = Date.now();
  const deadline = started + options.budgetMs;
  const mode = options.full ? 'full' : 'update';
  const chains = CHAINS.filter((c) => !options.chains || options.chains.includes(c.id));
  const report: RunReport = { job: 'prices', mode, dry: server.dry, chains: {}, problems: [], notes: [], seconds: 0 };

  // A trace at the start, so a run that never finishes is still visible (P12).
  await rpc('ingest_report', { p_report: { job: 'prices', mode, phase: 'started', chains: chains.map((c) => c.id) } }).catch((e) =>
    report.problems.push(`ingest_report: ${message(e)}`),
  );

  // Branches are sent by the daily run only. Without the government's locality list they are still sent:
  // coded cities go as '' (the server keeps the city it has), names in the text are still found.
  let localities: Localities | null = null;
  if (options.full) {
    localities = await (options.localities ?? loadLocalities)().catch((e) => {
      report.notes.push(`locality list: ${message(e)}; coded cities were left as the server has them`);
      return buildLocalities([]);
    });
  }

  // 1. Sessions and branches, every chain at once.
  const sessions = new Map<string, Session>();
  const finish = async (chain: Chain, result: ChainReport) => {
    report.chains[chain.id] = { ...report.chains[chain.id], ...result };
    // Victory before ~05:00 lists nothing: its status (and yesterday's prices) stay as they are.
    if (result.status === 'not_published') return;
    await rpc('report_chain_status', {
      p_chain: chain.id,
      p_status: result.status,
      p_error: result.error ?? null,
      p_branches_priced: result.priced ?? 0,
    }).catch((e) => report.problems.push(`report_chain_status ${chain.id}: ${message(e)}`));
  };
  await Promise.all(
    chains.map(async (chain) => {
      if (chain.relay !== 'none') {
        const relay = relayState();
        if (relay === 'missing') {
          await finish(chain, { status: 'needs_relay', error: 'RELAY_URL is not set', priced: 0 });
          return;
        }
        if (relay === 'broken') {
          await finish(chain, { status: 'down', error: `relay: ${network.relayProblem}`, priced: 0 });
          return;
        }
      }
      let session: Session;
      try {
        session = await (options.open ?? open)(chain);
      } catch (e) {
        await finish(chain, { status: e instanceof NeedsRelay ? 'needs_relay' : 'down', error: `cannot open: ${message(e)}`, priced: 0 });
        return;
      }
      sessions.set(chain.id, session);
      try {
        const found = await readStores(session);
        if (!found) {
          report.chains[chain.id] = { status: 'ok', stores: 0, error: 'no Stores file listed' };
          return;
        }
        report.chains[chain.id] = { status: 'ok', stores: found.length };
        if (localities) await ingestBranches(chain, found, localities);
      } catch (e) {
        if (e instanceof NeedsRelay) {
          sessions.delete(chain.id);
          await session.close().catch(() => {});
          await finish(chain, { status: 'needs_relay', error: message(e), priced: 0 });
          return;
        }
        report.chains[chain.id] = { ...report.chains[chain.id], status: 'ok', error: `branches: ${message(e)}` };
        // The daily run sends the branches; an update run reads the Stores file only to count them.
        (options.full ? report.problems : report.notes).push(`branches ${chain.id}: ${message(e)}`);
      }
    }),
  );

  // 2. What the server has: every branch it knows, addressed by chain and store.
  let stamps: BranchStamps = { byStore: new Map(), unaddressed: 0 };
  if (!server.dry && sessions.size > 0) {
    try {
      stamps = parseStamps(await rpc('price_map_stamps', {}));
      // An older server (without chain and store, or without the branches that have no map yet) cannot be written to.
      if (stamps.unaddressed > 0) report.problems.push(`price_map_stamps: ${stamps.unaddressed} entries without chain and store`);
      if (stamps.byStore.size === 0) report.problems.push('price_map_stamps: the server returned no branches');
    } catch (e) {
      report.problems.push(`price_map_stamps: ${message(e)}`);
      for (const chain of chains) if (sessions.has(chain.id)) await finish(chain, { status: 'down', error: `price_map_stamps: ${message(e)}`, priced: 0 });
      for (const session of sessions.values()) await session.close().catch(() => {});
      sessions.clear();
    }
  }

  // 3-4. Prices, every chain at once.
  const catalog = options.full ? new Map<string, ProductSeen>() : null;
  await Promise.all(
    chains
      .filter((c) => sessions.has(c.id))
      .map(async (chain) => {
        const before = report.chains[chain.id];
        let result: ChainReport;
        try {
          result = await priceChain(chain, sessions.get(chain.id)!, stamps, options, deadline, catalog, before?.stores ?? 0, report.problems);
        } catch (e) {
          result = { status: e instanceof NeedsRelay ? 'needs_relay' : 'down', error: message(e), priced: 0 };
        }
        if (before?.error) result.error = [before.error, result.error].filter(Boolean).join(' | ');
        await finish(chain, result);
      }),
  );
  for (const session of sessions.values()) await session.close().catch(() => {});

  // 5. Products, from the chains that were ok, after their statuses are on the server.
  if (catalog) {
    const ok = chains.filter((c) => report.chains[c.id]?.status === 'ok').map((c) => c.id);
    const rows = productRows(catalog);
    const batches: number[] = [];
    let note: string | undefined;
    if (ok.length < 3) {
      note = `not sent: only ${ok.length} chains were ok`;
    } else {
      try {
        await inBatches(rows, 1000, async (batch) => {
          batches.push(Buffer.byteLength(JSON.stringify(batch)));
          await rpc('ingest_products', { p_rows: batch });
        });
      } catch (e) {
        report.problems.push(`ingest_products: ${message(e)}`);
      }
    }
    report.products = {
      rows: rows.length,
      common: rows.filter((r) => r.chains >= 6).length,
      chains: ok,
      batches: batches.length,
      maxBatchKB: Math.round(Math.max(0, ...batches) / 1024),
      ...(note ? { note } : {}),
    };
  }

  report.seconds = Math.round((Date.now() - started) / 1000);
  await rpc('ingest_report', { p_report: { ...report, phase: 'finished' } }).catch((e) => report.problems.push(`ingest_report: ${message(e)}`));
  return report;
}

/** Non-zero when any chain is down or the run has a problem: GitHub then shows a red run and emails the owner. */
export const exitCode = (report: RunReport): number => (Object.values(report.chains).some((c) => c.status === 'down') || report.problems.length > 0 ? 1 : 0);
