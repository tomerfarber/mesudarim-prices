import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { Chain } from '../src/chains.ts';
import type { Session } from '../src/engines/index.ts';
import { type FileKind, type PublishedFile, parseName } from '../src/files.ts';
import { network } from '../src/http.ts';
import { buildLocalities } from '../src/localities.ts';
import { exitCode, prices } from '../src/run.ts';
import { inBatches, parseStamps, server } from '../src/server.ts';

/**
 * A whole run against fake chain servers and a fake Mesudarim server, checking
 * the calls the contract defines (docs/PRICES-CONTRACT.md, "Downloader RPCs").
 */
const realFetch = globalThis.fetch;
let calls: { fn: string; args: Record<string, unknown> }[] = [];
let stamps: unknown = {};
/** A test's own answer to an RPC (undefined: the default answer). */
let answer: (fn: string, args: Record<string, unknown>) => Response | undefined = () => undefined;

beforeEach(() => {
  calls = [];
  stamps = baseStamps;
  answer = () => undefined;
  process.env.SUPABASE_URL = 'https://db.example';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.PRICES_TOKEN = 'token';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const fn = String(url).replace('https://db.example/rest/v1/rpc/', '');
    const args = JSON.parse(String(init.body));
    assert.equal(args.p_token, 'token');
    delete args.p_token;
    calls.push({ fn, args });
    const own = answer(fn, args);
    if (own) return own;
    if (fn === 'price_map_stamps') return Response.json(stamps);
    return new Response(fn === 'report_chain_status' || fn === 'ingest_report' ? '' : '1');
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  network.direct = false;
  network.relay = null;
  network.relayProblem = null;
  server.dry = false;
  server.calls = [];
});

const xmlItems = (items: [string, string, string][]) =>
  gzipSync(`<Root><Items>${items.map(([code, name, price]) => `<Item><ItemCode>${code}</ItemCode><ItemName>${name}</ItemName><ItemPrice>${price}</ItemPrice></Item>`).join('')}</Items></Root>`);
const storesXml = (stores: [string, string, string][]) =>
  gzipSync(`<Root><Branches>${stores.map(([id, name, city]) => `<Branch><StoreId>${id}</StoreId><StoreName>${name}</StoreName><City>${city}</City></Branch>`).join('')}</Branches></Root>`);

/** A fake chain server: file name -> bytes. */
function fakeSession(files: Record<string, Buffer>): Session {
  const published = Object.keys(files).map((n) => parseName(n, n)!);
  return {
    list: async (kind: FileKind) => published.filter((f) => f.kind === kind),
    fetch: async (file: PublishedFile) => files[file.name],
    close: async () => {},
  };
}

const shufersal = fakeSession({
  'Stores7290027600007-000-20261027-020000.gz': storesXml([['1', 'שלי באר שבע', '9000'], ['2', 'אקספרס', '9000']]),
  // Branch 1: the server has yesterday's map; branch 2: today's is already there.
  'PriceFull7290027600007-001-001-20261027-030000.gz': xmlItems([['7290004131074', 'חלב', '7.20'], ['7290000068237', 'קוטג', '6.10']]),
  'PriceFull7290027600007-001-002-20261027-030000.gz': xmlItems([['7290004131074', 'חלב', '7.50']]),
  'Price7290027600007-001-001-20261027-020000.gz': xmlItems([['7290004131074', 'חלב', '1.00']]),
  'Price7290027600007-001-001-20261027-100000.gz': xmlItems([['7290004131074', 'חלב', '6.90']]),
  'Price7290027600007-001-001-20261027-110000.gz': xmlItems([['7290000068237', 'קוטג', '5.90']]),
  'Price7290027600007-001-002-20261027-110000.gz': xmlItems([['7290004131074', 'חלב', '7.40']]),
});
const kingStore = fakeSession({
  'PriceFull7290058108879-000-006-20261027-051209.GZ': xmlItems([['7290004131074', 'חלב', '7.10'], ['7290011194246', 'לחם', '8.00']]),
});
const yohananof = fakeSession({
  'PriceFull7290803800003-000-015-20261027-004052.gz': xmlItems([['7290004131074', 'חלב', '7.00']]),
});
const victoryBeforeFive = fakeSession({});

const sessions: Record<string, (() => Promise<Session>) | undefined> = {
  shufersal: async () => shufersal,
  king_store: async () => kingStore,
  yohananof: async () => yohananof,
  victory: async () => victoryBeforeFive,
  rami_levy: async () => {
    throw new Error('530 Login incorrect');
  },
};
const open = (chain: Chain) => (sessions[chain.id] ?? (() => Promise.reject(new Error(`unexpected chain ${chain.id}`))))();
const localities = async () => buildLocalities([{ code: '9000', name: 'באר שבע' }]);

const baseStamps = {
  '11': { chain: 'shufersal', store: '1', file: '20261026030000', delta: '20261026200000' },
  '12': { chain: 'shufersal', store: '2', file: '20261027030000', delta: null },
  '21': { chain: 'king_store', store: '6', file: null, delta: null },
  '31': { chain: 'yohananof', store: '15', file: null, delta: null },
};

test('a full run: maps when newer, merged changes, statuses, products with their chains, and a red exit for a down chain', async () => {
  // As on a machine in Israel, so Victory is reached (and has published nothing yet at 04:30).
  network.direct = true;
  const report = await prices({
    full: true,
    chains: ['shufersal', 'rami_levy', 'victory', 'king_store', 'yohananof'],
    budgetMs: 60_000,
    now: () => new Date('2026-10-27T02:30:00Z'),
    open,
    localities,
  });
  const fns = calls.map((c) => c.fn);
  assert.equal(fns[0], 'ingest_report');
  assert.equal((calls[0].args.p_report as { phase: string }).phase, 'started');
  assert.equal(fns.at(-1), 'ingest_report');

  // Branches, with the coded city resolved.
  const branchCall = calls.find((c) => c.fn === 'ingest_branches')!;
  assert.deepEqual(branchCall.args, {
    p_chain: 'shufersal',
    p_rows: [
      { store: '1', name: 'שלי באר שבע', address: '', city: 'באר שבע' },
      { store: '2', name: 'אקספרס', address: '', city: 'באר שבע' },
    ],
  });

  // Prices: branch 1 gets today's PriceFull, then the 10:00 and 11:00 changes merged; branch 2 only its change.
  const maps = calls.filter((c) => c.fn === 'ingest_price_map').map((c) => c.args);
  const of = (id: number) => maps.filter((m) => m.p_branch_id === id);
  assert.deepEqual(of(11), [
    { p_branch_id: 11, p_file_stamp: '20261027030000', p_prices: { '7290004131074': 720, '7290000068237': 610 }, p_full: true },
    { p_branch_id: 11, p_file_stamp: '20261027110000', p_prices: { '7290004131074': 690, '7290000068237': 590 }, p_full: false },
  ]);
  assert.deepEqual(of(12), [{ p_branch_id: 12, p_file_stamp: '20261027110000', p_prices: { '7290004131074': 740 }, p_full: false }]);
  assert.deepEqual(of(21).map((m) => [m.p_file_stamp, m.p_full]), [['20261027051209', true]]);

  // Every chain's status, as soon as it is known; Victory before 05:00 is left as it was.
  const statuses = Object.fromEntries(calls.filter((c) => c.fn === 'report_chain_status').map((c) => [c.args.p_chain, [c.args.p_status, c.args.p_branches_priced]]));
  assert.deepEqual(statuses, {
    shufersal: ['ok', 2],
    rami_levy: ['down', 0],
    king_store: ['ok', 1],
    yohananof: ['ok', 1],
  });
  assert.equal(report.chains.victory.status, 'not_published');
  assert.match(calls.find((c) => c.args.p_chain === 'rami_levy')!.args.p_error as string, /530 Login incorrect/);

  // Products after the statuses, with the chains (ok in this run) that sell each one.
  const productCalls = calls.filter((c) => c.fn === 'ingest_products');
  assert.equal(productCalls.length, 1);
  assert.ok(fns.lastIndexOf('report_chain_status') < fns.indexOf('ingest_products'));
  const rows = productCalls[0].args.p_rows as { barcode: string; chains: number; chain_ids: string[] }[];
  const milk = rows.find((r) => r.barcode === '7290004131074')!;
  assert.deepEqual([milk.chains, milk.chain_ids], [3, ['king_store', 'shufersal', 'yohananof']]);
  assert.deepEqual(rows.find((r) => r.barcode === '7290011194246')!.chain_ids, ['king_store']);
  assert.deepEqual(report.products?.chains.sort(), ['king_store', 'shufersal', 'yohananof']);

  assert.equal(exitCode(report), 1);
});

test('an update run sends only what changed, and needs_relay alone does not fail the run', async () => {
  const report = await prices({ full: false, chains: ['shufersal', 'carrefour', 'victory', 'hazi_hinam'], budgetMs: 60_000, open, localities });
  assert.equal(calls.filter((c) => c.fn === 'ingest_products').length, 0);
  // Branch 11's full map goes before its changes; branches run in parallel.
  const sent = calls.filter((c) => c.fn === 'ingest_price_map').map((c) => `${c.args.p_branch_id}:${c.args.p_full}`);
  assert.deepEqual([...sent].sort(), ['11:false', '11:true', '12:false']);
  assert.ok(sent.indexOf('11:true') < sent.indexOf('11:false'));
  assert.deepEqual([report.chains.carrefour.status, report.chains.victory.status, report.chains.hazi_hinam.status], ['needs_relay', 'needs_relay', 'needs_relay']);
  assert.equal(exitCode(report), 0);
});

test('a dry run downloads and builds every payload but calls no RPC', async () => {
  server.dry = true;
  const report = await prices({ full: true, chains: ['shufersal', 'king_store', 'yohananof'], budgetMs: 60_000, open, localities });
  assert.deepEqual(calls, []);
  assert.equal(report.dry, true);
  // Without the server's stamps every branch's map is built.
  assert.equal(report.chains.shufersal.sent, 2);
  const fns = new Set(server.calls.map((c) => c.fn));
  assert.deepEqual([...fns].sort(), ['ingest_branches', 'ingest_price_map', 'ingest_products', 'ingest_report', 'report_chain_status']);
});

test('a run past its time budget stops starting downloads and reports the chain down', async () => {
  const report = await prices({ full: false, chains: ['shufersal'], budgetMs: -1, open, localities });
  assert.equal(report.chains.shufersal.status, 'down');
  assert.match(report.chains.shufersal.error!, /time limit/);
  assert.equal(exitCode(report), 1);
});

test('price_map_stamps entries are matched by chain and store', () => {
  const parsed = parseStamps({ '7': { chain: 'victory', store: '071', file: '20261027051238', delta: null }, '8': { file: '20261027051238' }, x: {} });
  assert.deepEqual(parsed.byStore.get('victory:71'), { id: 7, file: '20261027051238', delta: null });
  assert.equal(parsed.unaddressed, 2);
});

// --- Failures that must never be a green run that writes nothing (P12), and the other review fixes.

const statusOf = (chain: string) => calls.find((c) => c.fn === 'report_chain_status' && c.args.p_chain === chain)?.args;
const kingCode = '7290058108879';
/** King Store with `n` branches, each with a PriceFull; `fetch` can be replaced. */
function kingStoreWith(n: number, fetch?: Session['fetch']): Session {
  const files: Record<string, Buffer> = { [`Stores${kingCode}-000-20261027-050000.gz`]: storesXml(Array.from({ length: n }, (_, i) => [String(i + 1), `קינג ${i + 1}`, '9000'])) };
  for (let i = 1; i <= n; i++) files[`PriceFull${kingCode}-000-${String(i).padStart(3, '0')}-20261027-051209.gz`] = xmlItems([['7290004131074', 'חלב', '7.10']]);
  const session = fakeSession(files);
  return fetch ? { ...session, fetch } : session;
}
const kingStamps = (stores: number[]) => Object.fromEntries(stores.map((st) => [String(100 + st), { chain: 'king_store', store: String(st), file: null, delta: null }]));

test("the committed 0072 price_map_stamps (no chain or store) fails the run: chains down, nothing priced, exit 1", async () => {
  stamps = { '11': { file: '20261026030000', delta: null }, '21': { file: '20261027051209', delta: null } };
  const report = await prices({ full: false, chains: ['shufersal', 'king_store'], budgetMs: 60_000, open, localities });
  assert.equal(calls.filter((c) => c.fn === 'ingest_price_map').length, 0);
  assert.deepEqual([statusOf('shufersal')?.p_status, statusOf('king_store')?.p_status], ['down', 'down']);
  assert.match(String(statusOf('shufersal')?.p_error), /2 of 2 listed branches are unknown to the server/);
  assert.match(String(statusOf('shufersal')?.p_error), /no branch was priced/);
  assert.ok(report.problems.some((p) => /price_map_stamps: 2 entries without chain and store/.test(p)));
  assert.equal(exitCode(report), 1);

  for (const empty of [{}, null]) {
    calls = [];
    stamps = empty;
    const again = await prices({ full: false, chains: ['king_store'], budgetMs: 60_000, open, localities });
    assert.ok(again.problems.includes('price_map_stamps: the server returned no branches'));
    assert.equal(statusOf('king_store')?.p_status, 'down');
    assert.equal(exitCode(again), 1);
  }
});

test('a few listed branches unknown to the server stay out of the chain status; many make it down', async () => {
  sessions.king_store = async () => kingStoreWith(10);
  try {
    stamps = kingStamps([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const few = await prices({ full: false, chains: ['king_store'], budgetMs: 60_000, open, localities });
    assert.deepEqual([statusOf('king_store')?.p_status, statusOf('king_store')?.p_error, statusOf('king_store')?.p_branches_priced], ['ok', null, 9]);
    assert.deepEqual(few.chains.king_store.unknown, ['10']);
    assert.equal(exitCode(few), 0);

    calls = [];
    stamps = kingStamps([1, 2, 3, 4, 5, 6, 7]);
    const many = await prices({ full: false, chains: ['king_store'], budgetMs: 60_000, open, localities });
    assert.equal(statusOf('king_store')?.p_status, 'down');
    assert.match(String(statusOf('king_store')?.p_error), /3 of 10 listed branches are unknown/);
    assert.equal(exitCode(many), 1);
  } finally {
    sessions.king_store = async () => kingStore;
  }
});

test('a full file the server did not take: its change files wait, and it is not counted as priced', async () => {
  answer = (fn, args) => (fn === 'ingest_price_map' && args.p_branch_id === 11 && args.p_full ? new Response('0') : undefined);
  const report = await prices({ full: false, chains: ['shufersal'], budgetMs: 60_000, open, localities });
  const sent = calls.filter((c) => c.fn === 'ingest_price_map').map((c) => `${c.args.p_branch_id}:${c.args.p_full}`);
  assert.deepEqual(sent.sort(), ['11:true', '12:false']);
  assert.deepEqual([report.chains.shufersal.status, report.chains.shufersal.sent, report.chains.shufersal.held, report.chains.shufersal.priced], ['ok', 0, ['1'], 1]);
  assert.match(String(statusOf('shufersal')?.p_error), /did not take 1 full files: 1/);
});

test('a branch read only for the product catalog keeps its change files when that read fails', async () => {
  const flaky: Session = { ...shufersal, fetch: async (file) => (file.name === 'PriceFull7290027600007-001-002-20261027-030000.gz' ? Promise.reject(new Error('reset')) : shufersal.fetch(file)) };
  sessions.shufersal = async () => flaky;
  try {
    const report = await prices({ full: true, chains: ['shufersal', 'king_store', 'yohananof'], budgetMs: 60_000, open, localities });
    const of12 = calls.filter((c) => c.fn === 'ingest_price_map' && c.args.p_branch_id === 12).map((c) => [c.args.p_file_stamp, c.args.p_full]);
    assert.deepEqual(of12, [['20261027110000', false]]);
    assert.equal(report.chains.shufersal.current, 1);
    assert.deepEqual(report.chains.shufersal.failed, ['2: reset']);
  } finally {
    sessions.shufersal = async () => shufersal;
  }
});

test('a file server that keeps failing is given up after a few failures in a row (P52)', async () => {
  let fetched = 0;
  sessions.king_store = async () =>
    kingStoreWith(30, async (file) => {
      if (file.kind === 'stores') return kingStoreWith(30).fetch(file);
      fetched++;
      throw new Error('ETIMEDOUT');
    });
  try {
    stamps = kingStamps(Array.from({ length: 30 }, (_, i) => i + 1));
    const report = await prices({ full: false, chains: ['king_store'], budgetMs: 60_000, open, localities });
    assert.equal(report.chains.king_store.status, 'down');
    assert.match(report.chains.king_store.error!, /gave up after 8 failures in a row, \d+ branches not tried/);
    assert.ok(fetched < 30, `tried ${fetched} of 30`);
  } finally {
    sessions.king_store = async () => kingStore;
  }
});

test('a server that stops answering: the chain is cut off at the time limit, and the run still reports and ends', async () => {
  sessions.king_store = async () => kingStoreWith(3, (file) => (file.kind === 'stores' ? kingStoreWith(3).fetch(file) : new Promise(() => {})));
  try {
    stamps = { ...kingStamps([1, 2, 3]), '31': baseStamps['31'] };
    const t = Date.now();
    const report = await prices({ full: false, chains: ['king_store', 'yohananof'], budgetMs: 200, graceMs: 200, open, localities });
    assert.ok(Date.now() - t < 5_000);
    assert.equal(statusOf('king_store')?.p_status, 'down');
    assert.match(String(statusOf('king_store')?.p_error), /still working at the run's time limit with 3 of 3 branches left/);
    assert.equal(statusOf('yohananof')?.p_status, 'ok');
    assert.equal(calls.at(-1)?.fn, 'ingest_report');
    assert.equal(exitCode(report), 1);
  } finally {
    sessions.king_store = async () => kingStore;
  }
});

test('a relay that is set up wrong takes down only the relay chains; the rest still run', async () => {
  network.relayProblem = 'RELAY_URL is set but there are no AWS credentials';
  const report = await prices({ full: false, chains: ['shufersal', 'carrefour', 'victory', 'hazi_hinam'], budgetMs: 60_000, open, localities });
  assert.equal((calls[0].args.p_report as { phase: string }).phase, 'started');
  assert.equal(statusOf('shufersal')?.p_status, 'ok');
  for (const id of ['carrefour', 'victory', 'hazi_hinam']) {
    assert.equal(statusOf(id)?.p_status, 'down');
    assert.match(String(statusOf(id)?.p_error), /^relay: RELAY_URL is set but there are no AWS credentials/);
  }
  assert.equal(exitCode(report), 1);
});

test('update runs only count the branches; the daily run sends them even when the locality list fails', async () => {
  const update = await prices({ full: false, chains: ['shufersal'], budgetMs: 60_000, open, localities });
  assert.equal(calls.filter((c) => c.fn === 'ingest_branches').length, 0);
  assert.equal(update.chains.shufersal.stores, 2);

  calls = [];
  const daily = await prices({
    full: true,
    chains: ['shufersal', 'king_store', 'yohananof'],
    budgetMs: 60_000,
    open,
    localities: () => Promise.reject(new Error('data.gov.il 503')),
  });
  const rows = calls.find((c) => c.fn === 'ingest_branches')?.args.p_rows as { store: string; city: string }[];
  // The coded city 9000 cannot be read without the list: '' keeps the server's city.
  assert.deepEqual(rows.map((r) => [r.store, r.city]), [['1', ''], ['2', '']]);
  assert.match(daily.notes.join(), /locality list: data.gov.il 503/);
  assert.equal(exitCode(daily), 0);
});

test('a listing that looks cut short fails the run but leaves the chain usable', async () => {
  const many = storesXml(Array.from({ length: 10 }, (_, i) => [String(i + 1), `סניף ${i + 1}`, '9000']));
  sessions.shufersal = async () => ({ ...shufersal, fetch: async (file) => (file.kind === 'stores' ? many : shufersal.fetch(file)) });
  try {
    const report = await prices({ full: false, chains: ['shufersal'], budgetMs: 60_000, open, localities });
    assert.equal(statusOf('shufersal')?.p_status, 'ok');
    assert.match(String(statusOf('shufersal')?.p_error), /only 2 of the 10 branches in the Stores file have a PriceFull/);
    assert.ok(report.problems.includes('shufersal: only 2 of the 10 branches in the Stores file have a PriceFull'));
    assert.equal(exitCode(report), 1);
  } finally {
    sessions.shufersal = async () => shufersal;
  }
});

test('when price_map_stamps fails every chain is down and its connections are closed at once', async () => {
  answer = (fn) => (fn === 'price_map_stamps' ? new Response('{"message":"function public.price_map_stamps does not exist"}', { status: 404 }) : undefined);
  let closed = 0;
  sessions.king_store = async () => ({ ...kingStore, close: async () => void closed++ });
  try {
    const report = await prices({ full: false, chains: ['king_store', 'shufersal'], budgetMs: 60_000, open, localities });
    assert.equal(closed, 1);
    assert.deepEqual([statusOf('king_store')?.p_status, statusOf('shufersal')?.p_status], ['down', 'down']);
    assert.equal(exitCode(report), 1);
  } finally {
    sessions.king_store = async () => kingStore;
  }
});

test('one failed batch does not stop the batches after it', async () => {
  const sent: number[][] = [];
  await assert.rejects(
    inBatches([1, 2, 3, 4, 5], 2, async (batch) => {
      sent.push(batch);
      if (batch[0] === 3) throw new Error('bad row');
    }),
    /1 of 3 batches failed: bad row/,
  );
  assert.deepEqual(sent, [[1, 2], [3, 4], [5]]);
});
