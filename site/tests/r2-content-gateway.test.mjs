import assert from 'node:assert/strict';
import test from 'node:test';
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
    async get(key, options) { calls.push([key, options]); return object; },
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
