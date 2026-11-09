import test from 'node:test';
import assert from 'node:assert/strict';
import {eventYieldOracleFixture} from './helpers/event-yield-oracle-fixture.mjs';
import {optimizeEventYield,challengeContinuation,createEventYieldRewardTransform} from '../src/lib/event-yield-optimizer.mjs';
import {refineEventYieldTeams} from '../src/lib/event-yield-refinement.mjs';
import {createEventEfficiency} from '../src/lib/scoring-rules/event-efficiency.mjs';
import {resolveSearchInput} from '../src/lib/scoring-rules/formation-input.mjs';
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

test('stability refinement avoids simulating replacements that lose at every reward grade',async()=>{
 const input=eventYieldOracleFixture();
 input.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank-2);
 input.rules.tables.EventEffect=[1,2,3,4,5].map(id=>({_id:id,_eventId:1,_resourceTypeConstraint:3,_supportCardId:id,_eventBonusType:1,
  ...Object.fromEntries([1,2,3,4,5].map(rank=>[`_rank${rank}EffectValue`,10000]))}));
 const result=await optimizeEventYield({...input,includeChallenge:false,goal:'badges'});
 assert.equal(result.results[0].bonuses.rewardBP,50000);
 assert.equal(result.certifiedSearch.bestProven,true);
 assert.ok(result.practical.stabilityRefinement.rewardPruned>=5);
});

test('reward pruning keeps a lower-bonus replacement that earns more at a nonmonotone lower grade',async()=>{
 const f=eventYieldOracleFixture();
 f.rules.tables.EventEffect=[1,2,3,4,5].map(id=>({_id:id,_eventId:1,_resourceTypeConstraint:3,_supportCardId:id,_eventBonusType:1,
  ...Object.fromEntries([1,2,3,4,5].map(rank=>[`_rank${rank}EffectValue`,10000]))}));
 f.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank===7?218500:r._liveScoreRank-2);
 f.rules.tables.LiveEventReward.forEach(r=>r._resourceCount=r._scoreRank===6?1000:10);
 const constraints={leaderId:f.draft.slots[2].memberCardId,lockedPairs:f.draft.slots.filter((_,i)=>i!==1)};
 const input=resolveSearchInput(f.rules,f.draft,{scope:'owned',inventory:f.inventory,constraints});
 const model=createEventEfficiency({tables:f.rules.tables,sourceReleaseId:f.rules.sourceReleaseId,eventId:1});
 const transformScore=createEventYieldRewardTransform({model,candidate:f.candidate,basis:'minimumScore',mode:'ordinary',liveBoost:1,budget:11,startingCP:0,includeChallenge:false,metric:'badges'});
 const evaluator=createCandidateEvaluator({rules:f.rules,chart:f.chart,objective:'minimum_song_score'});
 const first={...transformScore(evaluator.score(input.draft),input.draft),draft:input.draft,id:'initial'};
 assert.equal(first.reward.scoreRank,7);
 const [row]=await refineEventYieldTeams({rules:f.rules,chart:f.chart,input,results:[first],transformScore,goal:'badges'});
 assert.equal(row.draft.slots[1].supportCardId,'support-card-6');
 assert.equal(row.reward.scoreRank,6);
 assert.ok(row.total.badges>first.total.badges);
});
