import { writeFileSync } from 'node:fs';
import { USAGE, parseArgs } from './args.ts';
import { network } from './http.ts';
import { probe } from './probe.ts';
import { relaySetup } from './relay.ts';
import { exitCode, prices } from './run.ts';
import { server } from './server.ts';

/**
 * node --experimental-strip-types src/cli.ts prices [--full] [--dry] [--direct] [--chains a,b] [--out file] [--minutes N]
 * node --experimental-strip-types src/cli.ts probe [chain] [--direct]
 *
 * --full     the daily run: branches, every branch's PriceFull, and the product catalog
 * --dry      download and build every payload, but call no server RPC (no secrets needed)
 * --direct   this machine is in Israel: reach Carrefour, Hazi Hinam and Victory without the relay
 * --minutes  stop starting new downloads after N minutes (default 105; the job's timeout is 120)
 *
 * A mistyped chain or flag, or a --minutes that is not a number, exits 2 before anything runs (args.ts).
 */
async function main(argv: readonly string[]): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  network.direct = args.direct;
  server.dry = args.dry;
  // A relay that is set up wrong fails only the relay chains (run.ts), never the whole run.
  ({ relay: network.relay, problem: network.relayProblem } = relaySetup());

  switch (args.command) {
    case 'probe':
      await probe(args.chain);
      return 0;
    case 'prices': {
      const report = await prices({ full: args.full, chains: args.chains, budgetMs: args.minutes * 60_000 });
      const out = server.dry ? { ...report, calls: summarizeCalls() } : report;
      console.log(JSON.stringify(out, null, 2));
      if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2));
      return exitCode(report);
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

/** In a dry run: per RPC, how many calls would have been made and how big they would have been. */
function summarizeCalls() {
  const byFn: Record<string, { calls: number; maxKB: number; totalMB: number }> = {};
  for (const c of server.calls) {
    const s = (byFn[c.fn] ??= { calls: 0, maxKB: 0, totalMB: 0 });
    s.calls++;
    s.maxKB = Math.max(s.maxKB, Math.round(c.bytes / 1024));
    s.totalMB = Math.round((s.totalMB + c.bytes / 1e6) * 10) / 10;
  }
  return byFn;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
// The report is out. A connection that is still open (a server that stopped answering mid-transfer)
// must not keep the job running until its timeout: leave after 30 s whatever is still pending.
setTimeout(() => process.exit(), 30_000).unref();
