import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import gateway, {contentKey} from '../../deploy/r2_content_gateway.mjs';

const id = 'a'.repeat(24);

test('gateway admits only pointer and immutable public keys', () => {
  assert.deepEqual(contentKey('/content/global/current.json'), {key: 'content/current.json', mutable: true});
  assert.deepEqual(contentKey(`/content/releases/${id}/en/catalog.json`),
    {key: `content/releases/${id}/en/catalog.json`, mutable: false});
  for (const path of [`/content/releases/${id}/.receipt.json`, `/content/releases/${id}/private/key.json`,
    `/content/releases/${id}/en/../secret.json`, '/content/promotions/global/run.json', '/content/jp/previous.json']) {
    assert.equal(contentKey(path), null);
  }
});

test('gateway serves current without cache and supports media ranges', async () => {
  const calls = [];
  const object = {
    body: new TextEncoder().encode('hello'), size: 5, httpEtag: '"one"',
    writeHttpMetadata(headers) { headers.set('Content-Type', 'text/plain'); },
  };
  const env = {CONTENT: {
    async get(key, options) { if (key.startsWith('content/storage/')) return null; calls.push([key, options]); return object; },
    async head(key) { calls.push([key, 'head']); return object; },
  }};
  const pointer = await gateway.fetch(new Request('https://ournotes.stonebg.cn/content/current.json'), env);
  assert.equal(pointer.status, 200);
  assert.equal(pointer.headers.get('Cache-Control'), 'no-store');
  const media = await gateway.fetch(new Request(`https://ournotes.stonebg.cn/content/releases/${id}/public/media/x.webp`,
    {headers: {Range: 'bytes=0-2'}}), env);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(calls[1][1].range.get('Range'), 'bytes=0-2');
  const head = await gateway.fetch(new Request('https://ournotes.stonebg.cn/content/jp/current.json', {method: 'HEAD'}), env);
  assert.equal(head.status, 200);
  assert.equal(calls[2][1], 'head');
});

test('gateway refuses writes, query strings and internal release files', async () => {
  const env = {CONTENT: {get() {throw Error('unexpected read');}, head() {throw Error('unexpected read');}}};
  const post = await gateway.fetch(new Request('https://ournotes.stonebg.cn/content/current.json', {method: 'POST'}), env);
  assert.equal(post.status, 405);
  const query = await gateway.fetch(new Request('https://ournotes.stonebg.cn/content/current.json?debug=1'), env);
  assert.equal(query.status, 404);
  const privateObject = await gateway.fetch(new Request(`https://ournotes.stonebg.cn/content/releases/${id}/.receipt.json`), env);
  assert.equal(privateObject.status, 404);
});

test('full-span R2 metadata does not make ordinary GET or HEAD partial', async () => {
  const object = {body: new TextEncoder().encode('{}\n'), size: 3,
    httpEtag: '"one"', range: {offset: 0, length: 3},
    writeHttpMetadata(headers) {headers.set('Content-Type', 'application/json');}};
  const env = {CONTENT: {async get() {return object;}, async head() {return object;}}};
  for (const path of ['/content/current.json', `/content/releases/${id}/en/catalog.json`]) {
    for (const method of ['GET', 'HEAD']) {
      const result = await gateway.fetch(new Request('https://example.org' + path, {method}), env);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('Content-Range'), null);
      assert.equal(result.headers.get('Content-Length'), '3');
      assert.equal(await result.text(), method === 'GET' ? '{}\n' : '');
    }
  }
  const pointer = await gateway.fetch(new Request('https://example.org/content/current.json',
    {headers: {Range: 'bytes=0-1'}}), env);
  assert.equal(pointer.status, 200);
  assert.equal(pointer.headers.get('Content-Range'), null);
});


const hash = data => createHash('sha256').update(data).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
function sharedFixture() {
  const objects = new Map();
  const calls = [];
  const path = 'public/live2d/model/texture.png';
  const data = Buffer.from('abcdef');
  const manifest = encode({schemaVersion: 1, root: `/content/releases/${id}/`});
  const entry = {sha256: hash(data), bytes: data.length, etag: '"verified"', contentType: 'image/png'};
  const h = hash(path)[0];
  const modelPath = 'public/live2d/model/model3.json';
  const modelData = Buffer.from('{"FileReferences":{"Textures":["texture.png"]}}');
  const modelEntry = {sha256: hash(modelData), bytes: modelData.length, etag: '"verified"', contentType: 'application/json'};
  const filesByShard = {[h]: {[path]: entry}};
  const modelH = hash(modelPath)[0];
  (filesByShard[modelH] ??= {})[modelPath] = modelEntry;
  const descriptor = {schemaVersion: 1, layout: 'shared-media-v1', releaseId: id,
    manifestSha256: hash(manifest), inventorySha256: 'b'.repeat(64),
    shards: {}};
  for (const [prefix, files] of Object.entries(filesByShard)) {
    const shard = encode({schemaVersion: 1, releaseId: id, files});
    descriptor.shards[prefix] = {sha256: hash(shard), bytes: shard.length};
    objects.set(`content/storage/${id}/${prefix}.json`, shard);
  }
  const descriptorKey = `content/storage/${id}/descriptor.json`;
  objects.set(descriptorKey, encode(descriptor));
  objects.set(`content/releases/${id}/manifest.json`, manifest);
  objects.set(`content/blobs/${entry.sha256}`, data);
  objects.set(`content/blobs/${modelEntry.sha256}`, modelData);
  const bucket = {
    async get(key, options) {
      calls.push([key, 'get']);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const range = options?.range ? {offset: 1, length: 3} : null;
      const body = range ? bytes.subarray(1, 4) : bytes;
      return {size: bytes.length, httpEtag: '"verified"', range,
        body: new ReadableStream({start(controller) {controller.enqueue(body); controller.close();}}),
        writeHttpMetadata(headers) {headers.set('Content-Type', 'application/octet-stream');}};
    },
    async head(key) {
      calls.push([key, 'head']);
      const bytes = objects.get(key);
      return bytes ? {size: bytes.length, httpEtag: '"verified"', writeHttpMetadata() {}} : null;
    },
  };
  const env = {CONTENT: bucket};
  const url = `https://ournotes.stonebg.cn/content/releases/${id}/${path}`;
  return {env, objects, calls, path, data, entry, descriptor, descriptorKey, url, h};
}

test('shared media keeps logical URL and MIME, including range and HEAD', async () => {
  const f = sharedFixture();
  const response = await gateway.fetch(new Request(f.url), f.env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'abcdef');
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(response.headers.get('Location'), null);
  const controls = f.calls.filter(([key]) => key.startsWith('content/storage/')).length;
  const range = await gateway.fetch(new Request(f.url, {headers: {Range: 'bytes=1-3'}}), f.env);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), 'bytes 1-3/6');
  assert.equal(await range.text(), 'bcd');
  const head = await gateway.fetch(new Request(f.url, {method: 'HEAD'}), f.env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '6');
  assert.equal(await head.text(), '');
  assert.equal(f.calls.filter(([key]) => key.startsWith('content/storage/')).length, controls);
  assert.ok(f.calls.some(([key, method]) => key === `content/blobs/${f.entry.sha256}` && method === 'head'));
});

test('shared media refuses invalid descriptor, manifest, shards and object identity', async () => {
  for (const mutate of [
    f => f.objects.set(f.descriptorKey, encode({...f.descriptor, releaseId: 'c'.repeat(24)})),
    f => f.objects.set(`content/releases/${id}/manifest.json`, Buffer.from('changed')),
    f => f.objects.delete(`content/storage/${id}/${f.h}.json`),
    f => f.objects.set(`content/storage/${id}/${f.h}.json`, Buffer.from('{}')),
    f => f.objects.set(`content/blobs/${f.entry.sha256}`, Buffer.from('wrong length')),
    f => {const head = f.env.CONTENT.head; f.env.CONTENT.head = async key => ({...await head(key), httpEtag: '"other"'});},
  ]) {
    const f = sharedFixture();
    f.objects.set(`content/releases/${id}/${f.path}`, Buffer.from('must not fall back'));
    mutate(f);
    const response = await gateway.fetch(new Request(f.url, {method: 'HEAD'}), f.env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(!f.calls.some(([key]) => key === `content/releases/${id}/${f.path}`));
  }
});

test('shared media has no negative descriptor cache and locale JSON remains direct', async () => {
  const f = sharedFixture();
  const descriptor = f.objects.get(f.descriptorKey);
  f.objects.delete(f.descriptorKey);
  f.objects.set(`content/releases/${id}/${f.path}`, Buffer.from('legacy'));
  const legacy = await gateway.fetch(new Request(f.url), f.env);
  assert.equal(await legacy.text(), 'legacy');
  f.objects.set(f.descriptorKey, descriptor);
  const shared = await gateway.fetch(new Request(f.url), f.env);
  assert.equal(await shared.text(), 'abcdef');
  const jsonPath = `content/releases/${id}/en/catalog.json`;
  f.objects.set(jsonPath, Buffer.from('{"FileReferences":{"Textures":["texture.png"]}}'));
  const model = await gateway.fetch(new Request(`https://ournotes.stonebg.cn/${jsonPath}`), f.env);
  assert.equal(model.status, 200);
  assert.match(await model.text(), /texture.png/);
});

test('shared storage internals and missing mapped paths are not exposed', async () => {
  const f = sharedFixture();
  for (const path of [f.descriptorKey, `content/storage/${id}/${f.h}.json`, `content/blobs/${f.entry.sha256}`]) {
    assert.equal((await gateway.fetch(new Request(`https://ournotes.stonebg.cn/${path}`), f.env)).status, 404);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await gateway.fetch(new Request(f.url.replace('texture.png', 'missing.png')), f.env)).status, 404);
});

test('oversized storage controls fail closed before media lookup', async () => {
  for (const declared of [4 * 1024 * 1024 + 1, 1]) {
    const f = sharedFixture();
    const get = f.env.CONTENT.get;
    let cancelled = false;
    f.env.CONTENT.get = async (key, options) => key !== f.descriptorKey ? get(key, options) : {
      size: declared,
      body: new ReadableStream({
        start(controller) {controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));},
        cancel() {cancelled = true;},
      }),
    };
    const response = await gateway.fetch(new Request(f.url), f.env);
    assert.equal(response.status, 503);
    assert.equal(cancelled, true);
    assert.equal(f.calls.length, 0);
  }
});


test('shared Live2D JSON preserves relative texture references at the logical URL', async () => {
  const f = sharedFixture();
  const modelUrl = f.url.replace('texture.png', 'model3.json');
  const response = await gateway.fetch(new Request(modelUrl), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('Location'), null);
  const model = await response.json();
  assert.deepEqual(model.FileReferences.Textures, ['texture.png']);
  const textureUrl = new URL(model.FileReferences.Textures[0], modelUrl);
  assert.equal(textureUrl.href, f.url);
  const texture = await gateway.fetch(new Request(textureUrl), f.env);
  assert.equal(await texture.text(), 'abcdef');
});

function replaceShardFiles(f, files) {
  const bytes = encode({schemaVersion: 1, releaseId: id, files});
  f.objects.set(`content/storage/${id}/${f.h}.json`, bytes);
  f.descriptor.shards[f.h] = {sha256: hash(bytes), bytes: bytes.length};
  f.objects.set(f.descriptorKey, encode(f.descriptor));
}
function sameShardPath(f) {
  for (let i = 0; ; i++) {
    const path = `public/media/other-${i}.webp`;
    if (hash(path)[0] === f.h) return path;
  }
}

test('shared lookup validates only the requested entry in a large authenticated shard', async () => {
  const f = sharedFixture();
  const files = Object.fromEntries(Array.from({length: 10000}, (_, i) => [`public/media/unrelated-${i}.webp`, f.entry]));
  // A malformed unrelated record cannot break access to the requested object.
  // It remains inaccessible itself, and the complete control body is SHA-bound.
  files[sameShardPath(f)] = {sha256: '../../private/credentials'};
  files['private/credentials.json'] = f.entry;
  files[f.path] = f.entry;
  replaceShardFiles(f, files);
  const result = await gateway.fetch(new Request(f.url, {headers: {Range: 'bytes=1-3'}}), f.env);
  assert.equal(result.status, 206);
  assert.equal(await result.text(), 'bcd');
  assert.equal(result.headers.get('Content-Range'), 'bytes 1-3/6');
  const calls = f.calls.length;
  const privateResult = await gateway.fetch(new Request(`https://example.org/content/releases/${id}/private/credentials.json`), f.env);
  assert.equal(privateResult.status, 404);
  assert.equal(f.calls.length, calls);
});

test('every requested entry is validated on cached shard hits without direct fallback', async () => {
  for (const invalid of [null, [], {}, {bytes: -1}, {bytes: 1.5}, {bytes: Number.MAX_SAFE_INTEGER + 1},
    {sha256: '../private/secret'}, {sha256: 1}, {etag: 'unquoted'}, {etag: '"bad\\etag"'},
    {contentType: 'text/plain; charset=utf-8'}, {contentType: 1}, {unexpected: true}]) {
    const f = sharedFixture();
    const other = sameShardPath(f);
    replaceShardFiles(f, {[f.path]: f.entry, [other]: invalid === null || Array.isArray(invalid) ? invalid : {...f.entry, ...invalid}});
    if (invalid && !Array.isArray(invalid) && !Object.keys(invalid).length) {
      replaceShardFiles(f, {[f.path]: f.entry, [other]: {}});
    }
    assert.equal((await gateway.fetch(new Request(f.url, {method: 'HEAD'}), f.env)).status, 200);
    const controlReads = f.calls.filter(([key]) => key.startsWith('content/storage/')).length;
    const mediaReads = f.calls.filter(([key]) => key.startsWith('content/blobs/')).length;
    const url = `https://example.org/content/releases/${id}/${other}`;
    f.objects.set(`content/releases/${id}/${other}`, Buffer.from('must not fall back'));
    const response = await gateway.fetch(new Request(url), f.env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(f.calls.filter(([key]) => key.startsWith('content/storage/')).length, controlReads);
    assert.equal(f.calls.filter(([key]) => key.startsWith('content/blobs/')).length, mediaReads);
    assert.ok(!f.calls.some(([key]) => key === `content/releases/${id}/${other}`));
  }
});

test('lazy entries retain shard identity, schema and entry-count boundaries', async () => {
  for (const patch of [{releaseId: 'c'.repeat(24)}, {schemaVersion: 2}, {files: []},
    {files: Object.fromEntries(Array.from({length: 100001}, (_, i) => [`x${i}`, null]))}]) {
    const f = sharedFixture();
    const bytes = encode({schemaVersion: 1, releaseId: id, files: {[f.path]: f.entry}, ...patch});
    f.objects.set(`content/storage/${id}/${f.h}.json`, bytes);
    f.descriptor.shards[f.h] = {sha256: hash(bytes), bytes: bytes.length};
    f.objects.set(f.descriptorKey, encode(f.descriptor));
    const response = await gateway.fetch(new Request(f.url), f.env);
    assert.equal(response.status, 503);
    assert.ok(!f.calls.some(([key]) => key.startsWith('content/blobs/')));
  }
});
