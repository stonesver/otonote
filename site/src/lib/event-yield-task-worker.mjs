import {optimizeEventYield} from './event-yield-optimizer.mjs';
import {proveEventYieldGroups} from './event-yield-group-proof.mjs';
import {eventYieldGoals} from './event-yield-goals.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';
import {createBoundedChartLoader} from './bounded-chart-loader.mjs';
import {createEventSearchStore,eventSearchPartition,searchDigest} from './event-search-cache.mjs';

self.addEventListener('message',async({data:{id,task}})=>{
 let loader;
 try{
  const {rules,eventId,input,kind}=task,store=createEventSearchStore(),caches=new Map(),keys=new Map();
  const candidates=kind==='challenge'?[task.candidate]:task.candidates;
  loader=createBoundedChartLoader({candidates});
  const getScoreCache=async(c,mode,stage,chart)=>{
   if(!caches.has(c.id)){
    const base=await eventSearchPartition(rules,eventId,stage)+':'+mode+':'+await searchDigest({chart});
    const key=kind==='group'?base+':parallel:'+task.goal:base;
    caches.set(c.id,new Map([...(await store.get(base)??[]),...(key!==base?await store.get(key)??[]:[])]));keys.set(c.id,key);
   }
   return caches.get(c.id);
  };
  const candidateCache=new Map(),challengePlanCache=new Map(),yieldControl=createCalculationScheduler();
  let reportedAt=-Infinity;
  const onProgress=p=>{const now=performance.now();if(now-reportedAt<120)return;reportedAt=now;self.postMessage({id,type:'progress',progress:p});};
  let result;
  if(kind==='challenge'){
   const candidate=task.candidate,chart=await loader.loadChart(candidate),scoreCache=await getScoreCache(candidate,'challenge',input,chart),records=[];
   for(const goal of eventYieldGoals(input.goal,'challenge')){
    const start=performance.now();
    const value=await optimizeEventYield({rules,eventId,...input,candidate,chart,goal,candidateCache,challengePlanCache,scoreCache,yieldControl,
     maxEvaluations:0,includeChallenge:false,onProgress});
    records.push({goal,result:value,wallMs:performance.now()-start});
   }
   result={candidateId:candidate.id,records};
  }else if(kind==='witness'){
   const records=[];
   for(const candidate of candidates){
    const chart=await loader.loadChart(candidate),scoreCache=await getScoreCache(candidate,'ordinary',input,chart),modelCache={};
    for(const goal of eventYieldGoals(input.goal,'ordinary')){
     const start=performance.now();
     const value=await optimizeEventYield({rules,eventId,...input,candidate,chart,goal,challengeRows:task.challengeRows,
      candidateCache,challengePlanCache,scoreCache,modelCache,yieldControl,onProgress,witnessOnly:true,refineStability:false,maxEvaluations:0});
     records.push({candidateId:candidate.id,goal,result:value,wallMs:performance.now()-start});
    }
   }
   result={records};
  }else if(kind==='group'){
   result=await proveEventYieldGroups({rules,eventId,input,candidates,goal:task.goal,challengeRows:task.challengeRows,initialRows:task.initialRows,
    candidateCache,challengePlanCache,loadChart:loader.loadChart,getScoreCache,yieldControl,onProgress,individualProofs:task.individualProofs===true,allowForeignSeeds:task.allowForeignSeeds===true});
  }else throw Error('Unknown parallel calculation task');
  for(const [chartId,cache] of caches)await store.put(keys.get(chartId),[...cache]);
  await loader.close();self.postMessage({id,type:'result',result});
 }catch(error){await loader?.close();self.postMessage({id,type:'error',message:error.message});}
});
