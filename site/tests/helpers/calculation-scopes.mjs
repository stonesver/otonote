import {resolveCalculationScope,requireCalculationScope} from '../../src/lib/calculation-scope.mjs';
/** Controller tests use the real scope resolver without mounting a browser dialog. */
export function scopeControl(data,getFilters=()=>({}),getFixedTitle=()=>undefined) {
 let selection={kind:'all'},playlists=[];
 const resolve=(filters=getFilters())=>resolveCalculationScope({...data,...filters,selection,playlists,fixedRangeTitle:getFixedTitle()});
 return {get snapshot(){return resolve();},get selection(){return selection;},setSelection(value,lists=[]){selection=value;playlists=lists;},
   refresh(){},resolve,require:filters=>requireCalculationScope(resolve(filters)),destroy(){}};
}
export function eventScopeControls(tool,{getFilters}) {
 const main=scopeControl(tool.data,()=>getFilters(false),()=>tool.q('mode').value==='ordinary'&&tool.querySelector('[data-yield-songs]').value!=='selected'?undefined:'指定曲目'),challenge=scopeControl(tool.data,()=>getFilters(true),()=>'本期挑战曲池');
 return {main,challenge,destroy(){}};
}
export function teamScopeControls(tool) {
 const task={value:'single'};return {task,scope:scopeControl(tool.data,()=>({}),()=>task.value==='single'?'当前谱面':undefined),destroy(){}};
}
