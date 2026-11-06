/** Yield between CPU slices so progress and cancellation stay responsive. */
export function createCalculationScheduler({now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 let started=now(),pending=null;
 return async()=>{
   if(pending)return pending;
   const elapsed=now()-started;
   // Nested zero-delay browser timers may still wait ~4 ms. A longer full
   // speed slice avoids spending a quarter of the run waiting on timers.
   if(elapsed<48)return;
   pending=sleep(0).then(()=>{started=now();pending=null;});
   return pending;
 };
}
