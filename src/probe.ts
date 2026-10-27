import { CHAINS } from './chains.ts';
import { open } from './engines/index.ts';
import { newest, newestByStore } from './files.ts';
import { network, relayState } from './http.ts';
import { branches, decode, priceItems } from './xml.ts';

/** Checks every chain end to end: its Stores file, its PriceFull listing, then one branch's newest PriceFull. Needs no server. */
export async function probe(only?: string): Promise<void> {
  for (const chain of CHAINS.filter((c) => !only || c.id === only)) {
    const t = Date.now();
    if (chain.relay !== 'none' && relayState() === 'missing') {
      console.log(`${chain.id.padEnd(11)} needs_relay (set RELAY_URL, or pass --direct in Israel)`);
      continue;
    }
    if (chain.relay !== 'none' && relayState() === 'broken') {
      console.log(`${chain.id.padEnd(11)} FAIL relay: ${network.relayProblem}`);
      continue;
    }
    let session;
    try {
      session = await open(chain);
      const storesFile = newest(await session.list('stores'), 'stores', null);
      const stores = storesFile ? [...branches(decode(await session.fetch(storesFile)))] : [];
      const byStore = newestByStore(await session.list('pricefull'));
      const file = [...byStore.values()].sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
      const raw = file ? await session.fetch(file) : null;
      const items = raw ? [...priceItems(decode(raw))] : [];
      console.log(
        `${chain.id.padEnd(11)} ok  branches=${stores.length} pricefull-branches=${byStore.size} sample=${file?.name ?? '-'} bytes=${raw?.length ?? 0} items=${items.length} ${(Date.now() - t) / 1000}s`,
      );
    } catch (e) {
      console.log(`${chain.id.padEnd(11)} FAIL ${(e as Error).message}`);
    } finally {
      await session?.close();
    }
  }
}
