import type { Chain } from '../chains.ts';
import { type FileKind, type PublishedFile, parseName } from '../files.ts';
import { getBytes, getJson } from '../http.ts';
import { listingCache, type Session } from './index.ts';

/**
 * <prefix>.binaprojects.com (King Store): a JSON listing per kind (the newest
 * 1000 files, which covers a few days of every branch); a download is
 * Download.aspx -> [{ SPath }] -> the file.
 */
const TYPE: Record<FileKind, number> = { stores: 1, price: 2, promo: 3, pricefull: 4, promofull: 5 };

export function binaFiles(rows: unknown): PublishedFile[] {
  if (!Array.isArray(rows)) throw new Error('binaprojects: unexpected listing');
  return (rows as { FileNm?: string }[]).flatMap((r) => (typeof r?.FileNm === 'string' ? (parseName(r.FileNm, r.FileNm) ?? []) : []));
}

export async function openBina(chain: Chain, engine: { prefix: string }): Promise<Session> {
  const base = `https://${engine.prefix}.binaprojects.com`;
  const list = listingCache(async (kind) => {
    const files: PublishedFile[] = [];
    for (const code of chain.codes) {
      files.push(...binaFiles(await getJson(`${base}/MainIO_Hok.aspx?_=${code}&WFileType=${TYPE[kind]}&WStore=&WDate=`)));
    }
    return files.filter((f) => f.kind === kind);
  });
  return {
    list,
    async fetch(file) {
      const [first] = await getJson<{ SPath: string }[]>(`${base}/Download.aspx?FileNm=${encodeURIComponent(file.source)}`);
      if (!first?.SPath) throw new Error(`binaprojects: no download link for ${file.name}`);
      return getBytes(first.SPath);
    },
    close: async () => {},
  };
}
