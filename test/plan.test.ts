import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseName } from '../src/files.ts';
import { chainStatus, mergeDeltas, planChain, priceMap, type Stamp } from '../src/plan.ts';

const f = (name: string) => parseName(name, name)!;
const stamps = (table: Record<string, Stamp>) => (store: string) => table[store];

test('a branch gets its PriceFull when the server has none or an older one, and nothing when it is current', () => {
  const fulls = [
    f('PriceFull7290058140886-001-001-20261026-001001.gz'),
    f('PriceFull7290058140886-001-001-20261027-001001.gz'),
    f('PriceFull7290058140886-001-002-20261027-001009.gz'),
    f('PriceFull7290058140886-001-003-20261027-001009.gz'),
  ];
  const plans = planChain(fulls, [], stamps({ '2': { file: '20261027001009', delta: null }, '3': { file: '20261026001009', delta: '20261026220000' } }), { readAll: false });
  const byStore = Object.fromEntries(plans.map((p) => [p.store, p]));
  assert.equal(byStore['1'].full.stamp, '20261027001001');
  assert.equal(byStore['1'].sendFull, true);
  assert.equal(byStore['2'].sendFull, false);
  assert.equal(byStore['2'].readFull, false);
  assert.equal(byStore['3'].sendFull, true);
  // The daily run reads current branches too (product catalog) without sending them again.
  const daily = planChain(fulls, [], stamps({ '2': { file: '20261027001009', delta: null } }), { readAll: true });
  assert.deepEqual(daily.find((p) => p.store === '2'), { ...daily.find((p) => p.store === '2')!, sendFull: false, readFull: true });
});

test('change files newer than the map are applied oldest first; older ones are skipped', () => {
  const fulls = [f('PriceFull7290027600007-001-001-20261027-030000.gz'), f('PriceFull7290027600007-001-002-20261027-030000.gz')];
  const changes = [
    f('Price7290027600007-001-001-20261027-020000.gz'), // older than today's PriceFull
    f('Price7290027600007-001-001-20261027-110000.gz'),
    f('Price7290027600007-001-001-20261027-090000.gz'),
    f('Price7290027600007-001-002-20261027-090000.gz'),
    f('Price7290027600007-001-002-20261027-110000.gz'),
  ];
  const plans = planChain(fulls, changes, stamps({ '2': { file: '20261027030000', delta: '20261027090000' } }), { readAll: false });
  const byStore = Object.fromEntries(plans.map((p) => [p.store, p]));
  assert.deepEqual(byStore['1'].deltas.map((d) => d.stamp), ['20261027090000', '20261027110000']);
  // Branch 2 already merged the 09:00 changes.
  assert.equal(byStore['2'].sendFull, false);
  assert.deepEqual(byStore['2'].deltas.map((d) => d.stamp), ['20261027110000']);
});

test("Victory: the newest Price file is a complete list and replaces the map like a PriceFull", () => {
  const fulls = [f('PriceFull7290696200003-001-001-20261027-051238.gz')];
  const changes = [f('Price7290696200003-001-001-20261027-060723.gz'), f('Price7290696200003-001-001-20261027-110917.gz')];
  const [plan] = planChain(fulls, changes, stamps({ '1': { file: '20261027051238', delta: null } }), { readAll: false, priceIsFull: true });
  assert.equal(plan.full.name, 'Price7290696200003-001-001-20261027-110917.gz');
  assert.equal(plan.sendFull, true);
  assert.deepEqual(plan.deltas, []);
  // Before 05:00 only yesterday's map exists and nothing is listed: nothing to do.
  assert.deepEqual(planChain([], [], stamps({}), { readAll: true, priceIsFull: true }), []);
});

test('merging change files stops at the first one that failed, so no change is skipped for good', () => {
  const [a, b, c] = ['090000', '100000', '110000'].map((t) => f(`Price7290027600007-001-001-20261027-${t}.gz`));
  assert.deepEqual(mergeDeltas([{ file: a, map: { '1111': 100, '2222': 200 } }, { file: b, map: { '1111': 150 } }]), {
    map: { '1111': 150, '2222': 200 }, stamp: '20261027100000', applied: 2,
  });
  assert.deepEqual(mergeDeltas([{ file: a, map: { '1111': 100 } }, { file: b, map: null }, { file: c, map: { '1111': 1 } }]), {
    map: { '1111': 100 }, stamp: '20261027090000', applied: 1,
  });
  assert.deepEqual(mergeDeltas([{ file: a, map: null }]), { map: {}, stamp: null, applied: 0 });
});

test('the price map keeps valid prices only, the last duplicate winning', () => {
  const xml = `<Items>
    <Item><ItemCode>7290004131074</ItemCode><ItemName>חלב</ItemName><ItemPrice>7.20</ItemPrice></Item>
    <Item><ItemCode>7290004131074</ItemCode><ItemName>חלב</ItemName><ItemPrice>7.30</ItemPrice></Item>
    <Item><ItemCode>7290000000001</ItemCode><ItemPrice>123456.00</ItemPrice></Item>
    <Item><ItemCode>12</ItemCode><ItemPrice>5</ItemPrice></Item>
    <Item><ItemCode>1234</ItemCode><ItemPrice>0.10</ItemPrice></Item>
  </Items>`;
  const seen: string[] = [];
  assert.deepEqual(priceMap(xml, (i) => seen.push(i.barcode)), { '7290004131074': 730, '1234': 10 });
  assert.deepEqual(seen, ['7290004131074', '7290004131074', '1234']);
});

test('a chain is down when its listing fails or more than 10% of its files fail', () => {
  assert.equal(chainStatus(true, 0, 0), 'down');
  assert.equal(chainStatus(false, 0, 0), 'ok');
  assert.equal(chainStatus(false, 13, 1), 'ok');
  assert.equal(chainStatus(false, 13, 2), 'down');
  assert.equal(chainStatus(false, 424, 42), 'ok');
  assert.equal(chainStatus(false, 424, 43), 'down');
});
