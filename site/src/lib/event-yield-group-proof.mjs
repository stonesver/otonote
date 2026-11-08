import {resolveSearchInput} from './scoring-rules/formation-input.mjs';
import {maximumPairing,partitionPairing} from './scoring-rules/maximum-pairing.mjs';
import {compilePairingModels,draftFromPairing} from './inventory-optimizer.mjs';
import {createFormalSkillResolver} from './scoring-rules/formal-skills.mjs';
import {createFormalSongCalculator} from './scoring-rules/formal-song-score.mjs';
import {createOrdinaryScoreBound} from '../../../packages/scoring/scoring-rules/ordinary-score-bound.mjs';
import {createBonusConstrainedScoreEnvelopeBound} from '../../../packages/scoring/scoring-rules/bonus-constrained-score-bound.mjs';
import {createCandidateEvaluator} from './formation-candidate-evaluator.mjs';
import {createEventEfficiency} from './scoring-rules/event-efficiency.mjs';
import {prepareEventSearchInput} from './event-search-input.mjs';
import {createEventScoreCacheBinding,bindEventCandidateCache} from './event-search-cache.mjs';
import {compareEventPlans,compareEventRewards} from './event-yield-goals.mjs';
import {refineEventYieldTeams} from './event-yield-refinement.mjs';
import {eventCandidateKey,createChallengeContinuationPlanner,createEventYieldRewardTransform,attainableBonusSums,constrainBonusCards} from './event-yield-optimizer.mjs';

const HEURISTIC_SCORES_PER_CHART=48;

/** Prove the best reward tuple globally or independently for every chart. Chart envelopes
 * are normalized by each grade threshold before merging. A merged envelope
 * is a relaxation, never a synthetic score. Unknown coverage returns unproven
 * so the batch runner can retain its full individual-chart fallback. */
export async function proveEventYieldGroups({rules,eventId,input,candidates,challengeRows=[],initialRows=[],goal,
 candidateCache=new Map(),challengePlanCache,loadChart,getScoreCache,yieldControl=async()=>{},onProgress=()=>{},signal,individualProofs=false,allowForeignSeeds=false}){
 input={basis:'minimumScore',...input};
 await bindEventCandidateCache(candidateCache,rules);
 const stats={groups:0,groupsCompleted:0,leaders:0,visited:0,expanded:0,cardPartitions:0,chartPartitions:0,pairPartitions:0,prunedPartitions:0,
  fullScoreCalculations:0,boundScoreCalculations:0,scoreCacheHits:0,jointBoundMatchingCalls:0,powerMatchingCalls:0,
  heuristicScores:0,transferScores:0,representativeScores:0,candidateBoundPruned:0,normalizedEnvelopes:0,repeatedCandidatesSkipped:0,
  cardDomainCacheHits:0,bonusDomainCacheHits:0};
 let rows=[],covered=[];
 const compare=(a,b)=>compareEventRewards({...a,...(individualProofs?{song:{seconds:0}}:{})},{...b,...(individualProofs?{song:{seconds:0}}:{})},goal);
 const perChart=new Map();
 // A shared node can be excluded against the weakest incumbent among its
 // charts: beating ANY chart's incumbent also beats this lower reward tuple.
 // Splitting unresolved nodes retains every chart and every legal formation.
 const firstFor=charts=>individualProofs?charts.reduce((worst,e)=>{const row=perChart.get(e.candidate.id);return !worst||compare(row,worst)>0?row:worst;},null):rows[0];
 const retain=row=>{
  if(individualProofs){
   const old=perChart.get(row.song.id);
   const comparison=old?compare(row,old):-1;
   if(comparison>0||comparison===0&&compareEventPlans(row,old,goal)>=0)return;
   perChart.set(row.song.id,row);
   rows=[...perChart.values()].sort(compare);
  }else rows=[row,...rows.filter(r=>r.id!==row.id||r.song.id!==row.song.id)].sort(compare).slice(0,12);
 };
 const finish=(proven,reason)=>({results:rows,proven,certificate:{bestProven:proven,perChartBestProven:proven&&individualProofs,proofTarget:individualProofs?'best_for_each_chart':'best_for_goal_over_selected_charts',
  certifiedCount:proven?(individualProofs?candidates.length:1):0,topNComplete:false,alternativesOptimality:individualProofs?'each_chart_reward_proven':'not_proven',scoreTieOptimality:'not_proven',
  scope:'all_selected_charts_given_challenge_rows',objective:individualProofs?'per_chart_reward_tuple':'reward_tuple_and_duration',
  proof:'normalized_chart_groups_and_complete_card_pair_partitions',coverageComplete:proven,
  coveredChartIds:[...covered],candidateChartIds:candidates.map(c=>c.id),...(reason?{reason}:{})},stats:{...stats}});
 if(!candidates.length||input.mode!=='ordinary'||input.refineScoreTies||input.draft.modifiers?.performanceScenario)
  return finish(false,'group_bound_unavailable');
 const metric=goal==='eventPoints'?'eventPoints':'badges',other=metric==='badges'?'eventPoints':'badges';
 const primary=metric==='badges'?'rewardBP':'eventPointBP',secondary=primary==='rewardBP'?'eventPointBP':'rewardBP';
 if(input.scope==='owned'&&!input.inventory)return finish(false,'missing_owned_inventory');
 const options=prepareEventSearchInput({rules,draft:input.draft,scope:input.scope,inventory:input.inventory,
  rewardCards:input.rewardCards??[],rewardGrowth:input.rewardGrowth??'level',rewardGrowthOverride:input.rewardGrowthOverride??false});
 let draft=structuredClone(options.draft);draft.modifiers??={};delete draft.modifiers.event;
 if(options.scope==='owned'){
  if(!options.inventory)return finish(false,'missing_owned_inventory');
  draft.modifiers.growth=structuredClone(options.inventory.growth??{});
 }
 draft=resolveSearchInput(rules,draft,{scope:options.scope,inventory:options.inventory,constraints:input.constraints??{}}).draft;
 const model=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId});
 model.challengeCosts=rules.tables.ChallengeMusicBoostBonus.map(r=>r._consumedChallengePointCount);
 const cardBonuses=new Map(),cardBonus=(kind,id)=>{
  if(!cardBonuses.has(id))cardBonuses.set(id,model.cardBonus(kind,Number(id.split('-').at(-1)),draft.modifiers.growth?.[id]?.rank??1));
  return cardBonuses.get(id);
 };
 const pairBonuses=new WeakMap();
 const pairBonus=e=>{
  if(!pairBonuses.has(e)){const a=cardBonus('member',e.member),b=cardBonus('support',e.support);pairBonuses.set(e,{rewardBP:a.rewardBP+b.rewardBP,eventPointBP:a.eventPointBP+b.eventPointBP});}
  return pairBonuses.get(e);
 };
 const planners=new Map(),plans=new Map();
 const continuationFor=(cp,objective)=>{
  const key=objective+':'+cp;if(plans.has(key))return plans.get(key);
  if(!planners.has(objective))planners.set(objective,createChallengeContinuationPlanner(model,challengeRows,objective));
  const plan=planners.get(objective)(cp);plans.set(key,plan);return plan;
 };
 const plays=Math.floor(input.budget/input.liveBoost);
 const totalAt=(rank,kind,bp)=>{
  const reward=model.rewards({mode:'ordinary',scoreRank:rank,rewardBP:kind==='rewardBP'?bp:0,eventPointBP:kind==='eventPointBP'?bp:0,liveBoost:input.liveBoost,challengeCost:input.challengeCost});
  const continuation=input.includeChallenge?continuationFor((input.startingCP??0)+plays*reward.challengePoints,metric):null;
  const currency=kind==='rewardBP'?'badges':'eventPoints';
  return plays*reward[currency]+(continuation?.[currency]??0);
 };
 const groups=new Map(),entries=[];
 for(const candidate of [...candidates].sort((a,b)=>(a.seconds??Infinity)-(b.seconds??Infinity)||a.id.localeCompare(b.id))){
  if(signal?.aborted)return finish(false,'cancelled');
  const next={...structuredClone(draft),selectedSongId:candidate.trackId,selectedDifficulty:candidate.difficulty};
  const resolved=resolveSearchInput(rules,next,{scope:options.scope,inventory:options.inventory,constraints:input.constraints??{}});
  const key=eventCandidateKey(rules,next,options.inventory,options.scope,[],true,input.constraints??{});
  let group=groups.get(key);
  if(!group){
   const pairSkills=new Map(),resolver=createFormalSkillResolver(rules);
   for(const memberCardId of resolved.inventory.memberCardIds)for(const supportCardId of resolved.inventory.supportCardIds)
    pairSkills.set(`${memberCardId}|${supportCardId}`,resolver({slots:[{memberCardId,supportCardId}],modifiers:resolved.draft.modifiers})[0]);
   group={entries:[],models:null,pairSkills,resolved,merged:new Map(),transferred:new Set(),
    powerCacheKey:'group-power:'+JSON.stringify([eventCandidateKey(rules,next,options.inventory,options.scope,[],false),resolved.inventory,resolved.constraints])};groups.set(key,group);
  }
  const chart=await loadChart(candidate);
  if(chart.id!==candidate.id||chart.trackId!==candidate.trackId||chart.difficulty!==candidate.difficulty||chart.sourceReleaseId&&chart.sourceReleaseId!==rules.sourceReleaseId)
   return finish(false,'chart_identity_mismatch');
  const music=rules.tables.LiveMusic.find(r=>`music-${r._id}`===candidate.trackId);
  const grades=new Map(rules.tables.LiveScoreRank.filter(r=>r._group===music._liveScoreRankGroup).map(r=>[r._liveScoreRank,r._requiredScore]));
  const entry={candidate,chart,resolved,cacheDraft:next,song:null,bound:null,grades,envelopes:new Map(),group};
  entry.transform=createEventYieldRewardTransform({model,candidate,basis:input.basis,mode:'ordinary',liveBoost:input.liveBoost,challengeCost:input.challengeCost,
   budget:input.budget,startingCP:input.startingCP??0,includeChallenge:input.includeChallenge,metric,continuationFor});
  group.entries.push(entry);entries.push(entry);onProgress({phase:'event-group-preparation',stage:'准备跨谱面评分上界',completed:entries.length,total:candidates.length});await yieldControl();
 }
 stats.groups=groups.size;
 // Native replay histories are disposable but can retain 4 MiB per
 // calculator. Keep them only for the current transfer chart/search group.
 const songFor=entry=>entry.song??=createFormalSongCalculator(rules,entry.chart);
 const boundFor=entry=>entry.bound??=createOrdinaryScoreBound({song:songFor(entry),pairSkills:entry.group.pairSkills,legacyFactor:Infinity,input:entry.resolved,metric:input.basis,bonusConstraintBound:true});
 const releaseEntry=entry=>{entry.evaluator=null;entry.bound=null;entry.song=null;entry.envelopes.clear();};
 const byId=new Map(entries.map(e=>[e.candidate.id,e]));
 const seedEntry=row=>byId.get(row.song?.id)??(allowForeignSeeds?entries[0]:null);
 const cacheFor=async entry=>{
  entry.scoreCache??=await getScoreCache(entry.candidate,'ordinary',input,entry.chart);
  entry.bindScoreCache??=await createEventScoreCacheBinding({rules,chart:entry.chart,draft:entry.cacheDraft});
  entry.bindScoreCache(entry.scoreCache);return entry.scoreCache;
 };
 const characterFor=new Map(rules.tables.MemberCard.map(r=>[`member-card-${r._id}`,r._characterID]));
 const legal=(entry,team)=>{
  const pool=entry.resolved.inventory,c=entry.resolved.constraints,slots=team.slots;
  if(slots?.length!==5||slots.some(s=>!pool.memberCardIds.includes(s.memberCardId)||!pool.supportCardIds.includes(s.supportCardId)))return false;
  const members=slots.map(s=>s.memberCardId),supports=slots.map(s=>s.supportCardId);
  return new Set(members.map(id=>characterFor.get(id))).size===5&&new Set(supports).size===5
   &&(!c.leaderId||slots[2].memberCardId===c.leaderId)&&c.requiredMemberIds.every(id=>members.includes(id))&&c.requiredSupportIds.every(id=>supports.includes(id))
   &&c.lockedPairs.every(p=>slots.some(s=>s.memberCardId===p.memberCardId&&s.supportCardId===p.supportCardId));
 };
 rows=initialRows.filter(r=>seedEntry(r)
  &&r.orderCount===120&&r.reward?.mode==='ordinary'&&legal(seedEntry(r),r.draft)
  &&Number.isSafeInteger(r.total?.badges)&&Number.isSafeInteger(r.total?.eventPoints)).sort(compare);
 // A shard may borrow formations from another chart. Rescore all of those
 // before choosing an incumbent: their old rewards cannot rank destination
 // seeds, and must not displace a better local seed before native scoring.
 if(individualProofs&&!allowForeignSeeds){const seen=new Set();rows=rows.filter(row=>{if(seen.has(row.song.id))return false;seen.add(row.song.id);return true;});}
 else if(!individualProofs)rows=rows.slice(0,12);
 if(!rows.length)return finish(false,'no_verified_initial_row');
 // Rebuild seeds with THIS run's growth, score basis, budget and CP planner.
 // Structural validity alone cannot make a stale result a safe incumbent.
 const seeds=rows;rows=[];
 for(const seed of seeds){
  const entry=seedEntry(seed),edges=seed.draft.slots.map(s=>({member:s.memberCardId,support:s.supportCardId,key:s.memberCardId+'|'+s.supportCardId})).sort((a,b)=>a.key.localeCompare(b.key));
  const team=draftFromPairing(entry.resolved,seed.draft.slots[2].memberCardId,edges);
  const cache=await cacheFor(entry);
  const id=team.slots.map(s=>s.memberCardId+'|'+s.supportCardId).join(';');let raw=cache.get('full:'+id);
  if(raw)stats.scoreCacheHits++;else{entry.evaluator??=createCandidateEvaluator({rules,chart:entry.chart,objective:'expected_song_score'},{song:songFor(entry)});raw=entry.evaluator.score(team);cache.set('full:'+id,raw);stats.fullScoreCalculations++;}
  retain({...entry.transform(raw,team),draft:team,id,origins:['verified-current-group-seed'],recommendationGoals:[goal]});
 }
 rows.sort(compare);
 const envelopeFor=(entry,rank,requiredMembers=[])=>{
  const key=rank+':'+requiredMembers.join('|');
  if(!entry.envelopes.has(key)){
   if(entry.envelopes.size>=64)entry.envelopes.delete(entry.envelopes.keys().next().value);
   entry.envelopes.set(key,boundFor(entry).normalizedPowerEnvelope(entry.grades.get(rank),requiredMembers));stats.normalizedEnvelopes++;
  }
  return entry.envelopes.get(key);
 };
 const mergedFor=(group,charts,rank,state)=>{
  const members=input.basis==='minimumScore'?[...state.memberRequired].sort():[];
  const key=rank+':'+charts.map(e=>e.candidate.id).join('|')+':'+members.join('|');
  if(group.merged.has(key))return group.merged.get(key);
  const envelopes=charts.map(e=>envelopeFor(e,rank,members));
  const gains=new Map();
  const gainFor=edge=>{if(!gains.has(edge.key))gains.set(edge.key,Math.max(...envelopes.map(e=>e.gainFor(edge))));return gains.get(edge.key);};
  const bound=envelopes.every(Boolean)?createBonusConstrainedScoreEnvelopeBound({baseCoefficient:Math.max(...envelopes.map(e=>e.baseCoefficient)),
   gainFor,integerScore:false,cutoff:1}):null;
  if(group.merged.size>=64)group.merged.delete(group.merged.keys().next().value);
  group.merged.set(key,bound);return bound;
 };
 const score=async(entry,leader,matching,representative=false,transfer=false)=>{
  // Each chart needs its own useful incumbent. A single run-wide budget
  // starves later charts once early groups consume all optional scores,
  // leaving the complete proof to discover improvements by enumeration.
  if(!representative&&!transfer&&(entry.heuristicScores??0)>=HEURISTIC_SCORES_PER_CHART)return;
  // Bounds can suggest the same matching thousands of times. Its score and
  // reward are fixed within this chart/goal job; it has already updated the
  // incumbent, so even rebuilding its full growth draft is redundant.
  const signature=leader+':'+matching.edges.map(e=>e.key).join(';');
  entry.scored??=new Set();
  if(entry.scored.has(signature)){stats.repeatedCandidatesSkipped++;return;}
  const team=draftFromPairing(entry.resolved,leader,matching.edges);if(!legal(entry,team))return;
  const id=team.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`).join(';');
  const cache=await cacheFor(entry);
  let raw=cache.get('full:'+id);
  if(raw)stats.scoreCacheHits++;
  else {
   entry.evaluator??=createCandidateEvaluator({rules,chart:entry.chart,objective:'expected_song_score'},{song:songFor(entry)});
   raw=entry.evaluator.score(team);cache.set('full:'+id,raw);stats.fullScoreCalculations++;
   stats[transfer?'transferScores':representative?'representativeScores':'heuristicScores']++;
   if(!transfer&&!representative)entry.heuristicScores=(entry.heuristicScores??0)+1;
  }
  const row={...entry.transform(raw,team),draft:team,id,origins:['normalized-group-proof'],delta:null,comparison:null,recommendationGoals:[goal]};
  const old=individualProofs?perChart.get(entry.candidate.id):rows[0];retain(row);
  if(entry.scored.size>=4096)entry.scored.clear();
  entry.scored.add(signature);
  const best=individualProofs?perChart.get(entry.candidate.id):rows[0];
  if(!old||compare(best,old)<0){
   onProgress({phase:'event-group-proof',stage:individualProofs?'改进单曲收益方案':'改进跨谱面收益第一名',completed:stats.expanded,bestCandidate:best});
   // A better formation often improves nearby charts too. Transfer only its
   // cards, fully rescore on the destination, and cap this optional work.
   const group=entry.group;
   if(individualProofs&&!transfer&&group.transferred.size<8&&!group.transferred.has(id)){
    group.transferred.add(id);
    for(const other of group.entries){if(signal?.aborted)break;if(other!==entry)await score(other,leader,matching,false,true);}
   }
  }
  await yieldControl();
 };
 const scoreWitness=async(group,charts,leader,matching,required,rank)=>{
  if(charts.every(entry=>(entry.heuristicScores??0)>=HEURISTIC_SCORES_PER_CHART))return;
  const bonus=matching.edges.reduce((s,e)=>{const b=pairBonus(e);return {rewardBP:s.rewardBP+b.rewardBP,eventPointBP:s.eventPointBP+b.eventPointBP};},{rewardBP:0,eventPointBP:0});
  if(bonus[primary]<required[0]||bonus[secondary]<required[1])return;
  const power=matching.edges.reduce((s,e)=>s+e.weight,0);
  const promising=charts.map(entry=>{const env=envelopeFor(entry,rank);return {entry,potential:env?power*(env.baseCoefficient+matching.edges.reduce((s,e)=>s+env.gainFor(e),0)):Infinity};})
   .filter(r=>r.potential>=1&&(r.entry.heuristicScores??0)<HEURISTIC_SCORES_PER_CHART)
   .sort((a,b)=>(a.entry.candidate.seconds??Infinity)-(b.entry.candidate.seconds??Infinity)||b.potential-a.potential);
  for(const row of promising.slice(0,2))await score(row.entry,leader,matching);
 };
 // A formation proposed for one chart/goal can reach a different grade on
 // another power context. Transfer only the cards: score and rewards are
 // recomputed here. This is a bounded heuristic, never a coverage shortcut.
 const transferTeams=new Map();
 for(const target of [...new Set(['badges','eventPoints',goal])]){
  const seed=initialRows.filter(r=>seedEntry(r)&&legal(seedEntry(r),r.draft)&&r.orderCount===120)
   .sort((a,b)=>compareEventRewards(a,b,target))[0];
  if(!seed)continue;
  const leader=seed.draft.slots[2].memberCardId,edges=seed.draft.slots.map(s=>({member:s.memberCardId,support:s.supportCardId,key:s.memberCardId+'|'+s.supportCardId})).sort((a,b)=>a.key.localeCompare(b.key));
  transferTeams.set(leader+':'+edges.map(e=>e.key).join(';'),{leader,edges});
 }
 let transferred=0;
 for(const entry of entries){
  for(const matching of transferTeams.values()){
   if(signal?.aborted)return finish(false,'cancelled');
   await score(entry,matching.leader,matching,false,true);
   onProgress({phase:'event-group-seeds',stage:'跨谱面复算合法候选',completed:++transferred,total:entries.length*transferTeams.size,bestCandidate:rows[0]});
  }
  releaseEntry(entry);
 }
 if(individualProofs&&entries.some(entry=>!perChart.has(entry.candidate.id)))return finish(false,'missing_chart_seed');
 for(const group of groups.values()){
  const baseInput=group.resolved;
  group.models=await compilePairingModels(rules,baseInput,{signal,yieldControl,pairCache:candidateCache,pairCacheKey:group.powerCacheKey,onProgress:p=>onProgress({...p,stage:'准备当前谱面组的配对能力'})});
  if(!group.models)return finish(false,'cancelled');
  const allEdges=baseInput.inventory.memberCardIds.flatMap(member=>baseInput.inventory.supportCardIds.map(support=>({member,support,character:characterFor.get(member),key:member+'|'+support,weight:0})));
  if(!group.models.length)return finish(false,'missing_pair_models');
  const ceiling={};
  for(const kind of ['rewardBP','eventPointBP']){
   const maximum=maximumPairing({edges:allEdges,weight:e=>pairBonus(e)[kind]});if(!maximum)return finish(false,'missing_bonus_ceiling');
   ceiling[kind]=maximum.weight;
  }
  const minimumBonus=(rank,kind,target,attainable)=>{
   if(totalAt(rank,kind,ceiling[kind])<target)return null;
   let lo=0,hi=ceiling[kind];while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(totalAt(rank,kind,mid)>=target)hi=mid;else lo=mid+1;}
   if(!attainable)return lo;
   return attainable.find(value=>value>=lo)??null;
  };
  for(const [leaderIndex,modelRow] of group.models.entries()){
   const leader=modelRow.leader,c=baseInput.constraints;
   // Chart partitions share exactly the same card/edge domain. Cache only
   // chart-independent work, scoped to this immutable power model and leader.
   const cardDomains=new Map();
   const initial={leader,required:c.lockedPairs.map(p=>`${p.memberCardId}|${p.supportCardId}`),forbidden:[],
    memberRequired:[...new Set([leader,...c.requiredMemberIds,...c.lockedPairs.map(p=>p.memberCardId)])],
    supportRequired:[...new Set([...c.requiredSupportIds,...c.lockedPairs.map(p=>p.supportCardId)])],memberExcluded:[],supportExcluded:[],charts:group.entries};
   const states=[initial];
   while(states.length){
    if(signal?.aborted)return finish(false,'cancelled');
    stats.visited++;onProgress({phase:'event-group-proof',stage:individualProofs?'验证逐曲收益上界':'验证跨谱面收益上界',group:stats.groupsCompleted+1,groups:stats.groups,groupsCompleted:stats.groupsCompleted,leader:leaderIndex+1,leaderTotal:group.models.length,frontier:states.length,leaders:stats.leaders,visited:stats.visited,expanded:stats.expanded,completed:stats.visited,bestCandidate:rows[0]});await yieldControl();
    if(signal?.aborted)return finish(false,'cancelled');
    const state=states.pop();
    if(individualProofs&&state.charts.length>1){
     const buckets=new Map();
     for(const entry of state.charts){
      const row=perChart.get(entry.candidate.id),key=JSON.stringify([goal==='grade'?row.reward.scoreRank:null,row.total.badges,row.total.eventPoints]);
      if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(entry);
     }
     if(buckets.size>1){
      for(const charts of buckets.values())states.push({...state,charts});
      stats.chartPartitions+=buckets.size-1;stats.expanded++;continue;
     }
    }
    const domainKey=JSON.stringify([state.required,state.forbidden,state.memberRequired,state.supportRequired,state.memberExcluded,state.supportExcluded]);
    let domain=cardDomains.get(domainKey);
    if(domain)stats.cardDomainCacheHits++;
    else {
     const requiredCharacters=new Map(state.memberRequired.map(id=>[characterFor.get(id),id]));
     const excludedM=new Set(state.memberExcluded),excludedS=new Set(state.supportExcluded),requiredM=new Set(state.memberRequired),requiredS=new Set(state.supportRequired);
     const edges=modelRow.edges.filter(e=>!excludedM.has(e.member)&&!excludedS.has(e.support)
      &&(!requiredCharacters.has(e.character)||requiredCharacters.get(e.character)===e.member)
      &&(requiredM.size<5||requiredM.has(e.member))&&(requiredS.size<5||requiredS.has(e.support)));
     stats.powerMatchingCalls++;
     const power=maximumPairing({edges,required:state.required,forbidden:state.forbidden,requiredMembers:state.memberRequired,requiredSupports:state.supportRequired});
     const attainable=power?Object.fromEntries([primary,secondary].map(kind=>[kind,attainableBonusSums(edges,state,kind,cardBonus)])):null;
     domain={edges,power,attainable,constrained:new Map()};
     if(cardDomains.size>=64)cardDomains.delete(cardDomains.keys().next().value);
     cardDomains.set(domainKey,domain);
    }
    const {edges,power,attainable}=domain;
    if(!power)continue;
    const maxBP=Object.fromEntries([primary,secondary].map(kind=>[kind,attainable[kind]?.at(-1)??ceiling[kind]]));
    const shortest=Math.min(...state.charts.map(e=>e.candidate.seconds??Infinity));
    // Independent bonus maxima and the shortest chart form a lexicographic
    // upper tuple, even if these quantities cannot be realized together.
    let cheapCanWin=false;
    for(let rank=2;rank<=7;rank++){
     const total={badges:totalAt(rank,'rewardBP',maxBP.rewardBP),eventPoints:totalAt(rank,'eventPointBP',maxBP.eventPointBP)};
     if(compare({reward:{scoreRank:rank},total,song:{seconds:shortest}},firstFor(state.charts))<0){cheapCanWin=true;break;}
    }
    if(!cheapCanWin){stats.prunedPartitions++;continue;}
    let unresolved=false;
    for(let rank=7;rank>=2;rank--){
     const first=firstFor(state.charts);if(goal==='grade'&&rank<first.reward.scoreRank)continue;
     const domains=[];
     if(goal==='grade'&&rank>first.reward.scoreRank)domains.push({required:[0,0],charts:state.charts});
     else {
      const higher=minimumBonus(rank,primary,first.total[metric]+1,attainable[primary]);
      if(higher!=null)domains.push({required:[higher,0],charts:state.charts});
      const same=minimumBonus(rank,primary,first.total[metric],attainable[primary]),more=minimumBonus(rank,secondary,first.total[other]+1,attainable[secondary]);
      if(same!=null&&more!=null)domains.push({required:[same,more],charts:state.charts});
      const tied=minimumBonus(rank,secondary,first.total[other],attainable[secondary]);
      const faster=individualProofs?[]:state.charts.filter(e=>(e.candidate.seconds??Infinity)<(first.song.seconds??Infinity));
      if(same!=null&&tied!=null&&faster.length)domains.push({required:[same,tied],charts:faster});
     }
     let retry=false;
     for(const {required,charts} of domains){
      let excluded=false;
      const relaxation=mergedFor(group,charts,rank,state);
      for(const [a,b] of [[1,0],[0,1],[1,1],[ceiling[secondary]+1,1],[1,ceiling[primary]+1],[8,1],[1,8],[64,1],[1,64]]){
       if(!a&&!required[1]||!b&&!required[0])continue;
       const threshold=a*required[0]+b*required[1];if(!Number.isSafeInteger(threshold))continue;
       const bonusKey=a+':'+b+':'+threshold;
       let bonusDomain=domain.constrained.get(bonusKey);
       if(bonusDomain)stats.bonusDomainCacheHits++;
       else {
        const constrained=constrainBonusCards(edges,state,(kind,id)=>{const bp=cardBonus(kind,id);return a*bp[primary]+b*bp[secondary];},threshold);
        stats.powerMatchingCalls++;
        const constrainedPower=maximumPairing({edges:constrained,required:state.required,forbidden:state.forbidden,requiredMembers:state.memberRequired,requiredSupports:state.supportRequired});
        bonusDomain={constrained,constrainedPower};
        if(domain.constrained.size>=8)domain.constrained.delete(domain.constrained.keys().next().value);
        domain.constrained.set(bonusKey,bonusDomain);
       }
       const {constrained,constrainedPower}=bonusDomain;
       if(!constrainedPower){excluded=true;break;}
       if(relaxation){
        const banned=new Set(state.forbidden),fixed=new Set(state.required),available=constrained.filter(e=>!banned.has(e.key));
        const before=relaxation.stats.matchingCalls;
        const upper=relaxation(available,constrainedPower.edges.filter(e=>fixed.has(e.key)),leader,constrainedPower,0,e=>{const bp=pairBonus(e);return a*bp[primary]+b*bp[secondary];},threshold,state);
        stats.jointBoundMatchingCalls+=relaxation.stats.matchingCalls-before;
        const witnesses=relaxation.witnesses.filter(w=>w.bonus>=threshold).sort((x,y)=>y.weight-x.weight);
        if(witnesses[0])await scoreWitness(group,charts,leader,witnesses[0],required,rank);
        if(upper<1){excluded=true;break;}
       }
       if(signal?.aborted)return finish(false,'cancelled');
      }
      if(!excluded){if(compare(firstFor(state.charts),first)<0){retry=true;break;}unresolved=true;break;}
     }
     if(unresolved)break;if(retry)rank++;
    }
    if(!unresolved){stats.prunedPartitions++;continue;}
    const kind=state.memberRequired.length<5?'member':state.supportRequired.length<5?'support':null;
    // A merged envelope can combine incompatible advantages from different
    // charts. Split that relaxation before multiplying the card subsets.
    // Both halves retain every legal team and cover the parent chart domain.
    if(state.charts.length>1){
     const mid=Math.ceil(state.charts.length/2);states.push({...state,charts:state.charts.slice(mid)},{...state,charts:state.charts.slice(0,mid)});stats.chartPartitions++;
    }else if(kind){
     // Resolve cards of a maximum-power matching first: excluding one
     // tightens the grade bound, including it reduces the remaining domain.
     // This only orders the complete include/exclude partition; both sides
     // remain in the search, including low-power high-bonus cards.
     domain.strengths??={};let strengths=domain.strengths[kind];
     if(!strengths){
      strengths=new Map();for(const edge of edges)strengths.set(edge[kind],Math.max(strengths.get(edge[kind])??-Infinity,edge.weight));
      domain.strengths[kind]=strengths;
     }
     const choices=[...strengths.keys()].filter(id=>!state[kind+'Required'].includes(id)),matched=new Set(power.edges.map(e=>e[kind]));
     const order=(a,b)=>Number(matched.has(b))-Number(matched.has(a))||strengths.get(b)-strengths.get(a)||a.localeCompare(b);
     const id=choices.reduce((best,id)=>best===null||order(id,best)<0?id:best,null);if(!id)return finish(false,'incomplete_card_partition');
     states.push({...state,[kind+'Excluded']:[...state[kind+'Excluded'],id]},{...state,[kind+'Required']:[...state[kind+'Required'],id]});stats.cardPartitions++;
    }else {
     const entry=state.charts[0],team=draftFromPairing(entry.resolved,leader,power.edges),fixed={...state,required:power.edges.map(e=>e.key)};
     boundFor(entry);const before=entry.bound.stats.fullScoreCalculations;
     const upper=entry.bound(fixed,{...modelRow,edges:power.edges},power,()=>team);stats.boundScoreCalculations+=entry.bound.stats.fullScoreCalculations-before;
     const maxRank=model.scoreRank(Number(entry.candidate.trackId.split('-').at(-1)),upper===Infinity?Number.MAX_VALUE:upper);
     const bonus=power.edges.reduce((s,e)=>{const b=pairBonus(e);return {rewardBP:s.rewardBP+b.rewardBP,eventPointBP:s.eventPointBP+b.eventPointBP};},{rewardBP:0,eventPointBP:0});
     let canWin=false;
     for(let rank=2;rank<=maxRank;rank++){
      const total={badges:totalAt(rank,'rewardBP',bonus.rewardBP),eventPoints:totalAt(rank,'eventPointBP',bonus.eventPointBP)};
      if(compare({reward:{scoreRank:rank},total,song:entry.candidate},firstFor([entry]))<0){canWin=true;break;}
     }
     if(canWin)await score(entry,leader,power,true);else stats.candidateBoundPruned++;
     states.push(...partitionPairing(state,power));stats.pairPartitions++;
    }
    stats.expanded++;
    onProgress({phase:'event-group-proof',stage:individualProofs?'验证逐曲最优收益':'验证跨谱面收益第一名',group:stats.groupsCompleted+1,groups:stats.groups,groupsCompleted:stats.groupsCompleted,leader:leaderIndex+1,leaderTotal:group.models.length,frontier:states.length,leaders:stats.leaders,visited:stats.visited,expanded:stats.expanded,completed:stats.visited,bestCandidate:rows[0]});await yieldControl();
   }
   stats.leaders++;await yieldControl();
  }
  covered.push(...group.entries.map(e=>e.candidate.id));stats.groupsCompleted++;group.models=null;group.merged.clear();for(const entry of group.entries)releaseEntry(entry);
 }
 const refined=[];
 for(const row of rows){
  if(signal?.aborted)return finish(false,'cancelled');
  const entry=byId.get(row.song.id);
  refined.push(...await refineEventYieldTeams({rules,chart:entry.chart,input:entry.resolved,results:[row],transformScore:entry.transform,goal,
    scoreCache:await cacheFor(entry),counters:stats,signal,yieldControl,onProgress}));
 }
 rows=refined.sort((a,b)=>compareEventPlans(a,b,goal));
 return finish(!signal?.aborted,signal?.aborted?'cancelled':undefined);
}
