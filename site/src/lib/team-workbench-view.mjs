import {enhanceTaskSwitcher} from './tool-task-switcher.mjs';
import {createTeamSearchPlaceholder} from './team-search-placeholder.mjs';
import {planningUiText} from './team-planning-translations.mjs';
import {selectedOptionText} from './tool-quick-options.mjs';

/** Presentation only: readiness, cancellation and results remain owned by the optimizer. */
export function teamWorkbenchState({running=false, finished=false, hasResults=false}={}, feedbackState, comparing=false) {
  if (comparing) return 'compare';
  if (running) return 'running';
  if (feedbackState==='error') return 'error';
  if (feedbackState==='stopped') return 'stopped';
  if (hasResults) return 'results';
  return finished ? 'empty' : 'setup';
}

export function setupTeamWorkbenchView(host, {main, shell, aside, conditionBody, current, context, songRow, songLabel, songButton, tags, adjust}) {
  const q = selector => host.querySelector(selector);
  const ui = text => planningUiText(text, host.data.locale);
  const node = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text!=null) n.textContent=ui(text);
    if (className) n.className=className;
    return n;
  };
  const button = (text, className) => { const n=node('button',text,className); n.type='button'; return n; };
  const setText = (n,text) => { if(n.textContent!==text)n.textContent=text; };
  const events = new AbortController();
  const listen = (n,event,handler) => n.addEventListener(event,handler,{signal:events.signal});
  host.classList.add('team-builder-view');
  const tasks=q('.journey-tasks'), saved=q('[data-journey-task="saved"]');
  const resultStep=q('[data-journey-step="3"]'), results=q('[data-pairing-results]');
  const run=q('[data-optimize-pairing]'), cancel=q('[data-cancel-pairing]');
  const feedback=q('[data-calculation-progress="pairing"]'), progress=q('[data-pairing-progress]');
  const guidance=q('[data-calculator-guidance]'), notes=q('.calculator-notes');
  const workspaceStatus=q('[data-team-workspace-status]');
  const kind=q('[data-planning-kind]'), mode=q('[data-pairing-mode]'), profile=q('[data-performance-profile]');
  let expanded=false, previousState='setup';
  const rail=node('aside',null,'ds-condition-rail');rail.setAttribute('aria-label',ui('计算条件'));shell.prepend(rail);

  // Move the original controls, never copies: saved scenarios and all listeners survive.
  context.classList.add('team-setup');rail.append(context);main.prepend(current);
  context.querySelector('header')?.remove();
  const grid=node('div',null,'team-default-fields');
  const song=node('div',null,'team-song-field');
  song.append(node('span','歌曲与难度','team-field-label'),songRow);
  const cards=node('div',null,'team-card-field'), cardActions=node('div',null,'team-card-actions');
  const manage=button('管理卡库');manage.dataset.openTeamWorkspace='inventory';
  const edit=button('编辑手选队伍');edit.dataset.openTeamWorkspace='editor';
  const planning=button('培养设置');
  cardActions.append(manage,edit,planning);
  const scopeNote=node('small',null,'team-scope-note');
  cards.append(kind.closest('label'),scopeNote,cardActions);
  const modeField=mode.closest('label');modeField.hidden=false;
  grid.append(song,cards,modeField,profile.closest('label'));
  const goals=q('[data-pairing-objective]').closest('.task-condition-group');
  const growth=q('[data-planning-panel]').closest('.task-condition-group');
  goals.classList.add('team-primary-goals');growth.classList.add('team-primary-growth');
  grid.append(goals,growth);
  context.append(node('h2','计算条件','ds-panel-title'),grid);
  if(host.calculationScope){grid.append(q('[data-playlist-task]'));context.append(host.calculationScope.root);}
  q('.journey-choices').hidden=true;
  const footer=node('div',null,'team-setup-actions'), advancedSummary=node('span',null,'team-advanced-summary');
  adjust.textContent=ui('高级设置');adjust.classList.add('team-advanced-entry');
  footer.append(adjust,advancedSummary);context.append(footer,guidance);
  run.textContent=ui('推荐队伍');
  cancel.textContent=ui('停止');
  const dock=node('footer',null,'event-action-dock team-action-dock'),dockCopy=node('div',null,'event-action-copy'),dockTitle=node('strong'),dockNote=node('small'),actions=node('div',null,'event-dock-actions');
  dockCopy.append(dockTitle,dockNote);run.classList.add('event-primary');actions.append(run,cancel);
  const calculation=node('section',null,'event-calculation');
  calculation.setAttribute('aria-label',ui('计算状态'));
  calculation.append(feedback,progress);dock.append(calculation,dockCopy,actions);host.append(dock);
  const pending=createTeamSearchPlaceholder({caption:host.data.locale==='en'?'Your first team will appear here as soon as it is ready.':'首个方案生成后会自动显示。'});main.prepend(workspaceStatus,pending.element);
  const summary=node('section',null,'team-condition-summary'), summaryCopy=node('div'), summarySong=node('strong'), summaryConditions=node('span');
  summaryCopy.append(summarySong,summaryConditions);
  const modify=button('修改条件');summary.append(summaryCopy,modify);shell.before(summary);
  const warning=node('p','修改条件将停止本次计算。','team-edit-warning');context.prepend(warning);
  q('#optimizer-results-title').textContent=ui('推荐队伍');
  const count=node('span',null,'team-result-count');q('#optimizer-results-title').after(count);
  const boundary=node('p','实用推荐 · 不保证全局最优','team-result-boundary');
  results.after(boundary);
  notes.append(q('[data-export-pairing]'));
  q('#optimizer-results').after(notes);
  q('.calculator-start').hidden=true;
  aside.hidden=true;tags.hidden=true;
  enhanceTaskSwitcher(tasks,[
    {button:q('[data-journey-task="automatic"]'),icon:'team'},
    {button:saved,icon:'compare'},
  ]);

  function openAdvanced(target) {
    if(!target||!context.contains(target))adjust.click();
    if(target) {
      // Retain the original controls in the rail or dialog; reveal their target if needed.
      for(let parent=target.parentElement;parent&&parent!==conditionBody;parent=parent.parentElement) {
        if(parent.tagName==='DETAILS')parent.open=true;
      }
      target.scrollIntoView({block:'nearest'});
      [...target.querySelectorAll('select,input,button')].find(n=>!n.disabled&&n.getClientRects().length)?.focus();
    }
  }
  listen(planning,'click',()=>openAdvanced(q(kind.value==='trial'?'[data-planning-trial]':'[data-planning-training]')));
  listen(host,'calculator-edit-planning',()=>openAdvanced(q('[data-planning-training]')));
  listen(modify,'click',()=>{expanded=!expanded;refresh();if(expanded)songButton.focus();});
  listen(tasks,'click',()=>refresh());
  listen(run,'click',()=>{expanded=false;});

  function refresh() {
    const comparing=saved.getAttribute('aria-pressed')==='true';
    for(const step of [0,1,2])q(`[data-journey-step="${step}"]`).hidden=true;
    workspaceStatus.hidden=!host.teamWorkspaceContext?.error;
    setText(cancel,ui('停止'));
    const optimizer=host.optimizerState??{};
    const resultCount=results.querySelectorAll('.recommendation').length;
    const state=teamWorkbenchState({...optimizer,hasResults:resultCount>0},feedback.dataset.state,comparing);
    pending.update({running:optimizer.running,hasResults:resultCount>0,active:!comparing,title:host.data.locale==='en'?'Finding your team':'正在寻找推荐队伍'});
    if(state==='setup'||state==='running'&&previousState!=='running')expanded=false;
    previousState=state;host.dataset.teamView=state;
    context.hidden=rail.hidden=comparing||state!=='setup'&&!expanded;
    summary.hidden=comparing||state==='setup';
    dock.hidden=comparing;
    main.hidden=false;shell.hidden=false;
    current.hidden=!comparing&&state!=='setup';
    resultStep.hidden=comparing;
    calculation.hidden=comparing||state==='setup';
    cancel.hidden=state!=='running';
    warning.hidden=state!=='running'||!expanded;
    guidance.hidden=Boolean(optimizer.ready);
    const isManual=kind.value==='selected'||kind.value==='training'&&q('[data-planning-training-scope]').value==='selected';
    edit.hidden=!isManual;
    planning.hidden=!['training','trial'].includes(kind.value);
    setText(planning,ui(kind.value==='trial'?'选择试用卡':'培养设置'));
    const inventory=host.teamWorkspaceContext?.inventory??host.cardInventory;
    const inventoryCount=host.data.locale==='en'
      ? `${inventory?.memberCardIds?.length??0} members · ${inventory?.supportCardIds?.length??0} memories`
      : `${inventory?.memberCardIds?.length??0} 张成员 · ${inventory?.supportCardIds?.length??0} 张留影`;
    const scope={current:inventoryCount,selected:ui('手选卡片 · 按填写养成'),reference:ui('参考队伍 · 卡片满养成'),training:ui('培养计划 · 不修改卡库'),trial:ui('试用卡 · 不计入持有')};
    setText(scopeNote,scope[kind.value]??'');
    const explicit=q('[data-performance-explicit]').value.trim();
    const custom=explicit||['[data-performance-spread]','[data-performance-miss]','[data-performance-start]','[data-performance-end]'].some(s=>q(s).value!=='')||Number(q('[data-performance-bias]').value)!==0;
    const playlistTask=q('[data-playlist-task] select')?.value==='playlist';song.hidden=playlistTask;const playlistNote=q('.team-playlist-note');if(playlistNote)playlistNote.hidden=!playlistTask;
    setText(summarySong,playlistTask?'歌单逐曲推荐 · 每曲独立队伍':songLabel.textContent);
    setText(summaryConditions,[selectedOptionText(kind),selectedOptionText(mode),ui(explicit?'导入演出记录':custom?'自定义发挥':selectedOptionText(profile)),playlistTask?host.calculationScope?.summary:null].filter(Boolean).join(' · '));
    setText(dockTitle,songLabel.textContent);
    setText(dockNote,summaryConditions.textContent);
    setText(run,state==='setup'||state==='running'?ui('推荐队伍'):host.data.locale==='en'?'Recommend again':'重新推荐');
    const customConstraints=q('[data-search-constraints]').value.trim();
    const limited=customConstraints&&customConstraints!=='{}'||['[data-search-band]','[data-search-attribute]','[data-search-support-attribute]'].some(s=>[...q(s).selectedOptions].some(o=>o.value))||q('[data-planning-window-limit]').value!=='5';
    setText(advancedSummary,[ui(({expected_song_score:'平均分',minimum_song_score:'较低分表现',maximum_song_score:'较高分表现',formation_power:'综合力'})[q('[data-pairing-objective]').value]),ui(limited?'已设编成限制':'不限卡片'),...(custom?[ui('自定义发挥')]:[])].join(' · '));
    setText(modify,ui(expanded?'收起条件':'修改条件'));
    modify.setAttribute('aria-expanded',String(expanded));
    if(!context.id)context.id='team-default-conditions';modify.setAttribute('aria-controls',context.id);
    setText(count,resultCount?(host.data.locale==='en'?`${resultCount} teams`:`${resultCount} 套`):'');
    boundary.hidden=!resultCount;
    q('[data-search-state]').hidden=state==='results'&&q('[data-search-state]').textContent===ui('本次比较完成');
    // Keep actionable failures and incomplete-result warnings visible; move verbose telemetry to the existing details.
    progress.hidden=state==='running'||state==='setup'||state==='error'||state==='results'&&q('[data-search-state]').textContent===ui('本次比较完成');
    if(state==='results'&&!progress.hidden)calculation.hidden=false;
    q('[data-results-empty]').hidden=state!=='setup';
    q('#optimizer-results').hidden=!resultCount;
    q('#optimizer-results-title').closest('header').hidden=!resultCount;
    notes.hidden=state==='running'||state==='error'||!optimizer.finished;
    const help=q('.journey-help');if(help)help.hidden=comparing;
  }
  const observer=new MutationObserver(refresh);
  observer.observe(results,{childList:true});
  observer.observe(feedback,{childList:true,subtree:true,characterData:true});
  const dockSize=new ResizeObserver(([entry])=>host.style.setProperty('--event-dock-height',`${Math.ceil(entry.target.getBoundingClientRect().height)}px`));dockSize.observe(dock);
  refresh();
  return {refresh,destroy(){events.abort();observer.disconnect();dockSize.disconnect();myTeams.remove();}};
}
