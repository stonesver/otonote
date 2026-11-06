import {setupQuickOptions} from './tool-quick-options.mjs';
import {setupAttributeFilter} from './calculator-card-ui.mjs';
import {matchesFilter,selectedControlValues,restoreFilterControl} from './filter-controls.mjs';
export function matchesSongMission(missions,filter) {
  if(!filter)return true;
  if(filter==='mixed')return new Set(missions).size>1;
  return filter.endsWith('-only')?missions.every(m=>String(m)===filter.split('-')[0]):missions.some(m=>String(m)===filter);
}
export function matchesSongChart(chart,{difficulty='',min='',max=''}={}) {
  return !chart.disabled&&matchesFilter(chart.difficulty,difficulty)&&(!min||chart.level>=Number(min))&&(!max||chart.level<=Number(max));
}
export function setupCalculatorSongPicker(root,{getSelection,onSelect,allowedTrackIds=()=>null,getCalculationScope=()=>root.calculationScope}) {
  const picker=root.querySelector('[data-song-picker]');if(!picker)return null;
  const q=s=>picker.querySelector(s),rows=[...picker.querySelectorAll('[data-song-row]')],choices=[...picker.querySelectorAll('[data-song-choice]')];
  const rowCharts=new Map(rows.map(row=>[row,[...row.querySelectorAll('[data-song-choice]')]]));
  const list=q('[data-song-list]');let displayed=[];
  const fields=['query','band','difficulty','mission','sort','min','max'],pageSize=18;let page=0,visible=[];
  const attributes=setupAttributeFilter(q('[data-song-attributes]'),()=>{page=0;filter();});
  const shortcuts=setupQuickOptions(picker);
  function filter() {
    shortcuts.sync();
    const f=Object.fromEntries(fields.map(key=>{const field=q(`[data-song-${key}]`);return [key,field.multiple?selectedControlValues(field):field.value];}));
    const words=f.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const allowed=allowedTrackIds();let scopeKeys=null;
    const calculationScope=getCalculationScope();if(calculationScope){try{scopeKeys=new Set(calculationScope.resolve({}).candidates.map(c=>`${c.trackId}:${c.difficulty}`));}catch{scopeKeys=new Set();}}
    const levels=new Map();
    visible=rows.filter(row=>{
      const charts=rowCharts.get(row);
      for(const c of charts){
        const hidden=Boolean(scopeKeys&&!scopeKeys.has(`${c.dataset.songChoice}:${c.dataset.difficulty}`))||!matchesSongChart({difficulty:c.dataset.difficulty,level:Number(c.dataset.level),disabled:c.disabled},f);
        if(c.hidden!==hidden)c.hidden=hidden;
      }
      if(f.sort==='level')levels.set(row,Math.max(...charts.filter(c=>!c.hidden).map(c=>Number(c.dataset.level))));
      return (!allowed||allowed.has(row.dataset.songRow))&&(!attributes.values.length||attributes.values.includes(row.dataset.attribute))&&words.every(w=>row.dataset.search.includes(w))&&matchesFilter(row.dataset.bands.split(' '),f.band)&&matchesSongMission(row.dataset.missions.split(',').map(Number),f.mission)&&charts.some(c=>!c.hidden);
    });
    if(f.sort==='name')visible.sort((a,b)=>a.dataset.title.localeCompare(b.dataset.title,'zh-CN'));
    if(f.sort==='level')visible.sort((a,b)=>levels.get(b)-levels.get(a));
    const pages=Math.max(1,Math.ceil(visible.length/pageSize));page=Math.min(page,pages-1);
    const next=visible.slice(page*pageSize,(page+1)*pageSize),shown=new Set(next);
    for(const row of rows){const hidden=!shown.has(row);if(row.hidden!==hidden)row.hidden=hidden;}
    if(next.length!==displayed.length||next.some((row,i)=>row!==displayed[i]))for(const row of next)list.append(row);
    displayed=next;
    q('[data-song-empty]').hidden=visible.length>0;q('[data-song-count]').textContent=`${visible.length} 首歌曲 · 属性可多选`;
    q('[data-song-page]').textContent=`${page+1} / ${pages}`;q('[data-song-prev]').disabled=page===0;q('[data-song-next]').disabled=page===pages-1;
  }
  function reset(){fields.forEach(key=>restoreFilterControl(q(`[data-song-${key}]`),key==='sort'?'default':''));attributes.reset();page=0;filter();}
  function sync() {
    const {selectedSongId,selectedDifficulty}=picker.pendingSelection??getSelection();let selected;
    for(const button of choices){const active=button.dataset.songChoice===selectedSongId&&button.dataset.difficulty===selectedDifficulty;if(button.getAttribute('aria-pressed')!==String(active))button.setAttribute('aria-pressed',String(active));if(active)selected=button;}
    rows.forEach(row=>{const selected=String(row.dataset.songRow===selectedSongId);if(row.dataset.selected!==selected)row.dataset.selected=selected;});
    q('[data-song-selection]').textContent=selected?`已选：${selected.dataset.songTitle} · ${selectedDifficulty.toUpperCase()} · Lv.${selected.dataset.level}`:'还没选歌。点击一个难度开始。';
    q('[data-song-locate]').disabled=!selected;
  }
  choices.forEach(button=>button.addEventListener('click',()=>{const selection={selectedSongId:button.dataset.songChoice,selectedDifficulty:button.dataset.difficulty};if(picker.stageSelection)picker.stageSelection(selection);else onSelect(selection);sync();}));
  for(const key of fields)q(`[data-song-${key}]`).addEventListener(['query','min','max'].includes(key)?'input':'change',()=>{page=0;filter();});
  q('[data-song-reset]').addEventListener('click',reset);
  q('[data-song-prev]').addEventListener('click',()=>{page--;filter();q('[data-song-list]').scrollTop=0;});q('[data-song-next]').addEventListener('click',()=>{page++;filter();q('[data-song-list]').scrollTop=0;});
  q('[data-song-locate]').addEventListener('click',()=>{reset();page=Math.max(0,Math.floor(visible.findIndex(r=>r.dataset.songRow===getSelection().selectedSongId)/pageSize));filter();rows.find(r=>r.dataset.songRow===getSelection().selectedSongId)?.scrollIntoView({block:'nearest'});});
  filter();sync();return {sync,refresh:filter,reset,applySelection(selection){onSelect(selection);sync();}};
}
