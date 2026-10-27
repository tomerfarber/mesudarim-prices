/**
 * The chains Mesudarim downloads, and where each one publishes. The price
 * transparency regulations (חוק קידום התחרות בענף המזון, 2014) make every
 * chain publish its prices daily; the hosts and the public logins below are
 * the ones the chains publish. Order: largest first.
 */
export type Engine =
  | { kind: 'shufersal' }
  | { kind: 'cerberus'; user: string; password?: string; path?: string }
  | { kind: 'laib' }
  | { kind: 'bina'; prefix: string }
  | { kind: 'publishprice'; infix: string }
  | { kind: 'hazihinam' };

/**
 * Hosts that answer only Israeli addresses (measured 2026-10-27 from the US,
 * Germany, the Netherlands and AWS il-central-1). From GitHub's runners they
 * go through the Israeli relay (relay/template.yaml):
 * - 'all': listing and files (Carrefour, Victory);
 * - 'listing': only the listing pages; the files are on Azure Blob, reachable
 *   from anywhere (Hazi Hinam);
 * - 'none': reachable from anywhere.
 */
export type RelayUse = 'none' | 'listing' | 'all';

export interface Chain {
  /** Our stable key, also the `price_chains.id` row. */
  id: string;
  name: string;
  /** The GS1 chain codes in the file names (a chain may publish under two). */
  codes: string[];
  engine: Engine;
  relay: RelayUse;
  /** Files downloaded at once (FTP: connections). */
  concurrency: number;
  /**
   * The listing shows only today's files (Victory's laibcatalog API has no
   * date parameter), so it is empty from midnight until the chain's first
   * files (~05:00 Israel time). An empty listing before 09:00 is not a failure.
   */
  todayOnly?: boolean;
}

export const CHAINS: readonly Chain[] = [
  { id: 'shufersal', name: 'שופרסל', codes: ['7290027600007'], engine: { kind: 'shufersal' }, relay: 'none', concurrency: 8 },
  { id: 'rami_levy', name: 'רמי לוי', codes: ['7290058140886'], engine: { kind: 'cerberus', user: 'RamiLevi' }, relay: 'none', concurrency: 4 },
  {
    id: 'victory',
    name: 'ויקטורי',
    codes: ['7290696200003', '7290058103393'],
    engine: { kind: 'laib' },
    relay: 'all',
    concurrency: 4,
    todayOnly: true,
  },
  { id: 'yohananof', name: 'יוחננוף', codes: ['7290803800003'], engine: { kind: 'cerberus', user: 'yohananof' }, relay: 'none', concurrency: 2 },
  { id: 'osher_ad', name: 'אושר עד', codes: ['7290103152017'], engine: { kind: 'cerberus', user: 'osherad' }, relay: 'none', concurrency: 2 },
  { id: 'hazi_hinam', name: 'חצי חינם', codes: ['7290700100008'], engine: { kind: 'hazihinam' }, relay: 'listing', concurrency: 4 },
  { id: 'tiv_taam', name: 'טיב טעם', codes: ['7290873255550'], engine: { kind: 'cerberus', user: 'TivTaam' }, relay: 'none', concurrency: 2 },
  {
    id: 'carrefour',
    name: 'קרפור ויינות ביתן',
    codes: ['7290055700007'],
    engine: { kind: 'publishprice', infix: 'carrefour' },
    relay: 'all',
    concurrency: 4,
  },
  { id: 'king_store', name: 'קינג סטור', codes: ['7290058108879'], engine: { kind: 'bina', prefix: 'kingstore' }, relay: 'none', concurrency: 4 },
  {
    id: 'super_yuda',
    name: 'סופר יודה',
    codes: ['7290058198450', '7290058177776'],
    engine: { kind: 'cerberus', user: 'yuda_ho', password: 'Yud@147', path: '/Yuda' },
    relay: 'none',
    concurrency: 2,
  },
];

/** The hosts the relay may reach; the Lambda in relay/template.yaml allows exactly these. */
export const RELAY_HOSTS: readonly string[] = ['prices.carrefour.co.il', 'shop.hazi-hinam.co.il', 'laibcatalog.co.il'];

export const chainById = (id: string): Chain => {
  const chain = CHAINS.find((c) => c.id === id);
  if (!chain) throw new Error(`unknown chain ${id}`);
  return chain;
};
