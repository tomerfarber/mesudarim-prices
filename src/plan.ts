import { type PublishedFile, newestByStore } from './files.ts';
import { type PriceItem, priceItems } from './xml.ts';

/**
 * What one run does for one chain, decided from what the chain publishes now
 * and what the server already has (price_map_stamps). Pure, so it is tested
 * without a network.
 */

/** The server's stamps of one branch's map (YYYYMMDDHHMMSS, Israel time). */
export interface Stamp {
  file: string | null;
  delta: string | null;
}

export interface StorePlan {
  store: string;
  /**
   * The newest PriceFull of the branch. Price files are always merged as
   * changes, even where they happen to be complete lists (Victory's were, on
   * the day it was measured): merging a complete list gives the same map, and
   * a change-only file is never taken for the whole list.
   */
  full: PublishedFile;
  /** Send `full` with p_full = true: it is newer than the server's map, or there is no map. */
  sendFull: boolean;
  /** Download `full` even when it is not sent (the daily run reads every branch for the product catalog). */
  readFull: boolean;
  /** Price (change) files newer than what the map will hold, oldest first; merged into one p_full = false call. */
  deltas: PublishedFile[];
}

const later = (a: string | null | undefined, b: string | null | undefined) => ((a ?? '') > (b ?? '') ? (a ?? '') : (b ?? ''));

export function planChain(
  fulls: readonly PublishedFile[],
  prices: readonly PublishedFile[],
  stamps: (store: string) => Stamp | undefined,
  { readAll }: { readAll: boolean },
): StorePlan[] {
  const newestFull = newestByStore(fulls);
  const deltasByStore = Map.groupBy(prices.filter((f) => f.store !== null), (f) => f.store!);
  const plans: StorePlan[] = [];
  for (const [store, full] of newestFull) {
    const stamp = stamps(store);
    const sendFull = !stamp?.file || full.stamp > stamp.file;
    // After a full replace the map holds `full`; otherwise it holds the server's file plus its newest delta.
    const base = sendFull ? full.stamp : later(stamp?.file, stamp?.delta);
    const deltas = (deltasByStore.get(store) ?? []).filter((f) => f.stamp > base).sort((a, b) => a.stamp.localeCompare(b.stamp));
    plans.push({ store, full, sendFull, readFull: sendFull || readAll, deltas });
  }
  return plans;
}

/** Valid prices only: the server refuses codes that are not 4-14 digits and prices outside 1..9,999,999 agorot. */
export const validPrice = (barcode: string, agorot: number) => /^\d{4,14}$/.test(barcode) && Number.isInteger(agorot) && agorot >= 1 && agorot <= 9_999_999;

/** A file's prices as the map the server stores ({"<barcode>": agorot}); `onItem` sees every valid item (products). */
export function priceMap(xml: string, onItem?: (item: PriceItem) => void): Record<string, number> {
  const map: Record<string, number> = {};
  for (const item of priceItems(xml)) {
    if (!validPrice(item.barcode, item.priceAgorot)) continue;
    map[item.barcode] = item.priceAgorot;
    onItem?.(item);
  }
  return map;
}

/**
 * Change files merged oldest first, so a later price wins. Stops at the first
 * file that could not be read: sending later files without it would skip its
 * changes for good (the server keeps only the newest delta stamp).
 */
export function mergeDeltas(results: readonly { file: PublishedFile; map: Record<string, number> | null }[]): {
  map: Record<string, number>;
  stamp: string | null;
  applied: number;
} {
  const map: Record<string, number> = {};
  let stamp: string | null = null;
  let applied = 0;
  for (const r of results) {
    if (!r.map) break;
    Object.assign(map, r.map);
    stamp = r.file.stamp;
    applied++;
  }
  return { map, stamp, applied };
}

export type ChainStatus = 'ok' | 'down' | 'needs_relay';

/**
 * A chain is down when its listing failed, or when more than 10% of the files
 * it tried could not be downloaded (a few transient failures are retried by
 * the next run and only noted).
 */
export function chainStatus(listingFailed: boolean, tried: number, failed: number): ChainStatus {
  if (listingFailed) return 'down';
  return failed > Math.max(1, Math.floor(tried * 0.1)) ? 'down' : 'ok';
}
