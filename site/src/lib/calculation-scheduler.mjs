/** Cooperative worker scheduling. Short bursts followed by proportional rest
 * reduce sustained CPU load without reducing the candidate set or precision. */
export function createCalculationScheduler({eco=false,now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 let started=now(),pending=null;
 return async()=>{
   if(pending)return pending;
   const elapsed=now()-started;
   // Nested zero-delay browser timers may still wait ~4 ms. A longer full
   // speed slice avoids spending a quarter of the run waiting on timers.
   if(elapsed<(eco?12:48))return;
   pending=sleep(eco?Math.min(100,Math.max(16,elapsed*2)):0).then(()=>{started=now();pending=null;});
   return pending;
 };
}
