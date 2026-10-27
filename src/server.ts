import { limiter } from './pool.ts';

/**
 * The Mesudarim server, through its ingest RPCs (docs/PRICES-CONTRACT.md in
 * the app's repository): the anon key plus PRICES_TOKEN, which the RPCs check
 * against app_settings. No service key is needed or kept here. Each call runs
 * under the anon role's 3 s statement timeout, so every payload is one
 * branch's map (≈ 0.1-0.5 MB) or a batch of 1,000 products (≈ 270 KB).
 *
 * In a dry run (`--dry`) nothing is sent: every call is recorded with its
 * size instead, and the answers are empty.
 */
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export interface DryCall {
  fn: string;
  bytes: number;
}

export const server: { dry: boolean; calls: DryCall[] } = { dry: false, calls: [] };

/** At most 4 calls at once: the free-tier database is shared with the app. */
const slot = limiter(4);

export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (server.dry) {
    const bytes = Buffer.byteLength(JSON.stringify(args));
    server.calls.push({ fn, bytes });
    return null as T;
  }
  const body = JSON.stringify({ p_token: env('PRICES_TOKEN'), ...args });
  const key = env('SUPABASE_ANON_KEY');
  const url = `${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`;
  return slot(async () => {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        // A void RPC answers with an empty body.
        if (res.ok) return (text ? JSON.parse(text) : null) as T;
        last = new Error(`${fn}: ${res.status} ${text.slice(0, 200)}`);
        // The ingest RPCs ignore an older or equal stamp, so repeating a call is safe; a 4xx will not change.
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) {
        last = e;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    throw last;
  });
}

/**
 * Sends rows in batches, so one request never carries more than `size` rows.
 * A batch that fails (after rpc's retries) does not stop the others; when any
 * failed, it throws at the end, saying how many and the first error.
 */
export async function inBatches<T>(rows: readonly T[], size: number, send: (batch: T[]) => Promise<unknown>): Promise<void> {
  let failed = 0;
  let first: unknown;
  const total = Math.ceil(rows.length / size);
  for (let i = 0; i < rows.length; i += size) {
    try {
      await send(rows.slice(i, i + size));
    } catch (e) {
      failed++;
      first ??= e;
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${total} batches failed: ${first instanceof Error ? first.message : String(first)}`);
}

/**
 * price_map_stamps: every branch the server knows, with its map's stamps.
 * Each entry carries its chain and store, so the downloader can address a
 * branch that has no map yet:
 *   {"<branch_id>": {"chain": "shufersal", "store": "444", "file": "20261027030000" | null, "delta": ... | null}}
 */
export interface BranchStamps {
  /** "<chain>:<store>" -> branch id and stamps. */
  byStore: Map<string, { id: number; file: string | null; delta: string | null }>;
  /** Entries without chain/store (an older server): their maps cannot be matched to a store. */
  unaddressed: number;
}

export function parseStamps(raw: unknown): BranchStamps {
  const byStore: BranchStamps['byStore'] = new Map();
  let unaddressed = 0;
  if (raw && typeof raw === 'object') {
    for (const [id, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
      const chain = typeof v?.chain === 'string' ? v.chain : null;
      const store = v?.store === undefined || v?.store === null ? null : String(v.store);
      if (!chain || !store || !/^\d+$/.test(id)) {
        unaddressed++;
        continue;
      }
      const stamp = (s: unknown) => (typeof s === 'string' && /^\d{14}$/.test(s) ? s : null);
      byStore.set(`${chain}:${String(Number(store))}`, { id: Number(id), file: stamp(v.file), delta: stamp(v.delta) });
    }
  }
  return { byStore, unaddressed };
}
