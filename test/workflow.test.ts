import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { israelHour } from '../src/files.ts';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/prices.yml', import.meta.url), 'utf8'));
const steps: { name?: string; run?: string; 'continue-on-error'?: boolean }[] = workflow.jobs.run.steps;

test('the daily full run is the scheduled one the run step treats as full, after Victory publishes all year', () => {
  const crons: string[] = workflow.on.schedule.map((s: { cron: string }) => s.cron);
  const run = steps.find((s) => s.name === 'Run')!.run!;
  const full = /\$SCHEDULE" = "([^"]+)"/.exec(run)![1];
  assert.ok(crons.includes(full));
  const [minute, hour] = full.split(' ').map(Number);
  // Victory's first files appear ~05:00 Israel time; winter is UTC+2.
  for (const day of ['2026-12-15', '2026-07-15']) {
    const at = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
    assert.ok(israelHour(at) >= 5, `${full} is ${israelHour(at)}:${minute} in Israel on ${day}`);
  }
});

test('a failing AWS step does not stop the run (only the relay chains depend on it)', () => {
  assert.equal(steps.find((s) => s.name === 'Credentials for the Israeli relay')?.['continue-on-error'], true);
});
