import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationScoreSummary } from '../src/lib/score-visuals.mjs';
class Node {
  constructor(tag) { this.tagName=tag; this.children=[]; this.textContent=''; }
  append(...children) { this.children.push(...children); }
}
const all = node => [node, ...node.children.flatMap(all)];
function setup(t, lang='zh-CN') {
  const previous=globalThis.document;
  globalThis.document={documentElement:{lang},createElement:tag=>new Node(tag)};
  t.after(()=>{globalThis.document=previous;});
}
test('summary shows score components and whole-team changes, not JUST counts as points',t=>{
  setup(t);
  const nodes=all(recommendationScoreSummary({noteScore:1000.4,rankingBonus:2500.6,
    sections:[{just:9000}],comparison:{noteScoreDelta:-20,rankingBonusDelta:50}}));
  assert.deepEqual(nodes.filter(n=>n.tagName==='dt').map(n=>n.textContent),['平均音符分','平均段落奖励']);
  assert.deepEqual(nodes.filter(n=>n.tagName==='dd').map(n=>n.textContent),['1,000','2,501']);
  assert.match(nodes.find(n=>n.tagName==='p').textContent,/-20.*\+50/);
});
test('reference growth omits ungrounded deltas and translates the new summary',t=>{
  setup(t,'en');
  const nodes=all(recommendationScoreSummary({noteScore:100,rankingBonus:250,eventFixedScore:10,
    planning:{missingActual:true},comparison:{noteScoreDelta:20,rankingBonusDelta:50}}));
  assert.deepEqual(nodes.filter(n=>n.tagName==='dt').map(n=>n.textContent),['Mean note score','Mean section bonus','Mean additional score']);
  assert.equal(nodes.some(n=>n.tagName==='p'),false);
  assert.equal(recommendationScoreSummary({power:100}),null);
});
