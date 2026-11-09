import {createCandidateEvaluator} from './formation-candidate-evaluator.mjs';
import {legalPracticalDraft,practicalNeighbours} from './practical-optimizer.mjs';
import {compareEventPlans,compareEventRewards} from './event-yield-goals.mjs';

const signature=draft=>draft.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`).join(';');

/** Improve a reward winner after grade-based pruning has finished. Two local
 * rounds screen reward-competitive legal card, pairing and leader changes. Leaders
 * and the twelve leading neighbours are replayed over all 120 orders. This
 * preserves reward certificates; it does not prove globally optimal scores. */
export async function refineEventYieldTeams({rules,chart,input,eventAdapters=[],results,transformScore,goal,
 scoreCache=new Map(),counters={},scoreUpperFor,signal,yieldControl=async()=>{},onProgress=()=>{}}){
 const compare=(a,b)=>compareEventPlans(a,b,goal),rows=[...results].sort(compare);
 if(!rows.length)return rows;
 const characters=new Map(rules.tables.MemberCard.map(r=>[`member-card-${r._id}`,r._characterID])),characterFor=id=>characters.get(id);
 const refinement=counters.stabilityRefinement??={rounds:0,screened:0,fullyScored:0,rewardPruned:0,scorePruned:0};
 const music=rules.tables.LiveMusic.find(m=>`music-${m._id}`===input.draft.selectedSongId);
 const gradeScores=rules.tables.LiveScoreRank.filter(r=>r._group===music._liveScoreRankGroup).map(r=>r._requiredScore);
 const rewardCeilings=new Map();
 // Bonuses depend on the selected cards, not their pairing or leader. Check
 // every grade: neither rewards nor challenge continuation need be monotone.
 // These are reward bounds only; every retained recommendation is replayed.
 const rewardCeiling=(draft,upper=Infinity)=>{
  const key=draft.slots.map(s=>s.memberCardId).sort().join('|')+':'+draft.slots.map(s=>s.supportCardId).sort().join('|');
  if(!rewardCeilings.has(key)){
   const bounds=gradeScores.map(value=>({threshold:value,row:transformScore({minimumScore:value,expectedScore:value,maximumScore:value},draft)}));
   rewardCeilings.set(key,bounds.sort((a,b)=>compareEventRewards(a.row,b.row,goal)));
  }
  return rewardCeilings.get(key).find(b=>b.threshold<=upper)?.row;
 };
 const evaluators=new Map();
 const score=(draft,precision)=>{
  const key=precision+':'+signature(draft);
  if(scoreCache.has(key)){counters.scoreCacheHits=(counters.scoreCacheHits??0)+1;return scoreCache.get(key);}
  if(!evaluators.has(precision))evaluators.set(precision,createCandidateEvaluator({rules,chart,objective:'expected_song_score',
   eventAdapters,performanceScenario:input.draft.modifiers?.performanceScenario,scorePrecision:precision}));
  const raw=evaluators.get(precision).score(draft);scoreCache.set(key,raw);
  for(const field of ['scoreCalculations',precision==='full'?'fullScoreCalculations':'screenScoreCalculations'])counters[field]=(counters[field]??0)+1;
  return raw;
 };
 for(let round=0;round<2&&!signal?.aborted;round++){
  refinement.rounds++;
  const first=rows[0],screened=[];
  let checked=0;
  for(const neighbour of practicalNeighbours(first.draft,input.inventory)){
   if(signal?.aborted)break;
   if(!legalPracticalDraft(neighbour.draft,input,characterFor))continue;
   checked++;
   if(checked%50===0){onProgress({phase:'event-stability',stage:'提高同收益队伍的稳定性',round:round+1,completed:checked});await yieldControl();}
   if(compareEventRewards(rewardCeiling(neighbour.draft),first,goal)>0){refinement.rewardPruned++;continue;}
   if(scoreUpperFor){
    const upper=scoreUpperFor(neighbour.draft),ceiling=rewardCeiling(neighbour.draft,upper);
    const rewardOrder=ceiling?compareEventRewards(ceiling,first,goal):1;
    if(rewardOrder>0||rewardOrder===0&&upper<(first.scoreBasis==='minimumScore'?first.minimumScore:first.expectedScore)){
     refinement.scorePruned++;continue;
    }
   }
   screened.push({...transformScore(score(neighbour.draft,'screen'),neighbour.draft),...neighbour});
   refinement.screened++;
   onProgress({phase:'event-stability',stage:'提高同收益队伍的稳定性',round:round+1,completed:checked});
   await yieldControl();
  }
  screened.sort(compare);
  const finalists=new Map([...screened.filter(r=>r.kind==='leader'),...screened.slice(0,12)].map(r=>[signature(r.draft),r]));
  for(const [id,candidate] of finalists){
   if(signal?.aborted)break;
   const row={...transformScore(score(candidate.draft,'full'),candidate.draft),draft:candidate.draft,id,
    origins:['event-stability-refinement'],delta:null,comparison:null};
   refinement.fullyScored++;
   if(compare(row,rows[0])<0){
    rows.unshift(row);rows.sort(compare);
    onProgress({phase:'practical-result',bestCandidate:rows[0]});
   }
   await yieldControl();
  }
  if(rows[0]===first)break;
 }
 return [...new Map(rows.map(row=>[row.id,row])).values()].sort(compare).slice(0,results.length);
}
