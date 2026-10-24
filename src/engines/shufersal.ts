import type { Chain } from '../chains.ts';
import { type FileKind, type PublishedFile, parseName } from '../files.ts';
import { getBytes, getText } from '../http.ts';
import type { Session } from './index.ts';

/** prices.shufersal.co.il: one page per file kind and branch, links to Azure blobs. */
const CATEGORY: Record<FileKind, number> = { price: 1, pricefull: 2, promo: 3, promofull: 4, stores: 5 };

export async function openShufersal(_chain: Chain): Promise<Session> {
  return {
    async list(kind, store) {
      const html = await getText(`https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=${CATEGORY[kind]}&storeId=${store ?? 0}`);
      const files: PublishedFile[] = [];
      for (const m of html.matchAll(/href="(https:\/\/pricesprodpublic\.blob\.core\.windows\.net\/[^"]+)"/g)) {
        const url = m[1].replaceAll('&amp;', '&');
        const file = parseName(url, url);
        if (file) files.push(file);
      }
      return files;
    },
    fetch: (file) => getBytes(file.source),
    close: async () => {},
  };
}
