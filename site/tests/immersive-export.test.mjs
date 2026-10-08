import assert from 'node:assert/strict';
import test from 'node:test';
import { posterPng, recordCanvas, webmMimeType } from '../src/lib/immersive-export.mjs';

test('original poster PNG preserves the source image and does not use the animated canvas', async t => {
  const originalDocument = globalThis.document;
  const drawn = [];
  globalThis.document = { createElement: () => ({
    getContext: () => ({ drawImage: (...args) => drawn.push(args) }),
    toBlob: callback => callback(new Blob(['original-pixels'], { type: 'image/png' })),
  }) };
  t.after(() => { globalThis.document = originalDocument; });
  const image = { width: 512, height: 288, close() {} };
  const result = await posterPng('/scene/poster.webp', {
    fetcher: async url => { assert.equal(url, '/scene/poster.webp'); return new Response('poster'); },
    decode: async () => image,
  });
  assert.deepEqual(result.size, { width: 512, height: 288 });
  assert.equal(result.blob.type, 'image/png');
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0][0], image);
});

function recordingHarness(t) {
  let stopped = 0, instance, nextFrame;
  t.mock.method(globalThis, 'setTimeout', () => 1);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.mock.method(performance, 'now', () => 0);
  const oldRequest = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { nextFrame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { nextFrame = undefined; };
  t.after(() => {
    if (oldRequest) globalThis.requestAnimationFrame = oldRequest; else delete globalThis.requestAnimationFrame;
    if (oldCancel) globalThis.cancelAnimationFrame = oldCancel; else delete globalThis.cancelAnimationFrame;
  });
  class Recorder {
    onstart = () => {};
    onstop = () => {};
    ondataavailable = () => {};
    static isTypeSupported(type) { return type === 'video/webm;codecs=vp8'; }
    constructor() { instance = this; this.state = 'inactive'; }
    start() { this.state = 'recording'; this.onstart(); }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['recorded-frame']) });
      this.onstop();
    }
  }
  return {
    Recorder,
    canvas: { captureStream: () => ({ getTracks: () => [{ stop: () => stopped++ }] }) },
    tick: time => nextFrame(time),
    stopped: () => stopped,
    recorder: () => instance,
  };
}

test('unsupported WebM fails before capturing a stream', async () => {
  let captured = false;
  const Recorder = { isTypeSupported: () => false };
  assert.equal(webmMimeType(Recorder), null);
  await assert.rejects(recordCanvas({ captureStream() { captured = true; } }, 4, { Recorder }), /webm-unavailable/);
  assert.equal(captured, false);
});

test('a complete recording advances the animation and releases capture tracks', async t => {
  const h = recordingHarness(t), frames = [], progress = [];
  const result = recordCanvas(h.canvas, 4, { Recorder: h.Recorder, render: time => frames.push(time), progress: value => progress.push(value) });
  h.tick(2000); h.tick(4000);
  const blob = await result;
  assert.equal(blob.type, 'video/webm;codecs=vp8');
  assert.ok(blob.size > 0);
  assert.equal(frames[0], 0); assert.equal(frames[1], 2);
  assert.deepEqual(progress, [.5, 1]);
  assert.equal(h.stopped(), 1);
  assert.equal(h.recorder().state, 'inactive');
});

test('cancellation stops the recorder and rejects partial output', async t => {
  const h = recordingHarness(t), controller = new AbortController();
  const result = recordCanvas(h.canvas, 4, { Recorder: h.Recorder, signal: controller.signal, render() {} });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(h.stopped(), 1);
  assert.equal(h.recorder().state, 'inactive');
});

test('a recording error releases capture tracks', async t => {
  const h = recordingHarness(t);
  const result = recordCanvas(h.canvas, 4, { Recorder: h.Recorder, render() {} });
  h.recorder().onerror({ error: new Error('encoder-failed') });
  await assert.rejects(result, /encoder-failed/);
  assert.equal(h.stopped(), 1);
});

test('PNG export supersamples independently of preview and respects the GPU limit', async () => {
  const { pngRenderSize, pngOutputSize } = await import('../src/lib/immersive-export.mjs');
  assert.deepEqual(pngRenderSize(8192), { width: 5760, height: 3240 });
  assert.deepEqual(pngRenderSize(4096), { width: 3840, height: 2160 });
  assert.deepEqual(pngOutputSize(8192), { width: 3840, height: 2160 });
  assert.deepEqual(pngOutputSize(4096), { width: 3840, height: 2160 });
  assert.deepEqual(pngOutputSize(2048), { width: 1920, height: 1080 });
  assert.deepEqual(pngRenderSize(2048), { width: 1920, height: 1080 });
  assert.throws(() => pngOutputSize(1024), /png-resolution-unavailable/);
  assert.throws(() => pngRenderSize(1024), /png-resolution-unavailable/);
});
