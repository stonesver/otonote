const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export function eventRewardGrowthNote(growth,override=false){
 const customMatch=typeof growth==='string'?/^custom:r([1-5]):a([1-5]):s([1-5])$/.exec(growth):null;
 const preset=growth==='maximum'?'全满养成假设':customMatch?`自定义（${customMatch[1]}破 · ${customMatch[2]}觉 · 技能${customMatch[3]}）`:'满等级、初始觉醒 / 突破、技能 1';
 return override?`本期奖励卡统一按${preset}计算，包含已持有卡；仅用于本次计算，不修改卡库实际养成。`:`新增卡按${preset}计算；已持有卡仍按卡库中的实际养成计算，不会自动升满。`;
}
export function eventRewardOptions(tool,prefix){
 const root=el('section',null,'task-event-reward-options'),label=el('label',null,'task-reward-toggle'),enabled=el('input'),count=el('span',null,'task-reward-count ui-tag');enabled.type='checkbox';enabled.setAttribute('role','switch');enabled.className='ui-switch';enabled.dataset[`${prefix}Rewards`]='';label.append(enabled,el('span','临时纳入本期奖励卡'),count);root.append(label);
 const settings=el('div',null,'task-reward-settings');

 // Hidden canonical select synced with free-tuning controls for backward compatibility
 const growth=el('select',null,'ui-select');growth.hidden=true;growth.dataset[`${prefix}RewardGrowth`]='';
 const ensureOption=(value,text)=>{
  if(![...growth.options].some(o=>o.value===value)){const opt=el('option',text);opt.value=value;growth.append(opt);}
 };
 ensureOption('level','基础满级');
 ensureOption('maximum','全满养成');

 // Quick presets + 3 free sliders (突破 / 觉醒 / 技能)
 const sliderBox=el('div',null,'task-reward-slider-box');
 const sliderHead=el('div',null,'task-reward-slider-head'),sliderLabel=el('span','临时奖励卡养成'),sliderValue=el('strong','基础满级');
 sliderHead.append(sliderLabel,sliderValue);

 const stops=el('div',null,'task-reward-stops');
 const stopLow=el('button','基础满级','task-reward-stop'),stopMid=el('button','半养 3/3/3','task-reward-stop'),stopHigh=el('button','全满养成','task-reward-stop');
 stopLow.type='button';stopMid.type='button';stopHigh.type='button';
 stops.append(stopLow,stopMid,stopHigh);

 const customGrid=el('div',null,'task-reward-custom-sliders');
 const makeSlider=(name,aria)=>{
  const row=el('label',null,'task-reward-mini-slider');
  const title=el('span',name),val=el('b','1');
  const input=el('input',null,'task-reward-range');
  input.type='range';input.min='1';input.max='5';input.step='1';input.value='1';input.setAttribute('aria-label',aria);
  row.append(title,input,val);
  customGrid.append(row);
  return {input,val};
 };
 const sRank=makeSlider('突破','奖励卡突破等级');
 const sAwake=makeSlider('觉醒','奖励卡觉醒等级');
 const sSkill=makeSlider('技能','奖励卡技能等级');

 sliderBox.append(sliderHead,stops,customGrid,growth);

 const syncUI=()=>{
  const v=growth.value;
  const cm=/^custom:r([1-5]):a([1-5]):s([1-5])$/.exec(v);
  let r=1,a=1,s=1;
  if(v==='maximum'){r=5;a=5;s=5;}
  else if(cm){r=Number(cm[1]);a=Number(cm[2]);s=Number(cm[3]);}
  sRank.input.value=String(r);sRank.val.textContent=String(r);
  sAwake.input.value=String(a);sAwake.val.textContent=String(a);
  sSkill.input.value=String(s);sSkill.val.textContent=String(s);
  sliderValue.textContent=v==='maximum'?'全满（5破 · 5觉 · 技能5）':v==='level'?'基础（1破 · 1觉 · 技能1）':`自由（${r}破 · ${a}觉 · 技能${s}）`;
  stopLow.setAttribute('aria-pressed',String(v==='level'));
  stopMid.setAttribute('aria-pressed',String(v==='custom:r3:a3:s3'));
  stopHigh.setAttribute('aria-pressed',String(v==='maximum'));
 };
 const setVal=(val)=>{
  ensureOption(val,val);
  if(growth.value===val)return;
  growth.value=val;
  syncUI();
  growth.dispatchEvent(new Event('change',{bubbles:true}));
 };
 const onCustomChange=()=>{
  const r=Number(sRank.input.value),a=Number(sAwake.input.value),s=Number(sSkill.input.value);
  if(r===1&&a===1&&s===1)setVal('level');
  else if(r===5&&a===5&&s===5)setVal('maximum');
  else setVal(`custom:r${r}:a${a}:s${s}`);
 };
 sRank.input.addEventListener('input',onCustomChange);
 sAwake.input.addEventListener('input',onCustomChange);
 sSkill.input.addEventListener('input',onCustomChange);
 stopLow.addEventListener('click',()=>setVal('level'));
 stopMid.addEventListener('click',()=>setVal('custom:r3:a3:s3'));
 stopHigh.addEventListener('click',()=>setVal('maximum'));

 const note=el('p',null,'task-input-note task-event-reward-growth-note');
 const list=el('ul',null,'task-event-reward-card-list'),hint=el('p',null,'task-input-note task-reward-disabled-note');
 settings.append(sliderBox,list,note);root.append(settings,hint);let key='';
 function refresh(){
  const cards=tool.data.eventRewardCards?.[Number(tool.q('event').value)]??[],reference=tool.querySelector(prefix==='challengeOpt'?'[data-challenge-opt-scope]':'[data-pool]').value==='reference';
  syncUI();
  note.textContent=eventRewardGrowthNote(growth.value);
  enabled.disabled=!cards.length||reference;settings.hidden=!enabled.checked||enabled.disabled;
  root.dataset.expanded=String(!settings.hidden);
  count.textContent=cards.length?`${cards.length} 张`:'无';count.hidden=reference||!cards.length;
  hint.hidden=!reference&&cards.length>0;
  hint.textContent=reference?'全卡库参考已包含本期奖励卡。':!cards.length?'当前活动没有可读取的奖励卡。':'';
  const next=JSON.stringify(cards);if(next===key)return;key=next;list.replaceChildren();
  for(const reward of cards){
   const kind=reward.resourceType===2?'member':'support',id=`${kind}-card-${reward.resourceId}`,card=tool.data[`${kind}Cards`].find(c=>c.id===id),row=el('li');
   if(card?.imageUrl){const img=el('img');img.src=card.imageUrl;img.alt='';row.append(img);}
   row.append(el('strong',card?.displayName??reward.name));
   list.append(row);
  }
 }
 refresh();return {root,refresh};
}
