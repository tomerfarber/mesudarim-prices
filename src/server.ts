/**
 * The Mesudarim server, through its ingest RPCs (migration 0066): the anon
 * key plus PRICES_TOKEN, which the RPCs check against app_settings. No
 * service key is needed or kept here.
 */
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const key = env('SUPABASE_ANON_KEY');
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_token: env('PRICES_TOKEN'), ...args }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  // A void RPC answers with an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface Targets {
  branches: { id: number; chain: string; store: string }[];
  barcodes: string[];
}

/** Sends rows in batches, so one request never carries more than `size` rows. */
export async function inBatches<T>(rows: readonly T[], size: number, send: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await send(rows.slice(i, i + size));
}
