import {planningUiText} from './team-planning-translations.mjs';
import {planningKindScope,planningObjectiveForGoal,legacyPlanningScope,defaultPlanningKind,createPlanningSettings,planningSettingsValues,planningSummary,updatePlanningCardPreference} from './calculation/planning-settings.ts';
export {planningKindScope,planningObjectiveForGoal,legacyPlanningScope,defaultPlanningKind,createPlanningSettings,planningSettingsValues,planningSummary,updatePlanningCardPreference};
export function setupTeamPlanningScenarios(workbench,{getInventory,onChange}) {
  const q=s=>workbench.querySelector(s);if(!q('[data-planning-kind]'))return null;
  const ui=text=>planningUiText(text,workbench.data.locale),setText=(selector,text)=>{q(selector).textContent=ui(text);};
  const cards=[...workbench.data.memberCards,...workbench.data.supportCards];
  let targets={},allowed=new Set(),trial={memberCardIds:[],supportCardIds:[]},savedFingerprint='',restoring=false,restoredPerformance=null,restoredPerformanceValues='',versionError='',lockFingerprint='',trainingPoolFingerprint='';
  const controls={kind:'planning-kind',trainingScope:'planning-training-scope',unknownGrowth:'planning-unknown',growthMode:'planning-growth',maxTrainedCards:'planning-count',skillLevel:'planning-skill',gekisouSkillLevel:'planning-gekisou-skill',profile:'performance-profile',goal:'recommendation-goal',timingBiasMs:'performance-bias',timingSpreadMs:'performance-spread',missPercent:'performance-miss',startSeconds:'performance-start',endSeconds:'performance-end',explicit:'performance-explicit'};
  const values=()=>({...Object.fromEntries(Object.entries(controls).map(([k,s])=>[k,q(`[data-${s}]`).value])),allowedCardIds:[...allowed],targets,trialCardIds:trial});
  const performanceValues=v=>JSON.stringify(Object.fromEntries(Object.entries(v).filter(([key])=>['profile','timingBiasMs','timingSpreadMs','missPercent','startSeconds','endSeconds','explicit'].includes(key))));
  function read(){
    if(versionError)throw new Error(versionError);
    for(const input of workbench.querySelectorAll('[data-planning-panel] input[type=number],[data-performance-panel] input[type=number]'))if(!input.checkValidity())throw new Error('有一项数值超出范围，请检查培养目标或发挥设置。');
    const v=values(),settings=createPlanningSettings(v,{sourceReleaseId:workbench.data.sourceReleaseId,draft:workbench.draft});
    // A saved research input can contain more ranges and sample options than the short form.
    if(restoredPerformance&&performanceValues(v)===restoredPerformanceValues)settings.performanceScenario=structuredClone(restoredPerformance);
    return settings;
  }
  function fingerprint(){return JSON.stringify([workbench.draft.modifiers.planningScenario,workbench.draft.modifiers.performanceScenario,workbench.draft.modifiers.recommendationGoal]);}
  function persist(){const settings=read();Object.assign(workbench.draft.modifiers,settings);savedFingerprint=fingerprint();return settings;}
  function notify(){if(restoring)return;try{persist();setText('[data-planning-summary]',planningSummary(values()));}catch(error){setText('[data-planning-summary]',error.message);}onChange?.();}
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=ui(text);return n;};
  const cardName=card=>`${workbench.data.locale==='en'?(card.kind==='member'?'Member':'Memory'):(card.kind==='member'?'成员':'留影')} · ${card.shortLabel} ${card.relationLabel??''}`;
  function renderTraining(){
    trainingPoolFingerprint=JSON.stringify([workbench.draft.slots,q('[data-planning-training-scope]').value]);
    const inventory=getInventory(),source=q('[data-planning-training-scope]').value;
    const owned=new Set(source==='selected'?workbench.draft.slots.flatMap(slot=>[slot.memberCardId,slot.supportCardId]).filter(Boolean):[...inventory.memberCardIds,...inventory.supportCardIds]);
    const query=q('[data-planning-training-query]').value.toLocaleLowerCase();
    const filtered=cards.filter(card=>owned.has(card.id)&&(!query||cardName(card).toLocaleLowerCase().includes(query)));
    const root=q('[data-planning-training-cards]');root.replaceChildren();
    setText('[data-planning-training-count]',allowed.size?`允许培养 ${allowed.size} 张卡；最多实际提升 ${q('[data-planning-count]').value} 张。`:'未限定卡片；允许比较当前范围内全部卡的培养方案。');
    for(const card of filtered.slice(0,40)){
      const row=node('div');row.className='planning-card-option';const label=node('label'),check=node('input');check.type='checkbox';check.checked=allowed.has(card.id);
      label.append(check,node('span',cardName(card)));row.append(label);
      check.addEventListener('change',()=>{if(check.checked)allowed.add(card.id);else{allowed.delete(card.id);delete targets[card.id];}renderTraining();notify();});
      if(check.checked){
        const details=node('details'),summary=node('summary','单独设置这张卡的目标');details.append(summary);
        const fields=node('div');fields.className='planning-fields';
        for(const [field,title,max] of [['level','等级',200],['rank',card.kind==='member'?'觉醒阶数':'突破阶数',5],...(card.kind==='member'?[['awake','突破（特训）阶数',5],['skillLevel','演出技能',5],['gekisouSkillLevel','激奏技能',5]]:[])]) {
          const l=node('label');l.className='planning-field';const input=node('input');input.type='number';input.min='1';input.max=String(max);input.step='1';input.placeholder=ui('沿用上方目标');input.value=targets[card.id]?.[field]??'';
          input.addEventListener('change',()=>{if(!input.checkValidity()){input.reportValidity();notify();return;}targets[card.id]??={};if(input.value==='')delete targets[card.id][field];else targets[card.id][field]=Number(input.value);notify();});
          l.append(node('span',title),input);fields.append(l);
        }
        details.append(fields,node('p','觉醒与突破（特训）使用游戏记录的阶数；具体上限会在计算时核对。'));row.append(details);
      }
      root.append(row);
    }
    if(!filtered.length)root.append(node('p','没有符合条件的卡。可以在下方手选队伍，或改选已录入的卡库。'));
    if(filtered.length>40)root.append(node('p',`当前显示前 40 张，共 ${filtered.length} 张。输入卡名可缩小范围。`));
  }
  function renderTrial(){
    const select=q('[data-planning-trial-card]'),query=q('[data-planning-trial-query]').value.toLocaleLowerCase();select.replaceChildren();
    const empty=node('option','选择成员或留影');empty.value='';select.append(empty);
    for(const card of cards.filter(c=>!query||cardName(c).toLocaleLowerCase().includes(query)).slice(0,100)){const option=node('option',cardName(card));option.value=card.id;select.append(option);}
    const root=q('[data-planning-trial-selected]');root.replaceChildren();
    for(const kind of ['member','support'])for(const id of trial[`${kind}CardIds`]){
      const card=cards.find(c=>c.id===id),li=node('li',card?cardName(card):id),remove=node('button','移除');remove.type='button';remove.setAttribute('aria-label',`移除试用卡 ${card?.shortLabel??id}`);
      remove.addEventListener('click',()=>{trial[`${kind}CardIds`]=trial[`${kind}CardIds`].filter(v=>v!==id);renderTrial();notify();});li.append(remove);root.append(li);
    }
  }
  function renderLocks(){
    const root=q('[data-planning-card-locks]');if(!root)return;
    const input=q('[data-search-constraints]'),signature=JSON.stringify([workbench.draft.slots,input.value]);
    if(signature===lockFingerprint)return;lockFingerprint=signature;root.replaceChildren();
    let constraints;try{constraints=JSON.parse(input.value);if(!constraints||typeof constraints!=='object'||Array.isArray(constraints))throw new Error('invalid');}catch{root.append(node('p','更多卡片约束的 JSON 有误，请先修正。'));return;}
    const commit=next=>{input.value=JSON.stringify(next,null,2);input.dispatchEvent(new Event('change',{bubbles:true}));renderLocks();};
    for(const [index,slot] of workbench.draft.slots.entries()){
      const row=node('div');row.className='planning-card-option';let populated=false;
      for(const kind of ['member','support']) {
        const id=slot[`${kind}CardId`];if(!id)continue;populated=true;
        const card=cards.find(c=>c.id===id),label=node('label'),select=node('select'),suffix=kind==='member'?'MemberIds':'SupportIds';
        for(const [value,text] of [['','不限'],['keep','一定要带'],['exclude','不参加推荐']]){const option=node('option',text);option.value=value;select.append(option);}
        select.value=(constraints[`required${suffix}`]??[]).includes(id)?'keep':(constraints[`excluded${suffix}`]??[]).includes(id)?'exclude':'';
        select.addEventListener('change',()=>commit(updatePlanningCardPreference(JSON.parse(input.value),{kind,id,preference:select.value})));
        label.append(node('span',card?cardName(card):id),select);row.append(label);
      }
      if(slot.memberCardId&&slot.supportCardId){
        const label=node('label'),check=node('input');check.type='checkbox';const same=pair=>pair.memberCardId===slot.memberCardId&&pair.supportCardId===slot.supportCardId;
        check.checked=(constraints.lockedPairs??[]).some(same);check.addEventListener('change',()=>{const next=JSON.parse(input.value);next.lockedPairs=(next.lockedPairs??[]).filter(pair=>!same(pair));if(check.checked)next.lockedPairs.push({memberCardId:slot.memberCardId,supportCardId:slot.supportCardId});commit(next);});
        label.append(check,node('span',`保留位置 ${index+1} 的成员与留影配对`));row.append(label);
      }
      if(populated)root.append(row);
    }
    if(!root.children.length)root.append(node('p','还没有手选队伍。可先生成方案并应用，再保留喜欢的卡继续比较。'));
  }
  function refresh(){
    const v=values();q('[data-planning-training]').hidden=v.kind!=='training';q('[data-planning-trial]').hidden=v.kind!=='trial';q('[data-planning-missing]').hidden=v.kind==='reference';
    setText('[data-planning-note]',{reference:'不用导入卡库。先看搭配思路；结果可能包含你还没有的卡。',selected:'只比较下方选中的成员与留影。没有填写养成时，可展开下面的选项按参考值计算。',current:'使用已导入或手动填写的养成。缺少资料的卡默认不参加推荐。',training:'按所选范围比较培养后的搭配。手选卡需要填写实际养成，计划不会修改卡库。',trial:'选择想试的卡，再和已录入或手选的卡一起配队。'}[v.kind]);
    let performanceNote=v.explicit.trim()?'按填写的演出记录比较。':v.profile==='ideal'?'理想发挥：无时机偏差、无漏按，用于查看顺利发挥时的方案。':v.profile==='practice'?'参考条件：时机波动 ±110 毫秒，另有 2% 漏按；不是对你个人水平的判断。':'参考条件：时机波动 ±65 毫秒，不额外加入漏按；FC 不代表全 JUST。';
    if(v.timingSpreadMs!==''||v.missPercent!==''||Number(v.timingBiasMs)!==0||v.startSeconds!=='')performanceNote+=' 已调整发挥条件，请展开上方设置查看。';
    setText('[data-performance-note]',performanceNote);
    setText('[data-planning-summary]',planningSummary(v));
    q('[data-recommendation-goal]').querySelector('[value="missions"]').disabled=q('[data-pairing-mode]').value!=='gekisou';
    if(v.goal==='missions'&&q('[data-pairing-mode]').value!=='gekisou')q('[data-recommendation-goal]').value='score';
  }
  function restore(modifiers=workbench.draft.modifiers){
    restoring=true;const v=planningSettingsValues(modifiers,defaultPlanningKind(getInventory(),workbench.draft));
    if(!modifiers.planningScenario)v.trainingScope=(getInventory().memberCardIds.length||getInventory().supportCardIds.length)?'owned':'selected';
    versionError=modifiers.planningScenario?.sourceReleaseId&&modifiers.planningScenario.sourceReleaseId!==workbench.data.sourceReleaseId?'这份情景来自其他资料版本，请恢复参考设置后重新选择。':'';
    for(const [key,selector] of Object.entries(controls))q(`[data-${selector}]`).value=v[key];
    q('[data-pairing-objective]').value=planningObjectiveForGoal(v.goal);
    restoredPerformance=modifiers.performanceScenario?structuredClone(modifiers.performanceScenario):null;restoredPerformanceValues=performanceValues(values());
    targets=structuredClone(v.targets);allowed=new Set(v.allowedCardIds);trial=structuredClone(v.trialCardIds);q('[data-search-scope]').value=legacyPlanningScope(v.kind,v.trainingScope);
    renderTraining();renderTrial();renderLocks();refresh();savedFingerprint=fingerprint();restoring=false;
  }
  function sync(){if(fingerprint()!==savedFingerprint)restore();refresh();renderLocks();if(trainingPoolFingerprint!==JSON.stringify([workbench.draft.slots,q('[data-planning-training-scope]').value]))renderTraining();}
  for(const [key,selector] of Object.entries(controls))q(`[data-${selector}]`).addEventListener('change',()=>{
    if(key==='trainingScope'){allowed.clear();targets={};}
    if(key==='kind'||key==='trainingScope')q('[data-search-scope]').value=legacyPlanningScope(q('[data-planning-kind]').value,q('[data-planning-training-scope]').value);
    if(key==='goal')q('[data-pairing-objective]').value=planningObjectiveForGoal(q('[data-recommendation-goal]').value);
    if(key==='kind'||key==='maxTrainedCards'||key==='trainingScope')renderTraining();refresh();notify();
  });
  q('[data-planning-training-query]').addEventListener('input',renderTraining);
  q('[data-planning-training-clear]').addEventListener('click',()=>{allowed.clear();targets={};renderTraining();notify();});
  q('[data-planning-trial-query]').addEventListener('input',renderTrial);
  q('[data-planning-trial-add]').addEventListener('click',()=>{const card=cards.find(c=>c.id===q('[data-planning-trial-card]').value);if(!card){setText('[data-planning-summary]','先在列表中选择一张试用卡。');return;}const list=trial[`${card.kind}CardIds`];if(!list.includes(card.id))list.push(card.id);renderTrial();notify();});
  q('[data-planning-reset]').addEventListener('click',()=>{restore({});notify();});
  q('[data-search-scope]').addEventListener('change',()=>{const value=q('[data-search-scope]').value,current=q('[data-planning-kind]').value;if(value!==legacyPlanningScope(current,q('[data-planning-training-scope]').value)){q('[data-planning-kind]').value=value==='theoretical'?'reference':value==='selected'?'selected':'current';refresh();notify();}});
  q('[data-pairing-mode]').addEventListener('change',()=>{refresh();notify();});
  restore();return {read,restore,sync,persist,refreshInventory:renderTraining,get kind(){return q('[data-planning-kind]').value;}};
}
