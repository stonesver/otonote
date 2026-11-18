import assert from 'node:assert/strict';
import test from 'node:test';
import { Color as ThreeColor } from 'three';
import { Color as PixiColor } from 'pixi.js';
import { readThemePalette, observeTheme } from '../src/lib/theme-palette.mjs';

function themeDocument() {
  let observed, disconnected = false, nextFrame = 1;
  const frames = new Map();
  const canvasCalls = [], pixels = new Map();
  const colors = { '--theme-text': 'rgb(17, 19, 27)', '--theme-accent': 'rgb(122, 49, 85)' };
  const root = { children: [], appendChild(node) { this.children.push(node); node.parent = this; } };
  const ownerDocument = {
    documentElement: root,
    createElement: tag => tag === 'canvas' ? {
      getContext(type, options) {
        canvasCalls.push(['context', type, options, this.width, this.height]);
        return {
          clearRect(...rect) { canvasCalls.push(['clear', ...rect]); },
          fillRect(...rect) { canvasCalls.push(['fill', this.fillStyle, ...rect]); },
          getImageData() { return {data:pixels.get(this.fillStyle)}; },
        };
      },
    } : ({ style: {}, remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } }),
    defaultView: {
      getComputedStyle: node => ({ color: colors[node.style.color.slice(4, -1)] || 'rgb(255, 253, 247)' }),
      MutationObserver: class {
        constructor(callback) { this.callback = callback; }
        observe(target, options) { observed = { target, options, notify: () => this.callback() }; }
        disconnect() { disconnected = true; }
      },
      requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
      cancelAnimationFrame: id => frames.delete(id),
    },
  };
  root.ownerDocument = ownerDocument;
  root.isConnected = true;
  return { root, colors, frames, canvasCalls, pixels, get observed() { return observed; }, get disconnected() { return disconnected; } };
}

test('canvas palette reads resolved theme colors and removes its temporary probe', () => {
  const env = themeDocument();
  const palette = readThemePalette(env.root);
  assert.equal(palette.text, 'rgb(17, 19, 27)');
  assert.equal(palette.accent, 'rgb(122, 49, 85)');
  assert.equal(env.root.children.length, 0);
  assert.ok(Object.values(palette).every(color => !color.includes('var(')));
  assert.equal(env.canvasCalls.length, 0, 'legacy computed RGB needs no pixel conversion');
  env.colors['--theme-accent'] = 'rgb(20, 80, 140)';
  assert.equal(readThemePalette({ ownerDocument: env.root.ownerDocument, isConnected: false }).accent, 'rgb(20, 80, 140)', 'detached export canvases use the current document theme');
  assert.equal(env.root.children.length, 0);
});

test('modern CSS colors use one sRGB pixel canvas and retain alpha without blending successive colors', () => {
  const env = themeDocument();
  const mixed = 'color(srgb 0.2 0.4 0.6)', translucent = 'oklch(0.5 0.1 240 / 0.5)';
  env.colors['--theme-accent'] = mixed;
  env.colors['--theme-chart-1'] = mixed;
  env.colors['--theme-surface'] = translucent;
  env.pixels.set(mixed, new Uint8ClampedArray([51, 102, 153, 255]));
  env.pixels.set(translucent, new Uint8ClampedArray([31, 106, 150, 128]));
  const palette = readThemePalette(env.root);
  assert.equal(palette.accent, 'rgb(51, 102, 153)');
  assert.equal(new ThreeColor(palette.accent).getHexString(), '336699');
  assert.equal(new PixiColor(palette.accent).toHex(), '#336699');
  assert.equal(palette.chart1, palette.accent);
  assert.equal(palette.surface, `rgba(31, 106, 150, ${128 / 255})`);
  assert.deepEqual(env.canvasCalls, [
    ['context', '2d', {colorSpace:'srgb', willReadFrequently:true}, 1, 1],
    ['clear', 0, 0, 1, 1], ['fill', translucent, 0, 0, 1, 1],
    ['clear', 0, 0, 1, 1], ['fill', mixed, 0, 0, 1, 1],
  ]);
  assert.equal(env.root.children.length, 0);
});

test('theme mutations redraw a paused graphic once with fresh colors and cleanup cancels queued work', () => {
  const env = themeDocument(), drawn = [];
  const disconnect = observeTheme(env.root, () => drawn.push(readThemePalette(env.root).accent));
  assert.equal(env.observed.target, env.root);
  assert.deepEqual(env.observed.options.attributeFilter, ['style', 'class', 'data-theme', 'data-site-theme']);
  env.observed.notify();
  env.colors['--theme-accent'] = 'rgb(20, 80, 140)';
  env.observed.notify();
  assert.equal(env.frames.size, 1);
  const [id, redraw] = env.frames.entries().next().value;
  env.frames.delete(id); redraw();
  assert.deepEqual(drawn, ['rgb(20, 80, 140)']);
  env.observed.notify();
  disconnect();
  assert.equal(env.disconnected, true);
  assert.equal(env.frames.size, 0);
  assert.equal(drawn.length, 1);
});
