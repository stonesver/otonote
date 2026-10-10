const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export function eventRewardOptions(tool,prefix){
 const root=el('section',null,'task-event-reward-options'),label=el('label'),enabled=el('input');enabled.type='checkbox';enabled.dataset[`${prefix}Rewards`]='';label.append(enabled,el('span','临时纳入本期奖励卡'));root.append(label);
 const settings=el('div'),growthLabel=el('label','新增卡养成'),growth=el('select');growth.dataset[`${prefix}RewardGrowth`]='';
 for(const [value,text] of [['level','满等级 · 初始突破 / 觉醒 · 技能 1'],['maximum','全满养成 · 假设']]){const option=el('option',text);option.value=value;growth.append(option);}growthLabel.append(growth);settings.append(growthLabel,el('p','仅加入本次候选；已持有卡保留实际养成。奖励获取成本不从收益中扣除。','task-input-note'));
 const list=el('ul',null,'task-event-reward-card-list'),hint=el('p',null,'task-input-note');settings.append(list);root.append(settings,hint);let key='';
 function refresh(){
  const cards=tool.data.eventRewardCards?.[Number(tool.q('event').value)]??[],reference=prefix==='challengeOpt'&&tool.querySelector('[data-challenge-opt-scope]').value==='reference';
  enabled.disabled=!cards.length||reference;settings.hidden=!enabled.checked||enabled.disabled;
  hint.textContent=reference?'全卡库参考已包含本期奖励卡。':!cards.length?'当前活动没有可读取的兑换 / pt 奖励卡。':enabled.checked?'按已获取奖励卡后的队伍比较，不模拟刷取途中逐张获得。':`可纳入 ${cards.length} 张商店兑换 / pt 奖励卡`;
  const next=JSON.stringify(cards);if(next===key)return;key=next;list.replaceChildren();
  for(const reward of cards){const kind=reward.resourceType===2?'member':'support',id=`${kind}-card-${reward.resourceId}`,card=tool.data[`${kind}Cards`].find(c=>c.id===id),row=el('li'),copy=el('div');if(card?.imageUrl){const img=el('img');img.src=card.imageUrl;img.alt='';row.append(img);}copy.append(el('strong',card?.displayName??reward.name));
   const sources=reward.sources.map(source=>source.kind==='points'?`${Number(source.points).toLocaleString('zh-CN')} pt`:`商店 · ${Number(source.cost).toLocaleString('zh-CN')} 道具`);copy.append(el('small',sources.join(' / ')));row.append(copy);list.append(row);
  }
 }
 refresh();return {root,refresh};
}
