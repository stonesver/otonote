import {containModalFocus} from './dialog-focus.mjs';
import {cardGrowthLabel} from './card-growth-labels.mjs';
import {loadTeamWorkspaceData} from './shared-team-loader.mjs';
export {loadTeamWorkspaceData};
import {getActiveToolTeamContext} from './shared-team-context.mjs';
import {createTeamWorkspaceStore} from './team-workspace-store.mjs';
import {checkTeamCompatibility,mergeTeamForTool} from './team-workspace-compatibility.mjs';
import {createPersonalGrowthStore} from './personal-growth-store.mjs';
import {createTeamDraft} from './team-draft.mjs';
import {createToolCardPicker} from './tool-card-picker.mjs';
import {createInventoryManager} from './inventory-manager.mjs';
import {createPlanningSettings,planningSettingsValues} from './team-planning-scenario-ui.mjs';
import {setupSharedInventoryPanel} from './shared-inventory-panel.mjs';
import {currentServerContext,GAME_SERVERS} from './game-servers.mjs';
import {toolRoute} from './tool-route.mjs';
import {createTeamCardView,resolveTeamCardGrowth} from './team-card-view.mjs';
import {installWorkspaceDismiss} from './workspace-dismiss.mjs';

const element=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const button=(text,action,variant='secondary')=>{const b=element('button',text);b.type='button';b.dataset.variant=variant;b.addEventListener('click',action);return b;};
const copy=value=>structuredClone(value);
/** Keep a recommendation's chosen training subset when naming or saving it. */
export function syncEditedTeamPlanning(draft,sourceReleaseId,changedTrainingId) {
  const scenario=draft?.modifiers?.planningScenario;if(!scenario)return;
  const ids={memberCardIds:draft.slots.map(s=>s.memberCardId).filter(Boolean),supportCardIds:draft.slots.map(s=>s.supportCardId).filter(Boolean)};
  if(['selected','trial'].includes(scenario.scope))scenario.selectedCardIds=ids;
  if(scenario.scope==='trial')scenario.trialCardIds=ids;
  if(!scenario.plan)return;
  const selected=new Set([...ids.memberCardIds,...ids.supportCardIds]),previous=draft.modifiers.planningResult;
  scenario.plan.targets=Object.fromEntries(Object.entries(scenario.plan.targets??{}).filter(([id])=>selected.has(id)));
  const trained=previous?.selectedTrainingCardIds??Object.keys(scenario.plan.targets);
  draft.modifiers.planningResult={schemaVersion:1,sourceReleaseId,actualGrowth:copy(draft.modifiers.growth??{}),...previous,selectedTrainingCardIds:[...new Set([...trained,...(changedTrainingId?[changedTrainingId]:[])])].filter(id=>selected.has(id))};
  if(changedTrainingId){
    scenario.plan.maxTrainedCards=Math.max(scenario.plan.maxTrainedCards??1,draft.modifiers.planningResult.selectedTrainingCardIds.length);
    if(scenario.plan.allowedCardIds)scenario.plan.allowedCardIds=[...new Set([...scenario.plan.allowedCardIds,changedTrainingId])];
  }
}
/** Freeze the latest actual team only when leaving current-growth mode for an edit. */
export function prepareCurrentTeamGrowthEdit(draft,inventory) {
  if(planningSettingsValues(draft.modifiers,'selected').kind!=='current')return;
  const growth={};
  for(const slot of draft.slots)for(const kind of ['member','support']){
    const id=slot[`${kind}CardId`];
    if(id&&inventory?.[`${kind}CardIds`]?.includes(id)&&inventory.growth?.[id])growth[id]=copy(inventory.growth[id]);
  }
  draft.modifiers.growth=growth;
}
/** Keep hand-edited growth when a card is replaced away and selected again. */
export function retainTeamCardGrowth(draft,cardId,inventory) {
  draft.modifiers.growth??={};
  const actual=inventory?.growth?.[cardId];
  if(!Object.hasOwn(draft.modifiers.growth,cardId)&&actual)draft.modifiers.growth[cardId]=copy(actual);
}
/** Evaluate a replacement in its destination, excluding the card it replaces. */
export function teamCardSelectionReason(card,target,{draft,restrictions={},memberCards=[],locale='zh-CN'}={}) {
  const next=copy(draft??createTeamDraft()),slot=Number(target.slot),en=locale==='en';
  if(!Number.isInteger(slot)||slot<0||slot>=5)return en?'Choose a valid slot':'请选择有效位置';
  next.slots[slot][`${target.kind}CardId`]=card.id;
  const check=checkTeamCompatibility(next,{...restrictions,requireComplete:false});
  const issue=check.issues.find(i=>i.slot===slot&&i.kind===target.kind&&!['incomplete_team','missing_card','empty_slot','duplicate_card','duplicate_character'].includes(i.code));
  if(issue)return issue.message;
  const characterOf=id=>{
    const record=restrictions.rules?.tables?.MemberCard?.find(row=>`member-card-${row._id}`===id);
    const display=id===card.id?card:memberCards.find(row=>row.id===id);
    const value=record?._characterID??display?.characterId??display?.characterIds?.[0];
    return value==null?null:String(value).replace(/^character-/, '');
  };
  const character=target.kind==='member'?characterOf(card.id):null;
  const occupied=next.slots.findIndex((entry,index)=>index!==slot&&(
    entry[`${target.kind}CardId`]===card.id||target.kind==='member'&&character!=null&&characterOf(entry.memberCardId)===character));
  if(occupied>=0)return target.kind==='member'
    ?(en?`This character is in slot ${occupied+1}. Replace them in that slot.`:`此角色已在位置 ${occupied+1} 使用，请到该位置替换。`)
    :(en?`This snap is in slot ${occupied+1}. Replace it in that slot.`:`这张留影已在位置 ${occupied+1} 使用，请到该位置替换。`);
  return '';
}
function download(value,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const link=element('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}


export async function setupSharedTeamWorkspace(shell) {
  const panel=shell.querySelector('[data-team-workspace-panel]'),body=shell.querySelector('[data-team-workspace-body]'),launcher=shell.querySelector('[data-team-workspace-open]');
  const en=document.documentElement.lang==='en',say=(zh,english)=>en?english:zh;
  let context=getActiveToolTeamContext(),data=await loadTeamWorkspaceData(context);
  data.locale??=en?'en':'zh-CN';
  data.memberCards=data.memberCards.map(card=>({...card,kind:'member'}));data.supportCards=data.supportCards.map(card=>({...card,kind:'support'}));
  let store,profileStore,state,inventoryPanel,editing=null,editBaseline='',editingId=null,editingRevision,undo=null,pendingSave=null,origin=null;
  const tabScroll={teams:0,inventory:0};
  let activeTab='teams',applying=false,guarding=false,loadedProfile,includePerformance=false,dismissedOutside=false,lastSavedId=null,previewedTeam=null;
  const status=element('div','','tw-status tw-feedback');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const serverRow=element('div',null,'tw-server'),tabs=element('div',null,'tw-tabs'),teams=element('section'),inventory=element('section');
  teams.id='tw-teams';inventory.id='tw-inventory';tabs.setAttribute('role','tablist');
  const teamTab=button(null,()=>switchTab('teams')),inventoryTab=button(null,()=>switchTab('inventory'));
  const teamTabLabel=element('span',say('我的队伍','My teams')),teamTabCount=element('span','0','tw-tab-count');
  const inventoryTabLabel=element('span',say('管理养成','Growth & cards')),inventoryTabCount=element('span','0','tw-tab-count');
  teamTab.append(teamTabLabel,teamTabCount);inventoryTab.append(inventoryTabLabel,inventoryTabCount);
  for(const [b,id] of [[teamTab,'teams'],[inventoryTab,'inventory']]){b.id=`tw-tab-${id}`;b.setAttribute('role','tab');b.setAttribute('aria-controls',`tw-${id}`);}
  for(const [root,id] of [[teams,'teams'],[inventory,'inventory']]){root.setAttribute('role','tabpanel');root.setAttribute('aria-labelledby',`tw-tab-${id}`);}
  const navigation=element('div',null,'tw-navigation');tabs.append(teamTab,inventoryTab);navigation.append(tabs,serverRow);body.before(navigation,status);body.replaceChildren(teams,inventory);
  tabs.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();switchTab(event.key==='Home'?'teams':event.key==='End'?'inventory':activeTab==='teams'?'inventory':'teams');(activeTab==='teams'?teamTab:inventoryTab).focus();}});
  const currentBox=element('section',null,'tw-current'),editor=element('section',null,'tw-editor'),list=element('div',null,'tw-team-list'),search=element('input');
  search.type='search';search.placeholder=say('搜索队伍名称','Search team names');search.setAttribute('aria-label',search.placeholder);search.addEventListener('input',renderList);
  const actions=element('div',null,'tw-actions tw-library-actions');
  actions.append(button(say('新建队伍','New team'),()=>guardEditor(()=>edit(createTeamDraft(),null,say('新队伍','New team'))),'primary'));
  const backup=element('details',null,'tw-more'),backupMenu=element('div',null,'tw-more-menu');backup.append(element('summary',say('导入 / 导出','Import / export')),backupMenu);
  const importInput=element('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;importInput.setAttribute('aria-label',say('导入队伍文件','Import teams file'));
  backupMenu.append(button(say('导入队伍','Import teams'),()=>importInput.click()),button(say('导出队伍','Export teams'),()=>run(()=>{download(store.exportWorkspace(),'otonote-teams.json');feedback(say('已导出队伍备份。','Team backup exported.'));})),importInput);actions.append(backup);
  const importPreview=element('div',null,'tw-import-preview'),legacyBox=element('div',null,'tw-legacy');
  const libraryHead=element('div',null,'tw-library-head');
  libraryHead.append(element('h3',say('已存队伍','Saved teams')),actions);
  const library=element('section',null,'tw-library');library.append(libraryHead,search,importPreview,legacyBox,list);teams.append(currentBox,editor,library);
  function syncWorkspaceCounts(){
    const inv=profile()?.inventory;
    const cardTotal=(inv?.memberCardIds?.length??0)+(inv?.supportCardIds?.length??0);
    const teamTotal=state?.teams?.length??0;
    teamTabCount.textContent=String(teamTotal);teamTabCount.hidden=teamTotal===0;
    inventoryTabCount.textContent=String(cardTotal);inventoryTabCount.hidden=cardTotal===0;
  }
  editor.addEventListener('input',updateSaveState);editor.addEventListener('change',updateSaveState);
  function feedback(message,{tone='success'}={}){status.dataset.tone=tone;status.setAttribute('role',tone==='error'?'alert':'status');status.replaceChildren(element('span',message),button(say('收起提示','Dismiss notice'),()=>status.replaceChildren(),'quiet'));}
  function run(fn){try{return fn();}catch(error){feedback(error.message,{tone:'error'});return null;}}
  function profile(){if(loadedProfile===undefined)loadedProfile=run(()=>profileStore.read())??null;return loadedProfile;}
  function updateSaveState(){
    const unsaved=Boolean(editing&&(!editingId||dirty()));const label=editor.querySelector('[data-save-state]');
    if(label){label.textContent=unsaved?say('未保存','Unsaved'):say('已保存','Saved');label.dataset.dirty=String(unsaved);}
    const save=editor.querySelector('[data-save-team]');if(save)save.disabled=!unsaved;
    launcher.textContent=say('养成与队伍','Growth & teams')+(unsaved?say(' · 未保存',' · Unsaved'):'');
  }
  function cardView(card,draft,compact=false){return createTeamCardView(card,{...resolveTeamCardGrowth({card,draft,inventory:profile()?.inventory,rules:data.formalRules}),kind:card.kind,locale:data.locale,data,compact});}

  function restrictions(){return {rules:data.formalRules,inventory:profile()?.inventory,...context?.getRestrictions?.()};}
  function compatibility(draft){return checkTeamCompatibility(context?mergeTeamForTool(context.getDraft(),draft):draft,restrictions());}
  function dirty(){return editing && JSON.stringify(editing)!==editBaseline;}
  function switchTab(tab){const next=tab==='inventory'?'inventory':'teams',changed=next!==activeTab;if(changed)tabScroll[activeTab]=body.scrollTop;activeTab=next;teams.hidden=activeTab!=='teams';inventory.hidden=activeTab!=='inventory';for(const [b,id] of [[teamTab,'teams'],[inventoryTab,'inventory']]){b.setAttribute('aria-selected',String(activeTab===id));b.tabIndex=activeTab===id?0:-1;}if(changed)body.scrollTop=tabScroll[activeTab];}
  function initializeStores(){
    store=createTeamWorkspaceStore({rules:data.formalRules});profileStore=createPersonalGrowthStore({rules:data.formalRules,vipRanks:data.vipRanks??[]});
    loadedProfile=undefined;state=run(()=>store.read());
    inventoryPanel?.destroy();inventory.replaceChildren();
    inventoryPanel=setupSharedInventoryPanel({root:inventory,data,onChange:next=>{loadedProfile=next;syncWorkspaceCounts();renderCurrent();renderList();updateSaveState();},onFeedback:feedback,getRestrictions:()=>({...restrictions(),cardReason:card=>{const draft=createTeamDraft();draft.slots[0][`${card.kind}CardId`]=card.id;return checkTeamCompatibility(draft,{...restrictions(),requireOwned:false,requireComplete:false}).issues.find(i=>i.kind===card.kind)?.message??'';}})});
    renderServer();renderCurrent();renderList();renderLegacy();syncWorkspaceCounts();
    if(store.migrationNotice)feedback(store.migrationNotice);
  }
  function renderServer(){
    const {region,serverId}=currentServerContext(),label=element('label',null,'tw-server-picker'),select=element('select');
    label.append(element('span',say('区服','Server')));
    select.append(new Option(say('选择账号区服','Choose account server'),''));for(const s of GAME_SERVERS.filter(s=>s.region===region))select.append(new Option(en?s.englishLabel:s.label,s.id));select.value=serverId??'';
    select.addEventListener('change',async()=>{
      if(!select.value)return;
      if(inventoryPanel?.hasUnsavedChanges?.()){const answer=await ask(say('卡库还有未保存的修改，切区服会放弃这些输入。','Unsaved collection edits will be discarded when switching server.'),[[say('放弃并切换','Discard and switch'),'discard'],[say('继续编辑','Keep editing'),'cancel']]);if(answer!=='discard'){select.value=serverId??'';return;}}
      guardEditor(()=>{try{localStorage.setItem(`ournotes:server:${region}`,select.value);const url=new URL(location.href);url.searchParams.set('server',select.value);location.assign(url.href);}catch(error){feedback(error.message,{tone:'error'});}},()=>select.value=serverId??'');
    });label.append(select);serverRow.replaceChildren(label);
    if(!serverId)serverRow.append(element('small',say('保存前请先选择账号区服','Choose a server before saving')));
  }
  function miniRoster(draft){
    const row=element('div',null,'tw-mini-roster');row.setAttribute('aria-hidden','true');
    for(const [i,slot] of draft.slots.entries()){
      const cell=element('span',null,'tw-mini-slot');if(i===2)cell.dataset.leader='true';
      const member=slot.memberCardId?data.memberCards.find(c=>c.id===slot.memberCardId):null;
      if(member?.imageUrl){const img=element('img');img.src=member.imageUrl;img.alt='';img.loading='lazy';cell.append(img);}
      else cell.append(element('i',i===2?say('队','L'):String(i+1)));
      row.append(cell);
    }
    return row;
  }
  function lineup(draft,compact=false){
    const row=element('div',null,compact?'tw-lineup tw-lineup--compact':'tw-lineup');row.setAttribute('aria-label',say('五组成员与留影配对','Five member and snap pairs'));
    for(const [i,slot] of draft.slots.entries()){
      const pair=element('div',null,'tw-pair');if(i===2)pair.dataset.leader='true';pair.append(element('small',i===2?say('队长 · 位置 3','Leader · 3'):`${say('位置','Slot')} ${i+1}`));
      for(const kind of ['member','support']){const card=data[`${kind}Cards`].find(c=>c.id===slot[`${kind}CardId`]);
        if(card)pair.append(cardView(card,draft,compact));else pair.append(element('span',kind==='member'?say('未选成员','No member'):say('未选留影','No snap'),'tw-card-empty'));
      }row.append(pair);
    }return row;
  }
  function scenarioLabel(draft){const s=draft.modifiers?.planningScenario;return s?.plan?say('培养计划','Training plan'):s?.scope==='reference'?say('满养成参考','Max growth reference'):s?.scope==='trial'?say('试用队伍','Trial team'):s?.scope==='owned'?say('当前养成','Current growth'):say('手选 / 参考队伍','Selected / reference team');}
  function renderCurrent(){
    if(previewedTeam){
      const team=previewedTeam,check=compatibility(team.draft),controls=element('div',null,'tw-actions tw-preview-actions');
      const head=element('div',null,'tw-current-head'),titleWrap=element('div');
      titleWrap.append(element('small',say('编成预览','Lineup preview')),element('h3',team.name));
      head.append(titleWrap,element('span',scenarioLabel(team.draft),'ui-pill'));
      currentBox.replaceChildren(head,lineup(team.draft));
      controls.append(button(say('编辑这支队伍','Edit this team'),()=>guardEditor(()=>edit(team.draft,team.id,team.name)),context?'secondary':'primary'));
      if(context){const apply=button(say('使用这支队伍','Use this team'),()=>guardEditor(()=>applyTeam(team.draft)),'primary');apply.disabled=!check.compatible;controls.append(apply);}
      if(!check.compatible)currentBox.append(element('p',check.issues.map(i=>i.message).join(' · '),'tw-warning'));
      currentBox.append(controls);return;
    }
    const emptyStage=(heading,copyText,actions)=>{
      const box=element('div',null,'tw-empty-state tw-empty-state--stage');
      const slots=element('div',null,'tw-empty-blueprint');slots.setAttribute('aria-hidden','true');
      for(let i=0;i<5;i++){const s=element('span',i===2?say('队长','Leader'):`${i+1}`);if(i===2)s.dataset.leader='true';slots.append(s);}
      box.append(slots,element('h4',heading),element('p',copyText),actions);
      return box;
    };
    currentBox.replaceChildren(element('h3',context?say('当前工具使用','Current tool team'):say('跨工具共用队伍','Shared across tools')));
    if(context){const draft=context.getDraft(),hasCards=draft.slots.some(slot=>slot.memberCardId||slot.supportCardId);
      if(hasCards){const controls=element('div',null,'tw-actions tw-preview-actions');controls.append(button(say('编辑当前队伍','Edit current team'),()=>guardEditor(()=>edit(draft)),'primary'),button(say('存为队伍','Save as team'),()=>guardEditor(()=>edit(draft,null,say('我的队伍','My team'),true))));currentBox.append(lineup(draft),element('p',scenarioLabel(draft),'ui-pill'),controls);}
      else {
        const actions=element('div',null,'tw-actions tw-empty-actions');
        actions.append(button(say('新建队伍','New team'),()=>guardEditor(()=>edit(createTeamDraft(),null,say('新队伍','New team'))),'primary'),button(say('管理养成','Manage growth'),()=>switchTab('inventory')));
        currentBox.append(emptyStage(say('当前尚未选择队伍','No active team yet'),say('在左侧选用已存队伍，或从空白 5 人配置新建一套阵容。','Pick a saved team on the left, or start building a fresh 5-pair lineup.'),actions));
      }
    }
    else {
      const isRanking=location.pathname.includes('/song-ranking/');
      const actions=element('div',null,'tw-actions tw-empty-actions');
      actions.append(button(say('新建队伍','New team'),()=>guardEditor(()=>edit(createTeamDraft(),null,say('新队伍','New team'))),'primary'),button(say('管理养成','Manage growth'),()=>switchTab('inventory')));
      currentBox.append(emptyStage(say('统一队伍与卡库工作台','Shared lineup & collection'),isRanking?say('排行榜使用统一基准分数。选好或新建队伍后，可带入歌曲计算查看个人成绩。','Rankings use a fixed benchmark. Build or choose a team here to test in calculators.'):say('在左侧选择队伍预览详情，或新建编成并管理个人卡库与养成。','Select a team on the left to inspect its lineup, or create a new team.'),actions));
    }
  }
  function renderList(){
    if(!store)return;const next=run(()=>store.read());if(next)state=next;list.replaceChildren();syncWorkspaceCounts();
    if(previewedTeam){previewedTeam=state.teams.find(team=>team.id===previewedTeam.id)??null;renderCurrent();}
    const rows=(state?.teams??[]).filter(team=>team.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
    if(context){const current=button(say('当前工具使用的队伍','Current tool team'),()=>{previewedTeam=null;renderCurrent();renderList();});current.className='tw-current-option';current.setAttribute('aria-pressed',String(!previewedTeam));list.append(current);}
    for(const team of rows){
      const card=element('article',null,'tw-saved-team'),check=compatibility(team.draft),controls=element('div',null,'tw-actions');card.dataset.teamId=team.id;card.dataset.justSaved=String(team.id===lastSavedId);
      const heading=button('',()=>{previewedTeam=team;renderCurrent();renderList();});heading.className='tw-team-option';heading.setAttribute('aria-pressed',String(previewedTeam?.id===team.id));
      const headTop=element('div',null,'tw-team-option-head');headTop.append(element('strong',team.name),element('span',scenarioLabel(team.draft),'tw-team-scenario'));
      heading.append(headTop,miniRoster(team.draft));
      card.append(heading);
      if(!check.compatible)card.append(element('p',check.issues.map(i=>i.message).join(' · '),'tw-warning'));
      if(!context&&location.pathname.includes('/song-ranking/'))controls.append(button(say('带到歌曲计算','Open song calculator'),()=>run(()=>{store.setRecentDraft(team.draft);location.assign(toolRoute('/tools/song-calculator/',location.pathname));}),'primary'));
      controls.append(button(check.compatible?say('编辑','Edit'):say('复制并调整','Copy and adjust'),()=>guardEditor(()=>edit(team.draft,check.compatible?team.id:null,team.name+(check.compatible?'':say(' 副本',' copy'))))));
      const more=element('details',null,'tw-more'),menu=element('div',null,'tw-more-menu');more.append(element('summary',say('更多','More')),menu);
      menu.append(button(say('复制','Copy'),()=>guardEditor(()=>edit(team.draft,null,team.name+say(' 副本',' copy')))),button(say('重命名','Rename'),()=>guardEditor(()=>edit(team.draft,team.id,team.name,true))),button(say('删除','Delete'),()=>run(()=>{
        const checkpoint=store.checkpoint();state=store.removeTeam(team.id,{expectedRevision:state.revision});undo={checkpoint,revision:state.revision};feedback(say(`已删除「${team.name}」。`,`Deleted “${team.name}”.`));status.append(button(say('撤销删除','Undo delete'),()=>run(()=>{store.restore(undo.checkpoint,{expectedRevision:undo.revision});undo=null;renderList();feedback(say('队伍已恢复。','Team restored.'));})));renderList();
      }),'danger'));controls.append(more);card.append(controls);list.append(card);
    }
    if(!rows.length){
      const empty=element('div',null,'tw-empty-state tw-empty-state--compact');
      const hasQuery=Boolean(search.value.trim());
      empty.append(element('p',hasQuery?say('没有找到匹配的队伍，试试换个关键词。','No matching saved teams. Try another keyword.'):say('还没有保存的队伍。新建一套 5 人阵容，随时带入配队与算分工具。','No saved teams yet. Build a 5-pair lineup to reuse across tools.')));
      if(hasQuery)empty.append(button(say('清空搜索','Clear search'),()=>{search.value='';renderList();}));
      else empty.append(button(say('新建第一支队伍','Create first team'),()=>guardEditor(()=>edit(createTeamDraft(),null,say('我的队伍','My team'))),'primary'));
      list.append(empty);
    }
  }
  function renderLegacy(){legacyBox.replaceChildren();const sources=run(()=>store.listLegacy())??[];if(!sources.length)return;
    legacyBox.append(element('p',say('发现旧版预设。选择需要带入的记录；原备份会保留。','Legacy presets found. Choose a source to import; original backups are kept.')));
    for(const source of sources){const b=button(`${source.sourceReleaseId} · ${source.count??'?'} ${say('队','teams')}`,()=>run(()=>{state=store.migrateLegacy(source.key,{expectedRevision:state.revision});renderList();renderLegacy();feedback(say('旧预设已带入，原记录保留。','Presets imported. Original records were kept.'));}));if(source.error){b.disabled=true;b.title=source.error;}legacyBox.append(b);}
  }
  importInput.addEventListener('change',async()=>{const file=importInput.files?.[0];if(!file)return;try{if(file.size>5_000_000)throw Error(say('文件不能超过 5 MB','Maximum file size is 5 MB'));const value=JSON.parse(await file.text()),next=store.fromImport(value),revision=store.read().revision;importPreview.replaceChildren(element('p',say(`将导入 ${next.teams.length} 套队伍，现有队伍保留。`,`Import ${next.teams.length} teams and keep existing teams.`)),button(say('确认导入','Confirm import'),()=>run(()=>{state=store.importWorkspace(value,{expectedRevision:revision});importPreview.replaceChildren();renderList();feedback(say('队伍已导入。','Teams imported.'));})),button(say('取消','Cancel'),()=>importPreview.replaceChildren()));}catch(error){feedback(error.message,{tone:'error'});}finally{importInput.value='';}});

  function ask(message,choices){return new Promise(resolve=>{
    const origin=document.activeElement,dialog=element('dialog',null,'tw-confirm'),title=element('h3',message);title.id='tw-confirm-title';dialog.setAttribute('aria-labelledby',title.id);dialog.append(title);
    const row=element('div',null,'tw-actions');for(const [label,value] of choices)row.append(button(label,()=>dialog.close(value)));dialog.append(row);panel.append(dialog);
    dialog.addEventListener('cancel',event=>event.stopPropagation());
    dialog.addEventListener('close',event=>{event.stopPropagation();const answer=dialog.returnValue||'cancel';dialog.remove();if(origin?.isConnected)origin.focus({preventScroll:true});resolve(answer);},{once:true});
    dialog.addEventListener('keydown',event=>containModalFocus(dialog,event));dialog.showModal();row.lastElementChild?.focus();
  });}
  async function guardEditor(action,onCancel){
    if(guarding)return;guarding=true;
    try{if(dirty()){const choice=await ask(say('队伍修改尚未保存','Team changes have not been saved'),[[say('保存后继续','Save and continue'),'save'],[say('放弃修改','Discard changes'),'discard'],[say('取消','Cancel'),'cancel']]);if(choice==='cancel'){onCancel?.();return;}if(choice==='save'&&!saveEditor())return;}return action();}finally{guarding=false;}
  }
  async function applyTeam(draft){
    if(!context||applying)return;applying=true;
    try{if(context.isDirty?.()){const choice=await ask(say('当前工具的队伍有未保存修改','The current tool has unsaved team changes'),[[say('保存后切换','Save before switching'),'save'],[say('放弃修改并切换','Switch without saving'),'discard'],[say('取消','Cancel'),'cancel']]);if(choice==='cancel')return;if(choice==='save'){await guardEditor(()=>{edit(context.getDraft(),null,say('我的队伍','My team'),true);pendingSave={afterSave:()=>{context.markSaved?.();applyTeam(draft);}};});return;}}
    await context.applyDraft(copy(draft),{includePerformance});context.markSaved?.();renderCurrent();feedback(say('队伍已用于当前工具，歌曲与活动设置保留。','Team applied. Song and event settings were kept.'));}catch(error){feedback(error.message,{tone:'error'});}finally{applying=false;}
  }
  function cardReason(card,target){return teamCardSelectionReason(card,target,{draft:editing??createTeamDraft(),restrictions:restrictions(),memberCards:data.memberCards,locale:data.locale});}
  shell.data=data;
  const picker=createToolCardPicker({root:shell,getCards:kind=>data[`${kind}Cards`],getDraft:()=>editing,getOwned:kind=>profile()?.inventory?.[`${kind}CardIds`]??[],getCardState:card=>resolveTeamCardGrowth({card,draft:editing,inventory:profile()?.inventory,rules:data.formalRules}),conflict:cardReason,onChoose:(card,target)=>{
    editing.slots[target.slot][`${target.kind}CardId`]=card.id;
    retainTeamCardGrowth(editing,card.id,profile()?.inventory);syncPlanningCards();
    renderEditor();
  }});
  // Put the chooser in the panel so stacked modal focus remains inside the workspace.
  panel.append(shell.querySelector('.ux-card-picker'));
  const syncPlanningCards=changedTrainingId=>syncEditedTeamPlanning(editing,data.formalRules.sourceReleaseId,changedTrainingId);
  function edit(draft,id=null,name='',focusName=false){panel.dataset.taskEntry='editor';panel.querySelector('#tw-title').textContent=say('编辑队伍配对','Edit team pairs');pendingSave=null;editing=copy(draft);editingId=id;editingRevision=state?.revision;editing._name=name;editBaseline=JSON.stringify(editing);includePerformance=false;renderEditor();switchTab('teams');editor.scrollIntoView({block:'start',behavior:'auto'});if(focusName)editor.querySelector('[data-tw-name]')?.focus({preventScroll:true});}
  function renderEditor(){
    const openGrowth=new Set([...editor.querySelectorAll('details[open]')].map(node=>node.dataset.growthCard));const focused=document.activeElement?.dataset.growthField;const scroll=body.scrollTop;
    editor.replaceChildren();if(!editing){updateSaveState();return;}const manager=createInventoryManager(data.formalRules),name=element('input');name.type='text';name.maxLength=80;name.value=editing._name??'';name.placeholder=say('例如：日常稳分队','For example: steady daily team');name.dataset.twName='';name.addEventListener('input',()=>editing._name=name.value);
    const nameLabel=element('label',say('队伍名称','Team name'));nameLabel.append(name);const editorHeading=element('header',null,'tw-editor-heading'),saveState=element('span',null,'tw-save-state');saveState.dataset.saveState='';editorHeading.append(element('h3',editingId?say('编辑队伍','Edit team'):say('新建队伍','New team')),saveState);
    const settings=planningSettingsValues(editing.modifiers,'selected'),scenario=element('select');
    for(const [value,zh,english] of [['current','当前养成','Current growth'],['training','培养后使用','After training'],['reference','满养成参考','Max growth reference'],['selected','保留手选养成','Keep selected growth'],['trial','试用未持有卡','Try unowned cards']])scenario.append(new Option(say(zh,english),value));scenario.value=settings.kind;
    const scenarioLabel=element('label',say('养成场景','Growth scenario'));scenarioLabel.append(scenario);
    const metaRow=element('div',null,'tw-editor-meta');metaRow.append(nameLabel,scenarioLabel);
    editor.append(editorHeading,metaRow,element('p',say('选齐 5 位成员与 5 张留影，第 3 位默认作队长。关闭弹窗会暂存当前草稿；保存后各工具共享。','Choose 5 members and 5 snaps (slot 3 is the leader). Growth adjustments apply to this team only.')));
    scenario.addEventListener('change',()=>{try{const value={...settings,kind:scenario.value,trainingScope:'selected',maxTrainedCards:10,trialCardIds:{memberCardIds:editing.slots.map(s=>s.memberCardId).filter(Boolean),supportCardIds:editing.slots.map(s=>s.supportCardId).filter(Boolean)}};editing.modifiers.planningScenario=createPlanningSettings(value,{sourceReleaseId:data.formalRules.sourceReleaseId,draft:editing}).planningScenario;renderEditor();}catch(error){feedback(error.message,{tone:'error'});}});
    const slots=element('div',null,'tw-edit-slots');
    for(const [i,slot] of editing.slots.entries()){
      const pair=element('section',null,'tw-edit-pair'),heading=element('header');if(i===2)pair.dataset.leader='true';heading.append(element('strong',i===2?say('队长 · 位置 3','Leader · Slot 3'):`${say('位置','Slot')} ${i+1}`));if(i!==2)heading.append(button(say('设为队长','Make leader'),()=>{[editing.slots[2],editing.slots[i]]=[editing.slots[i],editing.slots[2]];renderEditor();}));pair.append(heading);
      for(const kind of ['member','support']){const id=slot[`${kind}CardId`],card=data[`${kind}Cards`].find(c=>c.id===id),row=element('div',null,'tw-edit-card');row.dataset.kind=kind;
        const choose=button(null,()=>picker.open(kind,i));choose.dataset.chooseSlot=i;choose.dataset.chooseKind=kind;
        choose.className='tw-card-choice';
        if(card){choose.append(cardView(card,editing),element('span',say('更换','Change'),'tw-card-choice-action'));choose.setAttribute('aria-label',say('更换','Change')+' '+(card.displayName??card.shortLabel));}
        else {const placeholder=element('span',null,'tw-card-slot-placeholder');placeholder.append(element('strong','＋'),element('span',kind==='member'?say('选择成员卡','Choose member'):say('选择留影','Choose snap')));choose.append(placeholder);}
        row.append(choose);
        if(card){const growth=element('details',null,'tw-subfold tw-growth-fold');growth.dataset.growthCard=id;growth.open=openGrowth.has(id);growth.append(element('summary',settings.kind==='training'?say('培养目标','Training target'):say('查看 / 调整养成','View / adjust growth')));const actual=profile()?.inventory?.growth?.[id],current=settings.kind==='current'?actual:editing.modifiers.growth?.[id]??actual;
          growth.append(element('p',actual?say(`卡库记录 Lv.${actual.level}`,`Collection level ${actual.level}`):say('卡库未记录这张卡，计算时会说明参考假设。','This card is not recorded. Calculations will identify reference assumptions.')));
          const trainingSelected=editing.modifiers.planningResult?.selectedTrainingCardIds;const target=settings.kind==='training'&&(!trainingSelected||trainingSelected.includes(id))?settings.targets[id]:current;
          const fields=kind==='member'?['level','rank','awake','skillLevel','gekisouSkillLevel']:['level','rank'];
          for(const field of fields){const label=element('label',cardGrowthLabel(field,kind,data.locale)),input=element('select');input.dataset.growthField=`${id}:${field}`;input.append(new Option(say('未记录 / 沿用','Unknown / inherited'),''));for(const n of manager.choices(id,kind,field,{...(current??manager.preset(id,kind,'minimum')),...(settings.kind==='training'?target:{})}))input.append(new Option(String(n),String(n)));input.value=String((settings.kind==='training'?target?.[field]:current?.[field])??'');input.addEventListener('change',()=>{prepareCurrentTeamGrowthEdit(editing,profile()?.inventory);editing.modifiers.growth??={};editing.modifiers.growth[id]??=copy(current??{});if(settings.kind==='training'){const plan=editing.modifiers.planningScenario.plan;plan.targets??={};if(editing.modifiers.planningResult?.selectedTrainingCardIds&&!editing.modifiers.planningResult.selectedTrainingCardIds.includes(id))plan.targets[id]=copy(current??{});plan.targets[id]??={};if(input.value)plan.targets[id][field]=Number(input.value);else delete plan.targets[id][field];syncPlanningCards(id);}else{if(input.value)editing.modifiers.growth[id][field]=Number(input.value);else delete editing.modifiers.growth[id][field];if(settings.kind==='current'){editing.modifiers.planningScenario=createPlanningSettings({kind:'selected'},{sourceReleaseId:data.formalRules.sourceReleaseId,draft:editing}).planningScenario;scenario.value='selected';}}if(['rank','awake'].includes(field))renderEditor();else {choose.replaceChildren(cardView(card,editing),element('span',say('更换','Change'),'tw-card-choice-action'));updateSaveState();} });label.append(input);growth.append(label);}row.append(growth);
        }pair.append(row);
      }slots.append(pair);
    }editor.append(slots);
    const perf=element('label',null,'tw-check'),check=element('input');check.type='checkbox';check.className='ui-switch';check.setAttribute('role','switch');check.dataset.twPerformance='';check.checked=includePerformance;check.addEventListener('change',()=>includePerformance=check.checked);perf.append(check,say('应用时同时带入发挥设置','Include performance settings when applying'));editor.append(perf);
    const controls=element('div',null,'tw-actions tw-editor-actions');const save=button(editingId?say('保存修改','Save changes'):say('保存队伍','Save team'),()=>saveEditor(Boolean(editingId)),'primary');save.dataset.saveTeam='';controls.append(save);
    if(editingId)controls.append(button(say('另存为新队伍','Save as new team'),()=>saveEditor(false)));
    if(context)controls.append(button(say('用于当前工具','Use in this tool'),()=>{syncPlanningCards();const d=copy(editing);delete d._name;applyTeam(d);}));
    controls.append(button(say('收起编辑','Close editor'),()=>guardEditor(()=>{pendingSave=null;editing=null;editor.replaceChildren();panel.dataset.taskEntry='teams';panel.querySelector('#tw-title').textContent=say('养成与队伍','Growth & teams');updateSaveState();}),'quiet'));editor.append(controls);updateSaveState();
    body.scrollTop=scroll;if(focused)editor.querySelector(`[data-growth-field="${focused}"]`)?.focus({preventScroll:true});
  }

  function saveEditor(update=Boolean(editingId)){
    if(!editing)return false;try{syncPlanningCards();const draft=copy(editing),name=draft._name?.trim();delete draft._name;if(!name)throw Error(say('先给队伍起个名字。','Give the team a name first.'));
      state=store.saveTeam({...(update&&editingId?{id:editingId}:{}),name,draft,expectedRevision:editingRevision});if(!update||!editingId)editingId=state.teams.at(-1).id;editingRevision=state.revision;editBaseline=JSON.stringify(editing);renderEditor();if(context&&JSON.stringify(context.getDraft().slots)===JSON.stringify(draft.slots)&&JSON.stringify(context.getDraft().modifiers)===JSON.stringify(draft.modifiers))context.markSaved?.();lastSavedId=editingId;renderList();feedback(say(`${update?'已更新':'已保存'}「${name}」，各工具都可以选用。`,`${update?'Updated':'Saved'} “${name}”. Available in every tool.`));const pending=pendingSave;pendingSave=null;pending?.onSaved?.();pending?.afterSave?.();return true;
    }catch(error){feedback(say('未保存：','Not saved: ')+error.message,{tone:'error'});if(error.code==='revision_conflict'||/冲突|变化|changed|conflict/.test(error.message))status.append(button(say('保留修改，另存副本','Keep changes and save a copy'),()=>{state=store.read();editingRevision=state.revision;editingId=null;saveEditor(false);}));pendingSave?.onError?.(error.message);return false;}
  }
  function changed(){if(applying)return;context=getActiveToolTeamContext();renderCurrent();if(panel.open)renderList();}
  document.addEventListener('team-workspace:context',changed);document.addEventListener('team-workspace:draft',changed);
  window.addEventListener('team-workspace:changed',()=>{if(panel.open)renderList();});
  window.addEventListener('personal-growth:changed',()=>{loadedProfile=undefined;inventoryPanel?.refresh();renderCurrent();if(panel.open)renderList();});
  window.addEventListener('storage',event=>{if(event.key===store?.key){renderList();feedback(say('其他窗口更新了队伍库；正在编辑的内容已保留。','Teams changed in another window. Your edits were kept.'),{tone:'info'});}if(event.key===profileStore?.key){loadedProfile=undefined;inventoryPanel?.refresh();renderCurrent();renderList();}});
  panel.addEventListener('close',()=>{document.body.classList.remove('tw-is-open');launcher.setAttribute('aria-expanded','false');if(!dismissedOutside)origin?.focus?.();dismissedOutside=false;updateSaveState();});
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.matches(':modal')&&!panel.querySelector('dialog[open]')){event.preventDefault();panel.close();}});
  panel.addEventListener('cancel',event=>{if(panel.querySelector('dialog[open]'))event.preventDefault();});
  installWorkspaceDismiss(panel,launcher,()=>{dismissedOutside=true;panel.close();});
  initializeStores();switchTab('teams');
  return {async open(tab=activeTab,saveRequest=null,entryOrigin=null){origin=entryOrigin??(panel.contains(document.activeElement)?launcher:document.activeElement);context=getActiveToolTeamContext();if(!panel.open){panel.showModal();document.body.classList.add('tw-is-open');launcher.setAttribute('aria-expanded','true');}panel.dataset.taskEntry=tab;panel.querySelector('#tw-title').textContent=tab==='editor'?say('编辑队伍配对','Edit team pairs'):say('养成与队伍','Growth & teams');switchTab(tab);renderCurrent();renderList();if(tab==='editor'&&context&&!saveRequest){if(!editing)edit(context.getDraft());else{panel.dataset.taskEntry='editor';panel.querySelector('#tw-title').textContent=say('编辑队伍配对','Edit team pairs');editor.scrollIntoView({block:'start',behavior:'auto'});editor.querySelector('[data-tw-name]')?.focus({preventScroll:true});}}else if(saveRequest){await guardEditor(()=>{edit(saveRequest.draft,null,saveRequest.name||say('我的队伍','My team'),true);pendingSave=saveRequest;});}else panel.querySelector('[data-team-workspace-close]')?.focus();}};
}
