import {createPersonalGrowthStore} from './personal-growth-store.mjs';
import {createInventoryManager, growthFields} from './inventory-manager.mjs';
import {currentServerContext, gameServer} from './game-servers.mjs';
import {bandItemGroups} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';

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
export function setupSharedInventoryPanel({root,data,onChange=()=>{},getRestrictions=()=>({})}) {
  const english=String(data.locale??document.documentElement.lang).startsWith('en');
  const t=(zh,en)=>english?en:zh;
  const rules=data.formalRules,cards=[...data.memberCards,...data.supportCards];
  const manager=createInventoryManager(rules,cards);
  let profile=null,store,contextKey='',page=0,undo=null,pendingImport=null,fileRequest=0,destroyed=false,editor=null,accountDirty=false,accountBaseline=null;
  const pageSize=8;
  const listeners=[];
  function listen(target,type,handler){target.addEventListener(type,handler);listeners.push(()=>target.removeEventListener(type,handler));}
  function button(text,handler){const value=node('button',text);value.type='button';value.addEventListener('click',handler);return value;}
  function field(text,input){const label=node('label',text,'tw-field');label.append(input);return label;}
  function select(options){const value=node('select');for(const [id,label] of options){const option=node('option',label);option.value=String(id);value.append(option);}return value;}
  function download(value,name){const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'}));const link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const status=node('p','','tw-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const count=node('p','','tw-inventory-count');
  const kind=select([['member',t('成员卡','Member cards')],['support',t('留影','Support cards')]]);
  const owned=select([['owned',t('已持有','Owned')],['all',t('全部卡片','All cards')],['missing',t('未记录','Not recorded')]]);
  const search=node('input');search.type='search';search.placeholder=t('卡名、角色或 ID','Card, character or ID');
  const filters=node('div','','tw-inventory-filters');filters.append(field(t('类型','Type'),kind),field(t('范围','Show'),owned),field(t('搜索','Search'),search));
  const list=node('div','','tw-inventory-list'),editRoot=node('div','','tw-inventory-editor');
  const pagination=node('div','','tw-actions'),pageText=node('span');
  const prev=button(t('上一页','Previous'),()=>{page--;renderCards();}),next=button(t('下一页','Next'),()=>{page++;renderCards();});
  pagination.append(prev,pageText,next);
  const undoButton=button(t('撤销上次修改','Undo last change'),()=>act(()=>{
    if(!undo)return;ensureStore();
    if(undo.key!==store.key||store.checkpoint()!==undo.after)throw Error(t('资料已在其他地方修改，不能撤销覆盖；请重新检查。','The profile changed elsewhere. Review it before undoing.'));
    store.restore(undo.before);undo=null;accountDirty=false;editor=null;editRoot.replaceChildren();refresh();onChange(profile);status.textContent=t('已撤销上次修改。','Last change undone.');
  }));
  const exportButton=button(t('导出卡库与养成','Export inventory'),()=>act(()=>{ensureStore();download(store.read()??store.empty(),'otonote-personal-growth.json');}));
  const actions=node('div','','tw-actions');actions.append(undoButton,exportButton);

  const importDetails=node('details','','tw-inventory-import'),importSummary=node('summary',t('导入备份','Import backup'));
  const file=node('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label',t('选择养成 JSON 文件','Choose growth JSON file'));
  const paste=node('textarea');paste.rows=4;paste.placeholder=t('也可以粘贴 JSON 备份','Or paste a JSON backup');paste.setAttribute('aria-label',t('养成 JSON','Growth JSON'));
  const importPreview=node('div','','tw-import-preview');
  const confirmImport=button(t('确认替换卡库与养成','Replace inventory and growth'),()=>act(()=>{
    if(!pendingImport)return;ensureStore();
    if(pendingImport.key!==store.key||pendingImport.before!==store.checkpoint())throw Error(t('预览后资料有变化，请重新预览再导入。','The profile changed since preview. Preview the backup again.'));
    commit(pendingImport.profile,t('备份已导入。已存队伍保留，可撤销本次导入。','Backup imported. Saved teams are preserved. You can undo this import.'));
    pendingImport=null;confirmImport.disabled=true;accountDirty=false;editor=null;editRoot.replaceChildren();renderAccount();
  }));confirmImport.disabled=true;
  const previewButton=button(t('预览导入','Preview import'),()=>act(prepareImport));
  const exportInput=button(t('另存当前导入内容','Save input as a file'),()=>download(paste.value,'otonote-pending-import.json'));
  const importActions=node('div','','tw-actions');importActions.append(previewButton,confirmImport,exportInput);
  importDetails.append(importSummary,node('p',t('先预览，再确认替换卡库与账号养成。不会修改已存队伍。','Preview before replacing inventory and account growth. Saved teams stay unchanged.')),file,paste,importActions,importPreview,node('small',t('遇到未知卡片时，请保留备份，更新到匹配的内容版本后重试；不会丢弃卡片或补成满养成。','If a card is unknown, keep your backup and retry with matching content. Cards are never dropped or assumed fully trained.')));

  const accountDetails=node('details','','tw-account-growth');accountDetails.append(node('summary',t('账号养成：乐器、角色评级、TGW','Account growth: items, character ranks, TGW')));
  const accountForm=node('form','','tw-account-form'),accountFields=node('div','','tw-account-fields'),accountStatus=node('p','','tw-status');accountStatus.setAttribute('role','status');
  const accountSubmit=node('button',t('保存账号养成','Save account growth'));accountSubmit.type='submit';
  const accountReset=button(t('恢复已保存值','Restore saved values'),()=>{accountDirty=false;renderAccount();});
  const accountExport=button(t('导出这次编辑','Export this edit'),()=>act(()=>{
    ensureStore();const draft=structuredClone(profile??store.empty());draft.account=collectAccount();download(store.validate(draft),'otonote-unsaved-account-growth.json');
  }));
  const accountActions=node('div','','tw-actions');accountActions.append(accountSubmit,accountReset,accountExport);accountForm.append(accountFields,accountActions,accountStatus);accountDetails.append(accountForm);
  root.replaceChildren(count,filters,list,pagination,editRoot,actions,importDetails,accountDetails,status);

  function ensureStore(){
    const context=currentServerContext(),key=`${context.region}:${context.serverId??'unselected'}`;
    if(key!==contextKey){
      contextKey=key;store=createPersonalGrowthStore({rules,vipRanks:data.vipRanks,context});profile=null;undo=null;pendingImport=null;
      confirmImport.disabled=true;editor=null;editRoot.replaceChildren();accountDirty=false;page=0;
    }
    return context;
  }
  function act(fn){try{fn();}catch(error){status.textContent=t('未保存，当前输入已保留：','Not saved; your input is preserved: ')+error.message;}}
  function commit(value,message){
    ensureStore();const before=store.checkpoint();const saved=store.save(value);
    undo={key:store.key,before,after:store.checkpoint()};profile=saved;pendingImport=null;confirmImport.disabled=true;
    renderCards();if(!accountDirty)renderAccount();onChange(profile);status.textContent=message;
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
    pendingImport={profile:incoming,key:store.key,before};confirmImport.disabled=false;
  }
  function renderCards(){
    const inventory=profile?.inventory??manager.empty(),query=search.value.trim().toLocaleLowerCase();
    count.textContent=`${t('成员卡','Member cards')} ${inventory.memberCardIds.length} · ${t('留影','Support cards')} ${inventory.supportCardIds.length}`;
    const selected=new Set(inventory[`${kind.value}CardIds`]);
    const filtered=cards.filter(card=>card.kind===kind.value&&(owned.value==='all'||(owned.value==='owned')===selected.has(card.id))&&(!query||[card.id,card.shortLabel,card.displayName,card.relationLabel,card.subtitle,card.description].some(value=>String(value??'').toLocaleLowerCase().includes(query))));
    const pages=Math.max(1,Math.ceil(filtered.length/pageSize));page=Math.max(0,Math.min(page,pages-1));list.replaceChildren();
    for(const card of filtered.slice(page*pageSize,(page+1)*pageSize)){
      const row=node('article','','tw-inventory-card'),body=node('div','','tw-card-copy');row.dataset.cardId=card.id;
      const imageUrl=card.imageUrl??card.artUrl;if(imageUrl){const image=node('img');image.src=imageUrl;image.alt='';image.loading='lazy';image.width=56;image.height=56;row.append(image);}
      body.append(node('strong',card.shortLabel??card.displayName??card.id),node('small',card.relationLabel??card.id));
      const growth=inventory.growth[card.id];body.append(node('span',growth?`${t('等级','Lv.')} ${growth.level} · ${t('突破','Rank')} ${growth.rank}${card.kind==='member'?` · ${t('觉醒','Awake')} ${growth.awake} · ${t('技能','Skills')} ${growth.skillLevel}/${growth.gekisouSkillLevel}`:''}`:t('未记录持有与养成','Ownership and growth not recorded')));
      const restrictions=getRestrictions()??{},reason=restrictions.cardReason?.(card);
      if(reason)body.append(node('small',`${t('当前工具不可用','Unavailable in this tool')}: ${reason}`,'tw-warning'));
      row.append(body,button(growth?t('编辑','Edit'):t('录入','Record'),()=>openEditor(card)));list.append(row);
    }
    if(!filtered.length)list.append(node('p',t('没有符合条件的卡片。可切换到“全部卡片”，或导入备份。','No matching cards. Choose “All cards” or import a backup.')));
    pageText.textContent=`${filtered.length} · ${page+1} / ${pages}`;prev.disabled=page===0;next.disabled=page>=pages-1;undoButton.disabled=!undo;
  }
  function openEditor(card){
    if(editor){status.textContent=t('请先保存或取消正在编辑的卡片，再打开另一张。','Save or cancel the open card edit before opening another card.');editor.form.querySelector('h3')?.focus();return;}
    ensureStore();let current;try{current=store.read();}catch(error){if(currentServerContext().serverId){status.textContent=error.message;return;}}
    const saved=current?.inventory.growth[card.id],growth={...saved??manager.preset(card.id,card.kind)},inputs=new Map();
    const key=store.key,baseline=saved?structuredClone(saved):null,form=node('form','','tw-growth-editor');editor={card,key,form};
    const title=node('h3',card.shortLabel??card.id);title.tabIndex=-1;form.append(title);
    if(!saved)form.append(node('p',t('尚未记录这张卡。以下从 1 级开始，请填写实际养成后保存。','This card is unrecorded. Values start at level 1; enter its actual growth before saving.')));
    const labels={level:t('等级','Level'),rank:t('突破阶数','Rank'),awake:t('觉醒阶数','Awakening'),skillLevel:t('演出技能','Live skill'),gekisouSkillLevel:t('激奏技能','Gekisou skill')};
    const grid=node('div','','tw-growth-fields');
    for(const name of card.kind==='member'?growthFields:growthFields.slice(0,2)){
      const input=select(manager.choices(card.id,card.kind,name,growth).map(value=>[value,String(value)]));input.value=String(growth[name]);input.name=name;inputs.set(name,input);grid.append(field(labels[name],input));
      input.addEventListener('change',()=>{
        growth[name]=Number(input.value);
        if(name==='rank'||name==='awake'){
          const level=inputs.get('level'),available=manager.choices(card.id,card.kind,'level',growth);level.replaceChildren();for(const value of available){const option=node('option',String(value));option.value=String(value);level.append(option);}
          if(!available.includes(growth.level)){growth.level=available.at(-1);status.textContent=t('等级超过该突破阶段上限，已调到有效上限；保存前请确认。','Level exceeds this rank’s limit and has been reduced. Check it before saving.');}level.value=String(growth.level);
        }
      });
    }
    const save=node('button',saved?t('保存实际养成','Save actual growth'):t('加入卡库','Add to inventory'));save.type='submit';
    const controls=node('div','','tw-actions');controls.append(save,button(t('取消','Cancel'),()=>{editor=null;editRoot.replaceChildren();}));
    if(saved)controls.append(button(t('移出卡库','Remove from inventory'),()=>act(()=>{
      const fresh=checkCardRevision();for(const k of ['member','support'])fresh.inventory[`${k}CardIds`]=fresh.inventory[`${k}CardIds`].filter(id=>id!==card.id);delete fresh.inventory.growth[card.id];
      commit(fresh,t('已移出卡库，可撤销。','Removed from inventory. Undo is available.'));editor=null;editRoot.replaceChildren();
    })));
    const exportEdit=button(t('导出这次编辑','Export this edit'),()=>act(()=>{
      const fresh=store.read()??store.empty();fresh.inventory=manager.batch(fresh.inventory,[card.id],{patch:growth});download(fresh,'otonote-unsaved-growth.json');
    }));controls.append(exportEdit);
    function checkCardRevision(){
      ensureStore();if(store.key!==key)throw Error(t('区服已切换，请重新打开卡片。','The server changed. Open the card again.'));
      const fresh=store.read()??store.empty();if(!same(fresh.inventory.growth[card.id]??null,baseline))throw Error(t('这张卡已在其他地方修改。请重新打开检查；当前输入仍保留。','This card changed elsewhere. Reopen it to review; your input is preserved.'));return fresh;
    }
    form.addEventListener('submit',event=>{event.preventDefault();act(()=>{
      const fresh=checkCardRevision();fresh.inventory=manager.batch(fresh.inventory,[card.id],{patch:growth});commit(fresh,t('实际养成已保存。','Actual growth saved.'));editor=null;editRoot.replaceChildren();
    });});form.append(grid,controls);editRoot.replaceChildren(form);title.focus();
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
  for(const input of [kind,owned,search])listen(input,input===search?'input':'change',()=>{page=0;renderCards();});
  listen(paste,'input',invalidatePreview);
  listen(file,'change',async()=>{
    invalidatePreview();const request=fileRequest,selected=file.files?.[0];if(!selected)return;
    try{if(selected.size>2_000_000)throw Error(t('文件过大，最多 2 MB。','The maximum backup size is 2 MB.'));const text=await selected.text();if(destroyed||request!==fileRequest)return;paste.value=text;prepareImport();}
    catch(error){if(!destroyed&&request===fileRequest)status.textContent=t('导入未应用：','Import not applied: ')+error.message;}
    finally{file.value='';}
  });
  function refresh(){
    if(destroyed)return;const context=ensureStore();
    try{profile=context.serverId?store.read():null;renderCards();renderAccount();}
    catch(error){status.textContent=t('资料未载入，原记录仍保留。可导入有效备份恢复：','Profile not loaded; the original record is preserved. Import a valid backup to recover: ')+error.message;}
  }
  refresh();
  return {refresh,destroy(){destroyed=true;fileRequest++;for(const remove of listeners)remove();root.replaceChildren();}};
}
