import {bindEventScoreCache} from './event-search-cache.mjs';
import {withEventRewardCandidates} from './event-reward-candidates.mjs';
import {optimizePractical} from './practical-optimizer.mjs';
import {createEventEfficiency,planChallengeSpending} from './scoring-rules/event-efficiency.mjs';

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
 if(!rows.length)throw Error('缺少可计算的后续挑战方案');
 const secondary=metric==='badges'?'eventPoints':'badges';
 const picks=modelChallengeCosts(model,rows).map(cost=>{
   const options=rows.map(row=>({row,reward:model.rewards({mode:'challenge',scoreRank:row.reward.scoreRank,...row.bonuses,challengeCost:cost})}));
   options.sort((a,b)=>b.reward[metric]-a.reward[metric]||b.reward[secondary]-a.reward[secondary]||(a.row.song.seconds??Infinity)-(b.row.song.seconds??Infinity));
   return options[0];
 });
 const plan=planChallengeSpending(picks.map(p=>p.reward),availableCP,metric);
 return {...plan,stages:plan.consumption.map(c=>({...c,...picks.find(p=>p.reward.challengeCost===c.cost)}))};
}
// Costs are supplied by the caller's rules, not invented from reward ratios.
function modelChallengeCosts(model,rows){return model.challengeCosts??[...new Set(rows.map(r=>r.reward.challengeCost))];}

export async function optimizeEventYield({rules,eventId,draft,chart,candidate,scope='owned',inventory,mode='ordinary',
 liveBoost=1,challengeCost=200,budget=100,startingCP=0,goal='badges',basis='expectedScore',challengeRows=[],includeChallenge=true,
 onProgress,yieldControl=async()=>{},signal,candidateCache,scoreCache,rewardCards=[],rewardGrowth='level'}){
 if(!['ordinary','challenge'].includes(mode))throw Error('收益配队仅支持普通与挑战；激奏需要团队结算档位');
 if(!['owned','selected'].includes(scope)||!['badges','eventPoints','grade'].includes(goal))throw Error('Invalid event search options');
 if(!Number.isInteger(budget)||budget<1||budget>10000||!Number.isInteger(startingCP)||startingCP<0||startingCP>1000000)throw Error('Invalid farming budget');
 ({draft,scope,inventory}=withEventRewardCandidates({rules,draft,scope,inventory,rewardCards,rewardGrowth}));
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
 const plans=new Map();
 const transformScore=(score,team)=>{
   const bonuses=model.teamBonus(team.slots.map(s=>({memberId:Number(s.memberCardId.split('-').at(-1)),supportId:Number(s.supportCardId.split('-').at(-1)),
     memberRank:team.modifiers.growth?.[s.memberCardId]?.rank??1,supportRank:team.modifiers.growth?.[s.supportCardId]?.rank??1})));
   const grades=eventGradeEstimate(model,Number(candidate.trackId.split('-').at(-1)),score,basis);
   const reward=model.rewards({mode,...bonuses,scoreRank:grades.scoreRank,liveBoost:mode==='ordinary'?liveBoost:0,challengeCost});
   let continuation=null,plays=mode==='ordinary'?Math.floor(budget/liveBoost):1;
   if(mode==='ordinary'&&includeChallenge){
     const cp=startingCP+plays*reward.challengePoints;
     if(!plans.has(cp))plans.set(cp,challengeContinuation(model,challengeRows,cp,metric));
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
   eventAdapters,extraProfiles,transformScore,candidateCache,scoreCache,pairCache:candidateCache,
   pairCacheKey:candidateCache?"power:"+eventCandidateKey(rules,next,inventory,scope,eventAdapters,false):null,
   candidateCacheKey:candidateCache?eventCandidateKey(rules,next,inventory,scope,eventAdapters)+':reward-event='+eventId:null,
   compareCandidates:(a,b)=>compareEventPlans(a,b,goal),finalistLimit:12,retainedOrigins:['bonus-items','bonus-points','bonus-both','mixed-items','mixed-points'],onProgress,yieldControl,signal});
 return {...result,objective:'event_yield',mode,goal,basis};
}
