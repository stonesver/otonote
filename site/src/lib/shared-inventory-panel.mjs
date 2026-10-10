import {cardGrowthLabel} from './card-growth-labels.mjs';
import {createPersonalGrowthStore} from './personal-growth-store.mjs';
import {createInventoryManager, growthFields} from './inventory-manager.mjs';
import {currentServerContext, gameServer} from './game-servers.mjs';
import {bandItemGroups} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';
import {createTeamCardView} from './team-card-view.mjs';
import {filterTeamCards,teamCardFilterOptions} from './team-card-filters.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {attachCardSkillHover,destroySkillPopover} from './calculator-card-ui.mjs';
import {setupSharedInventoryImports} from './shared-inventory-imports.mjs';

const node=(tag,text='',className='')=>{const value=document.createElement(tag);value.textContent=text;value.className=className;return value;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Import is a replacement, so show removals and changed growth as well as new cards. */
export function inventoryImportDelta(previous,next) {
  const before=previous?.inventory, after=next.inventory;
  return Object.fromEntries(['member','support'].map(kind=>{
    const oldIds=before?.[`${kind}CardIds`]??[],newIds=after[`${kind}CardIds`];
    const oldSet=new Set(oldIds),newSet=new Set(newIds);
    return [kind,{count:newIds.length,added:newIds.filter(id=>!oldSet.has(id)).length,
      removed:oldIds.filter(id=>!newSet.has(id)).length,
      changed:newIds.filter(id=>oldSet.has(id)&&!same(before.growth[id],after.growth[id])).length}];
  }));
}

/** Owns only actual inventory. Team plans and named teams never pass through this store. */
export function setupSharedInventoryPanel({root,data,onChange=()=>{},getRestrictions=()=>({}),onFeedback=()=>{}}) {
  const english=String(data.locale??document.documentElement.lang).startsWith('en');
  const t=(zh,en)=>english?en:zh;
  const rules=data.formalRules,cards=[...data.memberCards,...data.supportCards];
  const skillWorkbench={data};
  const manager=createInventoryManager(rules,cards);
  let profile=null,store,contextKey='',page=0,undo=null,pendingImport=null,fileRequest=0,destroyed=false,editor=null,accountDirty=false,accountBaseline=null,lastCardFeedback=null;
  const pageSize=24;
  let shortcuts;
  const listeners=[];
  function listen(target,type,handler){target.addEventListener(type,handler);listeners.push(()=>target.removeEventListener(type,handler));}
  function button(text,handler,variant='secondary'){const value=node('button',text);value.type='button';value.dataset.variant=variant;value.addEventListener('click',handler);return value;}
  function field(text,input){const label=node('label',text,'tw-field');label.append(input);return label;}
  function select(options){const value=node('select');for(const [id,label] of options){const option=node('option',label);option.value=String(id);value.append(option);}return value;}
  function download(value,name){const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'}));const link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const status=node('p','','tw-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  function feedback(message,tone='info'){
    status.textContent=message;status.dataset.tone=tone;
    try{onFeedback(message,{tone});}catch { /* Feedback cannot change a completed storage operation. */ }
  }
  const count=node('p','','tw-inventory-count');
  const kind=select([['member',t('成员卡','Member cards')],['support',t('留影','Support cards')]]);
  const owned=select([['owned',t('已持有','Owned')],['',t('全部卡片','All cards')],['unowned',t('未记录','Not recorded')]]);
  const search=node('input');search.type='search';search.placeholder=t('卡名、角色或 ID','Card, character or ID');
  const filters=node('div','','tw-inventory-filters');filters.append(field(t('类型','Type'),kind),field(t('范围','Show'),owned),field(t('搜索','Search'),search));
  const attribute=select([]),band=select([]),character=select([]),rarity=select([]);
  const sort=select([['default',t('默认顺序','Default order')],['name',t('卡名','Card name')],['rarity-desc',t('稀有度从高到低','Rarity: high to low')],['level-desc',t('等级从高到低','Level: high to low')]]);
  const extraFilters=node('details','','tw-inventory-extra-filters');extraFilters.append(node('summary',t('更多筛选与排序','More filters and sorting')));
  const commonFilters=node('div','','tw-inventory-common-filters');for(const [control,zh,en] of [[attribute,'属性','Attribute'],[band,'乐队','Band'],[rarity,'稀有度','Rarity']]){control.dataset.quick='';commonFilters.append(field(t(zh,en),control));}
  const extraGrid=node('div','','tw-inventory-filters');for(const [control,zh,en] of [[character,'角色','Character'],[sort,'排序','Sort']]){control.dataset.quickNative='true';extraGrid.append(field(t(zh,en),control));}
  const clearFilters=button(t('清空筛选','Clear filters'),()=>{search.value='';owned.value='';for(const control of [attribute,band,character,rarity])control.value='';sort.value='default';page=0;renderCards();});
  extraFilters.append(extraGrid,clearFilters);
  const list=node('div','','tw-inventory-list'),editRoot=node('div','','tw-inventory-editor');editRoot.hidden=true;
  const pagination=node('div','','tw-actions'),pageText=node('span');
  const prev=button(t('上一页','Previous'),()=>{page--;renderCards();}),next=button(t('下一页','Next'),()=>{page++;renderCards();});
  pagination.append(prev,pageText,next);
  const undoButton=button(t('撤销上次修改','Undo last change'),()=>act(()=>{
    if(!undo)return;ensureStore();
    if(undo.key!==store.key||store.checkpoint()!==undo.after)throw Error(t('资料已在其他地方修改，不能撤销覆盖；请重新检查。','The profile changed elsewhere. Review it before undoing.'));
    store.restore(undo.before);undo=null;accountDirty=false;closeEditor();refresh();onChange(profile);feedback(t('已撤销上次修改。','Last change undone.'),'success');
  }));
  const exportButton=button(t('导出卡库与养成','Export inventory'),()=>act(()=>{ensureStore();download(store.read()??store.empty(),'otonote-personal-growth.json');feedback(t('备份下载已发起。','Backup download started.'),'success');}));
  const actions=node('div','','tw-actions');actions.append(undoButton,exportButton);

  const importDetails=node('details','','tw-inventory-import'),importSummary=node('summary',t('导入备份','Import backup'));
  const file=node('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label',t('选择养成 JSON 文件','Choose growth JSON file'));
  const paste=node('textarea');paste.rows=4;paste.placeholder=t('也可以粘贴 JSON 备份','Or paste a JSON backup');paste.setAttribute('aria-label',t('养成 JSON','Growth JSON'));
  const importPreview=node('div','','tw-import-preview');
  const confirmImport=button(t('确认替换卡库与养成','Replace inventory and growth'),()=>act(()=>{
    if(!pendingImport)return;ensureStore();
    if(pendingImport.key!==store.key||pendingImport.before!==store.checkpoint())throw Error(t('预览后资料有变化，请重新预览再导入。','The profile changed since preview. Preview the backup again.'));
    commit(pendingImport.profile,t('备份已导入。已存队伍保留，可撤销本次导入。','Backup imported. Saved teams are preserved. You can undo this import.'));
    pendingImport=null;confirmImport.disabled=true;paste.value='';importPreview.replaceChildren();accountDirty=false;closeEditor();renderAccount();
  }),'primary');confirmImport.disabled=true;
  const previewButton=button(t('预览导入','Preview import'),()=>act(prepareImport),'primary');
  const exportInput=button(t('另存当前导入内容','Save input as a file'),()=>download(paste.value,'otonote-pending-import.json'));
  const importActions=node('div','','tw-actions');importActions.append(previewButton,confirmImport,exportInput);
  importDetails.append(importSummary,node('p',t('先预览，再确认替换卡库与账号养成。不会修改已存队伍。','Preview before replacing inventory and account growth. Saved teams stay unchanged.')),file,paste,importActions,importPreview,node('small',t('遇到未知卡片时，请保留备份，更新到匹配的内容版本后重试；不会丢弃卡片或补成满养成。','If a card is unknown, keep your backup and retry with matching content. Cards are never dropped or assumed fully trained.')));

  const accountDetails=node('details','','tw-account-growth');accountDetails.append(node('summary',t('账号养成：乐器、角色评级、TGW','Account growth: items, character ranks, TGW')));
  const accountForm=node('form','','tw-account-form'),accountFields=node('div','','tw-account-fields'),accountStatus=node('p','','tw-status');accountStatus.setAttribute('role','status');
  const accountSubmit=node('button',t('保存账号养成','Save account growth'));accountSubmit.type='submit';accountSubmit.dataset.variant='primary';
  const accountReset=button(t('恢复已保存值','Restore saved values'),()=>{accountDirty=false;renderAccount();});
  const accountExport=button(t('导出这次编辑','Export this edit'),()=>act(()=>{
    ensureStore();const draft=structuredClone(profile??store.empty());draft.account=collectAccount();download(store.validate(draft),'otonote-unsaved-account-growth.json');
  }));
  const accountActions=node('div','','tw-actions');accountActions.append(accountSubmit,accountReset,accountExport);accountForm.append(accountFields,accountActions,accountStatus);accountDetails.append(accountForm);
  const imports=setupSharedInventoryImports({root,data,manager,getStore:()=>{ensureStore();return store;},mergeInventory:(inventory,message)=>{ensureStore();commit({...store.read()??store.empty(),inventory},message);},refresh:()=>{refresh();onChange(profile);},feedback});
  imports.entry.prepend(count);
  const filterHeader=node('div','','tw-inventory-filter-header');filterHeader.append(imports.entry,filters,commonFilters,extraFilters);
  root.replaceChildren(filterHeader,imports.host,editRoot,list,pagination,actions,importDetails,accountDetails,status);
  function refreshFilterOptions(){
    shortcuts?.destroy();
    const options=teamCardFilterOptions(cards.filter(card=>card.kind===kind.value),data);
    for(const [name,control] of [['attribute',attribute],['band',band],['character',character],['rarity',rarity]]){
      const previous=control.value;control.replaceChildren();for(const item of [{value:'',label:t('全部','All')},...options[name]]){const option=node('option',item.label);option.value=String(item.value);if(item.icon){option.dataset.icon=item.icon;if(name==='band'){option.dataset.round='true';option.dataset.iconOnly='true';}}control.append(option);}control.value=[...control.options].some(option=>option.value===previous)?previous:'';
    }
    shortcuts=setupQuickOptions(filterHeader);
  }

  function ensureStore(){
    const context=currentServerContext(),key=`${context.region}:${context.serverId??'unselected'}`;
    if(key!==contextKey){
      contextKey=key;store=createPersonalGrowthStore({rules,vipRanks:data.vipRanks,context});profile=null;undo=null;pendingImport=null;
      confirmImport.disabled=true;closeEditor();accountDirty=false;page=0;lastCardFeedback=null;
    }
    return context;
  }
  function act(fn){try{fn();}catch(error){feedback(t('操作未完成，当前输入已保留：','Action not completed; your input is preserved: ')+error.message,'error');}}
  function commit(value,message,cardId=null){
    ensureStore();const before=store.checkpoint();const saved=store.save(value);
    undo={key:store.key,before,after:store.checkpoint()};profile=saved;pendingImport=null;confirmImport.disabled=true;
    lastCardFeedback=cardId?{id:cardId,message}:null;renderCards();if(!accountDirty)renderAccount();onChange(profile);feedback(message,'success');
  }
  function invalidatePreview(){fileRequest++;pendingImport=null;confirmImport.disabled=true;importPreview.replaceChildren();}
  function prepareImport(){
    pendingImport=null;confirmImport.disabled=true;ensureStore();
    if(paste.value.length>2_000_000)throw Error(t('文件过大，最多 2 MB。','The maximum backup size is 2 MB.'));
    const raw=JSON.parse(paste.value.trim().replace(/^\uFEFF/,''));
    const incoming=store.fromImport(raw),before=store.checkpoint();let previous=null,readable=true;
    try{previous=store.read();}catch{readable=false;}
    const delta=inventoryImportDelta(previous,incoming),server=gameServer(incoming.serverId);
    importPreview.replaceChildren(node('p',`${t('区服','Server')}: ${english?server?.englishLabel:server?.label} · ${t('已核对当前内容数据','Validated against current content')}`));
    if(!readable)importPreview.append(node('p',t('原资料无法读取。此次替换后仍可撤销恢复原记录。','The previous profile is unreadable. Undo can restore its original record.')));
    for(const k of ['member','support']){const d=delta[k];importPreview.append(node('p',`${k==='member'?t('成员卡','Member cards'):t('留影','Support cards')}: ${d.count} · ${t('新增','add')} ${d.added} · ${t('移除','remove')} ${d.removed} · ${t('养成变化','growth changes')} ${d.changed}`));}
    importPreview.append(node('p',t('账号养成也将使用备份中的记录；空缺项保持未记录。','Account growth will also use the backup values; missing values remain unrecorded.')));
    if(raw.inventory?.sourceReleaseId&&raw.inventory.sourceReleaseId!==rules.sourceReleaseId)importPreview.append(node('p',t('备份来自另一内容版本，所有卡片和养成已重新校验。','This backup is from another content version. All cards and growth values have been revalidated.')));
    pendingImport={profile:incoming,key:store.key,before};confirmImport.disabled=false;feedback(t('预览已准备好，请核对后确认导入。','Preview ready. Check the changes before confirming import.'));
  }
  function renderCards(){
    shortcuts?.sync();
    const inventory=profile?.inventory??manager.empty();
    count.textContent=`${t('成员卡','Member cards')} ${inventory.memberCardIds.length} · ${t('留影','Support cards')} ${inventory.supportCardIds.length}`;
    const filtered=filterTeamCards(cards.filter(card=>card.kind===kind.value),{query:search.value,attribute:attribute.value,band:band.value,character:character.value,rarity:rarity.value,ownership:owned.value,owned:inventory[`${kind.value}CardIds`],sort:sort.value,growth:inventory.growth});
    const pages=Math.max(1,Math.ceil(filtered.length/pageSize));page=Math.max(0,Math.min(page,pages-1));
    // Move the same editor node before replacing rows, preserving input, listeners and selection.
    root.insertBefore(editRoot,list);list.replaceChildren();let visibleEditor=false;
    for(const card of filtered.slice(page*pageSize,(page+1)*pageSize)){
      const row=node('article','','tw-inventory-card');row.dataset.cardId=card.id;
      const growth=inventory.growth[card.id],view=createTeamCardView(card,{growth,kind:card.kind,locale:data.locale??(english?'en':'zh-CN'),data,source:growth?'actual':'unknown'});row.append(view);attachCardSkillHover(skillWorkbench,card,view.querySelector('.tw-card-art'),{growth});
      const restrictions=getRestrictions()??{},reason=restrictions.cardReason?.(card);
      if(reason)row.append(node('small',`${t('当前工具不可用','Unavailable in this tool')}: ${reason}`,'tw-warning'));
      const editButton=button(growth?t('编辑养成','Edit growth'):t('录入养成','Record growth'),()=>openEditor(card));editButton.dataset.inventoryEdit=card.id;editButton.setAttribute('aria-expanded',String(editor?.card.id===card.id));row.append(editButton);
      if(lastCardFeedback?.id===card.id)row.append(node('p',lastCardFeedback.message,'tw-card-feedback'));
      list.append(row);if(editor?.card.id===card.id){list.append(editRoot);visibleEditor=true;}
    }
    editRoot.hidden=!editor;if(editor)editor.location.hidden=visibleEditor;
    if(!filtered.length)list.append(node('p',t('没有符合条件的卡片。可切换到“全部卡片”，或导入备份。','No matching cards. Choose “All cards” or import a backup.')));
    pageText.textContent=t(`共 ${filtered.length} 张 · 第 ${page+1} / ${pages} 页`,`${filtered.length} cards · Page ${page+1} of ${pages}`);prev.disabled=page===0;next.disabled=page>=pages-1;undoButton.disabled=!undo;
  }
  function closeEditor({returnFocus=false}={}){
    const cardId=editor?.card.id;editor=null;editRoot.replaceChildren();editRoot.hidden=true;root.insertBefore(editRoot,list);
    if(cardId){const origin=[...list.querySelectorAll('[data-inventory-edit]')].find(button=>button.dataset.inventoryEdit===cardId);origin?.setAttribute('aria-expanded','false');if(returnFocus)(origin??search).focus({preventScroll:true});}
  }
  function openEditor(card){
    if(editor){feedback(t('请先保存或取消正在编辑的卡片，再打开另一张。','Save or cancel the open card edit before opening another card.'));editor.form.querySelector('h3')?.focus({preventScroll:true});return;}
    ensureStore();let current;try{current=store.read();}catch(error){if(currentServerContext().serverId){feedback(error.message,'error');return;}}
    lastCardFeedback=null;
    const saved=current?.inventory.growth[card.id],growth={...saved??manager.preset(card.id,card.kind)},inputs=new Map();
    const key=store.key,baseline=saved?structuredClone(saved):null,form=node('form','','tw-growth-editor');
    const location=node('p',t('正在编辑的卡片不在本页，输入已保留。','The card being edited is outside this page. Your input is preserved.'),'tw-editor-location');editor={card,key,form,location};
    const title=node('h3',card.shortLabel??card.id);title.tabIndex=-1;form.append(title);
    if(!saved)form.append(node('p',t('尚未记录这张卡。以下从 1 级开始，请填写实际养成后保存。','This card is unrecorded. Values start at level 1; enter its actual growth before saving.')));
    const grid=node('div','','tw-growth-fields');
    for(const name of card.kind==='member'?growthFields:growthFields.slice(0,2)){
      const input=select(manager.choices(card.id,card.kind,name,growth).map(value=>[value,String(value)]));input.value=String(growth[name]);input.name=name;inputs.set(name,input);grid.append(field(cardGrowthLabel(name,card.kind,english?'en':'zh-CN'),input));
      input.addEventListener('change',()=>{
        growth[name]=Number(input.value);
        if(name==='rank'||name==='awake'){
          const level=inputs.get('level'),available=manager.choices(card.id,card.kind,'level',growth);level.replaceChildren();for(const value of available){const option=node('option',String(value));option.value=String(value);level.append(option);}
          if(!available.includes(growth.level)){growth.level=available.at(-1);feedback(t('等级超过该突破阶段上限，已调到有效上限；保存前请确认。','Level exceeds this rank’s limit and has been reduced. Check it before saving.'),'warning');}level.value=String(growth.level);
        }
      });
    }
    const save=node('button',saved?t('保存实际养成','Save actual growth'):t('加入卡库','Add to inventory'));save.type='submit';save.dataset.variant='primary';
    const controls=node('div','','tw-actions');controls.append(save,button(t('取消','Cancel'),()=>closeEditor({returnFocus:true})));
    if(saved)controls.append(button(t('移出卡库','Remove from inventory'),()=>act(()=>{
      const fresh=checkCardRevision();for(const k of ['member','support'])fresh.inventory[`${k}CardIds`]=fresh.inventory[`${k}CardIds`].filter(id=>id!==card.id);delete fresh.inventory.growth[card.id];
      commit(fresh,t('已移出卡库，可撤销。','Removed from inventory. Undo is available.'),card.id);closeEditor({returnFocus:true});
    }),'danger'));
    const exportEdit=button(t('导出这次编辑','Export this edit'),()=>act(()=>{
      const fresh=store.read()??store.empty();fresh.inventory=manager.batch(fresh.inventory,[card.id],{patch:growth});download(fresh,'otonote-unsaved-growth.json');
    }));controls.append(exportEdit);
    function checkCardRevision(){
      ensureStore();if(store.key!==key)throw Error(t('区服已切换，请重新打开卡片。','The server changed. Open the card again.'));
      const fresh=store.read()??store.empty();if(!same(fresh.inventory.growth[card.id]??null,baseline))throw Error(t('这张卡已在其他地方修改。请重新打开检查；当前输入仍保留。','This card changed elsewhere. Reopen it to review; your input is preserved.'));return fresh;
    }
    form.addEventListener('submit',event=>{event.preventDefault();act(()=>{
      const fresh=checkCardRevision();fresh.inventory=manager.batch(fresh.inventory,[card.id],{patch:growth});commit(fresh,t('实际养成已保存。','Actual growth saved.'),card.id);closeEditor({returnFocus:true});
    });});form.append(grid,controls);editRoot.replaceChildren(location,form);renderCards();title.focus({preventScroll:true});
  }
  function renderAccount(){
    if(accountDirty)return;
    const account=profile?.account??{};accountBaseline=structuredClone(account);accountFields.replaceChildren();accountStatus.textContent='';
    const tgw=select([['',t('未记录','Not recorded')],...(data.vipRanks??[]).map(row=>[row.rank,`Lv.${row.rank}`])]);tgw.name='tgwCardRank';tgw.value=String(account.tgwCardRank??'');accountFields.append(field(t('TGW 等级','TGW rank'),tgw));
    const groups=bandItemGroups(rules);
    function numberInput(labelText,value,min,max,dataset){const input=node('input');input.type='number';input.step='1';input.min=String(min);input.max=String(max);input.inputMode='numeric';input.placeholder=t('未记录','Not recorded');input.value=value===undefined?'':String(value);Object.assign(input.dataset,dataset);return field(labelText,input);}
    function section(title){const details=node('details');details.append(node('summary',title));const grid=node('div','','tw-account-grid');details.append(grid);accountFields.append(details);return grid;}
    const totals=section(t('按乐队填写道具总等级','Band item total levels'));
    for(const group of groups){const name=data.bands?.find(row=>Number(row.id)===group.bandId)?.name??`${t('乐队','Band')} ${group.bandId}`;
      const label=numberInput(`${name} (0–${group.maxTotal})`,account.bandItemTotals?.[group.bandId],0,group.maxTotal,{accountKind:'bandItemTotals',accountId:String(group.bandId)});
      if(!group.supported){label.querySelector('input').disabled=true;label.append(node('small',t('此乐队请按单件填写','Use individual items for this band')));}totals.append(label);
    }
    const items=section(t('按单件填写道具等级','Individual item levels'));
    for(const row of rules.tables.BandItem){const label=data.instruments?.find(item=>Number(item.id)===row._id)?.name??`${data.bands?.find(b=>Number(b.id)===row._bandId)?.name??t('乐队','Band')} · ${row._id}`;const max=Math.max(0,...rules.tables.BandItemSkillEffect.filter(effect=>effect._bandItemId===row._id).map(effect=>effect._level));items.append(numberInput(label,account.bandItems?.[row._id],0,max,{accountKind:'bandItems',accountId:String(row._id)}));}
    const characters=section(t('角色评级','Character ranks')),maxRank=Math.max(...rules.tables.CharacterRank.map(row=>row._rank));
    for(const row of rules.tables.Character){const name=data.characters?.find(character=>Number(character.id)===row._id)?.name??`${t('角色','Character')} ${row._id}`;characters.append(numberInput(name,account.characterRanks?.[row._id],1,maxRank,{accountKind:'characterRanks',accountId:String(row._id)}));}
    accountFields.append(node('p',t('留空表示未记录。同一乐队填写总等级时，以总等级为准；修改单件会清除该乐队的总等级。','Blank values are unrecorded. A band total overrides individual items; editing an item clears that band’s total.')));
  }
  listen(accountForm,'input',event=>{
    accountDirty=true;accountStatus.textContent=t('有尚未保存的修改。','You have unsaved changes.');
    const input=event.target;if(input.dataset.accountKind==='bandItems'){
      const group=bandItemGroups(rules).find(value=>value.items.some(item=>String(item.id)===input.dataset.accountId));
      const total=accountFields.querySelector(`[data-account-kind="bandItemTotals"][data-account-id="${group?.bandId}"]`);if(total)total.value='';
    }
  });
  function collectAccount(){
    const account={};const tgw=accountFields.querySelector('[name="tgwCardRank"]');if(tgw.value!=='')account.tgwCardRank=Number(tgw.value);
    for(const input of accountFields.querySelectorAll('[data-account-kind]'))if(input.value!==''&&!input.disabled)(account[input.dataset.accountKind]??={})[input.dataset.accountId]=Number(input.value);
    return account;
  }
  listen(accountForm,'submit',event=>{event.preventDefault();if(!accountForm.reportValidity())return;act(()=>{
    ensureStore();const fresh=store.read()??store.empty();
    if(!same(fresh.account,accountBaseline))throw Error(t('账号养成已在其他地方修改。当前输入保留，请恢复已保存值后重新编辑。','Account growth changed elsewhere. Your input is preserved; restore saved values before editing again.'));
    fresh.account=collectAccount();commit(fresh,t('账号养成已保存。','Account growth saved.'));accountDirty=false;renderAccount();
  });});
  for(const input of [kind,owned,search,attribute,band,character,rarity,sort])listen(input,input===search?'input':'change',()=>{page=0;if(input===kind)refreshFilterOptions();renderCards();});
  listen(paste,'input',invalidatePreview);
  listen(file,'change',async()=>{
    invalidatePreview();const request=fileRequest,selected=file.files?.[0];if(!selected)return;
    try{if(selected.size>2_000_000)throw Error(t('文件过大，最多 2 MB。','The maximum backup size is 2 MB.'));const text=await selected.text();if(destroyed||request!==fileRequest)return;paste.value=text;prepareImport();}
    catch(error){if(!destroyed&&request===fileRequest)feedback(t('导入未应用，内容已保留：','Import not applied; your input is preserved: ')+error.message,'error');}
    finally{file.value='';}
  });
  function refresh(){
    if(destroyed)return;const context=ensureStore();
    try{profile=context.serverId?store.read():null;renderCards();renderAccount();}
    catch(error){feedback(t('资料未载入，原记录仍保留。可导入有效备份恢复：','Profile not loaded; the original record is preserved. Import a valid backup to recover: ')+error.message,'error');}
  }
  refreshFilterOptions();refresh();
  return {
    refresh,
    // Closing the panel preserves these inputs; navigation/server changes must ask before discarding them.
    hasUnsavedChanges(){return Boolean(editor||accountDirty||pendingImport||paste.value.trim()||file.files?.length||imports.hasUnsavedChanges());},
    destroy(){destroyed=true;fileRequest++;imports.destroy();shortcuts?.destroy();destroySkillPopover(skillWorkbench);for(const remove of listeners)remove();root.replaceChildren();}
  };
}
