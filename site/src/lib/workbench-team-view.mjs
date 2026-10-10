import {createTeamCardView,resolveTeamCardGrowth} from './team-card-view.mjs';
import {teamCardFacets,teamCardFilterOptions} from './team-card-filters.mjs';
import {attachCardSkillHover} from './calculator-card-ui.mjs';
import {cardSkillRows} from './calculator-card-model.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export function pairingRelations(member,support) {
  if(!member||!support)return [];
  const a=teamCardFacets(member),b=teamCardFacets(support),out=[];
  if(a.attribute.some(v=>b.attribute.includes(v)))out.push({kind:'attribute',label:'同属性',description:'成员与留影属性一致；实际加成按技能、道具与配对规则计算。'});
  if(a.band.some(v=>b.band.includes(v)))out.push({kind:'band',label:'同乐队',description:'成员与留影属于同一乐队；实际加成以计算明细为准。'});
  return out;
}
export function createWorkbenchTeamView(tool,draft) {
  const data=tool.data??tool,rules=data.formalRules??data.rules,root=el('div',null,'score-lineup task-pairing');root.setAttribute('aria-label','五组成员与留影');
  const cards=(kind,id)=>data[`${kind}Cards`]?.find(c=>c.id===id);
  const music=rules?.tables.LiveMusic.find(m=>`music-${m._id}`===draft.selectedSongId),missions=[music?._gekisouMission1,music?._gekisouMission2,music?._gekisouMission3];
  const mode=tool.querySelector?.('[data-pairing-mode], [data-scoring-mode]')?.value;
  for(const [index,slot] of draft.slots.entries()) {
    const pair=el('article',null,'score-pair');pair.dataset.leader=String(index===2);pair.append(el('small',index===2?'队长':String(index+1).padStart(2,'0'),'score-position'));
    const member=cards('member',slot.memberCardId),support=cards('support',slot.supportCardId);
    for(const [kind,card] of [['member',member],['support',support]]) {
      const face=el('div',null,`score-face score-face--${kind}`);
      if(card){const state=resolveTeamCardGrowth({card,draft,rules,inventory:tool.inventory??tool.teamWorkspaceContext?.inventory});const view=createTeamCardView(card,{...state,kind,locale:data.locale,data});face.append(view);if(rules)attachCardSkillHover(tool,card,view.querySelector('.tw-card-art'),{growth:state.growth,leader:index===2});}
      else {const choose=el('button',kind==='member'?'选择成员':'选择留影','task-empty-card');choose.type='button';choose.dataset.openTeamWorkspace='teams';face.append(choose);}pair.append(face);
      if(kind==='member') {
        const links=el('div',null,'task-pair-links');
        for(const relation of pairingRelations(member,support)){const badge=el('span',relation.label,`task-link--${relation.kind}`);badge.title=relation.description;const options=teamCardFilterOptions([member,support],data),facet=teamCardFacets(member)[relation.kind].find(v=>teamCardFacets(support)[relation.kind].includes(v)),icon=options[relation.kind].find(v=>v.value===facet)?.icon;if(icon){const symbols=el('span',null,'task-link-icons');for(let n=0;n<2;n++){const img=el('img');img.src=icon;img.alt='';symbols.append(img);}badge.prepend(symbols);badge.append(el('b','✓'));}links.append(badge);}
        if(mode==='gekisou'&&card){const types=cardSkillRows(card,rules,draft.modifiers?.growth?.[card.id]).filter(r=>r.kind.startsWith('gekisou')&&missions.includes(r.mission));if(types.length){const badge=el('span','任务适配','task-link--mission');badge.title=types.map(r=>['','COMBO','LUCK','JUST'][r.mission]).join(' / ')+'：与当前歌曲激奏任务类型对应，实际效果见技能说明。';links.append(badge);}}
        pair.append(links);
      }
    }root.append(pair);
  }
  const leader=cards('member',draft.slots[2]?.memberCardId);
  if(leader&&rules){const state=resolveTeamCardGrowth({card:leader,draft,rules,inventory:tool.inventory??tool.teamWorkspaceContext?.inventory});const row=cardSkillRows(leader,rules,state.growth).find(r=>r.kind==='leader');if(row)root.append(el('p',`队长 · ${row.summary}`,'task-leader-skill'));}
  return root;
}
