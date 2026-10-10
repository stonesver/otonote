import {bindEventScoreCache} from './event-search-cache.mjs';
import {optimizePractical,PRACTICAL_SEARCH_WARNINGS} from './practical-optimizer.mjs';
import {createEventEfficiency,createChallengeSpendingPlanner} from './scoring-rules/event-efficiency.mjs';
import {searchEventFormations} from './event-formation-search.mjs';
import {resolveSearchInput} from './scoring-rules/formation-input.mjs';
import {maximumPairing} from './scoring-rules/maximum-pairing.mjs';

import {eventGradeEstimate} from './event-song-ranking.mjs';
import {createEventPipeline} from './scoring-rules/event-rules.mjs';
import {compareEventPlans} from './event-yield-goals.mjs';
export {compareEventPlans} from './event-yield-goals.mjs';

// This cache belongs to one calculation job. Music identity/difficulty affects
// scoring, but candidate preparation only reads effective type and favorite tags.
// Keep all other inputs in the key so growth, inventory or event changes miss.
export function eventCandidateKey(rules,draft,inventory,scope,eventAdapters,includeMusic=true){
 const music=createEventPipeline(rules,draft.modifiers.event,eventAdapters).apply('song_context',
   rules.tables.LiveMusic.find(m=>`music-${m._id}`===draft.selectedSongId),{draft});
 if(!music)throw Error('缺少歌曲资料');
 return JSON.stringify({source:rules.sourceReleaseId,version:rules.ruleSetVersion,native:rules.nativeSha256,
   scope,inventory,slots:draft.slots,modifiers:draft.modifiers,...(includeMusic?{type:music._musicType,tags:music._bestMusicTagIDs}:{})});
}

/** Choose the best evaluated challenge team/song for each consumption tier,
 * then spend only whole plays. The same chosen objective applies to both stages. */
export function challengeContinuation(model,rows,availableCP,metric='badges'){
 return createChallengeContinuationPlanner(model,rows,metric)(availableCP);
}
export function createChallengeContinuationPlanner(model,rows,metric='badges'){
 if(!rows.length)throw Error('缺少可计算的后续挑战方案');
 const secondary=metric==='badges'?'eventPoints':'badges';
 const picks=modelChallengeCosts(model,rows).map(cost=>{
   const options=rows.map(row=>({row,reward:model.rewards({mode:'challenge',scoreRank:row.reward.scoreRank,...row.bonuses,challengeCost:cost})}));
   options.sort((a,b)=>b.reward[metric]-a.reward[metric]||b.reward[secondary]-a.reward[secondary]||(a.row.song.seconds??Infinity)-(b.row.song.seconds??Infinity));
   return options[0];
 });
 const query=createChallengeSpendingPlanner(picks.map(p=>p.reward),metric);
 return availableCP=>{const plan=query(availableCP);return {...plan,stages:plan.consumption.map(c=>({...c,...picks.find(p=>p.reward.challengeCost===c.cost)}))};};
}
// Costs are supplied by the caller's rules, not invented from reward ratios.
function modelChallengeCosts(model,rows){return model.challengeCosts??[...new Set(rows.map(r=>r.reward.challengeCost))];}

export async function optimizeEventYield({rules,eventId,draft,chart,candidate,scope='owned',inventory,mode='ordinary',
 liveBoost=1,challengeCost=200,budget=100,startingCP=0,goal='badges',basis='expectedScore',challengeRows=[],includeChallenge=true,
 onProgress,yieldControl=async()=>{},signal,candidateCache,scoreCache,challengePlanCache,
 searchMethod='certified',maxEvaluations=24,refineScoreTies=false}){
 if(!['practical','certified'].includes(searchMethod))throw Error('Invalid event search method');
 if(!Number.isInteger(maxEvaluations)||maxEvaluations<0)throw Error('Invalid event search budget');
 if(typeof refineScoreTies!=='boolean')throw Error('Invalid score tie refinement option');
 if(!['ordinary','challenge'].includes(mode))throw Error('收益配队仅支持普通与挑战；激奏需要团队结算档位');
 if(!['owned','selected'].includes(scope)||!['badges','eventPoints','grade'].includes(goal))throw Error('Invalid event search options');
 if(!Number.isInteger(budget)||budget<1||budget>10000||!Number.isInteger(startingCP)||startingCP<0||startingCP>1000000)throw Error('Invalid farming budget');
 if(mode==='ordinary'&&(!Number.isInteger(liveBoost)||liveBoost<1||liveBoost>10||budget<liveBoost))throw Error('普通收益配队需消耗至少 1 火，预算不少于单次耗火');
 const model=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId});
 model.challengeCosts=rules.tables.ChallengeMusicBoostBonus.map(r=>r._consumedChallengePointCount);
 const next=structuredClone(draft);next.selectedSongId=candidate.trackId;next.selectedDifficulty=candidate.difficulty;next.modifiers??={};delete next.modifiers.event;
 if(mode==='challenge')next.modifiers.event={id:eventId,sourceReleaseId:rules.sourceReleaseId};
 if(scope==='owned'){
   if(!inventory)throw Error('请先导入已保存卡库与实际养成');
   const growth=structuredClone(inventory.growth??{});
   for(const [id,value] of Object.entries(next.modifiers.growth??{}))growth[id]={...growth[id],...value};
   next.modifiers.growth=growth;
 }
 const metric=goal==='eventPoints'?'eventPoints':'badges',bonusCache=new Map();
 const cardBonus=(kind,id)=>{
   if(!bonusCache.has(id))bonusCache.set(id,model.cardBonus(kind,Number(id.split('-').at(-1)),next.modifiers.growth?.[id]?.rank??1));
   return bonusCache.get(id);
 };
 const feature=(kind,pair)=>['member','support'].reduce((n,k)=>{const b=cardBonus(k,pair[`${k}CardId`]);return n+(kind==='both'?b.rewardBP+b.eventPointBP:kind==='items'?b.rewardBP:b.eventPointBP);},0)/10000;
 const extraProfiles=['items','points','both'].map(kind=>({id:'bonus-'+kind,label:'奖励加成 '+kind,powerWeight:.01,featureWeight:1,feature:(_,pair)=>feature(kind,pair)}));
 extraProfiles.push(...['items','points'].map(kind=>({id:'mixed-'+kind,label:'能力与奖励 '+kind,feature:(_,pair)=>feature(kind,pair)})));
 const plans=new Map(),planners=new Map(),modelCache={};
 const continuationKey=challengePlanCache?JSON.stringify({costs:model.challengeCosts,rows:challengeRows,
   rewards:[rules.tables.Event,rules.tables.ChallengeLiveEventPoint,rules.tables.ChallengeLiveEventReward,rules.tables.ChallengeMusicBoostBonus]}):null;
 const continuationFor=(cp,objective)=>{
   if(!planners.has(objective)){
     const key=`${rules.sourceReleaseId}:${eventId}:${objective}`,cached=challengePlanCache?.get(key);
     const planner=cached?.input===continuationKey?cached.planner:createChallengeContinuationPlanner(model,challengeRows,objective);
     planners.set(objective,planner);challengePlanCache?.set(key,{input:continuationKey,planner});
   }
   return planners.get(objective)(cp);
 };
 const transformScore=(score,team)=>{
   const bonuses=model.teamBonus(team.slots.map(s=>({memberId:Number(s.memberCardId.split('-').at(-1)),supportId:Number(s.supportCardId.split('-').at(-1)),
     memberRank:team.modifiers.growth?.[s.memberCardId]?.rank??1,supportRank:team.modifiers.growth?.[s.supportCardId]?.rank??1})));
   const grades=eventGradeEstimate(model,Number(candidate.trackId.split('-').at(-1)),score,basis);
   const reward=model.rewards({mode,...bonuses,scoreRank:grades.scoreRank,liveBoost:mode==='ordinary'?liveBoost:0,challengeCost});
   let continuation=null,plays=mode==='ordinary'?Math.floor(budget/liveBoost):1;
   if(mode==='ordinary'&&includeChallenge){
     const cp=startingCP+plays*reward.challengePoints;
     if(!plans.has(cp))plans.set(cp,continuationFor(cp,metric));
     continuation=plans.get(cp);
   }
   const total={badges:plays*reward.badges+(continuation?.badges??0),eventPoints:plays*reward.eventPoints+(continuation?.eventPoints??0)};
   return {...score,...grades,reward,bonuses:{rewardBP:bonuses.rewardBP,eventPointBP:bonuses.eventPointBP},normalPlays:plays,
     spentFire:mode==='ordinary'?plays*liveBoost:0,remainingFire:mode==='ordinary'?budget-plays*liveBoost:0,
     earnedCP:mode==='ordinary'?plays*reward.challengePoints:0,startingCP,continuation,total,value:total[metric],song:candidate};
 };
 const eventAdapters=mode==='challenge'?[model.challengeAdapter(rules)]:[];
 if(scoreCache)await bindEventScoreCache(scoreCache,{rules,chart,draft:next});
 const result=await optimizePractical({rules,draft:next,chart,scope,inventory,objective:'expected_song_score',performanceScenario:next.modifiers.performanceScenario,
   eventAdapters,extraProfiles,transformScore,candidateCache,scoreCache,modelCache,pairCache:candidateCache,
   pairCacheKey:candidateCache?"power:"+eventCandidateKey(rules,next,inventory,scope,eventAdapters,false):null,
   candidateCacheKey:candidateCache?eventCandidateKey(rules,next,inventory,scope,eventAdapters)+':reward-event='+eventId:null,
   compareCandidates:(a,b)=>compareEventPlans(a,b,goal),finalistLimit:12,retainedOrigins:['bonus-items','bonus-points','bonus-both','mixed-items','mixed-points'],onProgress,yieldControl,signal});
 if(searchMethod==='practical'||signal?.aborted||result.scoringCoverage?.complete===false)return {...result,objective:'event_yield',mode,goal,basis};
 const upperCandidate=({scoreUpper,tieScoreUpper,rewardBP,eventPointBP})=>{
   const rank=model.scoreRank(Number(candidate.trackId.split('-').at(-1)),scoreUpper===Infinity?Number.MAX_VALUE:scoreUpper),total={badges:0,eventPoints:0};
   const plays=mode==='ordinary'?Math.floor(budget/liveBoost):1;
   // Separate currency maxima also cover non-monotone reward tables and the
   // secondary tie-break of a primary-optimal continuation at a smaller budget.
   for(let scoreRank=2;scoreRank<=rank;scoreRank++){
     const reward=model.rewards({mode,scoreRank,rewardBP,eventPointBP,liveBoost:mode==='ordinary'?liveBoost:0,challengeCost});
     const cp=startingCP+plays*reward.challengePoints;
     for(const currency of ['badges','eventPoints'])total[currency]=Math.max(total[currency],plays*reward[currency]
       +(mode==='ordinary'&&includeChallenge?continuationFor(cp,currency)[currency]:0));
   }
   return {value:total[metric],total,reward:{scoreRank:rank},expectedScore:tieScoreUpper,song:candidate};
 };
 const pairBonus=edge=>{
     const a=cardBonus('member',edge.member),b=cardBonus('support',edge.support);
     return {rewardBP:a.rewardBP+b.rewardBP,eventPointBP:a.eventPointBP+b.eventPointBP};
 };
 // Expected score remains the display tie-break. It is an optional additional
 // optimization objective, independent of proving the selected farming yield.
 const compare=(a,b)=>refineScoreTies?compareEventPlans(a,b,goal):
   compareEventPlans({...a,expectedScore:0},{...b,expectedScore:0},goal);
 let exact,bonusCeiling;
 if(!refineScoreTies&&!next.modifiers.performanceScenario){
   const input=resolveSearchInput(rules,next,{scope,inventory});
   const characters=new Map(rules.tables.MemberCard.map(row=>[`member-card-${row._id}`,row._characterID]));
   const edges=input.inventory.memberCardIds.flatMap(member=>input.inventory.supportCardIds.map(support=>
     ({key:`${member}|${support}`,member,support,character:characters.get(member),...pairBonus({member,support})})));
   const maximum=kind=>maximumPairing({edges:edges.map(edge=>({...edge,weight:edge[kind]}))});
   const rewards=maximum('rewardBP'),points=maximum('eventPointBP');
   if(rewards&&points&&result.results.length===3){
     bonusCeiling={rewardBP:rewards.weight,eventPointBP:points.weight};
     const ceiling=upperCandidate({scoreUpper:Number.MAX_VALUE,tieScoreUpper:Number.MAX_VALUE,
       ...bonusCeiling});
     if(compare(ceiling,result.results.at(-1))>=0)exact={results:result.results,evaluated:0,
       optimality:'proven_within_model',searchStatus:'completed',upperBound:ceiling.value,optimalityGap:0,
       upperCandidate:{value:ceiling.value,total:ceiling.total,scoreRank:ceiling.reward.scoreRank},
       bestProven:true,topNComplete:true,frontier:0,proof:'global_grade_and_bonus_ceiling'};
   }
 }
 exact??=await searchEventFormations({rules,draft:next,chart,scope,inventory,eventAdapters,boundMetric:basis,
   seeds:result.results,bonusFor:{metric:metric==='badges'?'rewardBP':'eventPointBP',pair:pairBonus,card:cardBonus},
   upperCandidate,transformScore,compareCandidates:compare,rankCandidates:(a,b)=>compareEventPlans(a,b,goal),bonusCeiling,
   maxEvaluations,signal,yieldControl,onProgress,scoreCache,scoreCounters:result.practical,baselineResult:result.baselineResult,
   modelCache,pairCache:candidateCache,pairCacheKey:candidateCache?'power:'+eventCandidateKey(rules,next,inventory,scope,eventAdapters,false):null});
 const {results:exactResults,...certificate}=exact;
 exactResults.sort((a,b)=>compareEventPlans(a,b,goal));
 return {...result,results:exactResults,evaluated:result.evaluated+exact.evaluated,optimality:exact.optimality,
   warnings:exact.searchStatus==='player_scenario_bound_unavailable'?result.warnings:
     [...result.warnings.filter(w=>!PRACTICAL_SEARCH_WARNINGS.includes(w)),
       refineScoreTies?'精确阶段同时优化收益和同收益期望分；收益差距为 0 也可能尚未证明期望分排序最优。':
         '精确阶段优化所选收益及次级收益，只有搜索完成时才证明最优；同收益队伍按已算出的期望分排序，不保证其期望分全局最优。',
       '后续挑战以提供的候选方案为范围。'],
   searchMethod:exact.searchStatus==='player_scenario_bound_unavailable'?'practical':'certified',
   certifiedSearch:{...certificate,scope:includeChallenge&&mode==='ordinary'?'team_for_chart_given_challenge_rows':'team_for_chart',
     objective:refineScoreTies?'reward_tuple_and_expected_score':'reward_tuple',
     scoreTieOptimality:refineScoreTies?exact.optimality:'not_proven'},
   status:exact.searchStatus==='player_scenario_bound_unavailable'?result.status:exact.searchStatus,
   objective:'event_yield',mode,goal,basis};
}
