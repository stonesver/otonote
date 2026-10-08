import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLive2DCore, OFFICIAL_CORE_URL } from '../src/lib/live2d-core.mjs';

test('a missing local Core loads the official hosted Core once', async t => {
  const originalDocument = globalThis.document;
  const originalCore = globalThis.Live2DCubismCore;
  const requested = [];
  globalThis.document = {
    createElement() { return { remove() {} }; },
    head: { append(script) {
      requested.push(script.src);
      queueMicrotask(() => {
        if (script.src === OFFICIAL_CORE_URL) {
          globalThis.Live2DCubismCore = {};
          script.onload();
        } else script.onerror();
      });
    } },
  };
  delete globalThis.Live2DCubismCore;
  t.after(() => {
    globalThis.document = originalDocument;
    if (originalCore === undefined) delete globalThis.Live2DCubismCore;
    else globalThis.Live2DCubismCore = originalCore;
  });
  await Promise.all([loadLive2DCore('/missing-core.js'), loadLive2DCore('/missing-core.js')]);
  assert.deepEqual(requested, ['/missing-core.js', OFFICIAL_CORE_URL]);
});
