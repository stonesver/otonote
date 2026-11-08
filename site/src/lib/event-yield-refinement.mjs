import {createCandidateEvaluator} from './formation-candidate-evaluator.mjs';
import {legalPracticalDraft,practicalNeighbours} from './practical-optimizer.mjs';
import {compareEventPlans} from './event-yield-goals.mjs';

const signature=draft=>draft.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`).join(';');

/** Improve a reward winner after grade-based pruning has finished. Two local
 * rounds screen every legal single-card, pairing and leader change. Leaders
 * and the twelve leading neighbours are replayed over all 120 orders. This
 * preserves reward certificates; it does not prove globally optimal scores. */
export async function refineEventYieldTeams({rules,chart,input,eventAdapters=[],results,transformScore,goal,
 scoreCache=new Map(),counters={},signal,yieldControl=async()=>{},onProgress=()=>{}}){
 const compare=(a,b)=>compareEventPlans(a,b,goal),rows=[...results].sort(compare);
 if(!rows.length)return rows;
 const characters=new Map(rules.tables.MemberCard.map(r=>[`member-card-${r._id}`,r._characterID])),characterFor=id=>characters.get(id);
 const refinement={rounds:0,screened:0,fullyScored:0};counters.stabilityRefinement=refinement;
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
   screened.push({...transformScore(score(neighbour.draft,'screen'),neighbour.draft),...neighbour});
   checked++;refinement.screened++;
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
