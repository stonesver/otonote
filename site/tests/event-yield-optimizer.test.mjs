import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {optimizeEventYield,compareEventPlans,challengeContinuation} from '../src/lib/event-yield-optimizer.mjs';
import {eventGradeEstimate,estimateEventSong} from '../src/lib/event-song-ranking.mjs';
import {createEventEfficiency,planChallengeSpending,createChallengeSpendingPlanner} from '../src/lib/scoring-rules/event-efficiency.mjs';
import {createFormalSongCalculator} from '../src/lib/scoring-rules/formal-song-score.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';

test('AP basis chooses the grade threshold, not a continuous score multiplier',()=>{
 const model={scoreRank:(_,score)=>score>=1000?4:3};
 const scores={minimumScore:990,expectedScore:1010,maximumScore:1030};
 assert.deepEqual(eventGradeEstimate(model,1,scores),{scoreRank:4,scoreBasis:'expectedScore',estimatedScore:1010,minimumRank:3,maximumRank:4});
 assert.equal(eventGradeEstimate(model,1,scores,'minimumScore').scoreRank,3);
 assert.throws(()=>eventGradeEstimate(model,1,scores,'manual'));
});
test('more CP is not an automatic win when the chosen total reward is lower',()=>{
 const a={reward:{scoreRank:7},total:{badges:100,eventPoints:90},expectedScore:1000,song:{seconds:90}};
 const b={reward:{scoreRank:6},total:{badges:200,eventPoints:80},expectedScore:900,song:{seconds:100}};
 assert.ok(compareEventPlans(a,b,'badges')>0);
 assert.ok(compareEventPlans(a,b,'eventPoints')<0);
 assert.ok(compareEventPlans(a,b,'grade')<0);
});
test('finite challenge spending optimizes the selected currency and keeps leftovers',()=>{
 const base={mode:'challenge',sourceReleaseId:'global-test',eventId:1};
 const options=[{...base,challengeCost:200,badges:100,eventPoints:200},{...base,challengeCost:400,badges:300,eventPoints:100}];
 const items=planChallengeSpending(options,450),points=planChallengeSpending(options,450,'eventPoints');
 assert.equal(items.badges,300);assert.equal(items.plays,1);assert.equal(items.remainingCP,50);
 assert.equal(points.eventPoints,400);assert.equal(points.plays,2);assert.equal(points.remainingCP,50);
 assert.equal(planChallengeSpending(options,199).plays,0);
});
test('challenge continuation selects the best evaluated team per tier under one objective',()=>{
 const model={challengeCosts:[200,400],rewards:({rewardBP,eventPointBP,challengeCost})=>({mode:'challenge',sourceReleaseId:'global-test',eventId:1,challengeCost,badges:rewardBP*challengeCost/200,eventPoints:eventPointBP*challengeCost/200})};
 const rows=[{song:{id:'items',seconds:100},reward:{scoreRank:5},bonuses:{rewardBP:30,eventPointBP:10}},
 {song:{id:'points',seconds:90},reward:{scoreRank:4},bonuses:{rewardBP:20,eventPointBP:40}}];
 assert.equal(challengeContinuation(model,rows,450).stages[0].row.song.id,'items');
 assert.equal(challengeContinuation(model,rows,450,'eventPoints').stages[0].row.song.id,'points');
 assert.throws(()=>challengeContinuation(model,[],400));
});

test('challenge ties preserve the secondary reward before time or fewer plays',()=>{
 const base={mode:'challenge',sourceReleaseId:'test',eventId:1};
 const options=[{...base,challengeCost:200,badges:100,eventPoints:80},{...base,challengeCost:400,badges:200,eventPoints:100}];
 const plan=planChallengeSpending(options,450);
 assert.equal(plan.eventPoints,160);assert.equal(plan.plays,2);assert.equal(plan.remainingCP,50);
 const model={challengeCosts:[200],rewards:({rewardBP,eventPointBP,challengeCost})=>({...base,challengeCost,badges:rewardBP,eventPoints:eventPointBP})};
 const rows=[{song:{id:'short',seconds:80},reward:{scoreRank:4},bonuses:{rewardBP:100,eventPointBP:20}},
 {song:{id:'balanced',seconds:100},reward:{scoreRank:3},bonuses:{rewardBP:100,eventPointBP:50}}];
 assert.equal(challengeContinuation(model,rows,200).stages[0].row.song.id,'balanced');
 const swapped=options.map(r=>({...r,badges:r.eventPoints,eventPoints:r.badges}));
 assert.equal(planChallengeSpending(swapped,450,'eventPoints').badges,160);
});

function fixture(){
 const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
 const chart={id:'music-chart-10003803',trackId:'music-100038',difficulty:'expert',
   bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,2,3,4,5],feverRanges:[],
   notes:Array.from({length:40},(_,i)=>({id:`offline-${i}`,type:'tap',tick:i*157+1}))};
 chart.sourceReleaseId=rules.sourceReleaseId;
 const music=rules.tables.LiveMusic.find(m=>`music-${m._id}`===chart.trackId);music._liveScoreRankGroup=999;
 Object.assign(rules.tables,{
   Event:[{_id:1,_eventType:1,_eventItemId:43,_liveEventPointGroup:1,_liveEventRewardGroup:1,_challengeLiveEventPointGroup:1,_challengeLiveEventRewardGroup:1}],
   EventEffect:[2,3].map((type,i)=>({_id:i+1,_eventId:1,_resourceTypeConstraint:type,_eventBonusType:i,...Object.fromEntries([1,2,3,4,5].map(n=>[`_rank${n}EffectValue`,n*1000]))})),
   ChallengeMusic:[{_eventId:1,_liveMusicId:music._id,_musicType:music._musicType,_gekisouMission1:0,_gekisouMission2:0,_gekisouMission3:0}],
   LiveScoreRank:[2,3,4,5,6,7].map((rank,i)=>({_group:999,_liveScoreRank:rank,_requiredScore:i*100000})),
   LiveMusicBoostBonus:[{_consumedLiveBoostCount:1,_eventPointRate:5,_liveMusicRewardRate:5}],
   ChallengeMusicBoostBonus:[200,400].map(cost=>({_consumedChallengePointCount:cost,_eventPointRate:cost/200,_liveMusicRewardRate:cost/200})),
   LiveChallengePoint:[2,3,4,5,6,7].map(rank=>({_scoreRank:rank,_value:rank})),
 });
 for(const prefix of ['Live','ChallengeLive']){
   rules.tables[prefix+'EventPoint']=[2,3,4,5,6,7].map(rank=>({_group:1,_scoreRank:rank,_value:rank*100}));
   rules.tables[prefix+'EventReward']=[2,3,4,5,6,7].map(rank=>({_eventGroup:1,_scoreRank:rank,_resourceType:1,_resourceId:43,_resourceCount:rank*120,_probability:10000}));
 }
 const draft=createTeamDraft({slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`}))});
 const inventory={memberCardIds:draft.slots.map(s=>s.memberCardId),supportCardIds:draft.slots.map(s=>s.supportCardId),growth:{}};
 for(const s of draft.slots){inventory.growth[s.memberCardId]={level:1,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1};inventory.growth[s.supportCardId]={level:1,rank:1};}
 return {rules,chart,draft,inventory,candidate:{id:chart.id,trackId:chart.trackId,difficulty:chart.difficulty,seconds:100,title:'test'},eventId:1,scope:'owned',yieldControl:async()=>{}};
}
test('the same team can move from C to B in challenge through power bonuses, with no reward bonus multiplied into score',()=>{
 const input=fixture();input.draft.modifiers={growth:input.inventory.growth};
 input.rules.tables.EventEffect.push({_id:3,_eventId:1,_resourceTypeConstraint:2,_eventBonusType:2,
   ...Object.fromEntries([1,2,3,4,5].map(n=>[`_rank${n}EffectValue`,10000]))});
 const model=createEventEfficiency({tables:input.rules.tables,sourceReleaseId:input.rules.sourceReleaseId,eventId:1});
 const score=mode=>estimateEventSong({...input,model,options:{mode,liveBoost:mode==='ordinary'?1:0,challengeCost:200,rewardBP:0,eventPointBP:0}});
 const ordinary=score('ordinary'),challenge=score('challenge');
 assert.ok(challenge.power>ordinary.power);assert.ok(challenge.expectedScore>ordinary.expectedScore);
 const boundary=Math.ceil((ordinary.expectedScore+challenge.expectedScore)/2);
 input.rules.tables.LiveScoreRank.forEach(r=>r._requiredScore=r._liveScoreRank===2?0:r._liveScoreRank===3?1:r._liveScoreRank===4?boundary:1e12+(r._liveScoreRank-5)*1e11);
 assert.equal(score('ordinary').scoreRank,3);assert.equal(score('challenge').scoreRank,4);
 const withRewards=estimateEventSong({...input,model,options:{mode:'challenge',liveBoost:0,challengeCost:200,eventPointBP:17800,rewardBP:28500}});
 assert.equal(withRewards.expectedScore,challenge.expectedScore);
});
test('a middle grade with balanced bonuses can beat both highest grade and highest bonus',()=>{
 const {rules}=fixture(),model=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId:1});
 const plans=[{id:'power',rank:5,bp:0},{id:'bonus',rank:3,bp:10000},{id:'balanced',rank:4,bp:8000}].map(p=>{
   const reward=model.rewards({mode:'ordinary',scoreRank:p.rank,rewardBP:p.bp,eventPointBP:p.bp,liveBoost:1});
   return {...p,reward,total:reward,song:{seconds:100},expectedScore:p.rank*100000};
 });
 for(const goal of ['badges','eventPoints'])assert.equal([...plans].sort((a,b)=>compareEventPlans(a,b,goal))[0].id,'balanced');
});
test('joint search scores full AP candidates with actual growth, grade and separate bonuses',async()=>{
 const input=fixture(),original=structuredClone(input.draft);
 const challenge=await optimizeEventYield({...input,mode:'challenge'});
 const result=await optimizeEventYield({...input,mode:'ordinary',challengeRows:challenge.results,budget:11,startingCP:199});
 assert.equal(result.status,'completed');assert.deepEqual(input.draft,original);
 const model=createEventEfficiency({tables:input.rules.tables,sourceReleaseId:input.rules.sourceReleaseId,eventId:1});
 assert.ok(result.practical.directions.some(p=>p.id==='bonus-items'));
 for(const row of result.results){
   assert.equal(row.orderCount,120);assert.deepEqual(row.draft.modifiers.growth,input.inventory.growth);
   assert.equal(row.spentFire,11);assert.equal(row.normalPlays,11);
   assert.equal(row.total.badges,row.reward.badges*11+row.continuation.badges);
   assert.equal(row.total.eventPoints,row.reward.eventPoints*11+row.continuation.eventPoints);
   assert.equal(row.continuation.spentCP+row.continuation.remainingCP,199+row.earnedCP);
   const fixed=estimateEventSong({rules:input.rules,model,chart:input.chart,draft:row.draft,candidate:input.candidate,options:{mode:'ordinary',liveBoost:1,...row.bonuses}});
   assert.equal(fixed.expectedScore,row.expectedScore);assert.equal(fixed.scoreRank,row.reward.scoreRank);assert.equal(fixed.reward.badges,row.reward.badges);
 }
 await assert.rejects(optimizeEventYield({...input,mode:'gekisou'}),/团队/);
 await assert.rejects(optimizeEventYield({...input,liveBoost:0}),/至少/);
});

test('job cache preserves full results across same-context charts, and invalidates changed growth',async()=>{
 const input=fixture(),cache=new Map();
 const options={...input,mode:'ordinary',includeChallenge:false};
 const first=await optimizeEventYield({...options,candidateCache:cache});
 const second=await optimizeEventYield({...options,candidateCache:cache});
 assert.equal(first.practical.candidateCacheHit,false);assert.equal(second.practical.candidateCacheHit,true);
 assert.deepEqual(second.results,first.results);
 const changed=structuredClone(input.draft);changed.modifiers??={};changed.modifiers.growth={'member-card-1':{level:2,rank:1,awake:1,skillLevel:1}};
 const warm=await optimizeEventYield({...options,draft:changed,candidateCache:cache});
 const cold=await optimizeEventYield({...options,draft:changed});
 assert.equal(warm.practical.candidateCacheHit,false);assert.deepEqual(warm.results,cold.results);
});

test('cached pair power preserves type and favorite-song bonuses in a new song context',async()=>{
 const input=fixture(),cache=new Map();
 await optimizeEventYield({...input,mode:'ordinary',includeChallenge:false,candidateCache:cache});
 const rules=structuredClone(input.rules),music=rules.tables.LiveMusic.find(m=>`music-${m._id}`===input.chart.trackId);
 music._musicType=music._musicType===1?2:1;music._bestMusicTagIDs=[99999];
 const options={...input,rules,mode:'ordinary',includeChallenge:false};
 const warm=await optimizeEventYield({...options,candidateCache:cache}),cold=await optimizeEventYield(options);
 assert.equal(warm.practical.candidateCacheHit,false);assert.deepEqual(warm.results,cold.results);
});

test('reusing candidates never reuses a different chart score',async()=>{
 const input=fixture(),candidateCache=new Map(),options={...input,mode:'ordinary',includeChallenge:false,candidateCache};
 const first=await optimizeEventYield(options),rules=structuredClone(input.rules);
 rules.tables.LiveMusicScore.find(r=>`music-chart-${r._id}`===input.chart.id)._musicScoreLevel+=1;
 const warm=await optimizeEventYield({...options,rules});
 const cold=await optimizeEventYield({...options,rules,candidateCache:undefined});
 assert.equal(warm.practical.candidateCacheHit,true);assert.deepEqual(warm.results,cold.results);
 assert.notEqual(warm.results[0].expectedScore,first.results[0].expectedScore);
});

test('raw AP cache reuses simulations when budget, basis or objective changes without reusing rewards',async()=>{
 const options={...fixture(),mode:'ordinary',includeChallenge:false};
 const candidateCache=new Map(),scoreCache=new Map();
 await optimizeEventYield({...options,candidateCache,scoreCache});
 assert.ok(scoreCache.size>0);
 const changed={...options,budget:13,goal:'grade',basis:'minimumScore'};
 const warm=await optimizeEventYield({...changed,candidateCache,scoreCache});
 const cold=await optimizeEventYield(changed);
 assert.deepEqual(warm.results,cold.results);
 assert.ok(warm.practical.scoreCacheHits>0);
 const repeat=await optimizeEventYield({...changed,candidateCache,scoreCache});
 assert.equal(repeat.practical.scoreCalculations,0);
 assert.deepEqual(repeat.results,cold.results);
});

test('event yield uses saved non-AP performance and invalidates score caches when it changes',async()=>{
 const input=fixture(),scoreCache=new Map(),candidateCache=new Map();
 Object.assign(input.chart,{bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,2,3,4,5],feverRanges:[],
   notes:[100,200,1100,1200].map((tick,i)=>({id:`note-${i}`,type:'tap',tick,position:0,size:1}))});
 input.draft.modifiers.performanceScenario={profile:'ideal',samples:1};
 const options={...input,mode:'ordinary',includeChallenge:false,scoreCache,candidateCache};
 const healthy=await optimizeEventYield(options),healthyContext=scoreCache.get('$context');
 assert.ok(healthy.results[0].expectedScore>0);
 input.draft.modifiers.performanceScenario={profile:'ideal',missRate:1,samples:1};
 const missed=await optimizeEventYield(options);
 assert.notEqual(scoreCache.get('$context'),healthyContext);
 assert.equal(missed.practical.candidateCacheHit,false);
 assert.ok(missed.results.length);
 for(const row of missed.results){
   assert.equal(row.expectedScore,0);assert.equal(row.estimatedScore,0);assert.equal(row.reward.scoreRank,2);
   assert.equal(row.performanceScenario.missRate,1);
 }
});

test('incremental challenge DP preserves primary, secondary and play ties for out-of-order budgets',()=>{
 const base={mode:'challenge',sourceReleaseId:'global-test',eventId:1};
 const options=[{...base,challengeCost:200,badges:100,eventPoints:80},{...base,challengeCost:350,badges:190,eventPoints:120},
   {...base,challengeCost:500,badges:255,eventPoints:210}];
 for(const metric of ['badges','eventPoints']){
   const query=createChallengeSpendingPlanner(options,metric),secondary=metric==='badges'?'eventPoints':'badges';
   for(const budget of [0,199,200,950,450,3000,123,1750,350,3001]){
     const all=[];
     for(let a=0;a*200<=budget;a++)for(let b=0;a*200+b*350<=budget;b++)for(let c=0;a*200+b*350+c*500<=budget;c++)
       all.push({badges:a*100+b*190+c*255,eventPoints:a*80+b*120+c*210,plays:a+b+c,spentCP:a*200+b*350+c*500});
     all.sort((a,b)=>b[metric]-a[metric]||b[secondary]-a[secondary]||a.plays-b.plays||a.spentCP-b.spentCP);
     const actual=query(budget),best=all[0];
     for(const key of ['badges','eventPoints','plays','spentCP'])assert.equal(actual[key],best[key],`${metric}, ${budget}, ${key}`);
     assert.equal(actual.remainingCP,budget-actual.spentCP);
   }
 }
});

test('global grade/bonus ceiling proves reward objectives without enumerating score ties',async()=>{
 const input=fixture();
 input.rules.tables.LiveScoreRank.forEach(row=>row._requiredScore=row._liveScoreRank-2);
 const result=await optimizeEventYield({...input,includeChallenge:false});
 assert.equal(result.optimality,'proven_within_model');
 assert.equal(result.certifiedSearch.proof,'global_grade_and_bonus_ceiling');
 assert.equal(result.certifiedSearch.objective,'reward_tuple');
 assert.equal(result.certifiedSearch.scoreTieOptimality,'not_proven');
 assert.equal(result.certifiedSearch.evaluated,0);
 const practical=await optimizeEventYield({...input,includeChallenge:false,searchMethod:'practical'});
 assert.deepEqual(result.results,practical.results);
 await assert.rejects(optimizeEventYield({...input,maxEvaluations:-1}),/budget/);
});

test('shared continuation planners invalidate both mutated challenge rows and reward tables',async()=>{
 const input=fixture(),challenge=await optimizeEventYield({...input,mode:'challenge'}),challengePlanCache=new Map();
 const options={...input,challengeRows:challenge.results,challengePlanCache,budget:11,startingCP:199};
 await optimizeEventYield(options);
 for(const row of input.rules.tables.ChallengeLiveEventReward)row._resourceCount*=2;
 const warm=await optimizeEventYield(options),cold=await optimizeEventYield({...options,challengePlanCache:undefined});
 assert.deepEqual(warm.results,cold.results);
 challenge.results[0].bonuses.rewardBP+=10000;
 assert.deepEqual((await optimizeEventYield(options)).results,
   (await optimizeEventYield({...options,challengePlanCache:undefined})).results);
});

function* arrangements(values,n=values.length){
 if(!n){yield [];return;}
 for(let i=0;i<values.length;i++)for(const rest of arrangements(values.filter((_,j)=>j!==i),n-1))yield [values[i],...rest];
}

test('certified event search matches exhaustive full-order scoring with six supports and all three reward objectives',async()=>{
 const input=fixture();
 Object.assign(input.chart,{bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,2,3,4,5],feverRanges:[],
   notes:Array.from({length:16},(_,i)=>({id:`note-${i}`,type:'tap',tick:i*317+1}))});
 input.inventory.supportCardIds.push('support-card-6');input.inventory.growth['support-card-6']={level:1,rank:1};
 const template=input.rules.tables.LiveSkillEffect.find(e=>e._liveSkillID===1&&e._level===1);
 for(const id of [1,2]){
   input.rules.tables.MemberCard.find(m=>m._id===id)._liveSkillID=900000+id;
   input.rules.tables.LiveSkillEffect.push({...template,_id:900000+id,_liveSkillID:900000+id,
     _effectValue:id*1733,_activationTimeSecond:id*1.321,_skillConditionGroup:0});
 }
 input.rules.tables.EventEffect.push({_id:3,_eventId:1,_resourceTypeConstraint:3,_supportCardId:6,_eventBonusType:1,
   ...Object.fromEntries([1,2,3,4,5].map(n=>[`_rank${n}EffectValue`,9000]))});
 input.draft.selectedSongId=input.chart.trackId;input.draft.selectedDifficulty=input.chart.difficulty;
 input.draft.modifiers={growth:input.inventory.growth};
 const model=createEventEfficiency({tables:input.rules.tables,sourceReleaseId:input.rules.sourceReleaseId,eventId:1});
 const calculator=createFormalSongCalculator(input.rules,input.chart),all=[];
 for(const leader of input.inventory.memberCardIds){
   const members=input.inventory.memberCardIds.filter(id=>id!==leader);members.splice(2,0,leader);
   for(const supports of arrangements(input.inventory.supportCardIds,5)){
     const draft={...input.draft,slots:members.map((memberCardId,i)=>({memberCardId,supportCardId:supports[i]}))};
     const score=calculator.calculate(draft),bonuses=model.teamBonus(draft.slots.map(s=>({memberId:Number(s.memberCardId.split('-').at(-1)),supportId:Number(s.supportCardId.split('-').at(-1)),memberRank:1,supportRank:1})));
     all.push({score,bonuses});
   }
 }
 for(const [goal,basis] of [['badges','expectedScore'],['eventPoints','minimumScore'],['grade','maximumScore']]){
   const plans=all.map(({score,bonuses})=>{
     const reward=model.rewards({mode:'ordinary',scoreRank:model.scoreRank(Number(input.chart.trackId.split('-').at(-1)),score[basis]),...bonuses,liveBoost:1});
     return {...score,reward,total:{badges:reward.badges*11,eventPoints:reward.eventPoints*11},song:input.candidate};
   }).sort((a,b)=>compareEventPlans(a,b,goal));
   const result=await optimizeEventYield({...input,goal,basis,budget:11,includeChallenge:false,maxEvaluations:0,refineScoreTies:true});
   assert.equal(result.optimality,'proven_within_model');
   assert.equal(compareEventPlans(result.results[0],plans[0],goal),0,`${goal}, ${basis}`);
   const rewardsOnly=await optimizeEventYield({...input,goal,basis,budget:11,includeChallenge:false,maxEvaluations:0});
   assert.equal(rewardsOnly.optimality,'proven_within_model');
   assert.equal(compareEventPlans({...rewardsOnly.results[0],expectedScore:0},{...plans[0],expectedScore:0},goal),0);
   assert.equal(rewardsOnly.certifiedSearch.objective,'reward_tuple');
 }
});
