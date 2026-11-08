import test from 'node:test';
import assert from 'node:assert/strict';
import {eventYieldOracleFixture} from './helpers/event-yield-oracle-fixture.mjs';
import {optimizeEventYield,challengeContinuation} from '../src/lib/event-yield-optimizer.mjs';
import {compareEventPlans,compareEventRewards} from '../src/lib/event-yield-goals.mjs';
import {eventYieldStageInput} from '../src/lib/event-yield-stage.mjs';
import {eventGradeEstimate} from '../src/lib/event-song-ranking.mjs';
import {summarizeScoreDistribution} from '../src/lib/scoring-rules/score-distribution.mjs';
import {createCandidateEvaluator} from '../src/lib/formation-candidate-evaluator.mjs';

test('both farming stages default to the minimum while preserving explicit choices',()=>{
 const input={draft:{modifiers:{}},mode:'ordinary',includeChallenge:true};
 assert.equal(eventYieldStageInput(input,'ordinary').basis,'minimumScore');
 assert.equal(eventYieldStageInput({...input,basis:'maximumScore'},'challenge').basis,'minimumScore');
 assert.equal(eventYieldStageInput({...input,challengeBasis:'expectedScore'},'challenge').basis,'expectedScore');
});

test('stable ties rank minimum, mean and power without changing the reward proof objective',()=>{
 const a={reward:{scoreRank:7},total:{badges:100,eventPoints:90},song:{seconds:100},scoreBasis:'minimumScore',minimumScore:900,expectedScore:1000,power:10};
 for(const b of [{...a,minimumScore:899,expectedScore:1100},{...a,expectedScore:999,power:20},{...a,power:9}]){
  assert.ok(compareEventPlans(a,b)<0);assert.equal(compareEventRewards(a,b),0);
 }
 assert.ok(compareEventPlans(a,{...a,total:{badges:101,eventPoints:90},minimumScore:800})>0);
 const model={challengeCosts:[200],rewards:()=>({mode:'challenge',challengeCost:200,badges:100,eventPoints:90})};
 const b={...a,id:'unstable',minimumScore:899,expectedScore:1100},stable={...a,id:'stable'};
 assert.equal(challengeContinuation(model,[b,stable],200).stages[0].row.id,'stable');
});

test('grade probabilities count every order and do not turn samples into probabilities',()=>{
 const model={scoreRank:(_,s)=>s>=1000?7:6};
 const scores={minimumScore:990,expectedScore:1002,maximumScore:1010,
  scoreDistribution:summarizeScoreDistribution([...Array(48).fill(990),...Array(72).fill(1010)])};
 const average=eventGradeEstimate(model,1,scores),stable=eventGradeEstimate(model,1,scores,'minimumScore');
 assert.equal(average.scoreRank,7);assert.equal(stable.scoreRank,6);
 assert.deepEqual(stable.gradeProbabilities,[{rank:7,count:72,probability:.6},{rank:6,count:48,probability:.4}]);
 assert.equal(eventGradeEstimate(model,1,{...scores,scoreDistribution:{...scores.scoreDistribution,kind:'seed_samples',complete:false}}).gradeProbabilities,undefined);
});

test('a reward ceiling still refines leader and support choices using full order scores',async()=>{
 const input=eventYieldOracleFixture();input.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank-2);
 const result=await optimizeEventYield({...input,includeChallenge:false}),row=result.results[0];
 assert.equal(row.scoreBasis,'minimumScore');assert.equal(result.certifiedSearch.bestProven,true);
 assert.equal(result.certifiedSearch.scoreTieOptimality,'not_proven');
 assert.ok(result.practical.stabilityRefinement.fullyScored>0);
 assert.equal(row.gradeProbabilities.reduce((n,g)=>n+g.count,0),120);
 const evaluator=createCandidateEvaluator({rules:input.rules,chart:input.chart,objective:'minimum_song_score'});
 for(let i=0;i<5;i++){
  const draft=structuredClone(row.draft);[draft.slots[2],draft.slots[i]]=[draft.slots[i],draft.slots[2]];
  assert.ok(row.minimumScore>=evaluator.score(draft).minimumScore);
 }
 const locked=await optimizeEventYield({...input,includeChallenge:false,constraints:{leaderId:'member-card-1',
  lockedPairs:[{memberCardId:'member-card-1',supportCardId:'support-card-1'}],requiredSupportIds:['support-card-6']}});
 assert.equal(locked.results[0].draft.slots[2].memberCardId,'member-card-1');
 assert.equal(locked.results[0].draft.slots[2].supportCardId,'support-card-1');
 assert.ok(locked.results[0].draft.slots.some(s=>s.supportCardId==='support-card-6'));
});
