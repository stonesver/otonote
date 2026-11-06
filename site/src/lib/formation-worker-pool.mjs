/** Bounded persistent evaluation workers, with per-batch cancellation.
 * @param {unknown} context
 * @param {number} size
 * @param {{signal?: AbortSignal, createWorker?: () => Worker}} options */
export async function createFormationWorkerPool(context, size, {signal, createWorker=()=>new Worker(new URL('./formation-evaluation-worker.mjs',import.meta.url),{type:'module'})}={}) {
  const slots=[];let sequence=0,closed=false;
  function close(){if(closed)return;closed=true;for(const slot of slots){slot.worker.terminate();slot.pending?.reject(new Error('Calculation worker closed'));slot.readyReject?.(new Error('Calculation worker closed'));}signal?.removeEventListener('abort',cancel);}
  function cancel(){for(const slot of slots)slot.worker.postMessage({type:'cancel'});}
  signal?.addEventListener('abort',cancel);
  try {
    await Promise.all(Array.from({length:size},()=>new Promise((resolve,reject)=>{
      const worker=createWorker(),slot={worker,pending:null,readyReject:reject};slots.push(slot);
      worker.onmessage=({data})=>{
        if(data.type==='ready'){slot.readyReject=null;resolve();return;}
        if(data.type==='error'){const error=new Error(data.error);if(slot.readyReject){slot.readyReject=null;reject(error);}slot.pending?.reject(error);slot.pending=null;return;}
        if(data.type==='evaluated' && slot.pending?.id===data.taskId){slot.pending.resolve(data.result);slot.pending=null;}
      };
      worker.onerror=()=>{const error=new Error('Calculation worker failed');reject(error);slot.pending?.reject(error);slot.pending=null;};
      worker.postMessage({type:'init',context});
    })));
  }catch(error){close();throw error;}
  async function evaluateBatch(drafts){
    if(closed)throw new Error('Calculation worker closed');
    if(drafts.length>slots.length)throw new Error('Calculation batch exceeds worker count');
    if(signal?.aborted)return drafts.map(()=>null);
    return Promise.all(drafts.map((draft,i)=>new Promise((resolve,reject)=>{
      const slot=slots[i],id=++sequence;slot.pending={id,resolve,reject};slot.worker.postMessage({type:'evaluate',taskId:id,draft});
    })));
  }
  return {evaluateBatch,close};
}
