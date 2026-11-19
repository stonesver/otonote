import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizeEventYield} from '../src/lib/event-yield-optimizer.mjs';
import {createFormalSongCalculator} from '../src/lib/scoring-rules/formal-song-score.mjs';
import {createEventEfficiency} from '../src/lib/scoring-rules/event-efficiency.mjs';
import {eventYieldOracleFixture as fixture} from './helpers/event-yield-oracle-fixture.mjs';


function* permutations(values,n){
 if(!n){yield [];return;}
 for(let i=0;i<values.length;i++)for(const rest of permutations(values.filter((_,j)=>i!==j),n-1))yield [values[i],...rest];
}
// Does not use the production planner, comparator, search, matching or bounds.
function compare(a,b,{goal,refineScoreTies=false}){
 const metric=goal==='eventPoints'?'eventPoints':'badges',secondary=metric==='badges'?'eventPoints':'badges';
 return (goal==='grade'?b.rank-a.rank:0)||b.total[metric]-a.total[metric]||b.total[secondary]-a.total[secondary]
  ||(refineScoreTies?b.expectedScore-a.expectedScore:0);
}
function continuation(model,rows,cp,goal){
 const options=[200,400].flatMap(challengeCost=>rows.map(row=>model.rewards({mode:'challenge',challengeCost,scoreRank:row.reward.scoreRank,...row.bonuses})));
 let best={total:{badges:0,eventPoints:0}};
 const visit=(index,left,total)=>{
  if(index===options.length){const next={total};if(compare(next,best,{goal})<0)best=next;return;}
  const row=options[index];
  for(let n=0;n*row.challengeCost<=left;n++)visit(index+1,left-n*row.challengeCost,{badges:total.badges+n*row.badges,eventPoints:total.eventPoints+n*row.eventPoints});
 };
 visit(0,cp,{badges:0,eventPoints:0});return best.total;
}
function enumerate(input,mode){
 const model=createEventEfficiency({tables:input.rules.tables,sourceReleaseId:input.rules.sourceReleaseId,eventId:1});
 const draft=structuredClone(input.draft),eventAdapters=mode==='challenge'?[model.challengeAdapter(input.rules)]:[];
 if(mode==='challenge')draft.modifiers.event={id:1,sourceReleaseId:input.rules.sourceReleaseId};
 const calculator=createFormalSongCalculator(input.rules,input.chart,{eventAdapters}),all=[];
 for(const leader of input.inventory.memberCardIds){
  const members=input.inventory.memberCardIds.filter(id=>id!==leader);members.splice(2,0,leader);
  for(const supports of permutations(input.inventory.supportCardIds,5)){
   draft.slots=members.map((memberCardId,i)=>({memberCardId,supportCardId:supports[i]}));
   const score=calculator.calculate(draft),bonuses=model.teamBonus(draft.slots.map(s=>({memberId:Number(s.memberCardId.split('-').at(-1)),supportId:Number(s.supportCardId.split('-').at(-1)),memberRank:1,supportRank:1})));
   all.push({score,bonuses,slots:structuredClone(draft.slots)});
  }
 }
 assert.equal(all.length,3600);return {model,all};
}
test('first event yield team matches independent all-pairings oracle across ordinary/challenge, goals, bases and CP continuation',async()=>{
 const input=fixture(),original=structuredClone(input.inventory);
 for(const mode of ['ordinary','challenge']){
  const {model,all}=enumerate(input,mode);
  for(const [goal,basis,includeChallenge,refineScoreTies,constraints={}] of [
   ['badges','expectedScore',false,false],['eventPoints','minimumScore',true,false],
   ['grade','maximumScore',true,false],['badges','minimumScore',true,true],
   ['eventPoints','minimumScore',false,false,{leaderId:'member-card-1',requiredSupportIds:['support-card-6'],
    lockedPairs:[{memberCardId:'member-card-2',supportCardId:'support-card-3'}]}],
  ]){
   const options={goal,basis,includeChallenge,refineScoreTies,constraints};
   const plans=all.filter(({slots})=>(!constraints.leaderId||slots[2].memberCardId===constraints.leaderId)
    &&(constraints.requiredSupportIds??[]).every(id=>slots.some(s=>s.supportCardId===id))
    &&(constraints.lockedPairs??[]).every(pair=>slots.some(s=>s.memberCardId===pair.memberCardId&&s.supportCardId===pair.supportCardId)))
    .map(({score,bonuses})=>{
    const rank=model.scoreRank(100038,score[basis]);
    const reward=model.rewards({mode,scoreRank:rank,...bonuses,liveBoost:mode==='ordinary'?1:0,challengeCost:200});
    const plays=mode==='ordinary'?11:1,extra=mode==='ordinary'&&includeChallenge?continuation(model,input.challengeRows,399+plays*reward.challengePoints,goal):{badges:0,eventPoints:0};
    return {rank,total:{badges:plays*reward.badges+extra.badges,eventPoints:plays*reward.eventPoints+extra.eventPoints},expectedScore:score.expectedScore};
   }).sort((a,b)=>compare(a,b,options));
   const actual=await optimizeEventYield({...input,mode,...options});
   assert.equal(actual.optimality,'proven_within_model',`${mode} ${JSON.stringify(options)}`);
   assert.equal(actual.certifiedSearch.bestProven,true);
   assert.equal(actual.certifiedSearch.proofTarget,'best');
   assert.equal(actual.certifiedSearch.topNComplete,false);
   assert.equal(compare({...actual.results[0],rank:actual.results[0].reward.scoreRank},plans[0],options),0,`${mode} ${JSON.stringify(options)}`);
   assert.equal(actual.certifiedSearch.scoreTieOptimality,refineScoreTies?'proven_within_model':'not_proven');
  }
 }
 assert.deepEqual(input.inventory,original);
});

test('incompatible currency maxima never certify the sum-bonus witness',async()=>{
 const input=fixture();
 input.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank-2);
 input.rules.tables.EventEffect=[1,2,3,4,5,6].map(id=>({_id:id,_eventId:1,_resourceTypeConstraint:3,_supportCardId:id,
  _eventBonusType:id===6?0:1,...Object.fromEntries([1,2,3,4,5].map(n=>[`_rank${n}EffectValue`,id===6?30000:10000]))}));
 const result=await optimizeEventYield({...input,includeChallenge:false,goal:'badges'});
 assert.equal(result.practical.ceilingWitness.attempted,true);
 assert.equal(result.practical.ceilingWitness.success,false);
 assert.equal(result.optimality,'proven_within_model');
 assert.equal(result.results[0].bonuses.rewardBP,50000);
 assert.equal(result.results[0].bonuses.eventPointBP,0);
 assert.notEqual(result.certifiedSearch.proof,'global_grade_and_bonus_ceiling');
});

test('a cached witness never reuses an obsolete proof ceiling for corrected event effects',async()=>{
 const input=fixture(),candidateCache=new Map(),scoreCache=new Map();
 input.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank-2);
 input.rules.tables.EventEffect=[1,2,3,4,5].map(id=>({_id:id,_eventId:1,_resourceTypeConstraint:3,_supportCardId:id,_eventBonusType:1,
  ...Object.fromEntries([1,2,3,4,5].map(n=>[`_rank${n}EffectValue`,1000]))}));
 const old=await optimizeEventYield({...input,includeChallenge:false,candidateCache,scoreCache});
 assert.equal(old.results[0].draft.slots.some(s=>s.supportCardId==='support-card-6'),false);
 const rules=structuredClone(input.rules);
 rules.tables.EventEffect.push({_id:6,_eventId:1,_resourceTypeConstraint:3,_supportCardId:6,_eventBonusType:1,
  ...Object.fromEntries([1,2,3,4,5].map(n=>[`_rank${n}EffectValue`,50000]))});
 const warm=await optimizeEventYield({...input,rules,includeChallenge:false,candidateCache,scoreCache});
 const cold=await optimizeEventYield({...input,rules,includeChallenge:false});
 assert.equal(warm.practical.ceilingWitness.candidateCacheHit,false);
 assert.equal(warm.optimality,'proven_within_model');
 assert.deepEqual(warm.results[0].total,cold.results[0].total);
 assert.ok(warm.results[0].total.badges>old.results[0].total.badges);
});

test('new same-metadata power rules invalidate cached pairing models and score-only rules retain legal candidates',async()=>{
 const input=fixture(),candidateCache=new Map(),scoreCache=new Map();
 input.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank-2);
 const first=await optimizeEventYield({...input,mode:'challenge',includeChallenge:false,candidateCache,scoreCache});
 const changed=structuredClone(input.rules);
 changed.tables.EventEffect.push({_id:99,_eventId:1,_resourceTypeConstraint:2,_memberCardId:1,_eventBonusType:2,
  ...Object.fromEntries([1,2,3,4,5].map(n=>[`_rank${n}EffectValue`,10000]))});
 const warm=await optimizeEventYield({...input,rules:changed,mode:'challenge',includeChallenge:false,candidateCache,scoreCache});
 const cold=await optimizeEventYield({...input,rules:changed,mode:'challenge',includeChallenge:false});
 assert.equal(warm.practical.candidateCacheHit,false);
 assert.deepEqual(warm.results,cold.results);
 assert.ok(warm.results[0].power>first.results[0].power);
 const scoreRules=structuredClone(changed);
 scoreRules.tables.LiveMusicScore.find(r=>`music-chart-${r._id}`===input.chart.id)._musicScoreLevel++;
 const scoreWarm=await optimizeEventYield({...input,rules:scoreRules,mode:'challenge',includeChallenge:false,candidateCache,scoreCache});
 const scoreCold=await optimizeEventYield({...input,rules:scoreRules,mode:'challenge',includeChallenge:false});
 assert.equal(scoreWarm.practical.candidateCacheHit,true);
 assert.equal(scoreWarm.practical.scoreCacheHits,0);
 assert.equal(scoreWarm.results[0].expectedScore,scoreCold.results[0].expectedScore);
 assert.notEqual(scoreWarm.results[0].expectedScore,warm.results[0].expectedScore);
});
