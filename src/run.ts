import { type Chain, CHAINS } from './chains.ts';
import { type Session, open } from './engines/index.ts';
import { type PublishedFile, israelHour, newest } from './files.ts';
import { NeedsRelay, canReach } from './http.ts';
import { type Localities, cityName, loadLocalities } from './localities.ts';
import { type ChainStatus, type Stamp, chainStatus, mergeDeltas, planChain, priceMap } from './plan.ts';
import { mapLimit } from './pool.ts';
import { type BranchStamps, inBatches, parseStamps, rpc, server } from './server.ts';
import { type PriceItem, branches, decode } from './xml.ts';

/**
 * One run of the downloader (docs/PRICES-CONTRACT.md, "Downloader"):
 *
 * 1. every chain's Stores file -> ingest_branches (cities found here);
 * 2. price_map_stamps: what the server already has, per branch;
 * 3. per chain, the newest PriceFull of EVERY branch -> ingest_price_map(p_full = true)
 *    when it is newer than the server's map; then the newer Price (change)
 *    files, merged per branch -> ingest_price_map(p_full = false);
 * 4. report_chain_status for each chain as soon as it is done (a run cut by
 *    the job timeout still leaves a trace);
 * 5. the daily (`full`) run also reads every branch's PriceFull for the
 *    product catalog -> ingest_products, with the chains each product was seen in.
 *
 * Chains run in parallel and one chain's failure never stops another. The
 * process exits non-zero when any chain is down (cli.ts).
 */

/** A barcode counts as a product when it is a GS1 code (8-14 digits); shorter codes are a chain's own. */
const isGs1 = (barcode: string) => barcode.length >= 8;
/** Before this hour (Israel time) an empty listing of a today-only chain means "not published yet". */
const PUBLISHED_BY_HOUR = 9;

export interface RunOptions {
  /** The daily run: read every branch's PriceFull and send the product catalog. */
  full: boolean;
  /** Only these chains (default: all). */
  chains?: readonly string[];
  /** Stop starting new downloads after this many milliseconds (the job's own timeout is longer). */
  budgetMs: number;
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
  /** Branches with a price list on the chain's server now. */
  listed?: number;
  /** Full maps sent / already current on the server. */
  sent?: number;
  current?: number;
  /** Branches whose change files were merged and sent, and how many files that was. */
  deltaBranches?: number;
  deltaFiles?: number;
  /** Branches priced (sent or current), as reported to the server. */
  priced?: number;
  downloads?: number;
  downloadedMB?: number;
  failed?: string[];
  /** Listed branches the server has no row for (not in the Stores file). */
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

async function ingestBranches(chain: Chain, session: Session, localities: Localities | null): Promise<{ stores: number; note?: string }> {
  const storesFile = newest(await session.list('stores'), 'stores', null);
  if (!storesFile) return { stores: 0, note: 'no Stores file listed' };
  const found = [...branches(decode(await session.fetch(storesFile)))];
  // Without the government's locality list the coded cities would be written as '' over good ones.
  if (!localities) return { stores: found.length, note: 'branches not sent: the locality list did not load' };
  const rows = found.map((b) => ({ ...b, city: cityName(localities, b.city, b.name, b.address, chain.id) }));
  await inBatches(rows, 500, (batch) => rpc('ingest_branches', { p_chain: chain.id, p_rows: batch }));
  return { stores: found.length };
}

async function priceChain(
  chain: Chain,
  session: Session,
  stamps: BranchStamps,
  options: RunOptions,
  deadline: number,
  catalog: Map<string, ProductSeen> | null,
): Promise<ChainReport> {
  const started = Date.now();
  const report: ChainReport = { status: 'ok' };
  const problems: string[] = [];
  let listingFailed = false;

  const fulls = await session.list('pricefull');
  let changes: PublishedFile[] = [];
  try {
    changes = await session.list('price');
  } catch (e) {
    listingFailed = true;
    problems.push(`Price listing: ${message(e)}`);
  }
  if (fulls.length === 0 && (!chain.priceIsFull || changes.length === 0)) {
    if (chain.todayOnly && israelHour(options.now?.()) < PUBLISHED_BY_HOUR) return { status: 'not_published', error: 'nothing published yet today' };
    throw new Error('no PriceFull files listed');
  }

  const idOf = (store: string) => (server.dry ? 0 : (stamps.byStore.get(`${chain.id}:${store}`)?.id ?? null));
  const stampOf = (store: string): Stamp | undefined => stamps.byStore.get(`${chain.id}:${store}`);
  const plans = planChain(fulls, changes, stampOf, { readAll: options.full, priceIsFull: chain.priceIsFull });

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
  const failures: string[] = [];
  const unknown: string[] = [];
  let cut = 0;

  const fetchMap = async (file: PublishedFile, items?: (item: PriceItem) => void) => {
    const raw = await session.fetch(file);
    downloads++;
    bytes += raw.length;
    return priceMap(decode(raw), items);
  };
  const send = async (id: number, stamp: string, prices: Record<string, number>, full: boolean) => {
    const payload = { p_branch_id: id, p_file_stamp: stamp, p_prices: prices, p_full: full };
    const size = Buffer.byteLength(JSON.stringify(prices));
    maxPayload = Math.max(maxPayload, size);
    totalPayload += size;
    await rpc('ingest_price_map', payload);
  };

  await mapLimit(plans, chain.concurrency, async (plan) => {
    const id = idOf(plan.store);
    if (id === null) {
      unknown.push(plan.store);
      return;
    }
    if (Date.now() > deadline) {
      cut++;
      return;
    }
    if (plan.readFull) {
      tried++;
      try {
        const map = await fetchMap(plan.full, onItem);
        if (plan.sendFull) {
          await send(id, plan.full.stamp, map, true);
          sent++;
        } else {
          current++;
        }
      } catch (e) {
        failed++;
        failures.push(`${plan.store}: ${message(e).slice(0, 120)}`);
        // The change files build on the full list; without it they wait for the next run.
        return;
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
        } catch (e) {
          failed++;
          failures.push(`${plan.store} ${file.name}: ${message(e).slice(0, 100)}`);
          results.push({ file, map: null });
          break;
        }
      }
      const merged = mergeDeltas(results);
      if (merged.stamp && merged.applied > 0) {
        try {
          await send(id, merged.stamp, merged.map, false);
          deltaBranches++;
          deltaFiles += merged.applied;
        } catch (e) {
          failed++;
          failures.push(`${plan.store} changes: ${message(e).slice(0, 120)}`);
        }
      }
    }
  });

  let status = chainStatus(listingFailed, tried, failed);
  if (cut > 0) {
    status = 'down';
    problems.push(`stopped at the run's time limit with ${cut} of ${plans.length} branches left`);
  }
  if (failures.length > 0) problems.push(`${failures.length} failed: ${failures.slice(0, 3).join('; ')}`);
  if (stamps.unaddressed > 0 && !server.dry) problems.push(`price_map_stamps returned ${stamps.unaddressed} entries without chain/store`);
  if (unknown.length > 0 && !server.dry) problems.push(`${unknown.length} listed branches are unknown to the server`);

  if (seen && status === 'ok') {
    for (const [barcode, item] of seen) {
      const known = catalog!.get(barcode);
      if (known) known.chains.add(chain.id);
      else catalog!.set(barcode, { item, chains: new Set([chain.id]) });
    }
  }

  Object.assign(report, {
    status,
    error: problems.length ? problems.join(' | ').slice(0, 900) : undefined,
    listed: plans.length,
    sent,
    current,
    deltaBranches,
    deltaFiles,
    priced: sent + current,
    downloads,
    downloadedMB: Math.round(bytes / 1e5) / 10,
    failed: failures.length ? failures.slice(0, 20) : undefined,
    unknown: unknown.length && !server.dry ? unknown.slice(0, 50) : undefined,
    payloadKB: { max: Math.round(maxPayload / 1024), total: Math.round(totalPayload / 1024) },
    seconds: Math.round((Date.now() - started) / 1000),
  } satisfies ChainReport);
  return report;
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
  problems: string[];
  seconds: number;
}

export async function prices(options: RunOptions): Promise<RunReport> {
  const started = Date.now();
  const deadline = started + options.budgetMs;
  const mode = options.full ? 'full' : 'update';
  const chains = CHAINS.filter((c) => !options.chains || options.chains.includes(c.id));
  const report: RunReport = { job: 'prices', mode, dry: server.dry, chains: {}, problems: [], seconds: 0 };

  // A trace at the start, so a run that never finishes is still visible (P12).
  await rpc('ingest_report', { p_report: { job: 'prices', mode, phase: 'started', chains: chains.map((c) => c.id) } }).catch((e) =>
    report.problems.push(`ingest_report: ${message(e)}`),
  );

  const localities = await (options.localities ?? loadLocalities)().catch((e) => {
    report.problems.push(`locality list: ${message(e)}`);
    return null;
  });

  // 1. Sessions and branches, every chain at once.
  const sessions = new Map<string, Session>();
  const finish = async (chain: Chain, result: ChainReport) => {
    report.chains[chain.id] = { ...report.chains[chain.id], ...result };
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
      if (chain.relay !== 'none' && !canReach(true)) {
        await finish(chain, { status: 'needs_relay', error: 'RELAY_URL is not set', priced: 0 });
        return;
      }
      try {
        const session = await (options.open ?? open)(chain);
        sessions.set(chain.id, session);
        const { stores, note } = await ingestBranches(chain, session, localities);
        report.chains[chain.id] = { status: 'ok', stores, ...(note ? { error: note } : {}) };
      } catch (e) {
        if (e instanceof NeedsRelay) await finish(chain, { status: 'needs_relay', error: message(e), priced: 0 });
        else if (sessions.has(chain.id)) {
          report.chains[chain.id] = { status: 'ok', error: `branches: ${message(e)}` };
          report.problems.push(`ingest_branches ${chain.id}: ${message(e)}`);
        }
        else await finish(chain, { status: 'down', error: `cannot open: ${message(e)}` });
      }
    }),
  );

  // 2. What the server has.
  let stamps: BranchStamps = { byStore: new Map(), unaddressed: 0 };
  if (!server.dry) {
    try {
      stamps = parseStamps(await rpc('price_map_stamps', {}));
    } catch (e) {
      report.problems.push(`price_map_stamps: ${message(e)}`);
      for (const chain of chains) if (sessions.has(chain.id)) await finish(chain, { status: 'down', error: `price_map_stamps: ${message(e)}` });
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
          result = await priceChain(chain, sessions.get(chain.id)!, stamps, options, deadline, catalog);
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

/** Non-zero when any chain is down or a server call failed: GitHub then shows a red run and emails the owner. */
export const exitCode = (report: RunReport): number =>
  Object.values(report.chains).some((c) => c.status === 'down') || report.problems.some((p) => !p.startsWith('locality list')) ? 1 : 0;
