import type { Chain } from '../chains.ts';
import { type FileKind, type PublishedFile, parseName } from '../files.ts';
import { getBytes, getJson } from '../http.ts';
import type { Session } from './index.ts';

/** <prefix>.binaprojects.com (King Store): JSON listing per kind and branch; downloads go through Download.aspx. */
const TYPE: Record<FileKind, number> = { stores: 1, price: 2, promo: 3, pricefull: 4, promofull: 5 };

export async function openBina(chain: Chain, engine: { prefix: string }): Promise<Session> {
  const base = `https://${engine.prefix}.binaprojects.com`;
  return {
    async list(kind, store) {
      const files: PublishedFile[] = [];
      for (const code of chain.codes) {
        const rows = await getJson<{ FileNm: string }[]>(
          `${base}/MainIO_Hok.aspx?_=${code}&WFileType=${TYPE[kind]}&WStore=${store ?? ''}&WDate=`,
        );
        for (const r of rows) {
          const file = parseName(r.FileNm, r.FileNm);
          if (file && (store === null || file.store === store)) files.push(file);
        }
      }
      return files;
    },
    async fetch(file) {
      const [first] = await getJson<{ SPath: string }[]>(`${base}/Download.aspx?FileNm=${encodeURIComponent(file.source)}`);
      return getBytes(first.SPath);
    },
    close: async () => {},
  };
}
