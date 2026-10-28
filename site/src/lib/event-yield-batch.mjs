import {optimizeEventYield,compareEventPlans} from './event-yield-optimizer.mjs';
import {eventYieldGoals,selectEventYieldRows} from './event-yield-goals.mjs';
import {eventYieldStageInput} from './event-yield-stage.mjs';
import {planEventSearch} from './event-search-plan.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';

const seconds=c=>c.seconds??Infinity;
const compare=(a,b,goal)=>compareEventPlans({...a,expectedScore:0},{...b,expectedScore:0},goal);

/** Shared demand order for the batch and its bounded network lookahead. */
export function eventYieldChartPlan(candidates,rules,input){
 const plan=planEventSearch(candidates,rules,input.draft),full=input.searchDepth==='full';
 const selected=full?[...plan.full].sort((a,b)=>seconds(a)-seconds(b)||a.id.localeCompare(b.id)):plan.quick;
 return {plan,selected};
}

/** Production worker and local benchmarks share this complete batch path.
 * A skipped chart is covered by a global objective bound, never represented
 * as if its own best formation had been calculated. */
export async function runEventYieldBatch({rules,eventId,candidates,challengeCandidates=[],input,
 loadChart,optimizer=optimizeEventYield,candidateCache=new Map(),challengePlanCache=new Map(),
 getScoreCache=async()=>new Map(),afterChart=async()=>{},onJobComplete=async()=>{},onGroupComplete=async()=>{},
 onMessage=()=>{},signal,yieldControl=createCalculationScheduler({eco:input.eco===true}),proveGroup,
 globalPruning=true,witnessPrepass=true,runChallengeJobs,runGroupProofs}){
 const {plan,selected}=eventYieldChartPlan(candidates,rules,input),full=input.searchDepth==='full';
 const cycle=input.mode==='ordinary'&&input.includeChallenge;
 const goals=eventYieldGoals(input.goal,input.mode),total=selected.length+(cycle?challengeCandidates.length:0),available=candidates.length+(cycle?challengeCandidates.length:0);
 const failures=[],challengeRows=[],rows=new Map(),scoreCaches=new Map(),resolved=new Map(goals.map(g=>[g,new Set()])),
   pruned=new Map(goals.map(g=>[g,new Set()])),globalProofs={},uppers=new Map(),witnessCharts=new Set(),failed=new Set();
 let challengeDone=0,challengeOptimized=0,cacheHits=0,calculations=0,optimizerInvocations=0;
 const canGlobal=globalPruning&&full&&input.searchMethod!=='practical'&&!input.refineScoreTies&&!input.draft.modifiers?.performanceScenario;
 const key=(c,mode)=>mode+':'+c.id;
 const cacheFor=async(c,mode,stage,chart)=>{
   const id=key(c,mode);if(!scoreCaches.has(id))scoreCaches.set(id,Promise.resolve(getScoreCache(c,mode,stage,chart)));
   return scoreCaches.get(id);
 };
 const allRows=()=>[...rows.values()].flat();
 const bestFor=goal=>allRows().filter(r=>r.recommendationGoals.includes(goal)).sort((a,b)=>compare(a,b,goal))[0];
 const handled=(c,g)=>resolved.get(g).has(c.id)||pruned.get(g).has(c.id)||failed.has(key(c,input.mode));
 const completed=()=>challengeDone+selected.filter(c=>goals.every(g=>handled(c,g))).length;
 const boundCovers=(c,goal)=>{
   if(!canGlobal)return false;
   const upper=uppers.get(goal),best=bestFor(goal);if(!upper||!best)return false;
   return compare({total:upper.total,reward:{scoreRank:upper.scoreRank},song:c},best,goal)>=0;
 };
 const checkProofs=()=>{
   for(const goal of goals)if(!globalProofs[goal]?.bestProven&&full&&candidates.every(c=>resolved.get(goal).has(c.id)||pruned.get(goal).has(c.id))&&!failures.length)
     globalProofs[goal]={bestProven:true,proofTarget:'best',scope:cycle?'all_selected_charts_given_challenge_rows':'all_selected_charts',
       proof:'individual_proofs_and_global_chart_bounds',alternativesOptimality:'not_proven',scoreTieOptimality:input.refineScoreTies?'proven':'not_proven'};
 };
 const snapshot=type=>{
   checkProofs();
   const accounted=selected.filter(c=>goals.every(g=>handled(c,g))).length;
   const individual=selected.filter(c=>goals.every(g=>resolved.get(g).has(c.id))).length;
   const globallyCovered=selected.filter(c=>goals.every(g=>resolved.get(g).has(c.id)||pruned.get(g).has(c.id))).length;
   const groupComplete=goals.every(g=>globalProofs[g]?.bestProven);
   const coverageComplete=!failures.length&&(groupComplete||full&&globallyCovered===candidates.length);
   const fullyOptimizedCharts=challengeOptimized+individual,prunedCharts=Math.max(0,globallyCovered-individual);
   return {type,rows:selectEventYieldRows(allRows(),input.goal),failures,done:challengeDone+accounted,total,available,
     complete:coverageComplete,coverageComplete,evaluatedCharts:fullyOptimizedCharts,fullyOptimizedCharts,prunedCharts,
     witnessCharts:witnessCharts.size,optimizerInvocations,allProven:!failures.length&&fullyOptimizedCharts===available,
     globalProofs:{...globalProofs},cacheHits,calculations};
 };
 const mainChart=async(c,{witnessOnly=false,practicalSeed=false,preview=false}={})=>{
   const stage=eventYieldStageInput(input,input.mode),id=key(c,input.mode);
   if(failed.has(id))return;
   let chart,scoreCache;
   try{
     for(const goal of goals){
       if(signal?.aborted)break;
       if(resolved.get(goal).has(c.id)||pruned.get(goal).has(c.id))continue;
       if(boundCovers(c,goal)){pruned.get(goal).add(c.id);continue;}
       chart??=await loadChart(c);scoreCache??=await cacheFor(c,input.mode,stage,chart);
       const started=performance.now();
       onMessage({type:'progress',done:completed(),total,title:c.title,stage:practicalSeed?'准备跨谱面收益搜索起点':witnessOnly?'验证合法收益上界见证':'证明所选收益第一名'});
       const result=await optimizer({rules,eventId,...stage,candidate:c,chart,challengeRows,candidateCache,scoreCache,challengePlanCache,
         yieldControl,signal,goal,witnessOnly,searchMethod:practicalSeed?'practical':stage.searchMethod??'certified',maxEvaluations:full?0:stage.maxEvaluations??24,
         includeChallenge:input.mode==='ordinary'&&input.includeChallenge,
         onProgress:p=>{
           const best=p.bestCandidate&&bestFor(goal);
           if(p.bestCandidate&&(!best||compare(p.bestCandidate,best,goal)<0)){
             rows.set('live:'+c.id+':'+goal,[{...p.bestCandidate,recommendationGoals:[goal],search:{bestProven:false}}]);onMessage(snapshot('partial'));
           }
           onMessage({type:'progress',done:completed(),total,title:c.title,stage:p.stage??p.phase,detail:p});
         }});
       optimizerInvocations++;cacheHits+=result.practical.scoreCacheHits;calculations+=result.practical.scoreCalculations;
       if(witnessOnly)witnessCharts.add(c.id);
       rows.delete('live:'+c.id+':'+goal);
       rows.set((preview?'preview:':practicalSeed?'seed:':'')+c.id+':'+goal,result.results.map(row=>({...row,recommendationGoals:[goal],search:{optimality:result.optimality,status:result.status,...result.certifiedSearch}})));
       if(!preview&&result.certifiedSearch?.globalUpperCandidate)uppers.set(goal,result.certifiedSearch.globalUpperCandidate);
       if(!practicalSeed&&result.certifiedSearch?.bestProven)resolved.get(goal).add(c.id);
       await onJobComplete({candidate:c,mode:input.mode,goal,witnessOnly,practicalSeed,result,wallMs:performance.now()-started});
     }
     if(chart&&scoreCache)await afterChart({candidate:c,mode:input.mode,stageInput:stage,chart,scoreCache,candidateCache});
   }catch(error){if(!preview){failures.push({id:c.id,mode:input.mode,title:c.title,message:error.message});failed.add(id);}}
   onMessage(snapshot('partial'));
 };
 // Show a fully scored, legal cycle before starting unbounded certificates.
 // These rows are incumbents only. They never account for a completed chart,
 // and are removed before proofs use the final challenge continuation input.
 if(cycle&&canGlobal&&challengeCandidates.length&&selected.length&&!signal?.aborted){
   const c=challengeCandidates[0],stage=eventYieldStageInput(input,'challenge');
   try{
     const chart=await loadChart(c),scoreCache=await cacheFor(c,'challenge',stage,chart),goal=eventYieldGoals(input.goal,'challenge')[0];
     const started=performance.now();
     const result=await optimizer({rules,eventId,...stage,candidate:c,chart,challengeRows:[],candidateCache,scoreCache,challengePlanCache,
       yieldControl,signal,goal,searchMethod:'practical',maxEvaluations:0,includeChallenge:false,
       onProgress:p=>onMessage({type:'progress',done:0,total,title:c.title,stage:p.stage??p.phase,detail:p})});
     optimizerInvocations++;cacheHits+=result.practical.scoreCacheHits;calculations+=result.practical.scoreCalculations;
     challengeRows.push(...result.results.map(r=>({...r,recommendationGoals:[goal],search:{bestProven:false}})));
     await onJobComplete({candidate:c,mode:'challenge',goal,practicalSeed:true,result,wallMs:performance.now()-started});
     await afterChart({candidate:c,mode:'challenge',stageInput:stage,chart,scoreCache,candidateCache});
     if(challengeRows.length&&!signal?.aborted)await mainChart(selected[0],{practicalSeed:true,preview:true});
   }catch{/* The complete challenge domain below remains authoritative. */}
   challengeRows.length=0;
 }
 let parallelChallengesDone=false;
 if(cycle&&full&&runChallengeJobs&&!signal?.aborted){
  let outputs;
  try{outputs=await runChallengeJobs({candidates:challengeCandidates,input:eventYieldStageInput(input,'challenge'),goals:eventYieldGoals(input.goal,'challenge'),total});}
  catch{onMessage({type:'progress',done:0,total,stage:'并行计算不可用，继续完整单核计算'});}
  if(outputs&&!signal?.aborted){
   for(const [index,output] of outputs.entries()){
    const c=challengeCandidates[index];let chartProven=true;
    for(const {goal,result,wallMs} of output.records){
     optimizerInvocations++;cacheHits+=result.practical.scoreCacheHits;calculations+=result.practical.scoreCalculations;
     chartProven&&=Boolean(result.certifiedSearch?.bestProven);
     challengeRows.push(...result.results.map(r=>({...r,recommendationGoals:[goal],search:{optimality:result.optimality,...result.certifiedSearch}})));
     await onJobComplete({candidate:c,mode:'challenge',goal,witnessOnly:false,result,wallMs});
    }
    if(chartProven)challengeOptimized++;challengeDone++;
   }
   parallelChallengesDone=true;
  }
 }
 if(cycle&&!parallelChallengesDone)for(const c of challengeCandidates){
   if(signal?.aborted)break;
   const stage=eventYieldStageInput(input,'challenge');
   let chartProven=true;
   try{
     const chart=await loadChart(c),scoreCache=await cacheFor(c,'challenge',stage,chart);
     for(const goal of eventYieldGoals(input.goal,'challenge')){
       if(signal?.aborted)break;
       const started=performance.now();
       const result=await optimizer({rules,eventId,...stage,candidate:c,chart,challengeRows:[],candidateCache,scoreCache,challengePlanCache,
         yieldControl,signal,goal,maxEvaluations:full?0:stage.maxEvaluations??24,includeChallenge:false,
         onProgress:p=>onMessage({type:'progress',done:challengeDone,total,title:c.title,stage:p.stage??p.phase,detail:p})});
       optimizerInvocations++;cacheHits+=result.practical.scoreCacheHits;calculations+=result.practical.scoreCalculations;
       chartProven&&=Boolean(result.certifiedSearch?.bestProven);
       challengeRows.push(...result.results.map(r=>({...r,recommendationGoals:[goal],search:{optimality:result.optimality,...result.certifiedSearch}})));
       await onJobComplete({candidate:c,mode:'challenge',goal,witnessOnly:false,result,wallMs:performance.now()-started});
     }
     await afterChart({candidate:c,mode:'challenge',stageInput:stage,chart,scoreCache,candidateCache});
   }catch(error){chartProven=false;failures.push({id:c.id,mode:'challenge',title:c.title,message:error.message});}
   if(chartProven&&!signal?.aborted)challengeOptimized++;
   challengeDone++;
 }
 if(cycle&&!challengeRows.length&&!signal?.aborted)throw Error('后续挑战全部计算失败，无法可靠比较总收益。');
 if(cycle&&!signal?.aborted)for(const id of rows.keys())if(id.startsWith('preview:'))rows.delete(id);
 if(canGlobal&&witnessPrepass)for(const c of selected){if(signal?.aborted)break;await mainChart(c,{witnessOnly:true});}
 // These representative charts supply legal incumbents, never coverage.
 // Every selected chart remains in the subsequent complete proof domain.
 if(canGlobal&&proveGroup&&input.mode==='ordinary')for(const c of plan.quick){
   if(signal?.aborted)break;if(!goals.every(g=>handled(c,g)))await mainChart(c,{practicalSeed:true});
 }
 let parallelProofs;
 if(canGlobal&&proveGroup&&runGroupProofs&&!signal?.aborted){
  const pending=goals.filter(goal=>!candidates.every(c=>resolved.get(goal).has(c.id)||pruned.get(goal).has(c.id)));
  if(pending.length)try{parallelProofs=await runGroupProofs({candidates:selected,input:eventYieldStageInput(input,input.mode),goals:pending,challengeRows,initialRows:allRows(),done:completed(),total,
   onCandidate:(goal,row)=>{const best=bestFor(goal);if(!best||compare(row,best,goal)<0){rows.set('parallel-live:'+goal,[{...row,recommendationGoals:[goal],search:{bestProven:false}}]);onMessage(snapshot('partial'));}}});}
  catch{onMessage({type:'progress',done:completed(),total,stage:'并行验证不可用，继续完整单核验证'});}
 }
 if(canGlobal&&proveGroup&&!signal?.aborted)for(const goal of goals){
   if(candidates.every(c=>resolved.get(goal).has(c.id)||pruned.get(goal).has(c.id)))continue;
   let proof;
   try{proof=parallelProofs?.get(goal)??await proveGroup({rules,eventId,input:eventYieldStageInput(input,input.mode),candidates:selected,challengeRows,initialRows:allRows(),goal,
     candidateCache,challengePlanCache,loadChart,getScoreCache:cacheFor,yieldControl,signal,
     onProgress:p=>onMessage({type:'progress',done:completed(),total,goal,stage:p.stage??p.phase,detail:p})});
   }catch(error){proof={proven:false,error:error.message};}
   cacheHits+=proof.stats?.scoreCacheHits??0;calculations+=proof.stats?.fullScoreCalculations??0;
   if(proof.results?.length)rows.set('global:'+goal,proof.results.map(row=>({...row,recommendationGoals:[goal],search:{...proof.certificate,global:true}})));
   if(proof.proven){rows.delete('parallel-live:'+goal);globalProofs[goal]={...proof.certificate,bestProven:true,proofTarget:'best',scope:cycle?'all_selected_charts_given_challenge_rows':'all_selected_charts'};
     for(const c of selected)if(!resolved.get(goal).has(c.id))pruned.get(goal).add(c.id);}
   await onGroupComplete({goal,proof});
   // Group witnesses use the same raw score maps as the individual path.
   for(const c of selected)if(scoreCaches.has(key(c,input.mode))){
     const stage=eventYieldStageInput(input,input.mode),chart=await loadChart(c);
     await afterChart({candidate:c,mode:input.mode,stageInput:stage,chart,scoreCache:await scoreCaches.get(key(c,input.mode)),candidateCache});
   }
 }
 for(const c of selected){if(signal?.aborted)break;if(!goals.every(g=>handled(c,g)))await mainChart(c);}
 return snapshot('result');
}
