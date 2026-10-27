import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import { parse } from 'yaml';
import { RELAY_HOSTS } from '../src/chains.ts';

/** The Lambda's code (CommonJS, as Lambda runs index.js) and the CloudFormation template that carries it inline. */
const handler = createRequire(import.meta.url)('../relay/index.cjs').handler as (event: unknown) => Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}>;
const cfnTags = ['GetAtt', 'Sub', 'Ref'].map((t) => ({ tag: `!${t}`, resolve: (v: string) => ({ [t]: v }) }));
const cfnSeqTags = ['If', 'Equals'].map((t) => ({ tag: `!${t}`, collection: 'seq' as const, resolve: (v: { toJSON(): unknown }) => ({ [t]: v.toJSON() }) }));
const template = parse(readFileSync(new URL('../relay/template.yaml', import.meta.url), 'utf8'), { customTags: [...cfnTags, ...cfnSeqTags] });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (url: unknown, method = 'POST') => handler({ requestContext: { http: { method } }, body: JSON.stringify({ url }), isBase64Encoded: false });

test('the relay returns an allowed page as base64 with its status', async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: URL) => {
    asked.push(String(url));
    return new Response(new Uint8Array([0x1f, 0x8b, 1, 2]), { status: 200, headers: { 'content-type': 'application/gzip' } });
  }) as unknown as typeof fetch;
  const res = await call('https://prices.carrefour.co.il/20261027/PriceFull7290055700007-001-002-20261027-051004.gz');
  assert.equal(res.statusCode, 200);
  assert.equal(res.isBase64Encoded, true);
  assert.deepEqual([...Buffer.from(res.body, 'base64')], [0x1f, 0x8b, 1, 2]);
  assert.equal(res.headers['x-relay-status'], '200');
  assert.deepEqual(asked, ['https://prices.carrefour.co.il/20261027/PriceFull7290055700007-001-002-20261027-051004.gz']);
});

test('the relay refuses other hosts, other schemes, other methods and bad bodies', async () => {
  globalThis.fetch = (async () => assert.fail('must not fetch')) as unknown as typeof fetch;
  assert.equal((await call('https://example.com/')).statusCode, 403);
  assert.equal((await call('http://prices.carrefour.co.il/')).statusCode, 403);
  assert.equal((await call('https://prices.carrefour.co.il:8443/')).statusCode, 403);
  assert.equal((await call('https://user:pw@prices.carrefour.co.il/')).statusCode, 403);
  assert.equal((await call('https://prices.carrefour.co.il.evil.com/')).statusCode, 403);
  assert.equal((await call('https://prices.carrefour.co.il/', 'GET')).statusCode, 405);
  assert.equal((await call(42)).statusCode, 400);
  assert.equal((await handler({ requestContext: { http: { method: 'POST' } }, body: 'not json' })).statusCode, 400);
});

test('redirects are followed only within the allow-list; upstream errors pass through', async () => {
  globalThis.fetch = (async (url: URL) =>
    String(url).includes('/away')
      ? new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
      : String(url).includes('/moved')
        ? new Response(null, { status: 301, headers: { location: '/webapi/api/getfiles?edi=1' } })
        : new Response('[]', { status: String(url).includes('edi=1') ? 200 : 404 })) as unknown as typeof fetch;
  assert.equal((await call('https://laibcatalog.co.il/away')).statusCode, 403);
  const moved = await call('https://laibcatalog.co.il/moved');
  assert.equal(moved.statusCode, 200);
  assert.equal(Buffer.from(moved.body, 'base64').toString(), '[]');
  assert.equal((await call('https://laibcatalog.co.il/missing')).statusCode, 404);
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal((await call('https://shop.hazi-hinam.co.il/Prices')).statusCode, 502);
});

test('answers stay under the 6 MB Function URL limit once base64-encoded', async () => {
  globalThis.fetch = (async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1))) as unknown as typeof fetch;
  assert.equal((await call('https://prices.carrefour.co.il/big.gz')).statusCode, 413);
  globalThis.fetch = (async () => new Response(new Uint8Array(4 * 1024 * 1024))) as unknown as typeof fetch;
  const ok = await call('https://prices.carrefour.co.il/fits.gz');
  assert.equal(ok.statusCode, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(ok)) < 6 * 1024 * 1024);
});

test('the template carries exactly relay/index.cjs, within the 4 KB inline limit, and the downloader allow-list matches', () => {
  const code = readFileSync(new URL('../relay/index.cjs', import.meta.url), 'utf8');
  const fn = template.Resources.RelayFunction.Properties;
  assert.equal(fn.Code.ZipFile, code);
  assert.ok(code.length <= 4096, `inline code is ${code.length} characters`);
  assert.equal(fn.Handler, 'index.handler');
  assert.match(fn.Runtime, /^nodejs2\d\.x$/);
  const hosts = [...code.matchAll(/'([a-z.-]+\.co\.il)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(hosts, [...RELAY_HOSTS].sort());
});

test('only the repository\'s default branch can assume the role, and it may only call the Function URL', () => {
  const url = template.Resources.RelayUrl.Properties;
  assert.equal(url.AuthType, 'AWS_IAM');
  const role = template.Resources.GitHubRole.Properties;
  const trust = role.AssumeRolePolicyDocument.Statement;
  assert.equal(trust.length, 1);
  assert.equal(trust[0].Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(trust[0].Condition.StringEquals, {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': { Sub: 'repo:${GitHubRepository}:ref:refs/heads/${GitHubBranch}' },
  });
  assert.equal(template.Parameters.GitHubRepository.Default, 'tomerfarber/mesudarim-prices');
  assert.equal(template.Parameters.GitHubBranch.Default, 'main');
  assert.ok(role.MaxSessionDuration >= 7200, 'credentials outlive the 120-minute job');
  const statements = role.Policies.flatMap((p: { PolicyDocument: { Statement: unknown[] } }) => p.PolicyDocument.Statement);
  assert.deepEqual(
    statements.map((s: { Action: string; Resource: unknown; Condition: unknown }) => [s.Action, s.Resource, s.Condition]),
    [
      ['lambda:InvokeFunctionUrl', { GetAtt: 'RelayFunction.Arn' }, { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } }],
      ['lambda:InvokeFunction', { GetAtt: 'RelayFunction.Arn' }, { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } }],
    ],
  );
  assert.deepEqual(Object.keys(template.Outputs).sort(), ['FunctionUrl', 'RoleArn']);
  assert.equal(template.Resources.RelayLogs.Properties.RetentionInDays, 7);
});
