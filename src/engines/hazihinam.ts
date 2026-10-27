import type { Chain } from '../chains.ts';
import { type FileKind, type PublishedFile, israelDate, parseName } from '../files.ts';
import { getBytes, getText } from '../http.ts';
import { listingCache, type Session } from './index.ts';

/**
 * shop.hazi-hinam.co.il/Prices?d=YYYY-MM-DD&t=<1 prices|2 promos|3 stores>&p=<page>:
 * pages of 50 links to public Azure blobs, newest first, one day at a time.
 * The pages sit behind a Cloudflare check that lets only Israeli addresses
 * through (relay); the blobs on hazihinamprod01.blob.core.windows.net are
 * reachable from anywhere. Today and yesterday are listed, so a run after
 * midnight still finds every branch's newest PriceFull.
 */
const TYPE: Record<FileKind, number> = { price: 1, pricefull: 1, promo: 2, promofull: 2, stores: 3 };
const MAX_PAGES = 40;

export function haziLinks(html: string): PublishedFile[] {
  return [...html.matchAll(/href="(https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/[^"]+)"/g)].flatMap((m) => parseName(m[1], m[1]) ?? []);
}

const dashed = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

export async function openHaziHinam(chain: Chain, now = () => new Date()): Promise<Session> {
  const viaRelay = chain.relay !== 'none';
  const byType = new Map<number, Promise<PublishedFile[]>>();
  const loadType = async (type: number) => {
    const files: PublishedFile[] = [];
    for (const day of [israelDate(now()), israelDate(now(), 1)]) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const html = await getText(`https://shop.hazi-hinam.co.il/Prices?d=${dashed(day)}&t=${type}&f=null&p=${page}`, { viaRelay });
        if (!/<html/i.test(html)) throw new Error('shop.hazi-hinam.co.il: not a listing page');
        const found = haziLinks(html);
        if (found.length === 0) break;
        files.push(...found);
      }
    }
    return [...new Map(files.map((f) => [f.name, f])).values()];
  };
  const list = listingCache(async (kind) => {
    const type = TYPE[kind];
    if (!byType.has(type)) byType.set(type, loadType(type));
    return (await byType.get(type)!).filter((f) => f.kind === kind);
  });
  return {
    list,
    fetch: (file) => getBytes(file.source, { viaRelay: chain.relay === 'all' }),
    close: async () => {},
  };
}
