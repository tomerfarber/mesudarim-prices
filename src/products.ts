import type { PriceItem } from './xml.ts';

/**
 * The product catalog of the daily run: one row per barcode, the same whatever
 * order the chains finish in.
 *
 * Most chains cut ItemName to a fixed width: 20 characters at Rami Levy,
 * Yohananof, Osher Ad, Carrefour and Super Yuda, 24 at Shufersal; Tiv Taam
 * (up to 49), King Store and Hazi Hinam (up to ~70) publish longer names
 * (measured 2026-10-27). The width is found from each chain's own names in
 * the run (`cutWidth`), not kept here. When the first chain to finish named a
 * product, 26,000 names were cut to 20 characters and different products got
 * the same name (four Feldman ice-pop packs all became 'מאגדת שלגוני פלדמן 9').
 * So a product's name is chosen from every chain that sells it, by `betterName`:
 *
 * 1. a name with Hebrew letters (Yohananof sometimes publishes 'CRUNCH');
 * 2. the longer name, where a name that may be cut counts as CUT_PENALTY
 *    characters shorter, so a whole 'פאנטה אורנג 1.5 ליטר' wins over a cut
 *    "משקה מוגז אורנג' פאנ" of the same length;
 * 3. on a tie, the chain earlier in CHAINS, ItemName before the description,
 *    then the text itself.
 *
 * Each chain offers its ItemName and its ManufacturerItemDescription when that
 * differs (Yohananof's ItemName is sometimes only the brand, 'עלית', with the
 * product in the description). The other fields come from the chain earliest
 * in CHAINS (Shufersal first, as in the weekly catalog before 0072), the
 * manufacturer from the earliest chain that knows it, '' when none does (the
 * chains write 'לא ידוע', 'כללי', 'שונות' or '---', and the apps show any
 * manufacturer that is not empty).
 */

/** A name that may be cut counts as this many characters shorter. */
export const CUT_PENALTY = 4;
/** A chain cuts a field at the length most of its names have exactly, when this share of them has it... */
const CUT_SHARE = 0.25;
/** ...and at most this share is longer. Fewer names than CUT_MIN_NAMES tell nothing. */
const LONGER_SHARE = 0.05;
const CUT_MIN_NAMES = 100;

export interface NameCandidate {
  text: string;
  /** As long as the chain's cut width or longer: the end may be missing. */
  cut: boolean;
  /** The chain's place in CHAINS. */
  rank: number;
  /** 0: ItemName, 1: ManufacturerItemDescription. */
  field: 0 | 1;
}

export interface ProductSeen {
  /** Quantity, unit and weighted, from the chain earliest in CHAINS. */
  item: PriceItem;
  rank: number;
  name: NameCandidate;
  /** From the chain earliest in CHAINS that knows it; '' when no chain does. */
  manufacturer: { text: string; known: boolean; rank: number };
  chains: Set<string>;
}

const length = (s: string) => [...s].length;
const HEBREW = /[א-ת]/;
const PROMO = /^\*\s*מבצע\s*\*\s*/;
const PLACEHOLDER_MAKER = new Set(['לא ידוע', 'כללי', 'שונות']);
/** A manufacturer with letters that is not a placeholder. */
const knownMaker = (text: string) => /\p{L}/u.test(text) && !PLACEHOLDER_MAKER.has(text.trim());

/** Spaces collapsed, and Yohananof's '*מבצע*' (on sale) marker dropped: it is not part of the product's name. */
export function cleanName(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.replace(PROMO, '') || text;
}

/**
 * The width a chain cuts a field at, from the lengths of all its names in this
 * run: the most common length, when CUT_SHARE of the names have exactly it
 * and at most LONGER_SHARE are longer. null when the chain does not cut.
 */
export function cutWidth(lengths: Iterable<number>): number | null {
  const counts = new Map<number, number>();
  let total = 0;
  for (const n of lengths) {
    counts.set(n, (counts.get(n) ?? 0) + 1);
    total++;
  }
  if (total < CUT_MIN_NAMES) return null;
  let mode = 0;
  for (const [n, c] of counts) if (c > (counts.get(mode) ?? 0) || (c === counts.get(mode) && n > mode)) mode = n;
  let longer = 0;
  for (const [n, c] of counts) if (n > mode) longer += c;
  return counts.get(mode)! >= total * CUT_SHARE && longer <= total * LONGER_SHARE ? mode : null;
}

const score = (c: NameCandidate) => length(c.text) - (c.cut ? CUT_PENALTY : 0);

/** The better of two names for one product (see the top of this file). Symmetric, so the order chains finish in does not matter. */
export function betterName(a: NameCandidate, b: NameCandidate): NameCandidate {
  const hebrew = Number(HEBREW.test(b.text)) - Number(HEBREW.test(a.text));
  if (hebrew !== 0) return hebrew > 0 ? b : a;
  const longer = score(b) - score(a);
  if (longer !== 0) return longer > 0 ? b : a;
  if (a.rank !== b.rank) return a.rank < b.rank ? a : b;
  if (a.field !== b.field) return a.field < b.field ? a : b;
  return a.text <= b.text ? a : b;
}

/**
 * Within one chain, the sighting kept when branches name a barcode differently:
 * the longer ItemName, then the longer description, then the text, so the
 * order its branches finish in does not matter either.
 */
export function betterSighting(a: PriceItem, b: PriceItem): PriceItem {
  if (a.name === b.name && a.description === b.description) return a;
  const d = length(b.name) - length(a.name) || length(b.description) - length(a.description);
  if (d !== 0) return d > 0 ? b : a;
  return `${a.name}\u0000${a.description}` <= `${b.name}\u0000${b.description}` ? a : b;
}

/** Adds one chain's products (barcode -> its item) to the catalog, once the chain is known to be ok. */
export function addChain(catalog: Map<string, ProductSeen>, chainId: string, rank: number, seen: ReadonlyMap<string, PriceItem>): void {
  const items = [...seen.values()];
  const nameWidth = cutWidth(items.map((i) => length(i.name)));
  const descriptionWidth = cutWidth(items.filter((i) => i.description).map((i) => length(i.description)));
  const isCut = (raw: string, width: number | null) => width !== null && length(raw) >= width;

  for (const [barcode, item] of seen) {
    let name: NameCandidate = { text: cleanName(item.name), cut: isCut(item.name, nameWidth), rank, field: 0 };
    const description = cleanName(item.description);
    if (description && description !== name.text) {
      name = betterName(name, { text: description, cut: isCut(item.description, descriptionWidth), rank, field: 1 });
    }
    const makerKnown = knownMaker(item.manufacturer);
    const maker = { text: makerKnown ? item.manufacturer : '', known: makerKnown, rank };
    const known = catalog.get(barcode);
    if (!known) {
      catalog.set(barcode, { item, rank, name, manufacturer: maker, chains: new Set([chainId]) });
      continue;
    }
    known.chains.add(chainId);
    known.name = betterName(known.name, name);
    if (rank < known.rank) {
      known.item = item;
      known.rank = rank;
    }
    const m = known.manufacturer;
    if (maker.known !== m.known ? maker.known : rank < m.rank) known.manufacturer = maker;
  }
}

/** The product rows for ingest_products: per barcode, the chains (that were ok in this run) selling it. */
export function productRows(catalog: Map<string, ProductSeen>) {
  return [...catalog].map(([barcode, { item, name, manufacturer, chains }]) => ({
    barcode,
    name: name.text.slice(0, 200),
    manufacturer: manufacturer.text.slice(0, 120),
    quantity: item.quantity,
    unit: item.unit.slice(0, 30),
    weighted: item.weighted,
    chains: chains.size,
    chain_ids: [...chains].sort(),
  }));
}
