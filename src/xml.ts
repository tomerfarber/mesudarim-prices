import { gunzipSync, inflateRawSync } from 'node:zlib';

/**
 * The published files are XML, gzipped or zipped whatever the name says,
 * UTF-8 with or without a BOM, or UTF-16 (some Stores files). The tags differ
 * in case between chains (ItemCode, ITEMCODE), so every field is read
 * lowercased. Files are at most ~12 MB unpacked: decoding the whole buffer is
 * simpler than streaming and well within a CI runner's memory.
 */
export function decode(raw: Buffer): string {
  let buf = raw;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  else if (buf[0] === 0x50 && buf[1] === 0x4b) buf = firstZipEntry(buf);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** The first file in a zip archive (local header; stored or deflated). */
function firstZipEntry(zip: Buffer): Buffer {
  const method = zip.readUInt16LE(8);
  const size = zip.readUInt32LE(18);
  const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const body = zip.subarray(start, size ? start + size : undefined);
  return method === 0 ? body : inflateRawSync(body);
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e.toLowerCase()],
  );

/** Every <tag>…</tag> block (any case) as a map of its simple child fields, lowercased. */
export function* records(xml: string, tags: readonly string[]): Generator<Map<string, string>> {
  const block = new RegExp(`<(${tags.join('|')})>([\\s\\S]*?)</\\1>`, 'gi');
  const field = /<([A-Za-z_][\w.]*)>([^<]*)<\/\1>|<([A-Za-z_][\w.]*)\s*\/>/g;
  for (const m of xml.matchAll(block)) {
    const fields = new Map<string, string>();
    for (const f of m[2].matchAll(field)) {
      if (f[1]) fields.set(f[1].toLowerCase(), unescape(f[2].trim()));
      else fields.set(f[3].toLowerCase(), '');
    }
    yield fields;
  }
}

export interface PriceItem {
  barcode: string;
  name: string;
  manufacturer: string;
  /** Pack size as published (e.g. 1, 250), with its unit (ליטר, גרם…); null when unknown. */
  quantity: number | null;
  unit: string;
  weighted: boolean;
  priceAgorot: number;
}

const toNumber = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Items of a PriceFull or Price file. Rows without a code or a positive price are skipped. */
export function* priceItems(xml: string): Generator<PriceItem> {
  for (const r of records(xml, ['Item', 'Product'])) {
    const barcode = (r.get('itemcode') ?? '').replace(/^0+(?=\d{8})/, '');
    const price = toNumber(r.get('itemprice'));
    if (!/^\d{4,14}$/.test(barcode) || price === null || price <= 0) continue;
    yield {
      barcode,
      name: r.get('itemname') ?? r.get('itemnm') ?? '',
      manufacturer: r.get('manufacturename') ?? r.get('manufacturername') ?? '',
      quantity: toNumber(r.get('quantity')),
      unit: r.get('unitqty') && r.get('unitqty') !== 'לא ידוע' ? r.get('unitqty')! : (r.get('unitofmeasure') ?? ''),
      weighted: r.get('bisweighted') === '1',
      priceAgorot: Math.round(price * 100),
    };
  }
}

export interface Branch {
  store: string;
  name: string;
  address: string;
  city: string;
}

/** Branches of a Stores file. */
export function* branches(xml: string): Generator<Branch> {
  for (const r of records(xml, ['Store', 'Branch'])) {
    const id = r.get('storeid') ?? r.get('storeno') ?? '';
    if (!/^\d+$/.test(id)) continue;
    yield { store: String(Number(id)), name: r.get('storename') ?? '', address: r.get('address') ?? '', city: r.get('city') ?? '' };
  }
}
