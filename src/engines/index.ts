import type { Chain } from '../chains.ts';
import type { FileKind, PublishedFile } from '../files.ts';
import { openBina } from './bina.ts';
import { openCerberus } from './cerberus.ts';
import { openHaziHinam } from './hazihinam.ts';
import { openLaib } from './laib.ts';
import { openPublishPrice } from './publishprice.ts';
import { openShufersal } from './shufersal.ts';

/**
 * One chain's file server for one run. `list` returns every file of a kind
 * that is published now, for all branches (engines cache it for the run);
 * `fetch` returns the raw bytes. A listing that fails throws: it is never
 * turned into an empty list (P12). Opened once per chain, closed at the end
 * (the FTP engine holds connections).
 */
export interface Session {
  list(kind: FileKind): Promise<PublishedFile[]>;
  fetch(file: PublishedFile): Promise<Buffer>;
  close(): Promise<void>;
}

export function open(chain: Chain): Promise<Session> {
  switch (chain.engine.kind) {
    case 'shufersal':
      return openShufersal(chain);
    case 'cerberus':
      return openCerberus(chain, chain.engine);
    case 'laib':
      return openLaib(chain);
    case 'bina':
      return openBina(chain, chain.engine);
    case 'publishprice':
      return openPublishPrice(chain, chain.engine);
    case 'hazihinam':
      return openHaziHinam(chain);
  }
}

/** Caches one listing per kind for the session; a failed listing is cached too, so it is not retried per branch (P52). */
export function listingCache(load: (kind: FileKind) => Promise<PublishedFile[]>): (kind: FileKind) => Promise<PublishedFile[]> {
  const cache = new Map<FileKind, Promise<PublishedFile[]>>();
  return (kind) => {
    let pending = cache.get(kind);
    if (!pending) {
      pending = load(kind);
      cache.set(kind, pending);
    }
    return pending;
  };
}
