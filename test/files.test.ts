import assert from 'node:assert/strict';
import { test } from 'node:test';
import { israelDate, israelHour, newest, newestByStore, parseName } from '../src/files.ts';

test('parses every chain naming style', () => {
  assert.deepEqual(parseName('PriceFull7290027600007-007-444-20261024-030840.gz', 's'), {
    name: 'PriceFull7290027600007-007-444-20261024-030840.gz', kind: 'pricefull', chainCode: '7290027600007', store: '444', stamp: '20261024030840', source: 's',
  });
  assert.equal(parseName('PriceFull7290058108879-000-340-20261024-040513.GZ', 's')?.store, '340');
  assert.equal(parseName('https://x.blob.core.windows.net/p/PriceFull7290700100008-000-219-20261024-1320.gz?sv=1', 's')?.stamp, '20261024132000');
  const stores = parseName('Stores7290696200003-000-20261024060100-060100.gz', 's');
  assert.equal(stores?.kind, 'stores');
  assert.equal(stores?.stamp, '20261024060100');
  assert.equal(parseName('StoresFull7290700100008-000-20261024-005310.gz', 's')?.kind, 'stores');
  assert.equal(parseName('Promo7290696200003-001-069-20261024-140753.gz', 's')?.kind, 'promo');
  assert.equal(parseName('Price7290696200003-001-001-20261027-110917.gz', 's')?.kind, 'price');
  assert.equal(parseName('readme.txt', 's'), null);
});

test('newest picks the latest file of a kind for a branch', () => {
  const files = ['PriceFull7290058140886-001-711-20261024-001001.gz', 'PriceFull7290058140886-001-711-20261024-120005.gz', 'PriceFull7290058140886-001-712-20261024-200000.gz', 'Price7290058140886-001-711-20261024-230000.gz'].map((n) => parseName(n, n)!);
  assert.equal(newest(files, 'pricefull', '711')?.stamp, '20261024120005');
  assert.equal(newest(files, 'pricefull', '9'), null);
  const byStore = newestByStore(files.filter((f) => f.kind === 'pricefull'));
  assert.deepEqual([...byStore].map(([s, f]) => [s, f.stamp]), [['711', '20261024120005'], ['712', '20261024200000']]);
});

test('dates and hours are Israel time, including yesterday across a month', () => {
  assert.equal(israelDate(new Date('2026-10-24T22:30:00Z')), '20261025');
  assert.equal(israelDate(new Date('2026-10-24T22:30:00Z'), 1), '20261024');
  assert.equal(israelDate(new Date('2026-11-01T00:30:00Z'), 1), '20261031');
  assert.equal(israelDate(new Date('2027-01-01T03:00:00Z'), 1), '20261231');
  // 02:30 UTC is 04:30 in winter (UTC+2) and 05:30 in summer (UTC+3).
  assert.equal(israelHour(new Date('2026-10-27T02:30:00Z')), 4);
  assert.equal(israelHour(new Date('2026-07-01T02:30:00Z')), 5);
  assert.equal(israelHour(new Date('2026-10-26T22:10:00Z')), 0);
});
