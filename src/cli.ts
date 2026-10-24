import { probe } from './probe.ts';
import { catalog, prices } from './run.ts';
import { rpc } from './server.ts';

const [command, arg] = process.argv.slice(2);
const started = Date.now();

async function runAndReport(job: 'catalog' | 'prices', task: () => Promise<Record<string, unknown>>): Promise<void> {
  const report = { job, ...(await task()), seconds: Math.round((Date.now() - started) / 1000) };
  console.log(JSON.stringify(report, null, 2));
  await rpc('ingest_report', { p_report: report });
}

switch (command) {
  case 'probe':
    await probe(arg);
    break;
  case 'catalog':
    await runAndReport('catalog', catalog);
    break;
  case 'prices':
    await runAndReport('prices', prices);
    break;
  default:
    console.error('usage: cli.ts probe [chain] | catalog | prices');
    process.exitCode = 2;
}
