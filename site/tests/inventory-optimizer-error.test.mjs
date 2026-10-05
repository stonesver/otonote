import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupInventoryOptimizer } from '../src/lib/inventory-optimizer-ui.mjs';
import { createTeamDraft } from '../src/lib/team-draft.mjs';

const rules = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
function fixture(t, locale = 'zh-CN') {
  const nodes = new Map();
  const q = selector => {
    if (selector === '[data-planning-kind]') return null;
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', dataset: {}, hidden: false, disabled: false,
      handlers: {}, children: [], addEventListener(name, listener) { this.handlers[name] = listener; },
      replaceChildren(...children) { this.children = children; } });
    return nodes.get(selector);
  };
  for (const [name, value] of Object.entries({ 'search-scope': 'selected', 'pairing-objective': 'formation_power',
    'pairing-mode': 'gekisou', 'search-constraints': '{}', 'gekisou-fps': '60', 'gekisou-offset': '0',
    'gekisou-batches': '1', 'gekisou-seed': '42' })) q(`[data-${name}]`).value = value;
  let worker;
  const previous = globalThis.Worker;
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
  };
  t.after(() => { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; });
  const workbench = { querySelector: q,
    querySelectorAll: selector => selector === '[data-gekisou-rank]' ? [{ value: 1 }, { value: 1 }, { value: 1 }] : [],
    dispatchEvent() {}, data: { formalRules: rules, locale, charts: [{ trackId: 'music-100001', difficulty: 'expert', analysisDataUrl: '/chart.json' }] },
    draft: createTeamDraft({ selectedSongId: 'music-100001', selectedDifficulty: 'expert',
      slots: [1, 2, 3, 4, 5].map(id => ({ memberCardId: `member-card-${id}`, supportCardId: `support-card-${id}` })) }) };
  setupInventoryOptimizer(workbench);
  return { q, workbench, run: () => q('[data-optimize-pairing]').handlers.click(), get worker() { return worker; } };
}
function assertStopped({ q, workbench, worker }, message) {
  assert.equal(q('[data-search-state]').dataset.running, 'false');
  assert.equal(q('[data-search-state]').textContent, message);
  assert.equal(workbench.optimizerState.running, false);
  assert.equal(workbench.optimizerState.finished, true);
  assert.equal(workbench.optimizerState.hasResults, false);
  assert.equal(q('[data-optimize-pairing]').disabled, false);
  assert.equal(q('[data-cancel-pairing]').disabled, true);
  assert.equal(q('[data-export-pairing]').disabled, true);
  assert.deepEqual(q('[data-pairing-results]').children, []);
  if (worker) assert.equal(worker.terminated, true);
}
test('unsupported worker rules end the running state and discard incomplete results', async t => {
  const context = fixture(t);
  await context.run();
  const first = context.worker;
  assert.equal(context.q('[data-search-state]').textContent, '正在寻找更好的编成');
  context.q('[data-pairing-results]').children.push('unfinished candidate');
  first.onmessage({ data: { requestId: first.message.requestId, type: 'error', error: 'Unsupported Gekisou effect 98765' } });
  assertStopped(context, '比较失败');
  assert.match(context.q('[data-pairing-progress]').textContent, /尚未支持/);
  assert.match(context.q('[data-search-diagnostics]').textContent, /98765/);
  await context.run();
  assert.notEqual(context.worker, first);
  first.onmessage({ data: { requestId: first.message.requestId, type: 'error', error: 'stale error' } });
  first.onerror();
  assert.equal(context.q('[data-search-state]').dataset.running, 'true');
});
test('worker crashes use the same completed error state in English', async t => {
  const context = fixture(t, 'en');
  await context.run();
  context.worker.onerror();
  assertStopped(context, 'Comparison failed');
  assert.doesNotMatch(context.q('[data-pairing-progress]').textContent, /[\u4e00-\u9fff]/);
});
test('chart fetch failures clear the running status before any worker starts', async t => {
  const context = fixture(t);
  context.q('[data-pairing-objective]').value = 'expected_song_score';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  await context.run();
  assertStopped(context, '比较失败');
  assert.equal(context.q('[data-pairing-progress]').textContent, '谱面加载失败');
});

test('partial coverage finishes with a visible limitation and concrete diagnostics', async t => {
  const context = fixture(t);
  await context.run();
  const worker = context.worker;
  worker.onmessage({ data: { requestId: worker.message.requestId, type: 'result', result: {
    status: 'completed', searchMethod: 'planning', optimality: 'incomplete', evaluated: 0, results: [], warnings: [],
    scoringCoverage: { complete: false, unsupportedPairs: [{ sourceCardId: 'member-card-64', message: 'Unsupported Gekisou effect 98765' }] },
    planning: { completedVariants: 1 },
  } } });
  assert.equal(context.q('[data-search-state]').textContent, '部分卡片未参与计算');
  assert.equal(context.q('[data-search-state]').dataset.running, 'false');
  assert.match(context.q('[data-pairing-progress]').textContent, /没有可完整计算的队伍/);
  assert.match(context.q('[data-search-diagnostics]').textContent, /member-card-64.*98765/);
  assert.equal(context.q('[data-results-empty]').hidden, true);
  assert.equal(worker.terminated, true);
});
