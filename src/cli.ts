import { writeFileSync } from 'node:fs';
import { network } from './http.ts';
import { probe } from './probe.ts';
import { relayFromEnv } from './relay.ts';
import { exitCode, prices } from './run.ts';
import { server } from './server.ts';

/**
 * node --experimental-strip-types src/cli.ts prices [--full] [--dry] [--direct] [--chains a,b] [--out file] [--minutes N]
 * node --experimental-strip-types src/cli.ts probe [chain] [--direct]
 *
 * --full     the daily run: every branch's PriceFull is read and the product catalog is sent
 * --dry      download and build every payload, but call no server RPC (no secrets needed)
 * --direct   this machine is in Israel: reach Carrefour, Hazi Hinam and Victory without the relay
 * --minutes  stop starting new downloads after N minutes (default 105; the job's timeout is 120)
 */
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const value = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

network.direct = flag('direct');
server.dry = flag('dry');

try {
  network.relay = relayFromEnv();
  switch (command) {
    case 'probe':
      await probe(rest.find((a) => !a.startsWith('--')));
      break;
    case 'prices': {
      const report = await prices({
        full: flag('full'),
        chains: value('chains')?.split(','),
        budgetMs: Number(value('minutes') ?? 105) * 60_000,
      });
      const out = server.dry ? { ...report, calls: summarizeCalls() } : report;
      console.log(JSON.stringify(out, null, 2));
      const file = value('out');
      if (file) writeFileSync(file, JSON.stringify(out, null, 2));
      process.exitCode = exitCode(report);
      break;
    }
    default:
      console.error('usage: cli.ts prices [--full] [--dry] [--direct] [--chains a,b] [--out file] [--minutes N] | probe [chain] [--direct]');
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
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
