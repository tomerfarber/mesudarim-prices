import type { Chain } from '../chains.ts';
import type { FileKind, PublishedFile } from '../files.ts';
import { openBina } from './bina.ts';
import { openCerberus } from './cerberus.ts';
import { openHaziHinam } from './hazihinam.ts';
import { openLaib } from './laib.ts';
import { openPublishPrice } from './publishprice.ts';
import { openShufersal } from './shufersal.ts';

/**
 * One chain's file server for one run. `list` returns what is published now
 * (an engine may cache its listing for the run); `fetch` returns the raw
 * bytes. Opened once per chain, closed at the end (the FTP engines hold a
 * connection).
 */
export interface Session {
  list(kind: FileKind, store: string | null): Promise<PublishedFile[]>;
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
