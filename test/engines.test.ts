import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { PeerCertificate } from 'node:tls';
import { CHAINS, chainById } from '../src/chains.ts';
import { binaFiles } from '../src/engines/bina.ts';
import { dataHost, passiveMode, publishedPricesIdentity } from '../src/engines/cerberus.ts';
import { haziLinks, openHaziHinam } from '../src/engines/hazihinam.ts';
import { listingCache } from '../src/engines/index.ts';
import { laibFiles, openLaib } from '../src/engines/laib.ts';
import { openPublishPrice, publishPriceFiles } from '../src/engines/publishprice.ts';
import { linkExpiry, openShufersal, shufersalLinks, shufersalPages } from '../src/engines/shufersal.ts';
import { network } from '../src/http.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  network.direct = false;
  network.relay = null;
});

/** Answers by URL; records every URL asked for. */
function serve(routes: (url: string) => Response | Promise<Response>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    return routes(url);
  }) as typeof fetch;
  return asked;
}

test('Shufersal: blob links and the last page of the pager', () => {
  const html = `<tfoot><tr><td colspan="8">1 <a href="/FileObject/UpdateCategory?catID=1&amp;storeId=0&amp;page=2">2</a>
    <a href="/FileObject/UpdateCategory?catID=1&amp;storeId=0&amp;page=26">&gt;&gt;</a></td></tr></tfoot><tbody>
    <tr><td><a href="https://pricesprodpublic.blob.core.windows.net/price/Price7290027600007-001-001-20261027-020000.gz?sv=2014-02-14&amp;sr=b&amp;sig=x%3D&amp;se=2026-10-27T09%3A40%3A39Z&amp;sp=r" target="_blank">לחץ להורדה</a></td></tr>`;
  const [file] = shufersalLinks(html);
  assert.equal(file.store, '1');
  assert.equal(file.kind, 'price');
  assert.ok(file.source.includes('&sr=b&sig='));
  assert.equal(shufersalPages(html), 26);
  assert.equal(shufersalPages('<p>no pager</p>'), 1);
});

test('Carrefour lists today and yesterday, so a run after midnight still finds every branch', async () => {
  network.direct = true;
  const page = (day: string, names: string[]) =>
    new Response(`<script>const path = '${day}';\nconst files = ${JSON.stringify(names.map((name) => ({ name, size: 1 })))};</script>`);
  const asked = serve((url) =>
    url.endsWith('?date=20261026')
      ? page('20261026', ['PriceFull7290055700007-001-002-20261026-051004.gz', 'PriceFull7290055700007-001-003-20261026-051004.gz'])
      : page('20261027', ['PriceFull7290055700007-001-002-20261027-000100.gz', 'Stores7290055700007-000-20261027-000100.xml']),
  );
  const session = await openPublishPrice(chainById('carrefour'), { infix: 'carrefour' }, () => new Date('2026-10-26T22:20:00Z'));
  const fulls = await session.list('pricefull');
  assert.deepEqual(asked.sort(), ['https://prices.carrefour.co.il/', 'https://prices.carrefour.co.il/?date=20261026']);
  assert.deepEqual(fulls.map((f) => f.source).sort(), [
    'https://prices.carrefour.co.il/20261026/PriceFull7290055700007-001-002-20261026-051004.gz',
    'https://prices.carrefour.co.il/20261026/PriceFull7290055700007-001-003-20261026-051004.gz',
    'https://prices.carrefour.co.il/20261027/PriceFull7290055700007-001-002-20261027-000100.gz',
  ]);
  assert.equal((await session.list('stores')).length, 1);
  assert.equal(asked.length, 2, 'the listing is loaded once per run');
  assert.throws(() => publishPriceFiles('https://x', '<html>maintenance</html>'), /no file list/);
});

test('Carrefour, Victory and Hazi Hinam need the relay when RELAY_URL is not set, and never touch the network', async () => {
  const asked = serve(() => new Response('should not be called'));
  const carrefour = await openPublishPrice(chainById('carrefour'), { infix: 'carrefour' });
  await assert.rejects(carrefour.list('pricefull'), { name: 'NeedsRelay' });
  const victory = await openLaib(chainById('victory'));
  await assert.rejects(victory.list('pricefull'), { name: 'NeedsRelay' });
  const hazi = await openHaziHinam(chainById('hazi_hinam'));
  await assert.rejects(hazi.list('pricefull'), { name: 'NeedsRelay' });
  assert.deepEqual(asked, []);
  assert.deepEqual(CHAINS.filter((c) => c.relay !== 'none').map((c) => [c.id, c.relay]), [['victory', 'all'], ['hazi_hinam', 'listing'], ['carrefour', 'all']]);
});

test("Victory (laibcatalog): a code with no files is skipped, any other error is an error, never an empty list (P12)", async () => {
  network.direct = true;
  const entry = (fileName: string) => ({ branchNumber: 1, fileName, fileType: 'pricefull', fileDate: '2026-10-27 05:12:38', fileSize: '538.6 KB' });
  serve((url) =>
    url.includes('edi=7290058103393')
      ? new Response('{"message":"FilesRootPath is invalid"}', { status: 400 })
      : Response.json([entry('PriceFull7290696200003-001-001-20261027-051238.gz'), entry('Price7290696200003-001-001-20261027-110917.gz')]),
  );
  const ok = await openLaib(chainById('victory'));
  const fulls = await ok.list('pricefull');
  assert.deepEqual(fulls.map((f) => f.source), ['https://laibcatalog.co.il/webapi/7290696200003/PriceFull7290696200003-001-001-20261027-051238.gz']);
  assert.equal((await ok.list('price')).length, 1);

  serve(() => new Response('Server Error', { status: 500 }));
  const broken = await openLaib(chainById('victory'));
  await assert.rejects(broken.list('pricefull'), /500/);

  serve(() => new Response('{"message":"something else"}', { status: 400 }));
  const refused = await openLaib(chainById('victory'));
  await assert.rejects(refused.list('pricefull'), /400/);
  assert.throws(() => laibFiles('1', { message: 'x' }), /unexpected listing/);
});

test('Hazi Hinam: links of every page of today and yesterday, files fetched directly from Azure', async () => {
  network.direct = false;
  const relayed: string[] = [];
  network.relay = {
    fetch: async (url) => {
      relayed.push(url);
      const u = new URL(url);
      const day = u.searchParams.get('d');
      const page = u.searchParams.get('p');
      if (page !== '1') return new Response('<html><body>no rows</body></html>');
      return new Response(
        `<html><a href="https://hazihinamprod01.blob.core.windows.net/regulatories/PriceFull7290700100008-000-201-${day!.replaceAll('-', '')}-001910.gz">x</a></html>`,
      );
    },
  };
  const direct = serve(() => new Response(new Uint8Array([1, 2, 3])));
  const session = await openHaziHinam(chainById('hazi_hinam'), () => new Date('2026-10-27T09:00:00Z'));
  const fulls = await session.list('pricefull');
  assert.deepEqual(fulls.map((f) => f.stamp).sort(), ['20261026001910', '20261027001910']);
  assert.ok(relayed.every((u) => u.startsWith('https://shop.hazi-hinam.co.il/Prices?d=')));
  assert.equal(relayed.length, 4);
  assert.deepEqual([...(await session.fetch(fulls[0]))], [1, 2, 3]);
  assert.equal(direct.length, 1);
  assert.ok(direct[0].startsWith('https://hazihinamprod01.blob.core.windows.net/'));
  assert.equal(haziLinks('<a href="https://evil.example/PriceFull7290700100008-000-201-20261027-001910.gz">').length, 0);
});

test('King Store listing rows', () => {
  assert.deepEqual(binaFiles([{ FileNm: 'PriceFull7290058108879-000-006-20261027-051209.GZ' }, { FileNm: 'junk' }, {}]).map((f) => f.store), ['6']);
  assert.throws(() => binaFiles('<html>'), /unexpected/);
});

test('a failed listing is cached for the run, so it is not retried for every branch (P52)', async () => {
  let calls = 0;
  const list = listingCache(async () => {
    calls++;
    throw new Error('down');
  });
  await assert.rejects(list('pricefull'));
  await assert.rejects(list('pricefull'));
  assert.equal(calls, 1);
});

test('the FTP certificate must be issued to publishedprices.co.il (P56)', () => {
  const cert = (subjectaltname: string) => ({ subjectaltname, subject: { CN: '' } }) as unknown as PeerCertificate;
  const host = 'url.retail.publishedprices.co.il';
  assert.equal(publishedPricesIdentity(host, cert('DNS:*.publishedprices.co.il, DNS:publishedprices.co.il')), undefined);
  assert.equal(publishedPricesIdentity(host, cert('DNS:url.retail.publishedprices.co.il')), undefined);
  assert.ok(publishedPricesIdentity(host, cert('DNS:*.example.com')) instanceof Error);
  assert.ok(publishedPricesIdentity(host, cert('DNS:*.publishedprices.co.il.evil.com')) instanceof Error);
  assert.ok(publishedPricesIdentity('evil.com', cert('DNS:*.publishedprices.co.il')) instanceof Error);
});

test('FTP data connections go only to the FTP server: its own address or a neighbour in its /24', async () => {
  // The real server: control on .22, PASV names .21 (2026-10-27).
  assert.equal(dataHost('194.90.26.21', '194.90.26.22'), '194.90.26.21');
  assert.equal(dataHost('194.90.26.22', '::ffff:194.90.26.22'), '194.90.26.22');
  assert.equal(dataHost('10.0.0.5', '194.90.26.22'), '194.90.26.22');
  assert.throws(() => dataHost('8.8.8.8', '194.90.26.22'), /not the FTP server/);
  assert.throws(() => dataHost('194.90.27.21', '194.90.26.22'), /not the FTP server/);
  const ftp = (pasv: string) =>
    ({ request: async () => ({ code: 227, message: `227 Entering Passive Mode (${pasv})` }), socket: { remoteAddress: '194.90.26.22' } }) as unknown as Parameters<typeof passiveMode>[0];
  // Another host in the PASV answer is refused before any connection is made.
  await assert.rejects(passiveMode(ftp('8,8,8,8,4,1')), /not the FTP server/);
});

test('Shufersal: an expired or refused blob link is fetched again from one fresh listing', async () => {
  const now = Date.parse('2026-10-27T10:00:00Z');
  const blob = (store: string, sig: string, se: string) =>
    `https://pricesprodpublic.blob.core.windows.net/pricefull/PriceFull7290027600007-001-${store}-20261027-030000.gz?sv=2014-02-14&amp;sr=b&amp;sig=${sig}&amp;se=${encodeURIComponent(se)}&amp;sp=r`;
  let listings = 0;
  // Each listing signs its links anew; the first one's links expired at 09:50, later ones last until 10:40.
  const asked = serve((url) => {
    if (url.startsWith('https://prices.shufersal.co.il/')) {
      listings++;
      const se = listings === 1 ? '2026-10-27T09:50:00Z' : '2026-10-27T10:40:00Z';
      const stores = listings === 3 ? ['001', '003'] : ['001', '002', '003'];
      return new Response(stores.map((st) => `<a href="${blob(st, `s${listings}`, se)}">x</a>`).join(''));
    }
    // Azure refuses store 3's link of the second listing as if it had expired early.
    if (url.includes('-003-') && url.includes('sig=s2')) return new Response('<Error><Code>AuthenticationFailed</Code></Error>', { status: 403 });
    return new Response(new Uint8Array([7]));
  });
  const session = await openShufersal(chainById('shufersal'), () => now);
  const [one, two, three] = (await session.list('pricefull')).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(linkExpiry(one.source), Date.parse('2026-10-27T09:50:00Z'));

  // Two expired links fetched at once share one fresh listing.
  assert.deepEqual(await Promise.all([session.fetch(one), session.fetch(two)]).then((b) => b.map((x) => [...x])), [[7], [7]]);
  assert.equal(listings, 2);
  assert.deepEqual(asked.filter((u) => u.includes('blob.core')).map((u) => new URL(u).searchParams.get('sig')), ['s2', 's2']);

  // A refused link: listed once more, and the new link works.
  assert.deepEqual([...(await session.fetch(three))], [7]);
  assert.equal(listings, 3);
  assert.equal(new URL(asked.at(-1)!).searchParams.get('sig'), 's3');
  // A file that a newer one replaced in the meantime is an error, not a silent skip.
  await assert.rejects(session.fetch({ ...two, source: two.source }), /no longer listed/);
  assert.equal(listings, 3);
});
