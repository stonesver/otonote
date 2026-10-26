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

/** Move live controls into a small default form; all computation stays in the existing controllers. */
export function setupEventPresentation(host,{main,aside,conditionBody,context,adjust,primary,manual,challengeConditions,rushSongs,reference,tags,empty,instant,continuation,updateRushSelection}) {
 const q=s=>host.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
 const button=text=>{const n=el('button',text);n.type='button';return n;};
 const set=(n,text)=>{if(n.textContent!==text)n.textContent=text;};
 const events=new AbortController(),on=(n,event,fn)=>n.addEventListener(event,fn,{signal:events.signal});
 host.classList.add('event-simple-view');
 aside.hidden=true;tags.hidden=true;
 const activity=conditionBody.firstElementChild;activity.querySelector('h3').hidden=true;q('[data-mode-hint]').hidden=true;
 const setup=el('section',null,'event-default-setup'),fields=el('div',null,'event-default-fields'),common=el('div',null,'event-common-fields'),team=el('div',null,'event-team-fields'),quick=el('div',null,'event-quick-fields'),rush=el('div',null,'event-rush-fields');
 const rail=el('aside',null,'event-setup-rail');rail.setAttribute('aria-label','计算条件');main.before(rail);rail.append(setup);
 setup.prepend(el('h2','计算条件','event-setup-title'));
 const field=s=>q(s).closest('label');
 common.append(field('[data-event]'),field('[data-mode]'),field('[data-boost]'),field('[data-cost]'));
 team.append(field('[data-pool]'),field('[data-yield-goal]'),field('[data-yield-budget]'));
 quick.append(field('[data-manual-bonus]'),field('[data-manual-point-bonus]'),field('[data-rank]'));
 rush.append(field('[data-challenge-opt-scope]'),field('[data-challenge-opt-objective]'));
 fields.append(common,team,quick,rush);setup.append(fields,context);main.prepend(rushSongs);
 const quickError=el('p',null,'event-input-error');quickError.setAttribute('role','status');setup.append(quickError);
 // Keep frequently adjusted plan and song controls beside the results.
 const filters=el('section',null,'task-condition-group');filters.append(el('h3','选曲与档位'),field('[data-yield-level]'),q('[data-yield-song-filters]'),field('[data-yield-basis]'));
 context.querySelector('.task-event-song-footer').hidden=true;
 adjust.remove();
 const dock=el('footer',null,'event-action-dock'),dockCopy=el('div',null,'event-action-copy'),dockTitle=el('strong'),dockNote=el('small'),actions=el('div',null,'event-dock-actions');dockCopy.append(dockTitle,dockNote);dock.append(dockCopy,actions);host.append(dock);
 const run=q('[data-yield-run]'),rushRun=q('[data-challenge-opt-run]');run.textContent='计算收益';rushRun.textContent='推荐冲榜队伍';actions.append(run,rushRun);
 const depth=field('[data-yield-depth]'),eco=field('[data-yield-eco]'),search=el('div',null,'event-dock-search');depth.classList.add('event-search-depth');search.append(depth,eco);dock.insertBefore(search,actions);
 challengeConditions.classList.add('event-rush-options');setup.append(challengeConditions);
 const summary=el('section',null,'event-condition-summary'),copy=el('div'),title=el('strong'),description=el('span'),modify=button('修改条件');copy.append(title,description);summary.append(copy,modify);rail.parentElement.before(summary);
 setup.id='event-default-conditions';modify.setAttribute('aria-controls',setup.id);
 // A compact preparation workspace uses the original inputs, not duplicate values.
 const previewHead=el('header'),previewTitle=el('h2','计算准备'),previewState=el('span','未计算','event-ready-state');
 previewHead.append(previewTitle,previewState);
 const poolRow=el('div',null,'event-pool-readiness'),poolCopy=el('div'),poolValue=el('strong'),poolHint=el('small'),useCurrent=button('使用当前队伍'),poolManage=button('管理卡库');
 poolCopy.append(poolValue,poolHint);poolRow.append(poolCopy,useCurrent,poolManage);
 poolManage.dataset.openTeamWorkspace='inventory';
 on(useCurrent,'click',()=>{const pool=q('[data-pool]');pool.value='selected';pool.dispatchEvent(new Event('input',{bubbles:true}));pool.dispatchEvent(new Event('change',{bubbles:true}));preparation.open=false;});
 const preparation=el('details',null,'event-plan-configuration'),preparationTitle=el('summary','刷取计划与选曲'),preparationGrid=el('div',null,'event-plan-fields');
 primary.querySelector('h3').textContent='刷取计划';preparationGrid.append(primary,filters,continuation);preparation.append(preparationTitle,preparationGrid);preparation.open=true;
 const help=el('div',null,'event-plan-help');help.append(q('.task-event-planning-group > .task-event-advanced'));preparation.append(help);
 empty.replaceChildren(previewHead,poolRow,preparation);reference.before(empty);
 const desktop=window.matchMedia('(min-width:901px)');
 let expanded=false,desktopCollapsed=false,previous='setup',lastTask=host.dataset.task;
 on(desktop,'change',()=>refresh());
 on(modify,'click',()=>{if(desktop.matches)desktopCollapsed=!desktopCollapsed;else expanded=!expanded;refresh();if(!setup.hidden)q('[data-event]').focus();});
 const calculation=el('section',null,'event-calculation'),message=el('p',null,'event-state-message');message.setAttribute('role','status');calculation.append(message);
 const feedbacks=['yield','challenge'].map(kind=>q(`[data-calculation-progress="${kind}"]`)).filter(Boolean);
 const cancel=q('[data-yield-cancel]'),rushCancel=q('[data-challenge-opt-cancel]');cancel.textContent='停止';
 const cancelWrap=el('span'),rushCancelWrap=el('span');cancelWrap.append(cancel);rushCancelWrap.append(rushCancel);
 const feedbackSlots=feedbacks.map(n=>{const slot=el('div');slot.dataset.progressTask=n.dataset.calculationProgress;slot.append(n);calculation.append(slot);return slot;});actions.append(cancelWrap,rushCancelWrap);dock.prepend(calculation);
 const continueActions=el('div',null,'event-continue-actions');continueActions.append(q('[data-yield-continue]'));actions.append(continueActions);
 const details=el('details',null,'event-search-details');details.append(el('summary','计算详情'),q('[data-yield-status]'),q('[data-challenge-opt-status]'));main.append(details);
 const resultTitle=el('h2','推荐方案','event-result-title');q('[data-yield-results]').before(resultTitle);
 const pending=createTeamSearchPlaceholder();resultTitle.before(pending.element);
 // The three task tabs are the only top-level mode explanation.
 const tabs=q('.task-subtabs');tabs.append(q('[data-event-task="challenge"]'),q('[data-event-task="quick"]'));
 enhanceTaskSwitcher(tabs,[
  {button:q('[data-event-task="team"]'),icon:'team',label:'收益配队'},
  {button:q('[data-event-task="challenge"]'),icon:'trophy',label:'活动曲冲榜'},
  {button:q('[data-event-task="quick"]'),icon:'bolt',label:'加成速算'},
 ]);
 enhanceNumericInputs(setup);enhanceNumericInputs(preparation);
 function refresh(){
  const task=host.dataset.task,isQuick=task==='quick',isRush=task==='challenge',ordinary=q('[data-mode]').value==='ordinary';
  if(task!==lastTask){expanded=false;desktopCollapsed=false;lastTask=task;}
  const feedback=q(`[data-calculation-progress="${isRush?'challenge':'yield'}"]`);
  const running=q(isRush?'[data-challenge-optimizer]':'[data-yield-optimizer]').getAttribute('aria-busy')==='true';
  const results=q(isRush?'[data-challenge-opt-results]':'[data-yield-results]');
  const hasResults=!!results.querySelector(isRush?'.challenge-opt-result':'.task-event-plan-result');
  const state=eventPresentationState({running,hasResults,feedbackState:feedback?.hidden?undefined:feedback?.dataset.state,quick:isQuick});
  updateRushSelection?.({active:isRush,running});
  pending.update({running,hasResults,active:!isQuick,title:isRush?'正在寻找冲榜队伍':'正在寻找收益队伍'});
  if((state==='running'&&previous!=='running')||(state==='results'&&!['running','results'].includes(previous))){expanded=false;desktopCollapsed=true;preparation.open=false;}
  if(state==='setup'&&previous!=='setup')preparation.open=true;
  previous=state;host.dataset.eventView=state;
  const conditionsExpanded=desktop.matches?!desktopCollapsed:expanded;
  rail.hidden=desktop.matches&&desktopCollapsed&&!isQuick;
  setup.hidden=!desktop.matches&&!isQuick&&!expanded;
  summary.hidden=isQuick||(desktop.matches&&state==='setup'&&!desktopCollapsed);
  set(modify,conditionsExpanded?'收起条件':'修改条件');modify.setAttribute('aria-expanded',String(conditionsExpanded));
  set(title,selectedOptionText(q('[data-event]')));description.hidden=false;
  set(description,isRush?`${selectedOptionText(q('[data-challenge-opt-scope]'))} · ${selectedOptionText(q('[data-challenge-opt-objective]'))}`:`${selectedOptionText(q('[data-pool]'))} · ${ordinary?q('[data-yield-budget]').value+' 火':q('[data-cost]').value+' 挑战 pt'} · ${selectedOptionText(q('[data-yield-goal]'))}`);
  team.hidden=isQuick||isRush;quick.hidden=!isQuick;rush.hidden=!isRush;field('[data-yield-budget]').hidden=!ordinary;
  run.hidden=isQuick||isRush;rushRun.hidden=!isRush;
  continueActions.hidden=isQuick||isRush||running;
  cancelWrap.hidden=!running||isRush;rushCancelWrap.hidden=!running||!isRush;
  dock.hidden=isQuick;search.hidden=isQuick||isRush;
  set(dockTitle,isRush?'活动曲冲榜':ordinary?`${q('[data-yield-budget]').value} 火 · ${selectedOptionText(q('[data-yield-goal]'))}`:'挑战收益');
  set(dockNote,running?'计算中，可随时停止':isRush?selectedOptionText(q('[data-challenge-opt-scope]')):`${selectedOptionText(q('[data-pool]'))} · ${ordinary?selectedOptionText(q('[data-yield-stages]')):'当前挑战'}`);
  context.hidden=isQuick||isRush||!ordinary;rushSongs.hidden=isQuick||!isRush&&ordinary;
  // Keep current-team editing accessible without rendering another full roster above the result.
  if(state==='running'||state==='results')reference.hidden=true;
  field('[data-yield-stages]').hidden=isQuick||isRush||!ordinary;
  field('[data-yield-starting]').hidden=isQuick||isRush||!ordinary;
  primary.hidden=isQuick||isRush;manual.hidden=true;filters.hidden=isQuick||isRush;actions.hidden=isQuick;
  continuation.hidden=isQuick||isRush||!ordinary||q('[data-yield-stages]').value!=='cycle';
  challengeConditions.hidden=!isRush;
  q('.task-event-toolbar').hidden=true;q('.task-challenge-toolbar').hidden=true;instant.hidden=true;tags.hidden=true;
  empty.hidden=isQuick||isRush||((running||hasResults)&&!conditionsExpanded);
  previewHead.hidden=poolRow.hidden=running||hasResults||q('[data-pool]').value==='selected';
  const inventory=host.teamWorkspaceContext?.inventory,members=inventory?.memberCardIds?.length??0,supports=inventory?.supportCardIds?.length??0;
  set(poolValue,`我的卡库 · ${members} 成员 / ${supports} 留影`);
  const hasTeam=host.draft.slots.filter(slot=>slot.memberCardId&&slot.supportCardId).length===5;
  useCurrent.hidden=!hasTeam;
  set(poolHint,members<5||supports<5?(hasTeam?'已带入完整队伍，可直接切换计算。':'卡库不足 5 位成员与 5 张留影，可管理卡库或编辑队伍。'):'按卡库范围搜索收益方案。');
  previewState.hidden=members>=5&&supports>=5;set(previewState,'待选择卡片范围');
  field('[data-yield-level]').hidden=!ordinary||q('[data-yield-songs]').value==='selected';
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
 // Watch controller-owned state only; do not observe the presentation's own hidden flags.
 for(const n of feedbacks)observer.observe(n,{attributes:true,attributeFilter:['data-state'],childList:true,subtree:true,characterData:true});
 for(const s of ['[data-yield-optimizer]','[data-challenge-optimizer]'])observer.observe(q(s),{attributes:true,attributeFilter:['aria-busy']});
 const dockSize=new ResizeObserver(([entry])=>host.style.setProperty('--event-dock-height',`${Math.ceil(entry.target.getBoundingClientRect().height)}px`));dockSize.observe(dock);
 refresh();return {refresh,destroy(){events.abort();observer.disconnect();dockSize.disconnect();}};
}
