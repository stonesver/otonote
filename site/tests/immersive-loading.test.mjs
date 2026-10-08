import test from 'node:test';
import assert from 'node:assert/strict';
import { loadImmersiveAssets, loadImmersivePreview } from '../src/lib/immersive-loading.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const data = { nodes: Array.from({ length: 6 }, (_, i) => ({ spine: `cast-${i}`, spineFormat: i === 0 ? 'binary' : 'json' })) };
  // One skeleton is referenced twice, but must only be downloaded once.
  data.nodes.push(data.nodes[1]);
  const assets = Object.fromEntries(['background.webp', 'characters.webp', 'characters.atlas',
    ...data.nodes.map(node => `${node.spine}.${node.spineFormat === 'binary' ? 'skel' : 'json'}`)].map(file => [file, '12345678']));
  const manifest = { files: [...Object.entries(assets).map(([path, value]) => ({ path, bytes: value.length })),
    { path: 'poster.webp', bytes: 200 }] };
  const metadata = { 'scene.json': JSON.stringify(data), 'manifest.json': JSON.stringify(manifest) };
  return { data, assets, metadata };
}

test('resources overlap with a maximum of four, share duplicate files, and report streamed bytes', async () => {
  const { assets, metadata } = fixture(), calls = [], progress = [];
  let active = 0, peak = 0;
  const result = await loadImmersiveAssets('/scene/', { onProgress: value => progress.push(value), fetcher: async url => {
    const file = url.slice('/scene/'.length); calls.push(file);
    if (metadata[file]) return new Response(metadata[file]);
    active++; peak = Math.max(peak, active);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(assets[file].slice(0, 4)));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(assets[file].slice(4))); active--; controller.close();
      }, 10);
    } }));
  } });
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.equal(result.blobs.size, 9);
  assert.equal(result.manifest.files.length, 10);
  assert.equal(calls.filter(file => file === 'cast-1.json').length, 1);
  assert.ok(!calls.includes('poster.webp'));
  assert.equal(await result.blobs.get('cast-0.skel').text(), assets['cast-0.skel']);
  const downloads = progress.filter(p => p.phase === 'download');
  assert.ok(downloads.some(p => p.loaded > 0 && p.loaded < 8));
  assert.ok(downloads.every((p, i) => i === 0 || p.loaded >= downloads[i - 1].loaded));
  assert.deepEqual(downloads.at(-1), { phase: 'download', loaded: 72, total: 72 });
});

test('resource failure aborts in-flight peers, stops queued requests, and permits retry', async () => {
  const { assets, metadata } = fixture();
  let started = 0, cancelled = 0;
  await assert.rejects(loadImmersiveAssets('/scene/', { fetcher: async (url, { signal }) => {
    const file = url.slice('/scene/'.length);
    if (metadata[file]) return new Response(metadata[file]);
    started++;
    if (started === 1) { await tick(); return new Response('', { status: 503 }); }
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      cancelled++; reject(signal.reason);
    }, { once: true }));
  } }), /HTTP 503/);
  assert.equal(started, 4); assert.equal(cancelled, 3);
  const retry = await loadImmersiveAssets('/scene/', {
    fetcher: async url => new Response(metadata[url.slice(7)] ?? assets[url.slice(7)])
  });
  assert.equal(retry.blobs.size, 9);
});

test('cancelling a download aborts every active request and emits no later progress', async () => {
  const { metadata } = fixture(), controller = new AbortController(), progress = [];
  let started = 0, cancelled = 0;
  const pending = loadImmersiveAssets('/scene/', { signal: controller.signal, onProgress: value => progress.push(value),
    fetcher: async (url, { signal }) => {
      const file = url.slice(7);
      if (metadata[file]) return new Response(metadata[file]);
      started++;
      return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled++; reject(signal.reason); }, { once: true }));
    } });
  await tick(); assert.equal(started, 4);
  const count = progress.length; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, 4); assert.equal(progress.length, count);
});

test('invalid lengths fail instead of presenting a truncated scene as ready', async () => {
  const { metadata } = fixture();
  await assert.rejects(loadImmersiveAssets('/scene/', {
    fetcher: async url => new Response(metadata[url.slice(7)] ?? 'short')
  }), /Resource size mismatch/);
});

test('published shared textures and explicit atlas maps load once with their manifest sizes', async () => {
  const { data, assets, metadata } = fixture(), calls = [];
  data.textures = { background: '../shared/background.webp', cast: '../shared/cast.webp', reused: '../shared/cast.webp' };
  data.atlases = { cast: { file: 'characters.atlas', pages: { 'cast.png': 'cast' } } };
  assets['../shared/background.webp'] = assets['background.webp']; delete assets['background.webp'];
  assets['../shared/cast.webp'] = assets['characters.webp']; delete assets['characters.webp'];
  metadata['scene.json'] = JSON.stringify(data);
  metadata['manifest.json'] = JSON.stringify({ files: Object.entries(assets).map(([path, value]) => ({ path, bytes: value.length })) });
  const result = await loadImmersiveAssets('/scene/', { fetcher: async url => {
    const file = url.slice(7); calls.push(file); return new Response(metadata[file] ?? assets[file]);
  } });
  assert.equal(result.blobs.size, 9);
  assert.equal(calls.filter(file => file === '../shared/cast.webp').length, 1);
  assert.equal(result.blobs.get('../shared/background.webp').size, 8);
});

test('renderer and scene start together; runtime failure cancels resources', async () => {
  const calls = []; let aborted = false;
  await assert.rejects(loadImmersivePreview('/scene/', {
    loadAssets: (_, { signal }) => {
      calls.push('assets');
      return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    },
    loadRenderer: async () => { calls.push('renderer'); await tick(); throw Error('runtime unavailable'); },
  }), /runtime unavailable/);
  assert.deepEqual(calls, ['assets', 'renderer']); assert.ok(aborted);
});

test('cancel leaves a pending module import safely observed, even after assets completed', async () => {
  const controller = new AbortController(); let rejectModule;
  const pending = loadImmersivePreview('/scene/', { signal: controller.signal,
    loadAssets: async () => ({}), loadRenderer: () => new Promise((_, reject) => { rejectModule = reject; }) });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  rejectModule(Error('late import failure')); await tick();
});

test('already cancelled loads start no requests', async () => {
  const controller = new AbortController(); controller.abort();
  const unexpected = () => { throw Error('started'); };
  await assert.rejects(loadImmersiveAssets('/', { signal: controller.signal, fetcher: unexpected }), { name: 'AbortError' });
  await assert.rejects(loadImmersivePreview('/', { signal: controller.signal, loadAssets: unexpected, loadRenderer: unexpected }), { name: 'AbortError' });
});
