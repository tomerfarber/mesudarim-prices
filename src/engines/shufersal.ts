import type { Chain } from '../chains.ts';
import { type FileKind, type PublishedFile, parseName } from '../files.ts';
import { HttpError, getBytes, getText } from '../http.ts';
import { mapLimit } from '../pool.ts';
import { listingCache, type Session } from './index.ts';

/**
 * prices.shufersal.co.il: per file kind, pages of 20 rows (the newest file of
 * each branch), links to Azure blobs whose SAS signature expires ~30 minutes
 * after listing (`se=` in the link). A page takes ~20 s to render, so pages
 * load in parallel.
 *
 * A run lists first and downloads after, and a slow server can push a
 * download past its link's expiry. So a link that has expired (or is about
 * to), or that Azure refuses with 403, is fetched again from a fresh listing
 * of its kind; one fresh listing serves every file that needs it.
 */
const CATEGORY: Record<FileKind, number> = { price: 1, pricefull: 2, promo: 3, promofull: 4, stores: 5 };
const BASE = 'https://prices.shufersal.co.il/FileObject/UpdateCategory';
const PAGES_AT_ONCE = 6;
const MAX_PAGES = 200;
/** A link with less time than this left is renewed before it is used. */
const MARGIN_MS = 2 * 60_000;

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

/** When a SAS link stops working (its `se` parameter); null when it does not say. */
export function linkExpiry(source: string): number | null {
  const se = new URL(source).searchParams.get('se');
  const at = se ? Date.parse(se) : NaN;
  return Number.isFinite(at) ? at : null;
}

export async function openShufersal(_chain: Chain, now = () => Date.now()): Promise<Session> {
  const load = async (kind: FileKind) => {
    const url = (page: number) => `${BASE}?catID=${CATEGORY[kind]}&storeId=0&page=${page}`;
    const first = await getText(url(1), { timeoutMs: 90_000 });
    const rest = Array.from({ length: shufersalPages(first) - 1 }, (_, i) => i + 2);
    const pages = await mapLimit(rest, PAGES_AT_ONCE, (page) => getText(url(page), { timeoutMs: 90_000 }));
    const byName = new Map<string, PublishedFile>();
    for (const html of [first, ...pages]) for (const f of shufersalLinks(html)) byName.set(f.name, f);
    return [...byName.values()].filter((f) => f.kind === kind);
  };
  const list = listingCache(load);

  // The newest fresh listing of each kind, shared by every file that needs a new link.
  const fresh = new Map<FileKind, Promise<Map<string, string>>>();
  const expired = (source: string) => {
    const at = linkExpiry(source);
    return at !== null && at - now() < MARGIN_MS;
  };
  const relist = (kind: FileKind) => {
    const pending = load(kind).then((files) => new Map(files.map((f) => [f.name, f.source])));
    fresh.set(kind, pending);
    pending.catch(() => fresh.delete(kind));
    return pending;
  };
  /** A working link for `file`; `refused` is a link Azure just refused. */
  const renewed = async (file: PublishedFile, refused: string | null): Promise<string> => {
    let pending = fresh.get(file.kind) ?? relist(file.kind);
    let source = (await pending).get(file.name);
    // That fresh listing is old by now, or gave the same refused link: list once more. Files that
    // find the same old listing at the same time share the newer one.
    if (source && (expired(source) || source === refused)) {
      pending = fresh.get(file.kind) === pending ? relist(file.kind) : (fresh.get(file.kind) ?? relist(file.kind));
      source = (await pending).get(file.name);
    }
    if (!source) throw new Error(`${file.name} is no longer listed (a newer file replaced it)`);
    return source;
  };

  return {
    list,
    async fetch(file) {
      const source = expired(file.source) ? await renewed(file, null) : file.source;
      try {
        return await getBytes(source);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 403)) throw e;
        return getBytes(await renewed(file, source));
      }
    },
    close: async () => {},
  };
}
