import type { Chain } from '../chains.ts';
import { type PublishedFile, parseName } from '../files.ts';
import { getBytes, getJson } from '../http.ts';
import type { Session } from './index.ts';

/** laibcatalog.co.il (Victory): one JSON listing per chain code; files before ~08:00 may be missing. */
interface Entry {
  fileName: string;
}

export async function openLaib(chain: Chain): Promise<Session> {
  let listing: PublishedFile[] | null = null;
  return {
    async list(kind, store) {
      if (!listing) {
        listing = [];
        for (const code of chain.codes) {
          // A chain may publish under a code the listing does not serve (400): skip it, keep the rest.
          const entries = await getJson<Entry[]>(`https://laibcatalog.co.il/webapi/api/getfiles?edi=${code}`).catch(() => [] as Entry[]);
          for (const e of entries) {
            const file = parseName(e.fileName, `https://laibcatalog.co.il/webapi/${code}/${e.fileName}`);
            if (file) listing.push(file);
          }
        }
      }
      return listing.filter((f) => f.kind === kind && (store === null || f.store === store));
    },
    fetch: (file) => getBytes(file.source),
    close: async () => {},
  };
}
