import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { HttpError, NeedsRelay, get, network } from '../src/http.ts';
import { relayFromEnv } from '../src/relay.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  network.direct = false;
  network.relay = null;
});

test('a relayed host without a relay is NeedsRelay; in Israel (--direct) it is fetched directly', async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return new Response('ok');
  }) as typeof fetch;
  await assert.rejects(get('https://prices.carrefour.co.il/', { viaRelay: true }), NeedsRelay);
  assert.deepEqual(asked, []);
  network.direct = true;
  assert.equal(await (await get('https://prices.carrefour.co.il/', { viaRelay: true })).text(), 'ok');
  assert.deepEqual(asked, ['https://prices.carrefour.co.il/']);
});

test('the relay is used only for its allow-listed hosts', async () => {
  const relayed: string[] = [];
  network.relay = { fetch: async (url) => (relayed.push(url), new Response('via relay')) };
  assert.equal(await (await get('https://laibcatalog.co.il/webapi/api/getfiles?edi=7290696200003', { viaRelay: true })).text(), 'via relay');
  await assert.rejects(get('https://example.com/x', { viaRelay: true }), /allow-list/);
  assert.deepEqual(relayed, ['https://laibcatalog.co.il/webapi/api/getfiles?edi=7290696200003']);
});

test('a 4xx is an HttpError at once; a 5xx is retried', async () => {
  let calls = 0;
  globalThis.fetch = (async () => (calls++, new Response('nope', { status: 404 }))) as unknown as typeof fetch;
  await assert.rejects(get('https://prices.shufersal.co.il/x'), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = (async () => (calls++, calls < 2 ? new Response('busy', { status: 503 }) : new Response('fine'))) as unknown as typeof fetch;
  assert.equal(await (await get('https://prices.shufersal.co.il/x')).text(), 'fine');
  assert.equal(calls, 2);
});

test('relay requests are SigV4-signed for lambda in il-central-1 with the OIDC session token', async () => {
  assert.equal(relayFromEnv({}), null);
  assert.throws(() => relayFromEnv({ RELAY_URL: 'https://abc.lambda-url.il-central-1.on.aws/' }), /no AWS credentials/);
  const relay = relayFromEnv({
    RELAY_URL: 'https://abc.lambda-url.il-central-1.on.aws/',
    AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'session-token',
  })!;
  let seen: Request | null = null;
  globalThis.fetch = (async (req: Request) => {
    seen = req;
    return new Response('relayed');
  }) as unknown as typeof fetch;
  const res = await relay.fetch('https://prices.carrefour.co.il/', AbortSignal.timeout(5000));
  assert.equal(await res.text(), 'relayed');
  const req = seen as unknown as Request;
  assert.equal(req.url, 'https://abc.lambda-url.il-central-1.on.aws/');
  assert.equal(req.method, 'POST');
  assert.deepEqual(await req.json(), { url: 'https://prices.carrefour.co.il/' });
  const auth = req.headers.get('authorization') ?? '';
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/il-central-1\/lambda\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/);
  assert.equal(req.headers.get('x-amz-security-token'), 'session-token');
  assert.match(req.headers.get('x-amz-content-sha256') ?? '', /^[0-9a-f]{64}$/);
});
