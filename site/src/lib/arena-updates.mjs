import {checkedJson,validatePointer} from '../runtime/content.mjs';

/** Inspect a moving pointer without replacing the document's immutable snapshot. */
export function createContentUpdateCheck({region,pinned,pointer=null,fetcher=globalThis.fetch}) {
 let pending=null;
 return function check(){
  if(!pending)pending=(async()=>{
   try {
    const latest=validatePointer(await checkedJson(region==='jp'?'/content/jp/current.json':'/content/current.json',null,fetcher));
    return {status:latest.manifest===pinned.root+'manifest.json'&&(!pointer||pointer.sha256===latest.sha256)?'current':'changed',pointer:latest};
   }catch{return {status:'unknown'};}
  })().finally(()=>{pending=null;});
  return pending;
 };
}

/** Visible-only checks and wall-clock boundaries. All clocks/timers are injectable. */
export function installArenaUpdates({onBoundary,onCheck,onClockJump,getNextBoundary=()=>Infinity,checkInterval=300000,
 clock=()=>Date.now(),document=globalThis.document,window=globalThis.window,
 setTimer=setTimeout,clearTimer=clearTimeout,monotonic=()=>performance.now()}) {
 let timer=null,checkAt=clock()+checkInterval,lastWall=clock(),lastMono=monotonic(),suspended=false;
 const visible=()=>!suspended&&document.visibilityState!=='hidden';
 function tick(force=false){
  if(!visible())return;
  const now=clock(),mono=monotonic();
  const jumped=Math.abs((now-lastWall)-(mono-lastMono))>120000;
  lastWall=now;lastMono=mono;
  if(jumped)onClockJump();
  const boundary=now>=getNextBoundary();
  // Caller reparses at the exact next boundary, and on foreground recovery.
  if(boundary||force||jumped)onBoundary();
  if(boundary||force||jumped||now>=checkAt){checkAt=now+checkInterval;void onCheck();}
  schedule();
 }
 function schedule(){
  if(timer!==null)clearTimer(timer);
  if(!visible())return;
  const now=clock();
  timer=setTimer(()=>tick(),Math.max(1,Math.min(60000,checkAt-now,getNextBoundary()-now+1)));
 }
 function resume(){if(visible())tick(true);else if(timer!==null){clearTimer(timer);timer=null;}}
 const focus=()=>resume();
 const hide=()=>{suspended=true;if(timer!==null)clearTimer(timer);timer=null;};
 const show=()=>{suspended=false;resume();};
 document.addEventListener('visibilitychange',resume);
 window.addEventListener('focus',focus);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);
 schedule();
 return ()=>{hide();document.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',focus);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);};
}

/** Next Beijing 03:00: a synchronization check, never a generated mission cycle. */
export function nextArenaDailyCheck(now) {
 const day=86400000,offset=19*3600000;
 return Math.floor((now-offset)/day)*day+offset+day;
}
