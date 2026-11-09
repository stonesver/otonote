import test from 'node:test';
import assert from 'node:assert/strict';
import { addArenaSongs, createArenaSongPicker } from '../src/lib/arena-song-picker.mjs';

const tracks = Array.from({ length: 8 }, (_, i) => ({ id: `music-${i}`, title: `Song ${i}` }));
const charts = tracks.flatMap(track => ['easy', 'hard', 'expert'].map(difficulty => ({ trackId: track.id, difficulty, displayLevel: 20, analysisDataUrl: '/chart' })));

test('bulk add includes a whole band, keeps existing weights and difficulties, and is idempotent', () => {
  const before = [{ trackId: 'music-0', title: 'Song 0', difficulty: 'easy', weight: 3 }];
  const added = addArenaSongs(before, tracks, charts, 'hard');
  assert.equal(added.length, 8); assert.deepEqual(added[0], before[0]);
  assert.ok(added.slice(1).every(song => song.difficulty === 'hard' && song.weight === 1));
  assert.deepEqual(addArenaSongs(added, tracks, charts, 'expert'), added);
  assert.equal(before.length, 1);
  assert.equal(addArenaSongs([], tracks.slice(0, 1), charts.filter(c => c.difficulty !== 'hard'), 'hard')[0].difficulty, 'expert');
});

class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.value = ''; this.open = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector() { return null; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

test('picker stays open, reflects selections, applies bulk difficulty and removes filtered songs', t => {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  let selected;
  const picker = createArenaSongPicker({ charts, onChange: songs => { selected = songs; } });
  const nodes = () => { const visit = node => [node, ...node.children.flatMap(visit)]; return visit(picker.element); };
  const click = text => nodes().find(node => node.tagName === 'button' && node.textContent === text).dispatchEvent(new Event('click'));
  picker.open(tracks, [], 'Band');
  nodes().find(n => n.attributes['aria-label'] === 'Song 0 EASY 20').dispatchEvent(new Event('click'));
  assert.equal(picker.element.open, true); assert.equal(selected[0].difficulty, 'easy');
  nodes().find(n => n.attributes['aria-label'] === 'Song 1 HARD 20').dispatchEvent(new Event('click'));
  assert.equal(selected.length, 2); assert.equal(picker.element.open, true);
  click('全选当前乐队'); assert.equal(selected.length, 8); assert.equal(selected[0].difficulty, 'easy');
  nodes().find(n => n.attributes['aria-label'] === '批量难度').value = 'expert'; click('统一已选难度');
  assert.ok(selected.every(song => song.difficulty === 'expert'));
  const search = nodes().find(n => n.type === 'search'); search.value = 'Song 1'; search.dispatchEvent(new Event('input'));
  click('移除搜索结果'); assert.equal(selected.length, 7); assert.ok(selected.every(song => song.trackId !== 'music-1'));
  click('全选搜索结果'); assert.equal(selected.length, 8);
  click('完成选歌'); assert.equal(picker.element.open, false);
});
