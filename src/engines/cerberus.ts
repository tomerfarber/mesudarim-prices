import { Writable } from 'node:stream';
import { Client } from 'basic-ftp';
import type { Chain } from '../chains.ts';
import { type PublishedFile, parseName } from '../files.ts';
import type { Session } from './index.ts';

/**
 * url.retail.publishedprices.co.il (Cerberus): FTP over TLS with the chain's
 * public login. A directory holds a few days of every branch's files, so it is
 * listed once per run and filtered here.
 */
export async function openCerberus(chain: Chain, engine: { user: string; password?: string; path?: string }): Promise<Session> {
  const client = new Client(120_000);
  await client.access({
    host: 'url.retail.publishedprices.co.il',
    user: engine.user,
    password: engine.password ?? '',
    secure: true,
    secureOptions: { rejectUnauthorized: false },
  });
  if (engine.path) await client.cd(engine.path);
  let listing: PublishedFile[] | null = null;
  // basic-ftp runs one command at a time; chain the calls.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    async list(kind, store) {
      listing ??= await serial(async () =>
        (await client.list()).flatMap((f) => parseName(f.name, f.name) ?? []).filter((f) => chain.codes.includes(f.chainCode)),
      );
      return listing.filter((f) => f.kind === kind && (store === null || f.store === store));
    },
    fetch: (file) =>
      serial(async () => {
        const chunks: Buffer[] = [];
        const sink = new Writable({
          write(chunk, _enc, done) {
            chunks.push(chunk);
            done();
          },
        });
        await client.downloadTo(sink, file.source);
        return Buffer.concat(chunks);
      }),
    close: async () => client.close(),
  };
}
