import {eventYieldGaps} from './event-yield-goals.mjs';
import bandIcons from './arena-band-icons.json' with {type:'json'};

const DIFFICULTY_ORDER=['easy','normal','hard','expert'];
export const emptyEventResultFilters=()=>({difficulties:[],levels:[],bands:[],maxDropProbability:null,highestRewardOnly:false});
export const activeEventResultFilters=filters=>Number(Boolean(filters.difficulties?.length))+Number(Boolean(filters.levels.length))+Number(Boolean(filters.bands.length))
 +Number(filters.maxDropProbability!==null)+Number(filters.highestRewardOnly);

/** Per-play risk: every stage actually used by the plan must meet the limit. */
export function eventPlanDropProbability(row){
 const stages=[row,...(row.continuation?.stages??[]).filter(stage=>stage.plays>0).map(stage=>stage.row)];
 if(stages.some(stage=>!stage.gradeProbabilities?.length))return null;
 return Math.max(...stages.map(stage=>stage.gradeProbabilities.reduce((sum,g)=>sum+(g.rank<stage.reward.scoreRank?g.probability:0),0)));
}

export function eventResultFilterOptions(rows,tracks=[]){
 const byTrack=new Map(tracks.map(track=>[track.id,track])),bands=new Map(),presentDiffs=new Set();
 for(const row of rows){
  if(row.song?.difficulty)presentDiffs.add(row.song.difficulty);
  const track=byTrack.get(row.song.trackId);
  track?.bandIds?.forEach((id,i)=>bands.set(String(id),track.bandLabels?.[i]??String(id)));
 }
 return {difficulties:DIFFICULTY_ORDER.filter(d=>presentDiffs.has(d)),
  levels:[...new Set(rows.map(row=>row.song.level).filter(Number.isFinite))].sort((a,b)=>a-b),
  bands:[...bands].map(([value,label])=>({value,label}))};
}

export function filterEventYieldRows(rows,filters,{tracks=[],goal='badges'}={}){
 const byTrack=new Map(tracks.map(track=>[track.id,track]));
 const reference=filters.highestRewardOnly?eventYieldGaps(rows,goal).reference:null;
 return rows.filter(row=>{
  if(filters.difficulties?.length&&!filters.difficulties.includes(row.song?.difficulty))return false;
  if(filters.levels.length&&!filters.levels.includes(row.song.level))return false;
  if(filters.bands.length&&!byTrack.get(row.song.trackId)?.bandIds?.some(id=>filters.bands.includes(String(id))))return false;
  if(reference&&(row.total.badges!==reference.total.badges||row.total.eventPoints!==reference.total.eventPoints
    ||goal==='grade'&&row.reward.scoreRank!==reference.reward.scoreRank))return false;
  if(filters.maxDropProbability!==null){const risk=eventPlanDropProbability(row);if(risk===null||risk>filters.maxDropProbability)return false;}
  return true;
 });
}

const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
export function eventResultFilterControls({rows,tracks,filters,open,onOpen,onChange}){
 const control=(node,key)=>{node.className='event-result-filter-control';node.dataset.yieldResultFilter=key;return node;};
 const active=activeEventResultFilters(filters),trigger=control(el('button',null),'toggle');trigger.className+=' event-result-filters';trigger.type='button';
 trigger.setAttribute('aria-label','筛选方案');trigger.title='筛选方案';
 if(typeof document.createElementNS==='function'){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','14');svg.setAttribute('height','14');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
  const p=document.createElementNS('http://www.w3.org/2000/svg','polygon');p.setAttribute('points','22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3');svg.append(p);trigger.append(svg);
 }
 trigger.append(el('span','筛选','event-filter-label'));
 if(active)trigger.append(el('b',String(active),'event-filter-count'));
 const panel=el('div',null,'event-result-filter-panel');panel.id='event-yield-result-filters';panel.hidden=!open;
 trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded',String(open));
 trigger.addEventListener('click',()=>{const expanded=panel.hidden;panel.hidden=!expanded;trigger.setAttribute('aria-expanded',String(expanded));onOpen(expanded);});
 const options=eventResultFilterOptions(rows,tracks);
 const checkbox=(label,key,checked,change)=>{
  const item=el('label',null,'event-result-filter-option'),input=control(el('input'),key);input.type='checkbox';input.checked=checked;
  if(checked)input.setAttribute('checked','');
  input.addEventListener('change',event=>{event.stopPropagation();change(input.checked);});item.append(input,el('span',label));return item;
 };
 for(const [key,label,entries] of [
  ['difficulties','歌曲难度',options.difficulties.map(value=>({value,label:value.toUpperCase()}))],
  ['levels','歌曲等级',options.levels.map(value=>({value,label:String(value)}))],
  ['bands','歌曲乐队',options.bands]
 ]){
  const field=el('fieldset'),choices=el('div',null,'event-result-filter-choices');field.dataset.filterGroup=key;field.append(el('legend',label),choices);
  for(const option of entries){
   const item=checkbox(option.label,`${key}-${option.value}`,(filters[key]??[]).includes(option.value),checked=>{
    const current=filters[key]??[];
    onChange({...filters,[key]:checked?[...current,option.value]:current.filter(value=>value!==option.value)});
   });
   if(key==='difficulties')item.dataset.difficulty=option.value;
   if(key==='bands'){
    item.className+=' event-result-band';item.title=option.label;
    item.dataset.bandIcon=option.value;
   }
   choices.append(item);
  }
  if(!entries.length)choices.append(el('small','暂无可筛选资料'));
  panel.append(field);
 }
 const risk=el('fieldset'),choices=el('div',null,'event-result-filter-risk');risk.dataset.filterGroup='risk';risk.append(el('legend','AP 掉档风险'),choices);
 for(const [value,label] of [[null,'不限'],[0,'0%'],[.05,'≤ 5%'],[.1,'≤ 10%'],[.25,'≤ 25%']]){
  const item=el('label',null,'event-result-filter-option'),input=control(el('input'),`risk-${value??'all'}`);input.type='radio';input.name='event-result-drop-risk';input.value=String(value??'all');
  input.checked=filters.maxDropProbability===value;if(input.checked)input.setAttribute('checked','');
  item.title=value===null?'不限 AP 掉档率':`各阶段 AP 掉档率不超过 ${value*100}%`;
  input.addEventListener('change',event=>{event.stopPropagation();onChange({...filters,maxDropProbability:value});});item.append(input,el('span',label));choices.append(item);
 }
 const highest=checkbox('仅最高收益','highest',filters.highestRewardOnly,highestRewardOnly=>onChange({...filters,highestRewardOnly}));
 highest.className+=' event-result-filter-highest';highest.title='与当前收益第一的两项总收益均相同';risk.append(highest);panel.append(risk);
 const footer=el('div',null,'event-result-filter-footer'),clear=control(el('button','清除筛选'),'clear');clear.type='button';clear.disabled=!active;clear.addEventListener('click',()=>onChange(emptyEventResultFilters()));
 const help=el('details',null,'event-result-filter-help');help.append(el('summary','筛选说明'),el('p','按曲目难度/等级/乐队筛选；掉档风险按各阶段 AP 上限计算。'));
 footer.append(help,clear);panel.append(footer);
 return {trigger,panel};
}

// Attach only to the visible, reconciled panel. A calculation owns one image per band.
export function mountEventBandIcons(container,icons){
 for(const item of container.querySelectorAll('.event-result-band')){
  const band=item.dataset.bandIcon;
  let icon=icons.get(band);
  if(!icon){
   icon=el('img');icon.alt='';icon.width=icon.height=28;
   icon.src=`/content/releases/${bandIcons.releaseId}/public/images/filter-bands/${band}.png`;
   icons.set(band,icon);
  }
  if(icon.parentElement!==item)item.append(icon);
 }
}
