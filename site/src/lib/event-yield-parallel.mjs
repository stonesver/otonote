import {createCalculationWorkerPool,eventYieldParallelism} from './calculation-worker-pool.mjs';
import {compareEventPlans} from './event-yield-goals.mjs';

// Keep complete power-context groups together. Partitioning only schedules
// independent per-chart proofs; every assigned chart still needs a proof.
function chartPartitions(rules,candidates,count){
 if(count<=1)return [{candidates}];
 const music=new Map(rules.tables.LiveMusic.map(row=>['music-'+row._id,row])),groups=new Map();
 for(const candidate of candidates){
  const row=music.get(candidate.trackId),key=row?JSON.stringify([row._musicType,row._bestMusicTagIDs]):candidate.id;
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(candidate);
 }
 if(groups.size<2)return [{candidates}];
 const partitions=Array.from({length:Math.min(count,groups.size)},()=>({candidates:[],groupCount:0}));
 for(const group of [...groups.values()].sort((a,b)=>b.length-a.length)){
  const target=partitions.reduce((best,p)=>p.candidates.length<best.candidates.length?p:best);
  target.candidates.push(...group);target.groupCount++;
 }
 return partitions;
}

export function createEventYieldParallel({rules,eventId,input,onMessage,createWorker=()=>new Worker(new URL('./event-yield-task-worker.mjs',import.meta.url),{type:'module'}),size=eventYieldParallelism(input)}){
 if(size<2)return {close(){}};
 let active;
 async function phase(tasks,progress,completed=()=>{}){
  const pool=createCalculationWorkerPool({size:Math.min(size,tasks.length),createWorker});active=pool;
  try{return await Promise.all(tasks.map((task,index)=>pool.run({rules,eventId,...task},p=>progress(index,p)).then(result=>{completed(index,result);return result;})));}
  finally{pool.close();if(active===pool)active=null;}
 }
 return {
  close:()=>active?.close(),
  runWitnessJobs:async({candidates,input:stage,challengeRows,done,total})=>{
   const jobs=chartPartitions(rules,candidates,size).map(partition=>({kind:'witness',input:stage,...partition,challengeRows}));
   const outputs=await phase(jobs,(_index,p)=>onMessage({type:'progress',done,total,stage:'准备逐曲收益起点',detail:p,parallelism:Math.min(size,jobs.length)}));
   return outputs.flatMap(output=>output.records);
  },
  runChallengeJobs:async({candidates,input:stage,goals,total})=>{
   let done=0;
   const jobs=candidates.map(candidate=>({kind:'challenge',candidate,input:stage}));
   const parallelism=Math.min(size,jobs.length);
   const outputs=await phase(jobs,(index,p)=>onMessage({type:'progress',done,total,title:candidates[index].title,stage:p.stage??p.phase,detail:p,parallelism}),()=>{done++;onMessage({type:'progress',done,total,title:'后续挑战',stage:'完成一张挑战谱面',parallelism});});
   // Validate the complete ordered task domain before publishing any result.
   if(outputs.length!==candidates.length||outputs.some((o,i)=>o.candidateId!==candidates[i].id||o.records?.length!==goals.length||o.records.some((r,j)=>r.goal!==goals[j])))throw Error('Incomplete parallel challenge results');
   return outputs;
  },
  runGroupProofs:async({candidates,input:stage,goals,challengeRows,initialRows,done,total,onCandidate=()=>{},individualProofs=false})=>{
   if(!goals.length)return new Map();
   const partitions=chartPartitions(rules,candidates,individualProofs?size*2:1);
   const tasks=partitions.flatMap(partition=>goals.map(goal=>({kind:'group',input:stage,...partition,goal,challengeRows,
    initialRows,individualProofs,allowForeignSeeds:partitions.length>1})));
   const progress=new Map(),latestByGoal=new Map();
   const combinedProgress=goal=>{
    const indices=tasks.flatMap((task,i)=>task.goal===goal?[i]:[]),latest=latestByGoal.get(goal)??{};
    const sum=key=>indices.reduce((total,i)=>total+(progress.get(i)?.[key]??(key==='groups'?tasks[i].groupCount:0)??0),0);
    return {goal,...latest,...Object.fromEntries(['groups','groupsCompleted','visited','expanded'].map(key=>[key,sum(key)]))};
   };
   const report=(index,p)=>{
    const goal=tasks[index].goal;progress.set(index,{...progress.get(index),...p});latestByGoal.set(goal,p);if(p.bestCandidate)onCandidate(goal,p.bestCandidate);
    onMessage({type:'progress',done,total,goal,stage:p.stage??p.phase,detail:p,parallelism:Math.min(size,tasks.length),parallelGoals:goals.map(combinedProgress)});
   };
   const proofs=await phase(tasks,
    report,(index,proof)=>report(index,{phase:'event-group-proof',groups:proof.stats?.groups,groupsCompleted:proof.stats?.groupsCompleted,visited:proof.stats?.visited}));
   for(const [index,proof] of proofs.entries()){
    const ids=new Set(tasks[index].candidates.map(c=>c.id)),covered=new Set(proof.certificate?.coveredChartIds??[]);
    if(!proof.proven||!proof.certificate?.bestProven||covered.size!==ids.size||[...ids].some(id=>!covered.has(id))
      ||individualProofs&&(!proof.certificate.perChartBestProven||proof.results?.length!==ids.size||proof.results.some(r=>!ids.has(r.song.id))
       ||[...ids].some(id=>!proof.results.some(r=>r.song.id===id))))throw Error('Incomplete parallel group proof');
   }
   return new Map(goals.map(goal=>{
    const parts=proofs.filter((_,i)=>tasks[i].goal===goal);if(parts.length===1)return [goal,parts[0]];
    const ids=candidates.map(c=>c.id),stats={};
    for(const proof of parts)for(const [key,value] of Object.entries(proof.stats??{}))if(typeof value==='number')stats[key]=(stats[key]??0)+value;
    return [goal,{...parts[0],results:parts.flatMap(p=>p.results).sort((a,b)=>compareEventPlans(a,b,goal)),stats,
     certificate:{...parts[0].certificate,certifiedCount:ids.length,coveredChartIds:ids,candidateChartIds:ids}}];
   }));
  }
 };
}
