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

test('the collection offers twelve light palettes and keeps night as the sole dark choice', () => {
  const light = THEME_PRESETS.filter(theme => theme.tokens['color-scheme'] === 'light');
  const dark = THEME_PRESETS.filter(theme => theme.tokens['color-scheme'] === 'dark');
  assert.equal(light.length, 12);
  assert.deepEqual(dark.map(theme => [theme.id, theme.group]), [['night', 'dark']]);
  for (const theme of light) {
    assert.ok(luminance(theme.tokens.canvas) >= 0.82, `${theme.id} must have a bright canvas`);
    assert.ok(luminance(theme.tokens.surface) >= 0.93, `${theme.id} must have a bright content surface`);
  }
});

test('attribute-inspired palettes retain the five game attribute codes and names', () => {
  const attributes = THEME_PRESETS.filter(theme => theme.group === 'attribute');
  const expected = [
    ['attribute-red', 1, '红赤'], ['attribute-azure', 2, '绀碧'], ['attribute-jade', 3, '翡翠'],
    ['attribute-gold', 4, '山吹'], ['attribute-violet', 5, '紫苑'],
  ];
  assert.deepEqual(attributes.map(theme => [theme.id, theme.attribute]), expected.map(([id, code]) => [id, code]));
  for (const [id, , name] of expected) {
    const theme = attributes.find(item => item.id === id);
    assert.equal(theme.name['zh-CN'], name);
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
    pairs.push(['on-secondary', 'secondary'], ['inverse-text', 'inverse-surface'], ['inverse-muted', 'inverse-surface'], ['media-text', 'media-shade']);
    for (const [foreground, background] of pairs) {
      const ratio = contrast(theme.tokens[foreground], theme.tokens[background]);
      assert.ok(ratio >= 4.5, `${theme.id}: ${foreground} / ${background} = ${ratio.toFixed(2)}:1`);
    }
  });
}
