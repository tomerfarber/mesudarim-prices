import { CHAINS } from './chains.ts';
import { open } from './engines/index.ts';
import { newest } from './files.ts';
import { branches, decode, priceItems } from './xml.ts';

/** Checks every chain end to end: its Stores file, then one branch's newest PriceFull. */
export async function probe(only?: string): Promise<void> {
  for (const chain of CHAINS.filter((c) => !only || c.id === only)) {
    const t = Date.now();
    let session;
    try {
      session = await open(chain);
      const storesFile = newest(await session.list('stores', null), 'stores', null);
      const stores = storesFile ? [...branches(decode(await session.fetch(storesFile)))] : [];
      const all = await session.list('pricefull', null);
      const file = newest(all, 'pricefull', all.at(-1)?.store ?? null) ?? all[0];
      const items = file ? [...priceItems(decode(await session.fetch(file)))] : [];
      console.log(
        `${chain.id.padEnd(11)} ok  branches=${stores.length} pricefull-files=${all.length} sample=${file?.name ?? '-'} items=${items.length} ${(Date.now() - t) / 1000}s`,
      );
    } catch (e) {
      console.log(`${chain.id.padEnd(11)} FAIL ${(e as Error).message}`);
    } finally {
      await session?.close();
    }
  }
}
