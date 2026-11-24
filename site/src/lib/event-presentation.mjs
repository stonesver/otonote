import {enhanceTaskSwitcher} from './tool-task-switcher.mjs';
import {createTeamSearchPlaceholder} from './team-search-placeholder.mjs';
import {selectedOptionText} from './tool-quick-options.mjs';
import {enhanceNumericInputs} from './workbench-dialog.mjs';

export function eventPresentationState({running=false,hasResults=false,feedbackState,quick=false}={}) {
 if(quick)return 'quick';
 if(running)return 'running';
 if(feedbackState==='error')return 'error';
 if(feedbackState==='stopped')return 'stopped';
 if(hasResults)return 'results';
 return feedbackState==='complete'?'empty':'setup';
}

/** Unified collapsible two-column paper setup card + frosted floating dock; controllers own values. */
export function setupEventPresentation(host,{main,aside,conditionBody,context,adjust,primary,manual,challengeConditions,rushSongs,reference,tags,empty,instant,continuation,updateRushSelection}) {
 const q=s=>host.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
 const svgIcon=(d,viewBox='0 0 16 16',circles=[])=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',viewBox);svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);svg.append(p);for(const [cx,cy,r] of circles){const c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx',String(cx));c.setAttribute('cy',String(cy));c.setAttribute('r',String(r));svg.append(c);}return svg;};
 const button=(text,cls)=>{const n=el('button',text,cls);n.type='button';return n;};
 const set=(n,text)=>{if(n.textContent!==text)n.textContent=text;};
 const events=new AbortController(),on=(n,event,fn)=>n.addEventListener(event,fn,{signal:events.signal});
 host.classList.add('event-simple-view');
 aside.hidden=true;tags.hidden=true;
 const activity=conditionBody.firstElementChild;activity.querySelector('h3').hidden=true;q('[data-mode-hint]').hidden=true;

 const rail=el('aside',null,'event-setup-rail');rail.setAttribute('aria-label','计算条件');main.before(rail);
 const setup=el('section',null,'event-default-setup ui-sheet');setup.id='event-default-conditions';rail.append(setup);

 // Event header ribbon: active event selector + status filter + bonus game visuals + compact pool/account actions + collapse control
 const banner=el('header',null,'event-setup-banner'),bannerLead=el('div',null,'event-banner-lead'),bonusRibbon=el('div',null,'event-bonus-ribbon'),bannerRight=el('div',null,'event-banner-actions');
 const field=s=>q(s).closest('label');
 const eventSelect=q('[data-event]');
 const eventField=field('[data-event]');
 // Enrich event selector with status tags & compact status filter pills
 const allEventOptions=[...eventSelect.options].map(opt=>{
  const ev=(host.data.rules?.tables?.Event??[]).find(e=>String(e._id)===opt.value);
  const nowMs=Date.now();
  const sMs=ev?._startTime?Date.parse(ev._startTime):0;
  const eMs=ev?._endTime?Date.parse(ev._endTime):0;
  const status=!sMs||!eMs?'unknown':nowMs<sMs?'upcoming':nowMs>eMs?'ended':'active';
  const badge=status==='active'?'[进行中] ':status==='upcoming'?'[预告] ':status==='ended'?'[已结束] ':'';
  if(badge&&!opt.textContent.startsWith('['))opt.textContent=badge+opt.textContent;
  return {value:opt.value,text:opt.textContent,status};
 });
 const eventFilterRow=el('div',null,'event-status-filter');
 let eventFilter='all';
 const filterButtons=[['all','全部'],['active','进行中'],['ended','已结束']].map(([key,label])=>{
  const btn=button(label,'event-filter-pill');
  btn.setAttribute('aria-pressed',String(key==='all'));
  on(btn,'click',()=>{
   eventFilter=key;
   filterButtons.forEach(([k,b])=>b.setAttribute('aria-pressed',String(k===key)));
   const prevVal=eventSelect.value;
   const filtered=allEventOptions.filter(o=>key==='all'||o.status===key);
   const list=filtered.length?filtered:allEventOptions;
   eventSelect.replaceChildren(...list.map(o=>{const op=el('option',o.text);op.value=o.value;return op;}));
   if(list.some(o=>o.value===prevVal))eventSelect.value=prevVal;
   else if(list.length){eventSelect.value=list[0].value;eventSelect.dispatchEvent(new Event('change',{bubbles:true}));}
  });
  eventFilterRow.append(btn);
  return [key,btn];
 });
 bannerLead.append(eventField,eventFilterRow,bonusRibbon);

 const poolRow=el('div',null,'event-pool-readiness'),poolIcon=svgIcon('M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7ZM5 6.5h6M5 9.5h4');
 const poolValue=el('strong'),poolWarn=el('span',null,'event-pool-warn');
 poolWarn.append(svgIcon('M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.2h.01'));
 const useCurrent=button('用当前队伍','ui-btn-soft');
 poolRow.append(poolIcon,poolValue,poolWarn,useCurrent);
 on(useCurrent,'click',()=>{const target=host.dataset.task==='challenge'?q('[data-challenge-opt-scope]'):q('[data-pool]');target.value='selected';target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));});
 const accountButton=q('.task-account-entry');
 if(accountButton){
  accountButton.classList.add('event-banner-account-btn');
 }
 const collapseBtn=button(null,'event-collapse-btn ui-btn-ghost');collapseBtn.setAttribute('aria-controls',setup.id);
 collapseBtn.append(svgIcon('m4 10 4-4 4 4'),el('span','收起'));
 bannerRight.append(poolRow,...(accountButton?[accountButton]:[]),collapseBtn);
 banner.append(bannerLead,bannerRight);

 // Two-column setup body inside paper card
 const columns=el('div',null,'event-setup-columns'),colLeft=el('div',null,'event-col-left'),colRight=el('div',null,'event-col-right');
 const fields=el('div',null,'event-default-fields'),common=el('div',null,'event-common-fields'),team=el('div',null,'event-team-fields'),quick=el('div',null,'event-quick-fields'),rush=el('div',null,'event-rush-fields');
 common.append(field('[data-mode]'),field('[data-boost]'),field('[data-cost]'));
 team.append(field('[data-pool]'),field('[data-yield-goal]'),field('[data-yield-budget]'),field('[data-yield-starting]'),field('[data-yield-stages]'),field('[data-yield-basis]'));
 quick.append(field('[data-manual-bonus]'),field('[data-manual-point-bonus]'),field('[data-rank]'));
 rush.append(field('[data-challenge-opt-scope]'),field('[data-challenge-opt-objective]'));
 fields.append(common,team,quick,rush);

 // Extra team settings: collapsible card bands, reward options, account button
 const teamExtra=el('div',null,'event-team-extra');
 const cardBandFold=el('details',null,'event-subfold ui-subfold'),cardBandSummary=el('summary',null,'event-subfold-summary');
 cardBandSummary.append(el('span','成员与留影乐队限制'),el('small','不限'));
 cardBandFold.append(cardBandSummary,q('[data-yield-card-bands]'));
 const yieldExtras=el('div',null,'event-extras-row');
 const yieldRewards=q('.task-event-primary > .task-event-reward-options');
 const advHelp=q('.task-event-planning-group > .task-event-advanced');
 if(yieldRewards)yieldExtras.append(yieldRewards);
 if(advHelp)yieldExtras.append(advHelp);
 teamExtra.append(cardBandFold,yieldExtras);

 const rushRewardsEl=challengeConditions.querySelector('.task-event-reward-options'),rushAdvHelp=challengeConditions.querySelector('.task-event-advanced');
 const rushExtras=el('div',null,'event-rush-extra'),rushExtrasRow=el('div',null,'event-extras-row');
 if(rushRewardsEl)rushExtrasRow.append(rushRewardsEl);
 if(rushAdvHelp)rushExtrasRow.append(rushAdvHelp);
 rushExtras.append(rushExtrasRow);

 const quickError=el('p',null,'event-input-error');quickError.setAttribute('role','status');
 colLeft.append(fields,teamExtra,rushExtras,quickError);

 // Column 2: Song card & filters + collapsible follow-up challenge fold (and challenge conditions in rush mode)
 const filters=el('section',null,'task-condition-group event-song-filters-group'),filtersHeading=el('h3','选曲与筛选');
 filters.append(filtersHeading,field('[data-yield-level]'),q('[data-yield-song-filters]'));
 context.querySelector('.task-event-song-footer').hidden=true;
 const sharedScope=q('[data-event-calculation-scope]');
 const continuationFold=el('details',null,'event-subfold ui-subfold'),continuationSummary=el('summary',null,'event-subfold-summary');
 continuationSummary.append(el('span','后续挑战 · 独立配队与判档'),el('small','默认沿用设定'));
 continuationFold.append(continuationSummary,continuation);
 challengeConditions.classList.add('event-rush-options');
 colRight.append(context,...(sharedScope?[sharedScope]:[]),filters,continuationFold,challengeConditions);

 columns.append(colLeft,colRight);
 setup.append(banner,columns);
 main.prepend(rushSongs);
 adjust.remove();

 // Frosted bottom floating calculation dock
 const dock=el('footer',null,'event-action-dock ui-dock'),dockCopy=el('div',null,'event-action-copy'),dockTitle=el('strong'),dockNote=el('small'),actions=el('div',null,'event-dock-actions');
 dockCopy.append(dockTitle,dockNote);dock.append(dockCopy,actions);host.append(dock);
 const run=q('[data-yield-run]'),rushRun=q('[data-challenge-opt-run]');run.textContent='计算收益';rushRun.textContent='推荐冲榜队伍';actions.append(run,rushRun);

 // Collapsed 1-line multi-segment summary strip
 const summary=el('section',null,'event-condition-summary ui-summary-strip'),summarySegments=el('div',null,'ui-summary-segments'),modify=button(null,'ui-btn-soft');
 modify.append(svgIcon('M2.5 5h11M2.5 11h11','0 0 16 16',[[6,5,1.5],[10.5,11,1.5]]),el('span','修改条件'));
 modify.setAttribute('aria-controls',setup.id);
 summary.append(summarySegments,modify);rail.parentElement.before(summary);

 // Remove redundant ready card; status belongs concisely in the bottom dock
 empty.replaceChildren();
 empty.hidden=true;

 let collapsed=false,previous='setup',lastTask=host.dataset.task;
 const toggleSetup=()=>{collapsed=!collapsed;refresh();(collapsed?modify:q('[data-event]')).focus({preventScroll:true});};
 on(modify,'click',toggleSetup);
 on(collapseBtn,'click',toggleSetup);

 const calculation=el('section',null,'event-calculation'),message=el('p',null,'event-state-message');message.setAttribute('role','status');calculation.append(message);
 const feedbacks=['yield','challenge'].map(kind=>q(`[data-calculation-progress="${kind}"]`)).filter(Boolean);
 const cancel=q('[data-yield-cancel]'),rushCancel=q('[data-challenge-opt-cancel]');cancel.textContent='停止';
 const cancelWrap=el('span'),rushCancelWrap=el('span');cancelWrap.append(cancel);rushCancelWrap.append(rushCancel);
 const feedbackSlots=feedbacks.map(n=>{const slot=el('div');slot.dataset.progressTask=n.dataset.calculationProgress;slot.append(n);calculation.append(slot);return slot;});actions.append(cancelWrap,rushCancelWrap);dock.prepend(calculation);
 const continueActions=el('div',null,'event-continue-actions');continueActions.append(q('[data-yield-continue]'));actions.append(continueActions);
 const details=el('details',null,'event-search-details');details.append(el('summary','计算详情'),q('[data-yield-status]'),q('[data-challenge-opt-status]'));main.append(details);
 const resultTitle=el('h2','推荐方案','event-result-title');q('[data-yield-results]').before(resultTitle);
 const pending=createTeamSearchPlaceholder();resultTitle.before(pending.element);

 const tabs=q('.task-subtabs');tabs.append(q('[data-event-task="challenge"]'),q('[data-event-task="quick"]'));
 enhanceTaskSwitcher(tabs,[
  {button:q('[data-event-task="team"]'),icon:'team',label:'收益配队'},
  {button:q('[data-event-task="challenge"]'),icon:'trophy',label:'活动曲冲榜'},
  {button:q('[data-event-task="quick"]'),icon:'bolt',label:'加成速算'},
 ]);
 enhanceNumericInputs(setup);enhanceNumericInputs(continuationFold);

 const multiCount=selector=>{const s=q(selector);return s?[...s.selectedOptions].filter(o=>o.value!=='').length:0;};
 function updateBonusRibbon(){
  const eid=Number(q('[data-event]').value);
  const visual=host.data.eventVisuals?.[eid];
  const nodes=[];
  if(visual){
   for(const b of visual.bands??[]){
    const chip=el('span',null,'event-bonus-chip event-bonus-chip--band');chip.title=`${b.bonus?'加成':'登场'}乐队：${b.name}`;
    const src=b.circleImage||b.image;
    if(src){
     const img=el('img');img.src=src;img.alt=b.name;img.loading='lazy';
     if(b.circleImage&&b.image)img.addEventListener('error',()=>{if(img.src!==b.image){img.src=b.image;chip.classList.remove('event-bonus-chip--band');}},{once:true});
     chip.append(img);
    }else chip.textContent=b.name;
    nodes.push(chip);
   }
   for(const code of visual.attributes??[]){
    const attr=host.data.filterVisualOptions?.attribute?.find(a=>Number(a.value)===Number(code));
    if(attr){
     const chip=el('span',null,'event-bonus-chip event-bonus-chip--attr');chip.title=`加成属性：${attr.label}`;
     if(attr.icon){const img=el('img');img.src=attr.icon;img.alt=attr.label;img.loading='lazy';chip.append(img);}
     else chip.textContent=attr.label;
     nodes.push(chip);
    }
   }
   for(const c of (visual.characters??[]).slice(0,5)){
    if(!c.portrait)continue;
    const av=el('span',null,'event-bonus-avatar');av.title=`加成角色：${c.name}`;
    const img=el('img');img.src=c.portrait;img.alt=c.name;img.loading='lazy';
    av.append(img);nodes.push(av);
   }
  }
  bonusRibbon.replaceChildren(...nodes);
  bonusRibbon.hidden=!nodes.length;
 }

 function updateSummaryStrip(isRush,ordinary){
  const eid=Number(q('[data-event]').value);
  const visual=host.data.eventVisuals?.[eid];
  const eventSeg=el('span'),attrVisual=visual?.attributes?.[0]!=null?host.data.filterVisualOptions?.attribute?.find(a=>Number(a.value)===Number(visual.attributes[0])):null;
  if(attrVisual?.icon){const img=el('img');img.src=attrVisual.icon;img.alt='';eventSeg.append(img);}
  eventSeg.append(document.createTextNode(selectedOptionText(q('[data-event]'))));
  const segs=[eventSeg];
  if(isRush){
   segs.push(el('span',selectedOptionText(q('[data-challenge-opt-scope]'))),el('span',selectedOptionText(q('[data-challenge-opt-objective]'))));
  }else{
   segs.push(
    el('span',`${selectedOptionText(q('[data-pool]'))} · ${ordinary?`${q('[data-yield-budget]').value} 火`:`${q('[data-cost]').value} 挑战 pt`}`),
    el('span',selectedOptionText(q('[data-yield-goal]'))),
    el('span',q('[data-yield-songs]').value==='selected'?(q('[data-selected-song]')?.textContent||'指定谱面'):`自动选曲 · ${selectedOptionText(q('[data-yield-difficulty]'))}`)
   );
  }
  if(host.calculationScope?.enabled&&host.calculationScope?.summary)segs.push(el('span',host.calculationScope.summary));
  summarySegments.replaceChildren(...segs);
 }

 function refresh(){
  const task=host.dataset.task,isQuick=task==='quick',isRush=task==='challenge',ordinary=q('[data-mode]').value==='ordinary';
  if(task!==lastTask){collapsed=false;lastTask=task;}
  const feedback=q(`[data-calculation-progress="${isRush?'challenge':'yield'}"]`);
  const running=q(isRush?'[data-challenge-optimizer]':'[data-yield-optimizer]').getAttribute('aria-busy')==='true';
  const results=q(isRush?'[data-challenge-opt-results]':'[data-yield-results]');
  const hasResults=!!results.querySelector(isRush?'.challenge-opt-result':'.task-event-plan-result');
  const state=eventPresentationState({running,hasResults,feedbackState:feedback?.hidden?undefined:feedback?.dataset.state,quick:isQuick});
  updateRushSelection?.({active:isRush,running});
  pending.update({running,hasResults,active:!isQuick,title:isRush?'正在寻找冲榜队伍':'正在寻找收益队伍'});
  if((state==='running'&&previous!=='running')||(state==='results'&&!['running','results'].includes(previous))){collapsed=true;}
  previous=state;host.dataset.eventView=state;

  rail.hidden=!isQuick&&collapsed;
  setup.hidden=!isQuick&&collapsed;
  summary.hidden=isQuick||!collapsed;
  collapseBtn.hidden=isQuick||collapsed;
  modify.setAttribute('aria-expanded',String(!collapsed));

  updateBonusRibbon();
  updateSummaryStrip(isRush,ordinary);

  team.hidden=isQuick||isRush;quick.hidden=!isQuick;rush.hidden=!isRush;
  field('[data-yield-budget]').hidden=!ordinary;
  field('[data-yield-stages]').hidden=isQuick||isRush||!ordinary;
  field('[data-yield-starting]').hidden=isQuick||isRush||!ordinary;
  field('[data-yield-basis]').hidden=isQuick||isRush;
  teamExtra.hidden=isQuick||isRush;
  rushExtras.hidden=!isRush;
  const singleCol=isQuick||(!isRush&&!ordinary);
  colRight.hidden=singleCol;
  columns.dataset.singleCol=String(singleCol);
  filters.hidden=isQuick||isRush||!ordinary||q('[data-yield-songs]').value==='selected';
  field('[data-yield-level]').hidden=!ordinary||q('[data-yield-songs]').value==='selected';
  const songFilters=q('[data-yield-song-filters]');if(songFilters)songFilters.hidden=!ordinary||q('[data-yield-songs]').value==='selected';
  const showCont=!isQuick&&!isRush&&ordinary&&q('[data-yield-stages]').value==='cycle';
  continuation.hidden=!showCont;continuationFold.hidden=!showCont;

  const bandCount=multiCount('[data-yield-member-band]')+multiCount('[data-yield-support-band]');
  set(cardBandSummary.querySelector('small'),bandCount?`已筛选 ${bandCount} 项`:'不限');
  set(continuationSummary.querySelector('small'),`${selectedOptionText(q('[data-yield-challenge-scope]'))} · ${selectedOptionText(q('[data-yield-challenge-basis]'))}`);

  if(isRush&&accountButton&&!rushExtrasRow.contains(accountButton))rushAdvHelp?rushAdvHelp.before(accountButton):rushExtrasRow.append(accountButton);
  else if(!isRush&&accountButton&&!yieldExtras.contains(accountButton))advHelp?advHelp.before(accountButton):yieldExtras.append(accountButton);

  // Move shared calculation scope note cleanly alongside song card or right column in team mode
  if(sharedScope)sharedScope.hidden=isQuick||isRush||!ordinary||q('[data-yield-songs]').value==='selected';
  context.hidden=isQuick||isRush||!ordinary;rushSongs.hidden=isQuick||(!isRush&&ordinary);
  if(state==='running'||state==='results')reference.hidden=true;
  primary.hidden=true;manual.hidden=true;

  run.hidden=isQuick||isRush;rushRun.hidden=!isRush;
  continueActions.hidden=isQuick||isRush||running;
  cancelWrap.hidden=!running||isRush;rushCancelWrap.hidden=!running||!isRush;
  dock.hidden=isQuick;actions.hidden=isQuick;
  set(dockTitle,isRush?'活动曲冲榜':ordinary?`${q('[data-yield-budget]').value} 火 · ${selectedOptionText(q('[data-yield-goal]'))}`:'挑战收益');
  set(dockNote,running?'计算中，可随时停止':isRush?selectedOptionText(q('[data-challenge-opt-scope]')):`${selectedOptionText(q('[data-pool]'))} · ${ordinary?selectedOptionText(q('[data-yield-stages]')):'当前挑战'}`);

  q('.task-event-toolbar').hidden=true;q('.task-challenge-toolbar').hidden=true;instant.hidden=true;tags.hidden=true;
  empty.hidden=true;
  const activePoolSelect=isRush?q('[data-challenge-opt-scope]'):q('[data-pool]');
  poolRow.hidden=isQuick||activePoolSelect?.value==='selected';
  bannerRight.hidden=poolRow.hidden&&(!accountButton||accountButton.hidden)&&collapseBtn.hidden;
  const inventory=host.teamWorkspaceContext?.inventory,members=inventory?.memberCardIds?.length??0,supports=inventory?.supportCardIds?.length??0;
  set(poolValue,`${members} 成员 · ${supports} 留影`);
  const hasTeam=host.draft.slots.filter(slot=>slot.memberCardId&&slot.supportCardId).length===5;
  useCurrent.hidden=!hasTeam;
  const needCards=members<5||supports<5;
  poolWarn.hidden=!needCards;
  poolWarn.title=needCards?(hasTeam?'可切换当前队伍':'卡库不足 5 成员/5 留影，请完善养成或切全卡库'):'';

  resultTitle.hidden=isQuick||isRush||!hasResults;
  q('.task-challenge-result').hidden=!isRush||!hasResults;
  for(const slot of feedbackSlots)slot.hidden=slot.dataset.progressTask!==(isRush?'challenge':'yield');
  calculation.hidden=isQuick||((!feedback||feedback.hidden)&&!['error','stopped','empty'].includes(state));
  message.hidden=!!feedback&&!feedback.hidden;
  if(!running)set(message,state==='empty'?'没有符合条件的方案，请调整条件。':(state==='stopped'?feedback?.querySelector('strong')?.textContent:feedback?.querySelector('small')?.textContent)|| (state==='stopped'?'已停止':state==='error'?'计算失败，请重试。':''));
  details.hidden=isQuick||!['results','stopped','empty'].includes(state);
  quickError.hidden=!isQuick||!!host.current;if(!quickError.hidden)set(quickError,q('[data-bonus]').textContent);
  q('.task-quick-result').hidden=!isQuick||!host.current;
  q('[data-yield-status]').hidden=isRush;q('[data-challenge-opt-status]').hidden=!isRush;
 }

 const observer=new MutationObserver(refresh);
 for(const s of ['[data-yield-results]','[data-challenge-opt-results]'])observer.observe(q(s),{childList:true});
 for(const n of feedbacks)observer.observe(n,{attributes:true,attributeFilter:['data-state'],childList:true,subtree:true,characterData:true});
 for(const s of ['[data-yield-optimizer]','[data-challenge-optimizer]'])observer.observe(q(s),{attributes:true,attributeFilter:['aria-busy']});
 const dockSize=new ResizeObserver(([entry])=>host.style.setProperty('--event-dock-height',`${Math.ceil(entry.target.getBoundingClientRect().height)}px`));dockSize.observe(dock);
 refresh();return {refresh,destroy(){events.abort();observer.disconnect();dockSize.disconnect();}};
}
