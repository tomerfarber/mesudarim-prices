import type { Chain } from '../chains.ts';
import { type PublishedFile, israelDate, parseName } from '../files.ts';
import { getBytes, getText } from '../http.ts';
import { listingCache, type Session } from './index.ts';

/**
 * prices.<infix>.co.il (Carrefour): the page embeds a day's folder
 * (`const path = 'YYYYMMDD'`) and its file list (`const files = [...]`);
 * `/?date=YYYYMMDD` shows another day. Today's folder fills up from 00:01, so
 * right after midnight most branches' newest PriceFull is still in
 * yesterday's folder: both days are listed, and the newest file per branch
 * wins.
 */
export function publishPriceFiles(base: string, html: string): PublishedFile[] {
  const path = /const path = ['"](\d{8})['"]/.exec(html)?.[1];
  const json = /const files = (\[[\s\S]*?\]);/.exec(html)?.[1];
  if (!path || !json) throw new Error(`${base}: the page has no file list`);
  return (JSON.parse(json) as { name: string }[]).flatMap((f) => parseName(f.name, `${base}/${path}/${f.name}`) ?? []);
}

export async function openPublishPrice(chain: Chain, engine: { infix: string }, now = () => new Date()): Promise<Session> {
  const base = `https://prices.${engine.infix}.co.il`;
  const viaRelay = chain.relay !== 'none';
  const listing = listingCache(async () => {
    const today = israelDate(now());
    const yesterday = israelDate(now(), 1);
    const [a, b] = await Promise.all([getText(`${base}/`, { viaRelay }), getText(`${base}/?date=${yesterday}`, { viaRelay })]);
    const files = [...publishPriceFiles(base, a), ...publishPriceFiles(base, b)];
    // The default page is today's; if the site ever serves another day there, both lists still merge correctly.
    return [...new Map(files.map((f) => [f.source, f])).values()].filter((f) => f.stamp.slice(0, 8) <= today);
  });
  return {
    list: async (kind) => (await listing('pricefull')).filter((f) => f.kind === kind),
    fetch: (file) => getBytes(file.source, { viaRelay: chain.relay === 'all' }),
    close: async () => {},
  };
}
