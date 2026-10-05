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

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CONTROL_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const bucketCaches = new WeakMap();
const utf8 = new TextEncoder();

async function hash(bytes) {
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function cacheFor(bucket) {
  if (!bucketCaches.has(bucket)) bucketCaches.set(bucket, {entries: new Map(), bytes: 0});
  return bucketCaches.get(bucket);
}

function remember(cache, key, value, bytes) {
  while (cache.entries.size >= 64 || cache.bytes + bytes > MAX_CACHE_BYTES) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) return value;
    cache.bytes -= cache.entries.get(oldest).bytes;
    cache.entries.delete(oldest);
  }
  cache.entries.set(key, {value, bytes});
  cache.bytes += bytes;
  return value;
}

async function control(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_CONTROL_BYTES) {
    await object.body?.cancel();
    throw Error('Oversized storage control object');
  }
  const reader = object.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONTROL_BYTES) throw Error('Oversized storage control object');
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (size !== object.size) throw Error('Truncated storage control object');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sharedPath(path) {
  return path.startsWith('public/');
}

async function sharedObject(bucket, id, path) {
  const cache = cacheFor(bucket);
  const descriptorKey = `content/storage/${id}/descriptor.json`;
  let descriptor = cache.entries.get(descriptorKey)?.value;
  if (!descriptor) {
    const bytes = await control(bucket, descriptorKey);
    // Never cache absence: a release may be in the middle of publication.
    if (bytes === null) return null;
    descriptor = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!record(descriptor) || descriptor.schemaVersion !== 1 || descriptor.layout !== 'shared-media-v1'
        || descriptor.releaseId !== id || (typeof descriptor.manifestSha256 !== 'string' || !SHA256.test(descriptor.manifestSha256))
        || (typeof descriptor.inventorySha256 !== 'string' || !SHA256.test(descriptor.inventorySha256)) || !record(descriptor.shards)
        || Object.keys(descriptor.shards).length > 16) throw Error('Invalid storage descriptor');
    for (const [name, shard] of Object.entries(descriptor.shards)) {
      if (!/^[a-f0-9]$/.test(name) || !record(shard) || Object.keys(shard).sort().join(',') !== 'bytes,sha256'
          || typeof shard.sha256 !== 'string' || !SHA256.test(shard.sha256)
          || !Number.isSafeInteger(shard.bytes) || shard.bytes <= 0 || shard.bytes > MAX_CONTROL_BYTES)
        throw Error('Invalid storage shard record');
    }
    const manifest = await control(bucket, `content/releases/${id}/manifest.json`);
    if (manifest === null || await hash(manifest) !== descriptor.manifestSha256)
      throw Error('Storage descriptor does not match release manifest');
    remember(cache, descriptorKey, descriptor, bytes.byteLength);
  }
  const prefix = (await hash(utf8.encode(path)))[0];
  const expected = descriptor.shards[prefix];
  if (!expected) return {missing: true};
  const shardKey = `content/storage/${id}/${prefix}.json`;
  let shard = cache.entries.get(shardKey)?.value;
  if (!shard) {
    const bytes = await control(bucket, shardKey);
    if (bytes === null || bytes.byteLength !== expected.bytes || await hash(bytes) !== expected.sha256)
      throw Error('Missing or invalid storage shard');
    shard = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!record(shard) || shard.schemaVersion !== 1 || shard.releaseId !== id || !record(shard.files)
        || Object.keys(shard.files).length > 100000) throw Error('Invalid storage shard');
    for (const [name, entry] of Object.entries(shard.files)) {
      if (!sharedPath(name) || !contentKey(`/content/releases/${id}/${name}`) || !record(entry)
          || Object.keys(entry).sort().join(',') !== 'bytes,contentType,etag,sha256'
          || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
          || typeof entry.etag !== 'string' || !/^"[A-Za-z0-9-]{1,128}"$/.test(entry.etag)
          || typeof entry.contentType !== 'string' || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(entry.contentType)
          ) throw Error('Invalid shared media entry');
    }
    remember(cache, shardKey, shard, bytes.byteLength);
  }
  const entry = Object.hasOwn(shard.files, path) ? shard.files[path] : null;
  return entry ? {...entry, key: `content/blobs/${entry.sha256}`} : {missing: true};
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
    let shared = null;
    const match = release.exec(url.pathname);
    try {
      if (match && sharedPath(match[2])) shared = await sharedObject(env.CONTENT, match[1], match[2]);
    } catch {
      return new Response(null, {status: 503, headers: {'Cache-Control': 'no-store'}});
    }
    if (shared?.missing) return new Response(null, {status: 404, headers: {'Cache-Control': 'no-store'}});
    const objectKey = shared?.key ?? allowed.key;
    const requestedRange = !allowed.mutable && request.headers.has('range') && request.method === 'GET';
    const object = request.method === 'HEAD'
      ? await env.CONTENT.head(objectKey)
      : await env.CONTENT.get(objectKey, requestedRange ? {range: request.headers} : undefined);
    if (!object) return new Response(null, {status: 404, headers: {'Cache-Control': 'no-store'}});
    if (shared && (object.size !== shared.bytes || object.httpEtag !== shared.etag)) {
      await object.body?.cancel();
      return new Response(null, {status: 503, headers: {'Cache-Control': 'no-store'}});
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (shared) headers.set('Content-Type', shared.contentType);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', allowed.mutable ? 'no-store' : 'public, max-age=31536000, immutable');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Accept-Ranges', 'bytes');
    // R2 may report the full returned span even for an ordinary GET. Only a
    // client range request can turn that metadata into an HTTP 206 response.
    const partial = requestedRange && object.range;
    if (partial) {
      headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
      headers.set('Content-Length', String(object.range.length));
    } else {
      headers.set('Content-Length', String(object.size));
    }
    return new Response(request.method === 'HEAD' ? null : object.body,
      {status: partial ? 206 : 200, headers});
  },
};
