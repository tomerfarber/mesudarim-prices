import type { Chain } from '../chains.ts';
import { type PublishedFile, parseName } from '../files.ts';
import { HttpError, get, getBytes } from '../http.ts';
import { listingCache, type Session } from './index.ts';

/**
 * laibcatalog.co.il (Victory): its current publishing endpoint, the one
 * Victory's own transparency page (אתר שקיפות מחירים ויקטורי) and the
 * open-source israeli-supermarket-scarpers (VictoryNewSource) use:
 *   GET /webapi/api/getfiles?edi=<chain code>  -> [{ branchNumber, fileName, fileType, fileDate, fileSize }]
 *   GET /webapi/<chain code>/<fileName>       -> the file
 * It lists only today's files (no date parameter), so it is empty from
 * midnight until ~05:00 Israel time, and it answers only Israeli addresses
 * (from GitHub it goes through the relay). A chain code with no files answers
 * 400 "FilesRootPath is invalid" (7290058103393 today): that code is skipped.
 * Any other failure is an error, never an empty listing (P12).
 */
const BASE = 'https://laibcatalog.co.il/webapi';

interface Entry {
  fileName?: string;
}

export function laibFiles(code: string, entries: unknown): PublishedFile[] {
  if (!Array.isArray(entries)) throw new Error(`laibcatalog: unexpected listing for ${code}`);
  return (entries as Entry[]).flatMap((e) =>
    typeof e?.fileName === 'string' ? (parseName(e.fileName, `${BASE}/${code}/${encodeURIComponent(e.fileName)}`) ?? []) : [],
  );
}

export async function openLaib(chain: Chain): Promise<Session> {
  const viaRelay = chain.relay !== 'none';
  const listing = listingCache(async () => {
    const files: PublishedFile[] = [];
    for (const code of chain.codes) {
      const url = `${BASE}/api/getfiles?edi=${code}`;
      const res = await get(url, { viaRelay, accept: [400] });
      if (res.status === 400) {
        const body = await res.text();
        if (/FilesRootPath/i.test(body)) continue;
        throw new HttpError(400, url, body);
      }
      files.push(...laibFiles(code, await res.json()));
    }
    return files;
  });
  return {
    list: async (kind) => (await listing('pricefull')).filter((f) => f.kind === kind),
    fetch: (file) => getBytes(file.source, { viaRelay: chain.relay === 'all' }),
    close: async () => {},
  };
}
