import {createCalculationWorkerPool,eventYieldParallelism} from './calculation-worker-pool.mjs';

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
  runChallengeJobs:async({candidates,input:stage,goals,total})=>{
   let done=0;
   const jobs=candidates.map(candidate=>({kind:'challenge',candidate,input:stage}));
   const outputs=await phase(jobs,(index,p)=>onMessage({type:'progress',done,total,title:candidates[index].title,stage:p.stage??p.phase,detail:p,parallelism:size}),()=>{done++;onMessage({type:'progress',done,total,title:'后续挑战',stage:'完成一张挑战谱面',parallelism:size});});
   // Validate the complete ordered task domain before publishing any result.
   if(outputs.length!==candidates.length||outputs.some((o,i)=>o.candidateId!==candidates[i].id||o.records?.length!==goals.length||o.records.some((r,j)=>r.goal!==goals[j])))throw Error('Incomplete parallel challenge results');
   return outputs;
  },
  runGroupProofs:async({candidates,input:stage,goals,challengeRows,initialRows,done,total,onCandidate=()=>{},individualProofs=false})=>{
   const progress=new Map();
   const report=(index,p)=>{progress.set(goals[index],{...progress.get(goals[index]),...p});if(p.bestCandidate)onCandidate(goals[index],p.bestCandidate);onMessage({type:'progress',done,total,goal:goals[index],stage:p.stage??p.phase,detail:p,parallelism:Math.min(size,goals.length),parallelGoals:goals.map(goal=>({goal,...progress.get(goal)}))});};
   const proofs=await phase(goals.map(goal=>({kind:'group',input:stage,candidates,goal,challengeRows,initialRows,individualProofs})),
    report,(index,proof)=>report(index,{phase:'event-group-proof',groups:proof.stats?.groups,groupsCompleted:proof.stats?.groupsCompleted,visited:proof.stats?.visited}));
   const ids=new Set(candidates.map(c=>c.id));
   for(const proof of proofs){const covered=new Set(proof.certificate?.coveredChartIds??[]);
    if(!proof.proven||!proof.certificate?.bestProven||covered.size!==ids.size||[...ids].some(id=>!covered.has(id))
      ||individualProofs&&(!proof.certificate.perChartBestProven||[...ids].some(id=>!proof.results?.some(r=>r.song.id===id))))throw Error('Incomplete parallel group proof');
   }
   return new Map(goals.map((goal,i)=>[goal,proofs[i]]));
  }
 };
}
