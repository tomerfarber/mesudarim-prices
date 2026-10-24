/** fetch with a browser User-Agent (some chains refuse others), a timeout and a few retries. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export async function get(url: string, { timeoutMs = 60_000, tries = 3 } = {}): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (res.ok) return res;
      last = new Error(`${res.status} ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw last;
}

export const getText = async (url: string) => (await get(url)).text();
export const getJson = async <T>(url: string) => (await get(url)).json() as Promise<T>;
export const getBytes = async (url: string) => Buffer.from(await (await get(url, { timeoutMs: 180_000 })).arrayBuffer());
