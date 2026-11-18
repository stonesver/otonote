import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optimizePractical, PRACTICAL_PLAN } from '../src/lib/practical-optimizer.mjs';
import { createCandidateEvaluator } from '../src/lib/formation-candidate-evaluator.mjs';
import { createTeamDraft } from '../src/lib/team-draft.mjs';
import { resolveSearchInput } from '../../packages/scoring/scoring-rules/formation-input.mjs';
const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
function fixture() {
  const members=[51,52,53,54,55].map(id=>`member-card-${id}`), supports=[27,31,39,41,48,52,54,56].map(id=>`support-card-${id}`);
  let draft=createTeamDraft({selectedSongId:'music-100002',selectedDifficulty:'expert',
    slots:members.map((memberCardId,i)=>({memberCardId,supportCardId:supports[i]}))});
  draft=resolveSearchInput(rules,draft,{scope:'theoretical'}).draft;
  const chart={id:'music-chart-10000203',trackId:'music-100002',sourceReleaseId:rules.sourceReleaseId,difficulty:'expert',
    bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,2,3,4,5],
    feverRanges:[{start:.5,end:2.5},{start:3,end:4.5},{start:5,end:7.5}],
    notes:Array.from({length:80},(_,i)=>({id:`n${i}`,type:'tap',tick:100*(i+1),position:0,size:1}))};
  return {rules,chart,draft,mode:'gekisou',objective:'expected_song_score',scope:'owned',
    inventory:{memberCardIds:members,supportCardIds:supports},constraints:{leaderId:'member-card-53'},
    performanceScenario:{profile:'steady',samples:1},gekisouScenario:{ranks:[1,1,1]},maxWindowCards:5,yieldControl:async()=>{}};
}
test('score refinement recovers a profitable skill combination and is identical with warm caches',async()=>{
  const input=fixture(), evaluator=createCandidateEvaluator(input);
  // Independent witness: replace conversion with cumulative score-up while
  // preserving the rest of a previously selected team. No legacy search runs.
  const before={...input.draft,slots:[27,54,56,39,52].map((id,i)=>({memberCardId:`member-card-${51+i}`,supportCardId:`support-card-${id}`}))};
  const after=structuredClone(before);after.slots[0].supportCardId='support-card-41';
  const a=evaluator.score(before),b=evaluator.score(after);
  assert.ok(b.value>a.value);
  // These short sections need not reach the converter's trigger threshold.
  assert.ok(b.sections.reduce((s,r)=>s+r.just,0)<=a.sections.reduce((s,r)=>s+r.just,0));
  const caches={candidateCache:new Map(),candidateCacheKey:'short-just',scoreCache:new Map()};
  const cold=await optimizePractical({...input,...caches});
  assert.equal(cold.status,'completed');assert.ok(cold.results[0].value>=b.value);
  assert.ok(cold.practical.finalists<=4);
  assert.ok(cold.practical.refined>0&&cold.practical.refined<=PRACTICAL_PLAN.refinementCandidates);
  assert.equal(cold.practical.verified,cold.practical.finalists);
  assert.ok(cold.practical.refined+cold.practical.verified<=PRACTICAL_PLAN.refinementCandidates);
  assert.equal(cold.results[0].performanceCheck.seed,20261005);
  assert.equal(cold.results[0].performanceCheck.orderCount,10);
  assert.ok(cold.results.every(r=>r.scorePrecision==='full'&&r.orderCount===120&&r.draft.slots[2].memberCardId==='member-card-53'));
  const warm=await optimizePractical({...input,...caches});
  assert.deepEqual(warm.results,cold.results);assert.equal(warm.practical.scoreCalculations,0);
});
test('a large pool retains competitive high-ID replacements instead of spending the budget by card ID',async()=>{
  const input=fixture();input.constraints={};
  input.inventory={memberCardIds:rules.tables.MemberCard.filter(c=>c._characterID<=5).map(c=>`member-card-${c._id}`),
    supportCardIds:rules.tables.SupportCard.map(c=>`support-card-${c._id}`)};
  const witness={...input.draft,slots:[52,51,55,53,54].map((id,i)=>({memberCardId:`member-card-${id}`,
    supportCardId:`support-card-${[54,59,52,53,56][i]}`}))};
  const expected=createCandidateEvaluator(input).score(witness).value;
  const result=await optimizePractical(input);
  assert.ok(result.results[0].value>=expected);
  assert.ok(result.practical.refined+result.practical.verified<=24);
});
test('stopping during score refinement never presents a screening score as a final result',async()=>{
  const input=fixture(),controller=new AbortController();
  const result=await optimizePractical({...input,signal:controller.signal,
    onProgress:p=>{if(p.stage==='模拟换卡与配对')controller.abort();}});
  assert.equal(result.status,'cancelled');assert.deepEqual(result.results,[]);
});
test('stopping during independent verification keeps full scores without claiming a completed check',async()=>{
  const controller=new AbortController();
  const result=await optimizePractical({...fixture(),signal:controller.signal,
    onProgress:p=>{if(p.stage==='复核发挥样本')controller.abort();}});
  assert.equal(result.status,'cancelled');assert.ok(result.results.length);
  assert.ok(result.results.every(r=>r.scorePrecision==='full'&&r.orderCount===120&&!r.performanceCheck));
});
test('refinement preserves required memories, locked pairs, leader and window limit',async()=>{
  const input=fixture();input.draft.slots[2].supportCardId='support-card-56';
  input.constraints={...input.constraints,requiredSupportIds:['support-card-52'],lockedPairs:[input.draft.slots[2]]};
  const result=await optimizePractical({...input,maxWindowCards:1,finalistLimit:2});
  assert.equal(result.status,'completed');assert.ok(result.results.length);
  for(const {draft} of result.results){
    assert.deepEqual(draft.slots[2],input.draft.slots[2]);
    assert.ok(draft.slots.some(s=>s.supportCardId==='support-card-52'));
    assert.ok(draft.slots.filter(s=>['support-card-31','support-card-54'].includes(s.supportCardId)).length<=1);
  }
});
