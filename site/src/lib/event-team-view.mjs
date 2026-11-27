import {createWorkbenchTeamView} from './workbench-team-view.mjs';
import {skillActivation} from './skill-activation-view.mjs';
import {requestTeamSave} from './shared-team-context.mjs';
import {eventTeamStats} from './event-result-presentation.mjs';
export const eventElement=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
export function currentEventDraft(tool){
 return structuredClone(tool.draft);
}
export function applyEventPlan(tool,row,mode){
 tool.draft=structuredClone(row.draft);delete tool.draft.modifiers.event;
 tool.q('mode').value=mode;tool.q('song').value=row.song.trackId;tool.q('rank').value=String(row.reward.scoreRank);
 tool.q('bonus-source').value='team';tool.q('song-disclosure').open=false;tool.songPicker?.reset();tool.songPicker?.sync();tool.render();
 tool.q('team-status').textContent='已应用收益方案的队伍、歌曲与当前条件下的估计档位；可按实打情况调整档位。';
}
export function eventTeamDetails(tool,row){
 return createEventTeamView(tool,row.draft,{mode:row.reward.mode,eventId:Number(tool.q('event').value),summary:row});
}

/** One complete roster at every width; no second roster inside replay details. */
export function createEventTeamView(tool,draft,options={}) {
 const section=eventElement('section',null,'task-event-result-team event-full-team');
 const stats=eventTeamStats(options.summary);
 const headerBar=eventElement('div',null,'event-team-header');
 if(stats)headerBar.append(stats);
 const toggle=eventElement('button',null,'event-team-layout-toggle');
 toggle.type='button';toggle.setAttribute('aria-pressed','false');
 toggle.setAttribute('aria-label','切换列表详情');toggle.title='切换列表详情';
 const icon=(paths)=>{
  if(typeof document.createElementNS!=='function')return null;
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('width','14');svg.setAttribute('height','14');
  svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.8');
  svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
  for(const d of paths){const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);svg.append(p);}
  return svg;
 };
 const setToggleIcon=(list)=>{
  const svg=icon(list?['M3 4h5v5H3z','M12 4h5v5h-5z','M3 11h5v5H3z','M12 11h5v5h-5z']:['M7 5h10','M7 10h10','M7 15h10','M3 5h.01','M3 10h.01','M3 15h.01']);
  if(svg)toggle.replaceChildren(svg);else toggle.textContent=list?'5列':'列表';
  toggle.setAttribute('aria-label',list?'切回 5 列编队':'切换列表详情');
  toggle.title=list?'切回 5 列编队':'切换列表详情';
 };
 setToggleIcon(false);
 toggle.addEventListener('click',()=>{
  const list=section.dataset.mobileLayout!=='list';
  section.dataset.mobileLayout=list?'list':'grid';
  toggle.setAttribute('aria-pressed',String(list));
  setToggleIcon(list);
 });
 headerBar.append(toggle);
 section.append(headerBar);
 const roster=createWorkbenchTeamView(tool,draft);
 for(const relation of roster.querySelectorAll('.tw-card-relation'))relation.title=relation.textContent;
 section.append(roster);
 section.append(skillActivation(tool,draft,options));
 return section;
}

export function eventTeamSaveButton(draft, name) {
 const button=eventElement('button',document.documentElement.lang==='en'?'Save team':'保存队伍','ui-btn-outline');button.type='button';
 button.addEventListener('click',()=>requestTeamSave(draft,name));return button;
}
