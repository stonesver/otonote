import {growthFields} from './inventory-manager.mjs';
import {cardGrowthLabel} from './card-growth-labels.mjs';

/** Validate the whole batch before the caller makes one durable, undoable write. */
export function prepareInventoryBatch(manager,inventory,ids,{mode,patch={},updateExisting=false}={}) {
 if(!['minimum','maximum','level','custom'].includes(mode))throw Error('请选择这批卡片的养成方式');
 let next=inventory,added=0,updated=0,kept=0;const groups={member:[],support:[]};
 for(const id of new Set(ids)) {
  const kind=id.startsWith('member-')?'member':'support',exists=inventory[`${kind}CardIds`].includes(id);
  if(exists&&!updateExisting){kept++;continue;}
  groups[kind].push(id);exists?updated++:added++;
 }
 for(const kind of ['member','support']){
  const fields=kind==='member'?growthFields:growthFields.slice(0,2);
  if(groups[kind].length)next=manager.batch(next,groups[kind],{mode,patch:Object.fromEntries(Object.entries(patch).filter(([name])=>fields.includes(name)))});
 }
 return {inventory:next,added,updated,kept};
}

export function setupSharedInventoryBatch({root,cards,manager,t,getStore,getInventory,getPageCards,canEdit,onStart,onRender,commit,feedback}) {
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
 const button=(text,run)=>{const b=node('button',text);b.type='button';b.addEventListener('click',run);return b;};
 const selected=new Set();let active=false,only=false,baseline=null;
 const toolbar=node('div',null,'tw-batch-toolbar'),tools=node('div',null,'tw-batch-tools'),count=node('strong'),form=node('form',null,'tw-batch-form');form.hidden=true;tools.hidden=true;
 const entry=button(t('批量录入','Batch entry'),()=>{
  if(!canEdit())return;
  active=!active;form.hidden=true;baseline=null;
  if(active)onStart();only=false;render();onRender();
 });entry.dataset.batchEntry='';
 const selectedOnly=button(t('只看已选','Selected only'),()=>{only=!only;onRender(true);render();});
 const pageAll=button(t('选择本页','Select page'),()=>{for(const card of getPageCards())selected.add(card.id);changed();});
 const clear=button(t('清空','Clear'),()=>{selected.clear();only=false;changed();});
 const configure=button(t('设置养成','Set growth'),()=>{
  if(!canEdit())return;
  try{const store=getStore();baseline={key:store.key,checkpoint:store.checkpoint()};status.textContent='';form.hidden=false;renderForm();form.scrollIntoView({block:'nearest'});mode.focus({preventScroll:true});}
  catch(e){feedback(e.message,'error');}
 });configure.dataset.variant='primary';configure.className='tw-batch-configure';selectedOnly.className='tw-batch-selected-only';pageAll.className='tw-batch-select-page';clear.className='tw-batch-clear';tools.append(count,selectedOnly,pageAll,clear,configure);toolbar.append(entry,tools);
 const mode=node('select');mode.setAttribute('aria-label',t('批量养成方式','Batch growth preset'));
 for(const [value,zh,en] of [['','选择养成方式','Choose growth'],['minimum','初始养成 · 1 级','Initial growth · Lv.1'],['level','当前阶数满级','Max level at current rank'],['maximum','满养成','Maximum growth'],['custom','自定义养成','Custom growth']]){const o=node('option',t(zh,en));o.value=value;mode.append(o);}
 const header=node('div',null,'tw-batch-form-head'),title=node('strong',t('统一录入养成','Record batch growth')),close=button(t('收起','Close'),()=>{form.hidden=true;baseline=null;});header.append(title,mode,close);
 const fields=node('div',null,'tw-batch-fields'),inputs=new Map(),fieldTitles=new Map();
 for(const name of growthFields){
  const label=node('label'),title=node('span',cardGrowthLabel(name,'member',document.documentElement.lang)),input=node('input');input.type='number';input.min='1';input.step='1';input.inputMode='numeric';input.placeholder=t('保持 / 新卡为 1','Keep / new: 1');input.dataset.batchField=name;input.setAttribute('aria-label',title.textContent);if(name!=='level')input.max='5';label.append(title,input);fields.append(label);inputs.set(name,input);fieldTitles.set(name,title);
 }
 const overwrite=node('input');overwrite.type='checkbox';const overwriteLabel=node('label',null,'tw-batch-overwrite');overwriteLabel.append(overwrite,document.createTextNode(t('同时更新已记录卡片','Also update recorded cards')));
 const hint=node('p'),status=node('p',null,'tw-batch-message');status.setAttribute('role','status');
 const save=node('button',t('保存这批','Save batch'));save.type='submit';save.dataset.variant='primary';save.dataset.batchSave='';
 const actions=node('div',null,'tw-batch-save');actions.append(overwriteLabel,save);form.append(header,fields,hint,actions,status);root.append(toolbar,form);
 function renderForm(){
  fields.hidden=mode.value!=='custom';
  const hasMembers=[...selected].some(id=>id.startsWith('member-')),hasSupports=[...selected].some(id=>id.startsWith('support-'));
  const rankTitle=hasMembers&&hasSupports?t('觉醒 / 留影突破','Awakening / support rank'):cardGrowthLabel('rank',hasMembers?'member':'support',document.documentElement.lang);
  fieldTitles.get('rank').textContent=rankTitle;inputs.get('rank').setAttribute('aria-label',rankTitle);
  for(const name of growthFields.slice(2)){inputs.get(name).disabled=!hasMembers;inputs.get(name).parentElement.hidden=!hasMembers;}
  const inventory=getInventory(),existing=[...selected].filter(id=>inventory.growth[id]).length;
  hint.textContent=t(`已选 ${selected.size} 张 · ${existing} 张已记录${overwrite.checked?'，将更新养成':'，保留原值'}。请按实际养成选择；可保存后逐卡修正。`,`${selected.size} selected · ${existing} recorded (${overwrite.checked?'update':'keep'}). Use actual growth; edit individual cards after saving.`);
  save.disabled=!mode.value||!selected.size||(existing===selected.size&&!overwrite.checked);
 }
 mode.addEventListener('change',()=>{status.textContent='';renderForm();});overwrite.addEventListener('change',renderForm);
 fields.addEventListener('input',()=>{status.textContent='';});
 form.addEventListener('submit',event=>{
  event.preventDefault();if(!form.reportValidity()||save.disabled)return;
  try {
   if(!canEdit())return;
   const store=getStore();if(!baseline||store.key!==baseline.key||store.checkpoint()!==baseline.checkpoint)throw Error(t('卡库已变化，请收起后重新打开设置核对；已选卡片和输入保留。','The collection changed. Close and reopen these settings to review; selection and input are kept.'));
   const fresh=store.read()??store.empty(),patch=Object.fromEntries([...inputs].filter(([,input])=>!input.disabled&&input.value!=='').map(([name,input])=>[name,Number(input.value)]));
   const result=prepareInventoryBatch(manager,fresh.inventory,[...selected],{mode:mode.value,patch,updateExisting:overwrite.checked});
   commit({...fresh,inventory:result.inventory},t(`已新增 ${result.added} 张、更新 ${result.updated} 张，保留 ${result.kept} 张已有记录。可撤销本次修改。`,`Added ${result.added}, updated ${result.updated}, kept ${result.kept}. Undo is available.`));
   selected.clear();only=false;form.hidden=true;baseline=null;mode.value='';overwrite.checked=false;for(const input of inputs.values())input.value='';render();onRender();entry.focus({preventScroll:true});
  }catch(e){status.textContent=e.message;status.dataset.tone='error';}
 });
 function changed(){form.hidden=true;baseline=null;render();onRender();}
 function render(){
  tools.hidden=!active;entry.textContent=active?t('结束多选','Exit selection'):t(`批量录入${selected.size?`（${selected.size}）`:''}`,`Batch entry${selected.size?` (${selected.size})`:''}`);entry.setAttribute('aria-pressed',String(active));
  count.textContent=t(`已选 ${selected.size} 张`,`${selected.size} selected`);selectedOnly.setAttribute('aria-pressed',String(only));configure.disabled=clear.disabled=!selected.size;
 }
 render();
 return {get active(){return active;},get only(){return only;},has:id=>selected.has(id),get ids(){return [...selected];},
  toggle(id){selected.has(id)?selected.delete(id):selected.add(id);changed();},
  filter:rows=>only?cards.filter(c=>selected.has(c.id)):rows,
  reset(){selected.clear();active=false;only=false;form.hidden=true;baseline=null;mode.value='';overwrite.checked=false;status.textContent='';for(const input of inputs.values())input.value='';render();},
  hasUnsavedChanges:()=>selected.size>0,
 };
}
