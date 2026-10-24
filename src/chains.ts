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

export interface Chain {
  /** Our stable key, also the `chains.id` row. */
  id: string;
  name: string;
  /** The GS1 chain codes in the file names (a chain may publish under two). */
  codes: string[];
  engine: Engine;
}

export const CHAINS: readonly Chain[] = [
  { id: 'shufersal', name: 'שופרסל', codes: ['7290027600007'], engine: { kind: 'shufersal' } },
  { id: 'rami_levy', name: 'רמי לוי', codes: ['7290058140886'], engine: { kind: 'cerberus', user: 'RamiLevi' } },
  { id: 'victory', name: 'ויקטורי', codes: ['7290696200003', '7290058103393'], engine: { kind: 'laib' } },
  { id: 'yohananof', name: 'יוחננוף', codes: ['7290803800003'], engine: { kind: 'cerberus', user: 'yohananof' } },
  { id: 'osher_ad', name: 'אושר עד', codes: ['7290103152017'], engine: { kind: 'cerberus', user: 'osherad' } },
  { id: 'hazi_hinam', name: 'חצי חינם', codes: ['7290700100008'], engine: { kind: 'hazihinam' } },
  { id: 'tiv_taam', name: 'טיב טעם', codes: ['7290873255550'], engine: { kind: 'cerberus', user: 'TivTaam' } },
  { id: 'carrefour', name: 'קרפור ויינות ביתן', codes: ['7290055700007'], engine: { kind: 'publishprice', infix: 'carrefour' } },
  { id: 'king_store', name: 'קינג סטור', codes: ['7290058108879'], engine: { kind: 'bina', prefix: 'kingstore' } },
  {
    id: 'super_yuda',
    name: 'סופר יודה',
    codes: ['7290058198450', '7290058177776'],
    engine: { kind: 'cerberus', user: 'yuda_ho', password: 'Yud@147', path: '/Yuda' },
  },
];

export const chainById = (id: string): Chain => {
  const chain = CHAINS.find((c) => c.id === id);
  if (!chain) throw new Error(`unknown chain ${id}`);
  return chain;
};
