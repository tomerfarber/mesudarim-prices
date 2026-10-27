import type { Chain } from '../chains.ts';
import { type FileKind, type PublishedFile, parseName } from '../files.ts';
import { getBytes, getText } from '../http.ts';
import { mapLimit } from '../pool.ts';
import { listingCache, type Session } from './index.ts';

/**
 * prices.shufersal.co.il: per file kind, pages of 20 rows (the newest file of
 * each branch), links to Azure blobs whose SAS signature expires ~30 minutes
 * after listing. A page takes ~20 s to render, so pages load in parallel.
 */
const CATEGORY: Record<FileKind, number> = { price: 1, pricefull: 2, promo: 3, promofull: 4, stores: 5 };
const BASE = 'https://prices.shufersal.co.il/FileObject/UpdateCategory';
const PAGES_AT_ONCE = 6;
const MAX_PAGES = 200;

export function shufersalLinks(html: string): PublishedFile[] {
  const files: PublishedFile[] = [];
  for (const m of html.matchAll(/href="(https:\/\/pricesprodpublic\.blob\.core\.windows\.net\/[^"]+)"/g)) {
    const url = m[1].replaceAll('&amp;', '&');
    const file = parseName(url, url);
    if (file) files.push(file);
  }
  return files;
}

/** The last page number in the pager (page=N links); 1 when there is no pager. */
export function shufersalPages(html: string): number {
  const pages = [...html.matchAll(/[?&](?:amp;)?page=(\d+)/g)].map((m) => Number(m[1]));
  return Math.min(MAX_PAGES, Math.max(1, ...pages));
}

export async function openShufersal(_chain: Chain): Promise<Session> {
  const list = listingCache(async (kind) => {
    const url = (page: number) => `${BASE}?catID=${CATEGORY[kind]}&storeId=0&page=${page}`;
    const first = await getText(url(1), { timeoutMs: 90_000 });
    const rest = Array.from({ length: shufersalPages(first) - 1 }, (_, i) => i + 2);
    const pages = await mapLimit(rest, PAGES_AT_ONCE, (page) => getText(url(page), { timeoutMs: 90_000 }));
    const byName = new Map<string, PublishedFile>();
    for (const html of [first, ...pages]) for (const f of shufersalLinks(html)) byName.set(f.name, f);
    return [...byName.values()].filter((f) => f.kind === kind);
  });
  return {
    list,
    fetch: (file) => getBytes(file.source),
    close: async () => {},
  };
}
