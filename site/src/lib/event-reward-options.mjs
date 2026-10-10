const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export function eventRewardGrowthNote(growth,override=false){
 const preset=growth==='maximum'?'全满养成假设':'满等级、初始觉醒 / 突破、技能 1';
 return override?`本期奖励卡统一按${preset}计算，包含已持有卡；仅用于本次计算，不修改卡库实际养成。`:`新增卡按${preset}计算；已持有卡仍按卡库中的实际养成计算，不会自动升满。`;
}
export function eventRewardOptions(tool,prefix){
 const root=el('section',null,'task-event-reward-options'),label=el('label'),enabled=el('input');enabled.type='checkbox';enabled.dataset[`${prefix}Rewards`]='';label.append(enabled,el('span','临时纳入本期奖励卡'));root.append(label);
 const settings=el('div'),growthLabel=el('label'),growthTitle=el('span','新增卡养成'),growth=el('select');growth.dataset[`${prefix}RewardGrowth`]='';
 for(const [value,text] of [['level','满等级 · 初始觉醒 / 突破 · 技能 1'],['maximum','全满养成 · 假设']]){const option=el('option',text);option.value=value;growth.append(option);}growthLabel.append(growthTitle,growth);
 const overrideLabel=el('label'),override=el('input');override.type='checkbox';override.dataset[`${prefix}RewardOverride`]='';overrideLabel.append(override,el('span','已持有奖励卡也使用所选养成'));
 const note=el('p',null,'task-input-note');settings.append(growthLabel,overrideLabel,note);
 const list=el('ul',null,'task-event-reward-card-list'),hint=el('p',null,'task-input-note');settings.append(list);root.append(settings,hint);let key='';
 function refresh(){
  const cards=tool.data.eventRewardCards?.[Number(tool.q('event').value)]??[],reference=prefix==='challengeOpt'&&tool.querySelector('[data-challenge-opt-scope]').value==='reference';
  growthTitle.textContent=override.checked?'奖励卡养成（本次计算）':'新增卡养成';
  note.textContent=eventRewardGrowthNote(growth.value,override.checked)+'奖励获取成本不从收益中扣除。';
  enabled.disabled=!cards.length||reference;settings.hidden=!enabled.checked||enabled.disabled;
  hint.textContent=reference?'全卡库参考已包含本期奖励卡。':!cards.length?'当前活动没有可读取的兑换 / pt 奖励卡。':enabled.checked?'按已获取奖励卡后的队伍比较，不模拟刷取途中逐张获得。':`可纳入 ${cards.length} 张商店兑换 / pt 奖励卡`;
  const next=JSON.stringify(cards);if(next===key)return;key=next;list.replaceChildren();
  for(const reward of cards){const kind=reward.resourceType===2?'member':'support',id=`${kind}-card-${reward.resourceId}`,card=tool.data[`${kind}Cards`].find(c=>c.id===id),row=el('li'),copy=el('div');if(card?.imageUrl){const img=el('img');img.src=card.imageUrl;img.alt='';row.append(img);}copy.append(el('strong',card?.displayName??reward.name));
   const sources=reward.sources.map(source=>source.kind==='points'?`${Number(source.points).toLocaleString('zh-CN')} pt`:`商店 · ${Number(source.cost).toLocaleString('zh-CN')} 道具`);copy.append(el('small',sources.join(' / ')));row.append(copy);list.append(row);
  }
 }
 refresh();return {root,refresh};
}
