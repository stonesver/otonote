import {createCalculationScopeControl} from './calculation-scope-ui.mjs';
const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};

export function setupTeamScopeControls(workbench,{onChange}) {
  const q=s=>workbench.querySelector(s),task=el('select');task.setAttribute('aria-label','配队任务');
  for(const [value,text] of [['single','当前谱面'],['playlist','歌单逐曲']]){const o=el('option',text);o.value=value;task.append(o);}
  const label=el('label','配队任务');label.dataset.playlistTask='';const note=el('small','歌单内每张谱面分别推荐队伍。');note.className='team-playlist-note';label.append(task,note);q('[data-optimize-pairing]').parentElement.before(label);
  const scope=createCalculationScopeControl({host:workbench,mount:label.parentElement,data:workbench.data,toolKey:'team',getEnabled:()=>task.value==='playlist',getFixedTitle:()=>'当前谱面',getMode:()=>q('[data-pairing-mode]').value,onChange:()=>{onChange();workbench.songPicker?.refresh();}});
  workbench.calculationScope=scope;task.addEventListener('change',onChange);
  const carry=event=>{const link=event.target.closest?.('a[href]');if(link?.href.includes('/tools/'))scope.carry(link);};workbench.addEventListener('click',carry);
  return {task,scope,destroy(){workbench.removeEventListener('click',carry);scope.destroy();delete workbench.calculationScope;}};
}
export function setupEventScopeControls(tool,{getFilters,onChange,getResultCharts}) {
  const changed=()=>{onChange();tool.songPicker?.refresh();tool.taskWorkbench?.refresh();};
  const q=s=>tool.querySelector(`[data-yield-${s}]`),mount=el('div');mount.dataset.eventCalculationScope='';tool.q('yield-optimizer').prepend(mount);
  const main=createCalculationScopeControl({host:tool,mount,data:tool.data,toolKey:'event-main',getEnabled:()=>tool.q('mode').value==='ordinary'&&q('songs').value!=='selected'&&!['challenge','quick'].includes(tool.dataset?.task),getFixedTitle:()=>tool.q('mode').value==='challenge'?'本期活动曲':'指定谱面',getMode:()=>tool.q('mode').value,getFilters:()=>getFilters(false),onChange:changed});
  tool.calculationScope=main;
  const challenge=createCalculationScopeControl({host:tool,mount:q('challenge-settings'),data:tool.data,toolKey:'event-challenge',getEnabled:()=>false,getFixedTitle:()=>'本期挑战曲池',getMode:()=>tool.q('mode').value,getInheritedSelection:()=>main.selection,getFilters:()=>getFilters(true),onChange:changed});
  const save=el('button','将本次结果谱面保存为歌单');save.type='button';save.disabled=true;save.title='计算产生结果后，可保存本次结果中的谱面';mount.append(save);save.addEventListener('click',()=>{const charts=getResultCharts();if(charts.length)main.saveCharts(charts);});
  const carry=event=>{const link=event.target.closest?.('a[href]');if(link?.href.includes('/tools/'))main.carry(link);};tool.addEventListener('click',carry);
  return {main,challenge,refresh(){mount.hidden=!main.enabled;save.disabled=!getResultCharts().length;},destroy(){tool.removeEventListener('click',carry);main.destroy();challenge.destroy();delete tool.calculationScope;}};
}
