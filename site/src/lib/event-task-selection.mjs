/** Explicit event links win; otherwise use the newest available challenge event. */
export function defaultEventId(events, linkedId) {
 const available=events.filter(event=>event._eventType===1);
 const linked=available.find(event=>String(event._id)===linkedId);
 if(linked)return String(linked._id);
 const start=event=>String(event._startAt??'').replaceAll('/','-');
 const newest=[...available].sort((a,b)=>start(b).localeCompare(start(a))||b._id-a._id)[0];
 return newest?String(newest._id):null;
}

/** Songs and phase belong to a task; cards and account settings stay shared. */
export function createEventTaskSelection(initialTask, initial) {
 const empty=()=>({selectedSongId:null,selectedDifficulty:null,mode:'ordinary',songScope:'all'});
 const saved={team:empty(),quick:empty(),challenge:{...empty(),mode:'challenge'}};
 let active=initialTask;
 saved[active]={...saved[active],...initial};
 return {switchTo(task,current){
  saved[active]={...saved[active],...current};active=task;
  if(task==='challenge')saved[task].mode='challenge';
  return {...saved[task]};
 }};
}

/** Ordinary filters and the directly selected challenge chart have separate homes. */
export function createEventPhaseSelection(initial) {
 const saved={ordinary:{mode:'ordinary',selectedSongId:null,selectedDifficulty:null,songScope:'all'},challenge:{mode:'challenge',selectedSongId:null,selectedDifficulty:null,songScope:'selected'}};
 let active=initial.mode;
 const capture=current=>{active=current.mode;saved[active]={...current,songScope:active==='challenge'?'selected':current.songScope};};
 capture(initial);
 return {capture,switchTo(mode,current){saved[active]={...current,mode:active,songScope:active==='challenge'?'selected':current.songScope};active=mode;return {...saved[mode]};}};
}
