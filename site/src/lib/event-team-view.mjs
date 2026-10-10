import {createWorkbenchTeamView} from './workbench-team-view.mjs';
import {requestTeamSave} from './shared-team-context.mjs';
import {skillActivation} from './skill-activation-view.mjs';
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
 const section=eventElement('section',null,'task-event-result-team');section.append(createWorkbenchTeamView(tool,row.draft),skillActivation(tool,row.draft,{mode:row.reward.mode,eventId:Number(tool.q('event').value)}));return section;
}

export function eventTeamSaveButton(draft, name) {
 const button=eventElement('button',document.documentElement.lang==='en'?'Save team':'存为队伍');button.type='button';
 button.addEventListener('click',()=>requestTeamSave(draft,name));return button;
}
