import { CHAINS } from './chains.ts';

/** The command line, checked before anything runs: a typo must not turn into a quiet run of nothing. */
export const USAGE = 'usage: cli.ts prices [--full] [--dry] [--direct] [--chains a,b] [--out file] [--minutes N] | probe [chain] [--direct]';

export interface Args {
  command: string;
  full: boolean;
  dry: boolean;
  direct: boolean;
  chains?: string[];
  out?: string;
  minutes: number;
  /** probe: one chain, or every chain. */
  chain?: string;
}

const FLAGS = new Set(['--full', '--dry', '--direct']);
const WITH_VALUE = new Set(['--chains', '--out', '--minutes']);

/** Throws for an unknown flag or chain, a flag without its value, or a --minutes that is not a positive number. */
export function parseArgs(argv: readonly string[]): Args {
  const [command = '', ...rest] = argv;
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (WITH_VALUE.has(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      values.set(a, v);
      i++;
    } else if (a.startsWith('--')) {
      if (!FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    } else {
      positional.push(a);
    }
  }

  const ids = CHAINS.map((c) => c.id);
  const chains = values.get('--chains')?.split(',').map((c) => c.trim()).filter(Boolean);
  if (chains && chains.length === 0) throw new Error('--chains is empty');
  const chain = command === 'probe' ? positional[0] : undefined;
  const wrong = [...(chains ?? []), ...(chain ? [chain] : [])].filter((c) => !ids.includes(c));
  if (wrong.length) throw new Error(`unknown chain ${wrong.join(', ')} (chains: ${ids.join(', ')})`);

  const minutesText = values.get('--minutes') ?? '105';
  const minutes = Number(minutesText);
  if (!/^\d+(\.\d+)?$/.test(minutesText) || !(minutes > 0)) throw new Error(`--minutes must be a positive number, not ${minutesText}`);

  return { command, full: rest.includes('--full'), dry: rest.includes('--dry'), direct: rest.includes('--direct'), chains, out: values.get('--out'), minutes, chain };
}
