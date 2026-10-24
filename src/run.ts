import { CHAINS, chainById } from './chains.ts';
import { type Session, open } from './engines/index.ts';
import { newest } from './files.ts';
import { cityName, loadLocalities } from './localities.ts';
import { type Targets, inBatches, rpc } from './server.ts';
import { branches, decode, priceItems } from './xml.ts';

/** A barcode counts as a product when it is a GS1 code (8–14 digits); shorter codes are a chain's own. */
const isGs1 = (barcode: string) => barcode.length >= 8;
const COMMON_CHAINS = 6;
/** Branches sampled per chain for the catalog: more coverage, still a few MB. */
const CATALOG_FILES_PER_CHAIN = 2;

async function withSession<T>(chainId: string, task: (s: Session) => Promise<T>): Promise<T> {
  const session = await open(chainById(chainId));
  try {
    return await task(session);
  } finally {
    await session.close();
  }
}

/**
 * Weekly: every chain's branches (Stores file), and the national product
 * catalog from a couple of full price files per chain. `chains` counts in how
 * many chains a barcode is sold; 6 of 10 makes it "common" (always priced).
 */
export async function catalog(): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  const localities = await loadLocalities();
  const products = new Map<string, { name: string; manufacturer: string; quantity: number | null; unit: string; weighted: boolean; chains: Set<string> }>();
  for (const chain of CHAINS) {
    try {
      const [branchCount, itemCount] = await withSession(chain.id, async (s) => {
        const storesFile = newest(await s.list('stores', null), 'stores', null);
        const found = (storesFile ? [...branches(decode(await s.fetch(storesFile)))] : []).map((b) => ({
          ...b,
          city: cityName(localities, b.city, b.name, b.address),
        }));
        await inBatches(found, 500, (batch) => rpc('ingest_branches', { p_chain: chain.id, p_rows: batch }));
        const files = (await s.list('pricefull', null)).sort((a, b) => b.stamp.localeCompare(a.stamp));
        const picked = [...new Map(files.map((f) => [f.store, f])).values()].slice(0, CATALOG_FILES_PER_CHAIN);
        let items = 0;
        for (const file of picked) {
          for (const item of priceItems(decode(await s.fetch(file)))) {
            if (!isGs1(item.barcode) || !item.name) continue;
            items++;
            const known = products.get(item.barcode);
            if (known) known.chains.add(chain.id);
            else products.set(item.barcode, { ...item, chains: new Set([chain.id]) });
          }
        }
        return [found.length, items];
      });
      report[chain.id] = { branches: branchCount, items: itemCount };
    } catch (e) {
      report[chain.id] = { error: (e as Error).message.slice(0, 200) };
    }
  }
  const rows = [...products].map(([barcode, p]) => ({
    barcode,
    name: p.name.slice(0, 200),
    manufacturer: p.manufacturer.slice(0, 120),
    quantity: p.quantity,
    unit: p.unit.slice(0, 30),
    weighted: p.weighted,
    chains: p.chains.size,
  }));
  await inBatches(rows, 2000, (batch) => rpc('ingest_products', { p_rows: batch }));
  report.products = rows.length;
  report.common = rows.filter((r) => r.chains >= COMMON_CHAINS).length;
  return report;
}

/**
 * Daily: for every tracked branch, the newest PriceFull, kept down to the
 * tracked barcodes. A chain that fails does not stop the others.
 */
export async function prices(): Promise<Record<string, unknown>> {
  const targets = await rpc<Targets>('price_targets', {});
  const tracked = new Set(targets.barcodes);
  const report: Record<string, unknown> = { branches: targets.branches.length, barcodes: tracked.size };
  const byChain = Map.groupBy(targets.branches, (b) => b.chain);
  for (const [chainId, list] of byChain) {
    const result = { written: 0, missing: [] as string[], errors: [] as string[] };
    try {
      await withSession(chainId, async (s) => {
        for (const branch of list) {
          try {
            const file = newest(await s.list('pricefull', branch.store), 'pricefull', branch.store);
            if (!file) {
              result.missing.push(branch.store);
              continue;
            }
            const rows: [string, number][] = [];
            for (const item of priceItems(decode(await s.fetch(file)))) {
              if (tracked.has(item.barcode)) rows.push([item.barcode, item.priceAgorot]);
            }
            await rpc('ingest_prices', { p_branch_id: branch.id, p_file_stamp: file.stamp, p_rows: rows });
            result.written++;
          } catch (e) {
            result.errors.push(`${branch.store}: ${(e as Error).message.slice(0, 120)}`);
          }
        }
      });
    } catch (e) {
      result.errors.push((e as Error).message.slice(0, 200));
    }
    report[chainId] = result;
  }
  return report;
}
