import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_THEME, THEME_PRESETS } from '../src/lib/theme-presets.mjs';

function luminance(hex) {
  const value = hex.slice(1);
  const full = value.length === 3 ? [...value].map(char => char + char).join('') : value;
  const channels = [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first, second) {
  const [dark, light] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (light + 0.05) / (dark + 0.05);
}

test('paper preserves the CSS defaults and every preset overrides the same base palette', () => {
  const css = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const defaults = Object.fromEntries([...css.matchAll(/--theme-([\w-]+):\s*(#[\da-f]+|light|dark)\s*;/g)].map(([, key, value]) => [key, value]));
  assert.equal(DEFAULT_THEME, 'paper');
  assert.deepEqual(THEME_PRESETS.find(theme => theme.id === DEFAULT_THEME).tokens, defaults);
  for (const theme of THEME_PRESETS) {
    assert.deepEqual(Object.keys(theme.tokens).sort(), Object.keys(defaults).sort(), theme.id);
  }
});

for (const theme of THEME_PRESETS) {
  test(`${theme.id} keeps text and solid-button labels at WCAG AA contrast`, () => {
    const pairs = [];
    for (const background of ['canvas', 'surface', 'surface-deep']) {
      for (const foreground of ['text', 'text-soft', 'muted', 'accent', 'secondary-ink', 'warning-ink', 'success-ink', 'danger-ink']) {
        pairs.push([foreground, background]);
      }
    }
    for (const background of ['accent', 'accent-bright', 'secondary-ink', 'warning', 'success', 'danger']) {
      pairs.push(['on-accent', background]);
    }
    pairs.push(['inverse-text', 'inverse-surface'], ['inverse-muted', 'inverse-surface'], ['media-text', 'media-shade']);
    for (const [foreground, background] of pairs) {
      const ratio = contrast(theme.tokens[foreground], theme.tokens[background]);
      assert.ok(ratio >= 4.5, `${theme.id}: ${foreground} / ${background} = ${ratio.toFixed(2)}:1`);
    }
  });
}
