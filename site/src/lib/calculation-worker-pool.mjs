/** Bounded CPU workers. Any worker failure rejects the whole phase so its
 * caller can replay the original complete serial search. Never drop a job. */
export function createCalculationWorkerPool({size,createWorker}){
 if(!Number.isInteger(size)||size<1)throw Error('Invalid calculation worker count');
 const slots=[],queue=[];let closed=false,nextId=0;
 const close=(error=new Error('Calculation workers closed'))=>{
  if(closed)return;closed=true;
  for(const slot of slots){slot.worker.terminate();slot.job?.reject(error);slot.job=null;}
  for(const job of queue.splice(0))job.reject(error);
 };
 function pump(){
  if(closed)return;
  try{
   while(queue.length){
    let slot=slots.find(s=>!s.job);
    if(!slot&&slots.length<size){
     const worker=createWorker();slot={worker,job:null};slots.push(slot);
     worker.addEventListener('message',({data})=>{
      const job=slot.job;if(!job||data.id!==job.id)return;
      if(data.type==='progress'){job.progress?.(data.progress);return;}
      if(data.type!=='result'){close(new Error(data.message??'Invalid calculation worker response'));return;}
      slot.job=null;job.resolve(data.result);pump();
     });
     worker.addEventListener('error',()=>close(new Error('Calculation worker failed')));
     worker.addEventListener('messageerror',()=>close(new Error('Calculation worker response could not be read')));
    }
    if(!slot)return;
    slot.job=queue.shift();slot.worker.postMessage({id:slot.job.id,task:slot.job.task});
   }
  }catch(error){close(error);}
 }
 return {run:(task,progress)=>new Promise((resolve,reject)=>{
  if(closed){reject(new Error('Calculation workers closed'));return;}
  queue.push({id:++nextId,task,progress,resolve,reject});pump();
 }),close};
}

export function eventYieldParallelism(input,{cores=globalThis.navigator?.hardwareConcurrency??1,memory=globalThis.navigator?.deviceMemory}={}){
 if(input.eco===true||input.searchDepth!=='full')return 1;
 // Keep one logical core for interaction; cap replicated scoring data on
 // low-memory and unknown-memory browsers rather than exhausting the device.
 return Math.max(1,Math.min(Number.isFinite(cores)?Math.floor(cores)-1:1,memory>=8?4:2));
}
