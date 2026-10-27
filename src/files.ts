/**
 * Names of the published files: <Kind><chain code>-<sub-chain>-<store>-<YYYYMMDD>-<HHMMSS>.gz,
 * Stores files without the store part. One parser for every engine, so each
 * engine only lists names and fetches bytes.
 */
export type FileKind = 'pricefull' | 'price' | 'promofull' | 'promo' | 'stores';

export interface PublishedFile {
  name: string;
  kind: FileKind;
  chainCode: string;
  /** The branch number without leading zeros; null for Stores files. */
  store: string | null;
  /** YYYYMMDDHHMMSS, comparable as text. */
  stamp: string;
  /** Where the engine fetches it from (a URL or an FTP path). */
  source: string;
}

const HEAD = /^(pricefull|price|promofull|promo|stores?(?:full)?)(\d{13})$/i;

export function parseName(name: string, source: string): PublishedFile | null {
  const base = name.split('/').pop()!.split('?')[0];
  const parts = base.replace(/(\.(gz|xml|zip))+$/i, '').split('-');
  const head = HEAD.exec(parts[0]);
  if (!head) return null;
  const kindText = head[1].toLowerCase();
  const kind: FileKind = kindText.startsWith('store') ? 'stores' : (kindText as FileKind);
  // PriceFull<code>-<sub>-<store>-<date>-<time>; Stores<code>-<sub>-<date>-<time>
  const [store, stamped, time] = kind === 'stores' ? [null, parts[2], parts[3]] : [String(Number(parts[2])), parts[3], parts[4]];
  // The date is YYYYMMDD, or YYYYMMDDHHMMSS with the time joined to it (Victory's Stores files).
  if (!stamped || !/^\d{8}(\d{6})?$/.test(stamped) || store === 'NaN') return null;
  const date = stamped.slice(0, 8);
  const hhmmss = (stamped.slice(8) || (time ?? '')).replace(/\D/g, '').padEnd(6, '0').slice(0, 6);
  return { name: base, kind, chainCode: head[2], store, stamp: date + hhmmss, source };
}

/** The newest file of a kind for one branch (or the newest Stores file). */
export function newest(files: readonly PublishedFile[], kind: FileKind, store: string | null): PublishedFile | null {
  let best: PublishedFile | null = null;
  for (const f of files) {
    if (f.kind !== kind || (store !== null && f.store !== store)) continue;
    if (!best || f.stamp > best.stamp) best = f;
  }
  return best;
}

/** The newest file of each branch, among files of one kind. */
export function newestByStore(files: readonly PublishedFile[]): Map<string, PublishedFile> {
  const best = new Map<string, PublishedFile>();
  for (const f of files) {
    if (f.store === null) continue;
    const known = best.get(f.store);
    if (!known || f.stamp > known.stamp) best.set(f.store, f);
  }
  return best;
}

const israelParts = (at: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );

/** A day in Israel as YYYYMMDD (the chains name files by Israel time): today, or `daysAgo` days earlier. */
export function israelDate(at = new Date(), daysAgo = 0): string {
  const p = israelParts(at);
  if (daysAgo === 0) return `${p.year}${p.month}${p.day}`;
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - daysAgo));
  return day.toISOString().slice(0, 10).replaceAll('-', '');
}

/** The hour of the day in Israel, 0-23. */
export const israelHour = (at = new Date()): number => Number(israelParts(at).hour);
