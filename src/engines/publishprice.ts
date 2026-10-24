import type { Chain } from '../chains.ts';
import { type PublishedFile, parseName } from '../files.ts';
import { getBytes, getText } from '../http.ts';
import type { Session } from './index.ts';

/** prices.<infix>.co.il (Carrefour): the page embeds today's folder and file list in a script. */
export async function openPublishPrice(_chain: Chain, engine: { infix: string }): Promise<Session> {
  const base = `https://prices.${engine.infix}.co.il`;
  let listing: PublishedFile[] | null = null;
  return {
    async list(kind, store) {
      if (!listing) {
        const html = await getText(`${base}/`);
        const path = /const path = ['"]([^'"]*)['"]/.exec(html)?.[1] ?? '';
        const json = /const files = (\[[\s\S]*?\]);/.exec(html)?.[1] ?? '[]';
        listing = (JSON.parse(json) as { name: string }[]).flatMap(
          (f) => parseName(f.name, path ? `${base}/${path}/${f.name}` : `${base}/${f.name}`) ?? [],
        );
      }
      return listing.filter((f) => f.kind === kind && (store === null || f.store === store));
    },
    fetch: (file) => getBytes(file.source),
    close: async () => {},
  };
}
