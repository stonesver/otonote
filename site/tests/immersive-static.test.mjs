import test from 'node:test';
import assert from 'node:assert/strict';
import { initImmersiveScenes } from '../src/lib/immersive-browser.mjs';

test('an unverified scene keeps its poster and downloads that poster before animation loads', async t => {
  const previous = Object.fromEntries(['document', 'fetch', 'createImageBitmap', 'addEventListener'].map(key => [key, globalThis[key]]));
  const previousCreateURL = URL.createObjectURL;
  const previousRevokeURL = URL.revokeObjectURL;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
    URL.createObjectURL = previousCreateURL;
    URL.revokeObjectURL = previousRevokeURL;
  });
  let clickHandler, downloads = 0, requested;
  const button = { disabled: false, addEventListener(_name, handler) { clickHandler = handler; } };
  const status = { textContent: '' };
  const download = { hidden: true, dataset: {}, click() { downloads++; } };
  const root = { dataset: { locale: 'zh-CN', compact: 'false', sceneId: '10001', cameraVerified: 'false', posterSrc: '/scene/poster.webp' },
    querySelector(selector) { return ({ '[data-scene-export="png"]': button, '[data-scene-status]': status,
      '[data-scene-download]': download })[selector] ?? null; } };
  globalThis.document = { querySelectorAll: () => [root], createElement: () => ({
    getContext: () => ({ drawImage() {} }), toBlob: callback => callback(new Blob(['poster'], { type: 'image/png' })),
  }) };
  globalThis.fetch = async url => { requested = url; return new Response('poster'); };
  globalThis.createImageBitmap = async () => ({ width: 512, height: 288, close() {} });
  globalThis.addEventListener = () => {};
  URL.createObjectURL = () => 'blob:poster'; URL.revokeObjectURL = () => {};

  initImmersiveScenes();
  assert.equal(root.dataset.initialized, 'true');
  await clickHandler();
  assert.equal(requested, '/scene/poster.webp');
  assert.equal(download.download, 'otonote-scene-10001-original-512x288.png');
  assert.equal(downloads, 1);
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /游戏原图 PNG 已生成/);
});
