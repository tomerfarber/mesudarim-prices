import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { Chain } from '../src/chains.ts';
import type { Session } from '../src/engines/index.ts';
import { type FileKind, type PublishedFile, parseName } from '../src/files.ts';
import { network } from '../src/http.ts';
import { buildLocalities } from '../src/localities.ts';
import { exitCode, prices } from '../src/run.ts';
import { parseStamps, server } from '../src/server.ts';

/**
 * A whole run against fake chain servers and a fake Mesudarim server, checking
 * the calls the contract defines (docs/PRICES-CONTRACT.md, "Downloader RPCs").
 */
const realFetch = globalThis.fetch;
let calls: { fn: string; args: Record<string, unknown> }[] = [];
let stamps: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  process.env.SUPABASE_URL = 'https://db.example';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.PRICES_TOKEN = 'token';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const fn = String(url).replace('https://db.example/rest/v1/rpc/', '');
    const args = JSON.parse(String(init.body));
    assert.equal(args.p_token, 'token');
    delete args.p_token;
    calls.push({ fn, args });
    if (fn === 'price_map_stamps') return Response.json(stamps);
    return new Response(fn === 'report_chain_status' || fn === 'ingest_report' ? '' : '1');
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  network.direct = false;
  network.relay = null;
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

const sessions: Record<string, () => Promise<Session>> = {
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

stamps = {
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
