'use strict';
// Mesudarim price relay: fetches one public price page or file from a chain
// that answers only Israeli addresses. Only the hosts below, only https GET.
const HOSTS = new Set(['prices.carrefour.co.il', 'shop.hazi-hinam.co.il', 'laibcatalog.co.il']);
// The answer is base64 (x4/3) and a Function URL answer is at most 6 MB.
const MAX = 4 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const json = (statusCode, error) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error }) });
const allowed = (u) => u.protocol === 'https:' && !u.port && !u.username && !u.password && HOSTS.has(u.hostname);

async function read(res) {
  if (Number(res.headers.get('content-length') || 0) > MAX) return null;
  const parts = [];
  let size = 0;
  for await (const part of res.body || []) {
    size += part.length;
    if (size > MAX) return null;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

exports.handler = async (event) => {
  const t = Date.now();
  if ((event.requestContext && event.requestContext.http && event.requestContext.http.method) !== 'POST') return json(405, 'POST only');
  let url;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
    url = new URL(JSON.parse(raw).url);
  } catch {
    return json(400, 'body must be {"url": "https://..."}');
  }
  for (let hop = 0; hop < 4; hop++) {
    if (!allowed(url)) return json(403, 'host not allowed');
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(50000) });
    } catch (e) {
      console.log(JSON.stringify({ host: url.hostname, error: String(e && e.name), ms: Date.now() - t }));
      return json(502, 'upstream unreachable');
    }
    const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (next) {
      url = new URL(next, url);
      continue;
    }
    const body = await read(res);
    console.log(JSON.stringify({ host: url.hostname, status: res.status, bytes: body ? body.length : -1, ms: Date.now() - t }));
    if (!body) return json(413, 'too large for the relay');
    return {
      statusCode: res.status,
      headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream', 'x-relay-status': String(res.status) },
      body: body.toString('base64'),
      isBase64Encoded: true,
    };
  }
  return json(508, 'too many redirects');
};
