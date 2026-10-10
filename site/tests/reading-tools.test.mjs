import test from 'node:test';
import assert from 'node:assert/strict';
import { chartLoopRange, chartPlaybackFromSearch, chartPlaybackUrl } from '../src/lib/chart-playback-state.mjs';
import { findStoryLines, stepStoryMatch } from '../src/lib/story-reader-search.mjs';

test('chart loops reject incomplete, reversed, nonfinite and unplayably short ranges', () => {
  for (const [start, end, duration] of [[null, 5, 100], [0, '', 100], [5, 4, 100], [3, 3.1, 100], [0, Infinity, 100], [0, 5, 0]]) {
    assert.equal(chartLoopRange(start, end, duration), null);
  }
  assert.deepEqual(chartLoopRange(-1, 500, 100), { start: 0, end: 100 });
  assert.deepEqual(chartLoopRange(0, 0.25, 100), { start: 0, end: 0.25 });
  assert.deepEqual(chartLoopRange(0.1, 0.35, 100), { start: 0.1, end: 0.35 });
});

test('shared playback links preserve server, difficulty and loop across a reload', () => {
  const href = 'https://local.invalid/global/zh-CN/music/music-1/?server=global-en&unused=ok#old';
  const url = chartPlaybackUrl(href, { time: 12.25, difficulty: 'hard', loop: { start: 10, end: 14.5 } });
  assert.equal(url.pathname, '/global/zh-CN/music/music-1/');
  assert.equal(url.searchParams.get('server'), 'global-en');
  assert.equal(url.searchParams.get('view'), 'playback');
  assert.equal(url.searchParams.get('difficulty'), 'hard');
  assert.equal(url.hash, '');
  assert.deepEqual(chartPlaybackFromSearch(url.search, 100), { time: 12.25, loop: { start: 10, end: 14.5 } });
  const cleared = chartPlaybackUrl(url, { time: 20, difficulty: 'expert', loop: null });
  assert.equal(cleared.searchParams.has('loopStart'), false);
  assert.equal(cleared.searchParams.has('loopEnd'), false);
  assert.deepEqual(chartPlaybackFromSearch('?t=Infinity&loopStart=10&loopEnd=3', 100), { time: 0, loop: null });
});

test('story search keeps original indexes, supports Unicode and combines speaker with all query words', () => {
  const lines = [
    { speaker: '', text: '街角' },
    { speaker: '愛音', text: 'ＨＥＬＬＯ world！' },
    { speaker: '燈', text: 'Hello again' },
    { speaker: '愛音', text: 'ありがとう' },
  ];
  assert.deepEqual(findStoryLines(lines, ''), []);
  assert.deepEqual(findStoryLines(lines, 'hello'), [1, 2]);
  assert.deepEqual(findStoryLines(lines, 'WORLD hello', '愛音'), [1]);
  assert.deepEqual(findStoryLines(lines, '', '愛音'), [1, 3]);
  assert.deepEqual(findStoryLines(lines, 'hello', 'unknown'), []);
  assert.deepEqual(findStoryLines(lines, '街角'), [0]);
  assert.deepEqual(findStoryLines([{speaker:'立希 / 睦',text:'……'}], '', '睦'), [0]);
  assert.equal(lines.length, 4);
});

test('dialogue navigation wraps and handles no matches', () => {
  assert.equal(stepStoryMatch(0, -1, 3), 2);
  assert.equal(stepStoryMatch(2, 1, 3), 0);
  assert.equal(stepStoryMatch(-1, 1, 3), 0);
  assert.equal(stepStoryMatch(-1, -1, 3), 2);
  assert.equal(stepStoryMatch(-1, 1, 0), -1);
});
