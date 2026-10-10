import {growthFields,growthLabels} from './inventory-manager.mjs';
import {closeSkillPopover} from './calculator-card-ui.mjs';

const maximumLabels={level:'当前满级',rank:'满突破',awake:'满突破（特训）',skillLevel:'满演出技能',gekisouSkillLevel:'满激奏技能'};
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};

export function setupInventoryCardEdit(workbench,{manager,getInventory,commit}) {
  const dialog=workbench.querySelector('[data-inventory-edit-dialog]'),q=s=>dialog.querySelector(s);
  const form=q('form'),status=q('[data-inventory-edit-status]'),save=q('[type=submit]'),reset=q('[data-inventory-edit-reset]');
  const controls=Object.fromEntries(growthFields.map(field=>[field,q(`[data-inventory-edit-field="${field}"]`)]));
  let targets=[],batch=false,original=null,initial={},values={},valid=false;
  const fields=()=>targets[0]?.kind==='member'?growthFields:growthFields.slice(0,2);
  const patch=()=>Object.fromEntries(fields().filter(field=>values[field]!==''&&values[field]!==undefined).map(field=>[field,values[field]==='maximum'?'maximum':Number(values[field])]));
  const before=card=>original.growth[card.id]??manager.preset(card.id,card.kind);
  function populateChoices() {
    const changes=patch();delete changes.level;
    const current=targets.map(card=>manager.applyPatch(card.id,card.kind,before(card),changes));
    for(const field of growthFields) {
      const control=controls[field],visible=fields().includes(field);
      q(`[data-inventory-edit-label="${field}"]`).hidden=!visible;control.disabled=!visible;
      if(!visible)continue;
      const options=targets.map((card,i)=>manager.choices(card.id,card.kind,field,current[i]));
      const common=options[0].filter(value=>options.every(choices=>choices.includes(value)));
      control.replaceChildren();
      const add=(value,label)=>{const option=el('option',label);option.value=String(value);control.append(option);};
      if(batch)add('','保持各卡原值');
      const caps=options.map(choices=>Math.max(...choices)),min=Math.min(...caps),max=Math.max(...caps);
      add('maximum',field==='rank'&&targets[0]?.kind==='member'?'满觉醒':maximumLabels[field]);
      for(const value of common)add(value,field==='level'?`Lv.${value}`:String(value));
      const value=String(values[field]??'');
      const invalid=value!==''&&value!=='maximum'&&!common.includes(Number(value));
      if(invalid)add(value,`${value}（超过当前可选范围）`);
      control.value=value;control.setCustomValidity(invalid?`${growthLabels[field]}超过当前上限，请重新选择或使用一键满级。`:'');
      control.setAttribute('aria-invalid',String(invalid));
      q(`[data-inventory-edit-range="${field}"]`).textContent=min===max?`当前上限 ${max}`:`各卡上限 ${min}–${max}；满级选项分别计算`;
    }
  }
  function refresh() {
    valid=false;save.disabled=true;reset.disabled=JSON.stringify(values)===JSON.stringify(initial);
    try {
      populateChoices();
      const invalid=fields().find(field=>!controls[field].validity.valid);
      if(invalid){status.textContent=controls[invalid].validationMessage;return;}
      const next=manager.batch(original,targets.map(card=>card.id),{patch:patch()});
      const changed=targets.filter(card=>JSON.stringify(original.growth[card.id])!==JSON.stringify(next.growth[card.id])).length;
      valid=changed>0&&(!batch||Object.keys(patch()).length>0);save.disabled=!valid;
      status.textContent=valid?`将更新 ${changed} 张卡，点击保存后生效。`:batch?'选择要修改的字段，或使用上方快捷操作。':'当前数值与已保存的养成相同。';
    }catch(error){status.textContent=`暂不能保存：${error.message}。可重新选择等级或使用一键满级。`;}
  }
  for(const field of growthFields)controls[field].addEventListener('change',()=>{values[field]=controls[field].value;refresh();});
  reset.addEventListener('click',()=>{values={...initial};refresh();});
  for(const button of dialog.querySelectorAll('[data-inventory-edit-preset]'))button.addEventListener('click',()=>{
    const mode=button.dataset.inventoryEditPreset;
    const changedFields=mode==='level'?['level']:mode==='skills'?['skillLevel','gekisouSkillLevel']:fields();
    for(const field of changedFields)values[field]='maximum';
    refresh();
  });
  form.addEventListener('submit',event=>{
    event.preventDefault();if(!targets.length||!valid||!form.reportValidity())return;
    try {
      const inventory=getInventory();
      if(targets.some(card=>original[`${card.kind}CardIds`].includes(card.id)&&!inventory[`${card.kind}CardIds`].includes(card.id)))throw new Error('所选卡片已被移出卡库，请关闭后重新选择');
      commit(manager.batch(inventory,targets.map(card=>card.id),{patch:patch()}),batch?`已保存所选 ${targets.length} 张卡的养成，可撤销。`:`已更新「${targets[0].shortLabel}」的养成，可撤销。`);
      const anchor=batch?workbench.querySelector('[data-inventory-edit-selected]'):[...workbench.querySelectorAll('[data-inventory-edit]')].find(node=>node.dataset.inventoryEdit===targets[0].id);
      if(anchor){
        const feedback=el('div');feedback.className='inventory-edit-feedback';
        const message=el('span',batch?`已保存 ${targets.length} 张卡`:'养成已保存');message.setAttribute('role','status');
        const undo=el('button','撤销');undo.type='button';undo.setAttribute('aria-label',batch?'撤销本次批量养成修改':`撤销 ${targets[0].shortLabel} 的养成修改`);
        undo.addEventListener('click',()=>{workbench.querySelector('[data-inventory-undo]').click();workbench.querySelector('[data-inventory-edit-selected]')?.focus({preventScroll:true});});
        feedback.append(message,undo);anchor.after(feedback);
      }
      dialog.close();
    }catch(error){status.textContent=`未保存：${error.message}`;}
  });
  for(const selector of ['[data-inventory-edit-cancel]','[data-inventory-edit-close]'])q(selector).addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{
    const trigger=batch?workbench.querySelector('[data-inventory-edit-selected]'):[...workbench.querySelectorAll('[data-inventory-edit]')].find(button=>button.dataset.inventoryEdit===targets[0]?.id);
    targets=[];status.textContent='';trigger?.focus({preventScroll:true});
  });
  function open(cards,isBatch) {
    if(!cards.length)return;
    if(cards.some(card=>card.kind!==cards[0].kind))throw new Error('请分别编辑成员卡与留影');
    targets=[...cards];batch=isBatch;original=structuredClone(getInventory());
    initial=batch?Object.fromEntries(fields().map(field=>[field,''])):Object.fromEntries(fields().map(field=>[field,String(before(cards[0])[field])]));
    values={...initial};closeSkillPopover(workbench);
    const card=cards[0],title=batch?`批量修改 ${cards.length} 张${card.kind==='member'?'成员卡':'留影'}`:'修改养成';
    q('h2').textContent=title;dialog.setAttribute('aria-label',batch?title:`修改 ${card.shortLabel} 的养成`);
    for(const [field,label] of Object.entries({level:'等级',rank:card.kind==='member'?'觉醒星数':'突破花瓣',awake:'突破（特训）',skillLevel:'演出技能等级',gekisouSkillLevel:'激奏技能等级'})){q(`[data-inventory-edit-title="${field}"]`).textContent=label;controls[field].setAttribute('aria-label',label);}
    q('[data-inventory-edit-name]').textContent=batch?`已选 ${cards.length} 张卡`:card.shortLabel;
    q('[data-inventory-edit-relation]').textContent=batch?'仅修改选中的卡片，保存后可整批撤销。':card.relationLabel??'';
    const missing=cards.filter(c=>!original[`${c.kind}CardIds`].includes(c.id)).length;
    q('[data-inventory-edit-help]').textContent=batch?`选「保持各卡原值」的字段不会修改。${missing?`保存时会将 ${missing} 张未录入卡加入卡库。`:''}`:'先选择养成，再保存；快捷操作不会立即写入卡库。';
    const image=q('[data-inventory-edit-image]');image.hidden=batch||!card.imageUrl;
    if(!batch&&card.imageUrl)image.src=card.imageUrl;else image.removeAttribute('src');image.onerror=()=>{image.hidden=true;};
    const list=q('[data-inventory-edit-targets]');list.hidden=!batch;list.open=false;
    list.querySelector('summary').textContent=`查看所选 ${cards.length} 张卡`;
    list.querySelector('ul').replaceChildren(...cards.map(c=>el('li',`${c.shortLabel} · ${c.relationLabel??''}${original.growth[c.id]?'':'（未录入）'}`)));
    q('[data-inventory-edit-preset="skills"]').hidden=card.kind!=='member';
    q('[data-inventory-edit-preset="level"] small').textContent=card.kind==='member'?'只改等级，保留阶数与技能':'只改等级，保留突破';
    q('[data-inventory-edit-preset="maximum"] small').textContent=card.kind==='member'?'等级、阶数、技能全部升满':'等级与突破全部升满';
    reset.textContent=batch?'清空本次设置':'恢复原值';save.textContent=batch?`保存 ${cards.length} 张卡`:'保存修改';
    refresh();dialog.showModal();q('h2').focus();
  }
  return {open:card=>open([card],false),openBatch:cards=>open(cards,true)};
}
