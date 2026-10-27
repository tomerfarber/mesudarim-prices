import { type PeerCertificate, checkServerIdentity } from 'node:tls';
import { Writable } from 'node:stream';
import { Client } from 'basic-ftp';
// Not re-exported by the package index; basic-ftp is pinned (package.json), so the path is stable.
import { enterPassiveModeIPv4_forceControlHostIP } from 'basic-ftp/dist/transfer.js';
import type { Chain } from '../chains.ts';
import { type PublishedFile, parseName } from '../files.ts';
import { limiter } from '../pool.ts';
import { listingCache, type Session } from './index.ts';

/**
 * url.retail.publishedprices.co.il (Cerberus): FTP over TLS with the chain's
 * public login. A directory holds ~3 days of every branch's files, so it is
 * listed once per run and filtered here.
 *
 * TLS is verified (P56): the chain of trust must reach a root CA, and the
 * certificate must be issued to publishedprices.co.il. The server presents
 * `*.publishedprices.co.il`, which by the wildcard rules does not cover the
 * two-label `url.retail.` host, so the identity check accepts that exact
 * domain instead of the host name; anything else is refused.
 *
 * EPSV data connections never open on this server (each attempt waits for the
 * timeout), so transfers go straight to PASV. The data connection must go to
 * the host of the verified control connection: a PASV answer that names
 * another host is refused (basic-ftp's safe default, which plain
 * enterPassiveModeIPv4 would turn off).
 */
export const passiveMode = enterPassiveModeIPv4_forceControlHostIP;

export const HOST = 'url.retail.publishedprices.co.il';
const DOMAIN = 'publishedprices.co.il';

export function publishedPricesIdentity(host: string, cert: PeerCertificate): Error | undefined {
  if (!checkServerIdentity(host, cert)) return undefined;
  const names = (cert.subjectaltname ?? '').split(/,\s*/);
  if (host.endsWith(`.${DOMAIN}`) && (names.includes(`DNS:*.${DOMAIN}`) || names.includes(`DNS:${DOMAIN}`))) return undefined;
  return new Error(`the FTP server's certificate is not for ${DOMAIN}: ${cert.subjectaltname ?? '(no names)'}`);
}

export async function openCerberus(chain: Chain, engine: { user: string; password?: string; path?: string }): Promise<Session> {
  const connect = async () => {
    const client = new Client(120_000);
    client.prepareTransfer = passiveMode;
    await client.access({
      host: HOST,
      user: engine.user,
      password: engine.password ?? '',
      secure: true,
      secureOptions: { servername: HOST, rejectUnauthorized: true, checkServerIdentity: publishedPricesIdentity },
    });
    if (engine.path) await client.cd(engine.path);
    return client;
  };
  // A few connections, each used by one transfer at a time (basic-ftp runs one command at a time).
  const idle: Client[] = [];
  const all = new Set<Client>();
  const slot = limiter(Math.max(1, chain.concurrency));
  const withClient = <T>(task: (c: Client) => Promise<T>): Promise<T> =>
    slot(async () => {
      const client = idle.pop() ?? (await connect());
      all.add(client);
      try {
        const result = await task(client);
        idle.push(client);
        return result;
      } catch (e) {
        // The connection may be half-way through a transfer: drop it, the next task opens a new one.
        client.close();
        all.delete(client);
        throw e;
      }
    });

  // The first connection proves the login before anything is listed.
  idle.push(await connect());
  all.add(idle[0]);

  const listing = listingCache(async () =>
    withClient(async (c) => (await c.list()).flatMap((f) => parseName(f.name, f.name) ?? []).filter((f) => chain.codes.includes(f.chainCode))),
  );
  const download = (file: PublishedFile) =>
    withClient(async (c) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, done) {
          chunks.push(chunk);
          done();
        },
      });
      await c.downloadTo(sink, file.source);
      return Buffer.concat(chunks);
    });

  return {
    list: async (kind) => (await listing('pricefull')).filter((f) => f.kind === kind),
    // One retry on a fresh connection: a dropped data connection is the common failure.
    fetch: (file) => download(file).catch(() => download(file)),
    close: async () => {
      for (const c of all) c.close();
    },
  };
}
