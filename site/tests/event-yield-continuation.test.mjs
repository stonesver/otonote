import test from 'node:test';
import assert from 'node:assert/strict';
import {createChallengeSongPlanners} from '../src/lib/event-yield-continuation.mjs';

test('per-chart continuations retain both goals, whole mixed-cost plays and unspent CP',()=>{
 const model={challengeCosts:[200,400],rewards:({rewardBP,eventPointBP,challengeCost})=>({mode:'challenge',sourceReleaseId:'jp-test',eventId:1,challengeCost,
  badges:rewardBP*(challengeCost===400?3:1),eventPoints:eventPointBP*(challengeCost===400?2:1)})};
 const team=(id,chart,rewardBP,eventPointBP,goal)=>({id,song:{id:chart,trackId:'same-song',seconds:100},reward:{scoreRank:5},bonuses:{rewardBP,eventPointBP},recommendationGoals:[goal]});
 const rows=[team('items','expert',30,10,'badges'),team('points','expert',20,40,'eventPoints'),team('other-difficulty','hard',10,20,'badges')],before=structuredClone(rows);
 for(const metric of ['badges','eventPoints']){
  const plans=createChallengeSongPlanners(model,rows,metric);assert.deepEqual(plans.map(p=>p.song.id),['expert','hard']);
  const expert=plans[0].plan(649);
  assert.equal(expert.spentCP,600);assert.equal(expert.remainingCP,49);assert.equal(expert.plays,2);
  assert.deepEqual(expert.consumption.map(c=>[c.cost,c.plays]).sort((a,b)=>a[0]-b[0]),[[200,1],[400,1]]);
  assert.ok(expert.stages.every(s=>s.row.id===(metric==='badges'?'items':'points')));
  assert.equal(expert.badges,metric==='badges'?120:80);assert.equal(expert.eventPoints,metric==='badges'?30:120);
  assert.ok(plans[1].plan(649).stages.every(s=>s.row.song.id==='hard'));
  const small=plans[0].plan(199);assert.equal(small.plays,0);assert.equal(small.remainingCP,199);assert.deepEqual(small.stages,[]);
  assert.deepEqual(plans[0].plan(649),expert,'reusing the planner across different balances is exact');
 }
 assert.deepEqual(rows,before);
});
