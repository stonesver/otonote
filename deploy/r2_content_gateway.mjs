/** Serve only public content keys from a private R2 bucket on /content/*. */
const release = /^\/content\/releases\/([a-f0-9]{24})\/([A-Za-z0-9_./()\-]+)$/;
const pointer = new Map([
  ['/content/current.json', 'content/current.json'],
  ['/content/global/current.json', 'content/current.json'],
  ['/content/jp/current.json', 'content/jp/current.json'],
]);

export function contentKey(pathname) {
  if (pointer.has(pathname)) return {key: pointer.get(pathname), mutable: true};
  const match = release.exec(pathname);
  if (!match) return null;
  const parts = match[2].split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
      || !['manifest.json', 'en', 'zh-CN', 'public', 'recognition'].includes(parts[0])
      || (parts[0] === 'manifest.json' && parts.length !== 1)
      || /\.(?:apk|secret|credentials)$/i.test(pathname)) return null;
  return {key: pathname.slice(1), mutable: false};
}

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, {status: 405, headers: {'Allow': 'GET, HEAD', 'Cache-Control': 'no-store'}});
    }
    const url = new URL(request.url);
    if (url.search || url.hash || /%(?:2f|5c|2e)/i.test(url.pathname)) {
      return new Response(null, {status: 404, headers: {'Cache-Control': 'no-store'}});
    }
    const allowed = contentKey(url.pathname);
    if (!allowed) return new Response(null, {status: 404, headers: {'Cache-Control': 'no-store'}});
    const requestedRange = !allowed.mutable && request.headers.has('range') && request.method === 'GET';
    const object = request.method === 'HEAD'
      ? await env.CONTENT.head(allowed.key)
      : await env.CONTENT.get(allowed.key, requestedRange ? {range: request.headers} : undefined);
    if (!object) return new Response(null, {status: 404, headers: {'Cache-Control': 'no-store'}});
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', allowed.mutable ? 'no-store' : 'public, max-age=31536000, immutable');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Accept-Ranges', 'bytes');
    if (object.range) {
      headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
      headers.set('Content-Length', String(object.range.length));
    } else {
      headers.set('Content-Length', String(object.size));
    }
    return new Response(request.method === 'HEAD' ? null : object.body,
      {status: object.range ? 206 : 200, headers});
  },
};
