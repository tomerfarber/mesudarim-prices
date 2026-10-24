import type { Chain } from '../chains.ts';
import { type FileKind, type PublishedFile, parseName } from '../files.ts';
import { getBytes, getText } from '../http.ts';
import type { Session } from './index.ts';

/** shop.hazi-hinam.co.il/Prices: paged tables of links to Azure blobs, newest first. */
const TYPE: Record<FileKind, number> = { price: 1, pricefull: 1, promo: 2, promofull: 2, stores: 3 };
const MAX_PAGES = 40;

export async function openHaziHinam(_chain: Chain): Promise<Session> {
  const cache = new Map<number, PublishedFile[]>();
  return {
    async list(kind, store) {
      const type = TYPE[kind];
      if (!cache.has(type)) {
        const files: PublishedFile[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const html = await getText(`https://shop.hazi-hinam.co.il/Prices?t=${type}&f=null&p=${page}`);
          const found = [...html.matchAll(/href="(https:\/\/[^"]+\.blob\.core\.windows\.net\/[^"]+)"/g)].flatMap(
            (m) => parseName(m[1], m[1]) ?? [],
          );
          if (found.length === 0) break;
          files.push(...found);
        }
        cache.set(type, files);
      }
      return cache.get(type)!.filter((f) => f.kind === kind && (store === null || f.store === store));
    },
    fetch: (file) => getBytes(file.source),
    close: async () => {},
  };
}
