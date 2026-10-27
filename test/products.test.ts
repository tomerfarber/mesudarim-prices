import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAINS } from '../src/chains.ts';
import { type NameCandidate, type ProductSeen, addChain, betterName, betterSighting, cleanName, cutWidth, productRows } from '../src/products.ts';
import type { PriceItem } from '../src/xml.ts';

/**
 * The product names of the daily run. On 2026-10-27 the first full run named
 * every product after the chain that finished first (Osher Ad, King Store,
 * Super Yuda), which cut names at 20 characters: four different Feldman
 * ice-pop packs all became 'מאגדת שלגוני פלדמן 9', and 'במבה 80 גרם אסם'
 * became 'במבה 80 גרם'. The names below are those chains' real ItemNames.
 */

const item = (barcode: string, name: string, extra: Partial<PriceItem> = {}): PriceItem => ({
  barcode,
  name,
  description: '',
  manufacturer: '',
  quantity: null,
  unit: '',
  weighted: false,
  priceAgorot: 100,
  ...extra,
});

/** A chain's other products, as many as a real file has: `width` characters long when the chain cuts there, varied otherwise. */
function others(prefix: string, width: number | null, n = 150): [string, PriceItem][] {
  return Array.from({ length: n }, (_, i) => {
    const barcode = `${prefix}${String(i).padStart(13 - prefix.length, '0')}`;
    const base = `מוצר ${i} `;
    const length = width ?? 10 + (i % 40);
    return [barcode, item(barcode, base.padEnd(length, 'א'))];
  });
}

const rank = (id: string) => CHAINS.findIndex((c) => c.id === id);
const FELDMAN = ['7290101114338', '7290101114345', '7290101114352', '7290101114598'];
const BAMBA = '7290000066318';

/** What each chain published on 2026-10-27 for the ice-pop packs and Bamba (Osher Ad and Carrefour cut at 20, Shufersal at 24). */
const chains: Record<string, Map<string, PriceItem>> = {
  osher_ad: new Map([
    ...others('11', 20),
    [FELDMAN[0], item(FELDMAN[0], 'מאגדת שלגוני פלדמן 9')],
    [FELDMAN[1], item(FELDMAN[1], 'מאגדת שלגוני פלדמן 9')],
    [FELDMAN[2], item(FELDMAN[2], 'מאגדת שלגוני פלדמן 9')],
    [FELDMAN[3], item(FELDMAN[3], 'מאגדת שלגוני פלדמן 9')],
    [BAMBA, item(BAMBA, 'במבה 80 גרם', { manufacturer: 'לא ידוע' })],
  ]),
  shufersal: new Map([
    ...others('22', 24),
    [FELDMAN[0], item(FELDMAN[0], 'חמישיה שלגון ונילש.פיסטו')],
    [FELDMAN[1], item(FELDMAN[1], 'חמישיה שלגון וניל ש.מריר')],
    [FELDMAN[3], item(FELDMAN[3], 'חמישיה99קל.קרם לימון200ג')],
    [BAMBA, item(BAMBA, 'במבה 80 גרם אסם', { manufacturer: 'אסם', quantity: 80, unit: 'גרם' })],
  ]),
  tiv_taam: new Map([
    ...others('33', null),
    [FELDMAN[2], item(FELDMAN[2], 'מאגדת חמישיה שלגון וניל עם ש. בלונדי 99', { description: 'מאגדת חמישיה שלגון ו' })],
  ]),
  carrefour: new Map([...others('44', 20), [BAMBA, item(BAMBA, 'במבה קלאסי 80 גרם', { manufacturer: 'כללי' })]]),
};

const build = (order: string[]) => {
  const catalog = new Map<string, ProductSeen>();
  for (const id of order) addChain(catalog, id, rank(id), chains[id]);
  return new Map(productRows(catalog).map((r) => [r.barcode, r]));
};

test('names do not depend on which chain finishes first, and a name cut at 20 characters loses (the 2026-10-27 run)', () => {
  const raceOrder = build(['osher_ad', 'carrefour', 'tiv_taam', 'shufersal']);
  for (const order of [CHAINS.map((c) => c.id).filter((id) => id in chains), ['shufersal', 'tiv_taam', 'carrefour', 'osher_ad']]) {
    assert.deepEqual(build(order), raceOrder);
  }
  const names = FELDMAN.map((code) => raceOrder.get(code)!.name);
  assert.deepEqual(names, [
    'חמישיה שלגון ונילש.פיסטו',
    'חמישיה שלגון וניל ש.מריר',
    'מאגדת חמישיה שלגון וניל עם ש. בלונדי 99',
    'חמישיה99קל.קרם לימון200ג',
  ]);
  assert.equal(new Set(names).size, 4);
  // A whole name (Carrefour's 17 characters are under its width of 20) beats the shorter ones.
  const bamba = raceOrder.get(BAMBA)!;
  assert.equal(bamba.name, 'במבה קלאסי 80 גרם');
  // The other fields come from the chain earliest in CHAINS (Shufersal), the manufacturer from the first that knows it.
  assert.deepEqual([bamba.manufacturer, bamba.quantity, bamba.unit, bamba.chains], ['אסם', 80, 'גרם', 3]);
});

test("a chain's cut width is found from its own names", () => {
  const lengths = (spec: [number, number][]) => spec.flatMap(([length, n]) => Array(n).fill(length));
  assert.equal(cutWidth(lengths([[20, 3571], [19, 1036], [18, 124], [15, 85]])), 20); // Rami Levy
  assert.equal(cutWidth(lengths([[24, 2694], [23, 1114], [22, 616], [20, 300]])), 24); // Shufersal
  assert.equal(cutWidth(lengths([[20, 6000], [19, 2091], [18, 523], [39, 1], [26, 1]])), 20); // Yohananof: a few longer names
  const spread: [number, number][] = Array.from({ length: 40 }, (_, i) => [10 + i, 400]);
  assert.equal(cutWidth(lengths([...spread, [40, 1556], [39, 1167], [20, 978], [32, 925], [38, 913]])), null); // Tiv Taam: whole names
  assert.equal(cutWidth(lengths([[20, 50]])), null); // too few to tell
});

test('a whole name beats a cut one of the same length; Hebrew beats Latin; ties go by chain order', () => {
  const c = (text: string, cut: boolean, chain: string, field: 0 | 1 = 0): NameCandidate => ({ text, cut, rank: rank(chain), field });
  const ramiCut = c("משקה מוגז אורנג' פאנ", true, 'rami_levy');
  const tivWhole = c('פאנטה אורנג 1.5 ליטר', false, 'tiv_taam');
  assert.equal(betterName(ramiCut, tivWhole), tivWhole);
  assert.equal(betterName(tivWhole, ramiCut), tivWhole);
  // A cut name still beats a much shorter whole one (a brand alone).
  const brand = c('מנטוס', false, 'yohananof');
  const cut = c('סוכריות מנטוס מנטה 4', true, 'osher_ad');
  assert.equal(betterName(brand, cut), cut);
  assert.equal(betterName(c('FINSH,IT,DEO LEMON*20 MON', false, 'rami_levy', 1), c('פיניש מפיץ ריח למדיח', true, 'rami_levy')).text, 'פיניש מפיץ ריח למדיח');
  const a = c('פאנטה אורנג 1.5 ליטר', false, 'osher_ad');
  assert.equal(betterName(a, tivWhole), a);
  assert.equal(betterName(tivWhole, a), a);
});

test("Yohananof's description is used where its ItemName is only the brand, without its '*מבצע*' marker", () => {
  const yohananof = new Map([
    ...others('55', 20),
    ['7290119381043', item('7290119381043', 'עלית', { description: 'תפוציפס פופס 50 גרם' })],
    ['7290018755877', item('7290018755877', 'מגנום', { description: '*מבצע* מיני מגנום קל' })],
    ['5900020047915', item('5900020047915', 'CRUNCH', { description: 'דגני קראנץ טריפל 375' })],
  ]);
  const catalog = new Map<string, ProductSeen>();
  addChain(catalog, 'yohananof', rank('yohananof'), yohananof);
  const name = (code: string) => catalog.get(code)!.name.text;
  assert.deepEqual(['7290119381043', '7290018755877', '5900020047915'].map(name), ['תפוציפס פופס 50 גרם', 'מיני מגנום קל', 'דגני קראנץ טריפל 375']);
  assert.equal(cleanName('  חלב   3%  1 ליטר '), 'חלב 3% 1 ליטר');
  assert.equal(cleanName('*מבצע*'), '*מבצע*');
});

test("within a chain, the branches' order does not change the name kept", () => {
  const a = item('7290000000001', 'חלב 3% 1 ל');
  const b = item('7290000000001', 'חלב 3% 1 ליטר');
  const c = item('7290000000001', 'חלב 3% 1 לטר');
  assert.equal(betterSighting(a, b), b);
  assert.equal(betterSighting(b, a), b);
  assert.equal(betterSighting(b, c), betterSighting(c, b));
});
