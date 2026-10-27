import { RELAY_HOSTS } from './chains.ts';
import type { Relay } from './relay.ts';

/** fetch with a browser User-Agent (some chains refuse others), a timeout and a few retries. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** Thrown for a host that only answers Israeli addresses when no relay is configured. */
export class NeedsRelay extends Error {
  constructor(host: string) {
    super(`${host} answers only Israeli addresses and RELAY_URL is not set`);
    this.name = 'NeedsRelay';
  }
}

/** A non-2xx answer, kept apart from network errors so callers can tell them apart (P12). */
export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, url: string, body: string) {
    super(`${status} ${new URL(url).host}${new URL(url).pathname.slice(0, 80)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * How this process reaches the Israeli-only hosts: through the relay, or
 * directly when it runs in Israel (`--direct`, e.g. a local dry run).
 */
export const network: { relay: Relay | null; direct: boolean } = { relay: null, direct: false };

export interface GetOptions {
  timeoutMs?: number;
  tries?: number;
  /** Send this request through the Israeli relay. */
  viaRelay?: boolean;
  /** Statuses returned as a Response instead of thrown (e.g. laibcatalog's 400 for an unused chain code). */
  accept?: readonly number[];
}

export const canReach = (viaRelay: boolean) => !viaRelay || network.direct || network.relay !== null;

export async function get(url: string, { timeoutMs = 60_000, tries = 3, viaRelay = false, accept = [] }: GetOptions = {}): Promise<Response> {
  const host = new URL(url).host;
  const relayed = viaRelay && !network.direct;
  if (relayed) {
    if (!RELAY_HOSTS.includes(host)) throw new Error(`${host} is not on the relay's allow-list`);
    if (!network.relay) throw new NeedsRelay(host);
  }
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = relayed
        ? await network.relay!.fetch(url, signal)
        : await fetch(url, { headers: { 'user-agent': UA }, signal, redirect: 'follow' });
      if (res.ok || accept.includes(res.status)) return res;
      last = new HttpError(res.status, url, (await res.text().catch(() => '')).slice(0, 300));
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    if (attempt < tries) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw last;
}

export const getText = async (url: string, options?: GetOptions) => (await get(url, options)).text();
export const getJson = async <T>(url: string, options?: GetOptions) => (await get(url, options)).json() as Promise<T>;
export const getBytes = async (url: string, options?: GetOptions) =>
  Buffer.from(await (await get(url, { timeoutMs: 180_000, ...options })).arrayBuffer());
