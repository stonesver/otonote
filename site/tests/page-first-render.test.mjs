import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const layout = readFileSync(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');

test('base layout allows progressive rendering instead of render-blocking on full main HTML', () => {
  const head = layout.slice(layout.indexOf('<head>'), layout.indexOf('</head>'));
  assert.doesNotMatch(head, /<link\b[^>]*rel="expect"[^>]*blocking="render"/);
});

const { default: vm } = await import('node:vm');
const readiness = readFileSync(new URL('../src/lib/page-first-render.mjs', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ ready = false, reduced = false, motion = 'on', images = [] } = {}) {
  const listeners = new Map();
  const timers = new Map();
  const dataset = { motion };
  const document = {
    documentElement: { dataset }, readyState: ready ? 'complete' : 'loading',
    addEventListener: (name, callback) => listeners.set(name, callback),
    querySelectorAll: () => images
  };
  const window = {
    innerWidth: 1280, innerHeight: 800,
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    setTimeout: (callback, milliseconds) => { const id = Symbol(); timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(readiness, { document, window });
  return {
    dataset, timers,
    ready: () => listeners.get('DOMContentLoaded')?.(),
    reveal: transition => listeners.get('pagereveal')({ viewTransition: transition }),
    expire(milliseconds) {
      const entry = [...timers.values()].find(timer => timer.milliseconds === milliseconds);
      assert.ok(entry, `expected ${milliseconds}ms safety deadline`);
      entry.callback();
    }
  };
}
const image = (decode, top = 10) => ({
  loading: 'lazy', currentSrc: '/cover.webp', decode,
  getBoundingClientRect: () => ({ width: 200, height: 200, top, bottom: top + 200, left: 0, right: 200 })
});

test('the outgoing frame covers deferred initialization and visible image decoding', async () => {
  const decoded = deferred();
  const visible = image(() => decoded.promise);
  const belowFold = image(() => { throw new Error('must remain lazy'); }, 1000);
  const f = fixture({ images: [visible, belowFold] });
  const run = f.reveal({ finished: deferred().promise });
  assert.equal(f.dataset.navigationPending, 'true');
  f.ready(); await tick();
  assert.equal(f.dataset.navigationPending, 'true');
  assert.equal(visible.loading, 'eager');
  assert.equal(belowFold.loading, 'lazy');
  decoded.resolve(); await run;
  assert.equal(f.dataset.navigationPending, undefined);
  assert.equal(f.timers.size, 0);
});

test('stalled initialization and stalled images both release the curtain', async () => {
  const cold = fixture();
  const coldRun = cold.reveal({ finished: deferred().promise });
  cold.expire(400); await coldRun;
  assert.equal(cold.dataset.navigationPending, undefined);
  const slowImage = fixture({ ready: true, images: [image(() => deferred().promise)] });
  const imageRun = slowImage.reveal({ finished: deferred().promise });
  await tick(); slowImage.expire(150); await imageRun;
  assert.equal(slowImage.dataset.navigationPending, undefined);
});

test('direct loads, motion off and reduced motion never pause rendering', async () => {
  for (const options of [{}, { motion: 'off' }, { reduced: true }]) {
    const f = fixture(options);
    await f.reveal(Object.keys(options).length ? { finished: deferred().promise } : null);
    assert.equal(f.dataset.navigationPending, undefined);
    assert.equal(f.timers.size, 0);
  }
});

test('a cancelled transition cannot release a newer reveal of the same document', async () => {
  const f = fixture();
  const first = deferred();
  const firstRun = f.reveal({ finished: first.promise });
  const secondRun = f.reveal({ finished: deferred().promise });
  first.resolve(); await tick();
  assert.equal(f.dataset.navigationPending, 'true');
  f.ready(); await Promise.all([firstRun, secondRun]);
  assert.equal(f.dataset.navigationPending, undefined);
});

test('failed image decoding does not fail navigation', async () => {
  const f = fixture({ ready: true, images: [image(() => Promise.reject(new Error('broken image')))] });
  await f.reveal({ finished: deferred().promise });
  assert.equal(f.dataset.navigationPending, undefined);
});
