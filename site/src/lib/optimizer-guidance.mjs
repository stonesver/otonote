import {planningUiText} from './team-planning-translations.mjs';
export function optimizerReadiness({draft,scope='selected',inventory,objective='expected_song_score',locale='zh-CN',characterFor}) {
  const songReady=objective==='formation_power'||Boolean(draft.selectedSongId&&draft.selectedDifficulty);
  const members=scope==='selected'?draft.slots.filter(s=>s.memberCardId).length:scope==='theoretical'?5:inventory?.memberCardIds?.length??0;
  const supports=scope==='selected'?draft.slots.filter(s=>s.supportCardId).length:scope==='theoretical'?5:inventory?.supportCardIds?.length??0;
  const memberIds=scope==='selected'?draft.slots.map(s=>s.memberCardId).filter(Boolean):inventory?.memberCardIds??[];
  const characters=scope==='theoretical'?5:characterFor?new Set(memberIds.map(characterFor)).size:members;
  const supportIds=scope==='selected'?draft.slots.map(s=>s.supportCardId).filter(Boolean):inventory?.supportCardIds??[];
  const cardsReady=characters>=5&&(scope==='theoretical'||new Set(supportIds).size>=5);
  return {songReady,cardsReady,ready:songReady&&cardsReady,members,supports,
    message:planningUiText(!songReady?'先选择歌曲和难度，再比较这首歌的出分。':!cardsReady&&members>=5&&supports>=5?'成员需要覆盖至少 5 个不同角色，留影也不能重复。':!cardsReady?
      scope==='owned'?`当前范围还需要至少 5 张不同角色的成员卡和 5 张留影，目前 ${members}＋${supports} 张。可以手动录入，或先看参考队伍。`:
        `请在下方选满 5 张成员和 5 张留影，目前 ${members}＋${supports} 张；也可以先看参考队伍。`:
      scope==='theoretical'?'准备好了。将使用满养成卡片；账号、TGW 与乐器仍按你的设置。':'准备好了。按所选发挥与养成条件比较搭配。',locale)};
}
export function recommendedWorkerCount(cores) {return Math.max(1,Math.min(4,Math.floor((Number(cores)||2)/2)));}

export function searchEvaluationBudget(effort, value) {
  if(effort==='complete'||effort==='practical')return 0;
  const budget=Number(effort==='custom'?value:effort);
  if(!Number.isInteger(budget)||budget<1||budget>100000)throw new Error('计算上限应为 1–100000');
  return budget;
}
