import {toolRoute} from './tool-route.mjs';
import {createAccountEditor} from './workbench-account-ui.mjs';
import {createWorkbenchDialog,modalizeDetails,showWorkbenchToast,enhanceNumericInputs} from './workbench-dialog.mjs';
import {createWorkbenchTeamView} from './workbench-team-view.mjs';
import {serializeTeamDraftSearch} from './team-draft.mjs';
import {destroySkillPopover} from './calculator-card-ui.mjs';
import {setupScoreWorkbenchView} from './score-workbench-view.mjs';
import {setupEventWorkbenchView} from './event-workbench-view.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const move=(parent,...nodes)=>nodes.filter(Boolean).forEach(n=>parent.append(n));

/** Layout adapter retains each tool's input nodes, event bindings and calculation engine. */
export function setupTaskWorkbench(host,kind) {
  if(host.taskWorkbench)return host.taskWorkbench;
  const q=s=>host.querySelector(s),nav=el('nav',null,'task-workbench-nav');nav.setAttribute('aria-label','计算任务');
  for(const [id,title,path] of [['team','配队推荐','deck-builder'],['score','估分与选曲','song-calculator'],['event','活动收益','event-efficiency']]){const a=el('a',title);a.href=toolRoute(`/tools/${path}/`,location.pathname);if(id===kind)a.setAttribute('aria-current','page');nav.append(a);}
  const ranking=el('a','歌曲排行榜 ↗');ranking.href=toolRoute('/tools/song-ranking/',location.pathname);ranking.className='task-ranking-link';nav.append(ranking);
  const selectedServer=new URLSearchParams(location.search).get('server');if(selectedServer){const url=new URL(ranking.href);url.searchParams.set('server',selectedServer);ranking.href=url.href;}
  host.classList.add('task-workbench');const studio=host.closest('.tool-studio');studio?.classList.add('task-studio');const pageTitle=studio?.querySelector('.tool-page-heading h1');if(pageTitle)pageTitle.textContent=kind==='team'?'配队推荐':kind==='score'?'估分与选曲':'活动收益';const heading=studio?.querySelector('.tool-page-header-inner');(heading??host).append(nav);nav.querySelector('.task-ranking-link')?.remove();
  const context=el('section',null,'task-context-bar'),songButton=el('button','选择歌曲 / 谱面','task-song-entry'),accountButton=el('button','账号加成');songButton.type=accountButton.type='button';accountButton.className='task-account-entry';
  const songLabel=el('strong','未选谱面');const songHeading=el('header');songHeading.append(el('span','本次谱面'),el('small',kind==='team'?'用于比较推荐编成':kind==='score'?'用于计算当前队伍':'用于活动收益比较'));const songRow=el('div',null,'task-song-row');songRow.append(songLabel,songButton);context.append(songHeading,songRow);host.prepend(context);
  const shell=el('div',null,'task-workbench-shell'),aside=el('aside',null,'task-condition-panel'),main=el('div',null,'task-workbench-main');aside.setAttribute('aria-label','本次计算条件');shell.append(aside,main);context.after(shell);
  const conditionHeader=el('header'),conditionTitle=el('h2','计算条件'),collapse=el('button','收起','task-condition-toggle'),adjust=el('button','调整条件');collapse.type=adjust.type='button';collapse.setAttribute('aria-expanded','true');collapse.setAttribute('aria-label','收起计算条件');collapse.title='向左收起计算条件';conditionHeader.append(conditionTitle,adjust,collapse);aside.append(conditionHeader);
  const conditionBody=el('div',null,'task-condition-body');conditionBody.id=`task-${kind}-condition-body`;collapse.setAttribute('aria-controls',conditionBody.id);aside.append(conditionBody);
  const tags=el('div',null,'task-condition-tags');tags.setAttribute('aria-label','全部计算条件');main.append(tags);
  const appendConditionTag=(label,description,heading)=>{
    const tag=el('span',label,'task-condition-tag'),tip=el('span',null,'task-condition-tooltip');
    tag.tabIndex=0;tip.id=`task-${kind}-condition-tip-${tags.children.length}`;tip.setAttribute('role','tooltip');tag.setAttribute('aria-describedby',tip.id);
    tip.append(el('strong',heading));for(const line of [].concat(description))tip.append(el('span',line));tag.append(tip);
    const position=()=>{delete tag.dataset.dismissed;tag.dataset.tipMeasuring='true';const rect=tag.getBoundingClientRect(),size=tip.getBoundingClientRect();tag.style.setProperty('--tip-offset',`${Math.max(12,Math.min(rect.left,document.documentElement.clientWidth-size.width-12))-rect.left}px`);tag.dataset.tipBelow=String(rect.top<size.height+12);delete tag.dataset.tipMeasuring;};
    tag.addEventListener('mouseenter',position);tag.addEventListener('focus',position);tag.addEventListener('keydown',e=>{if(e.key==='Escape')tag.dataset.dismissed='true';});tags.append(tag);
  };
  const current=el('section',null,'task-current-team');const currentHeader=el('header'),currentTitle=el('div');currentTitle.append(el('small',kind==='score'?'用于估分的队伍':'对照队伍'),el('h2','当前编成'));currentHeader.append(currentTitle);current.append(currentHeader);context.before(current);
  if(kind==='team') {
    const steps=[...host.querySelectorAll('[data-journey-step]')],team=steps[1],settings=steps[2];
    for(const child of [...team.children]) {
      if(child.matches('h3,.journey-intro,.journey-manual,#power-settings'))continue;
      move(child.matches('.calculator-links,[data-team-workspace-status],[data-team-workspace-summary]')?current:conditionBody,child);
    }
    main.prepend(q('.calculator-start'));move(conditionBody,settings);
    move(main,steps[3],q('.journey-saved'));const subTasks=q('.journey-tasks');if(subTasks){subTasks.classList.add('task-subtabs');current.before(subTasks);}
    steps[0].hidden=true;team.hidden=true;
    q('.journey-heading')?.setAttribute('hidden','');
  } else if(kind==='score') {
    const saved=q('.tool-saved-team');if(saved){saved.querySelector('h2')?.remove();move(current,...saved.childNodes);}
    for(const selector of ['[data-scoring-mode]','[data-score-performance-profile]'])move(conditionBody,q(selector)?.closest('label'));
    move(conditionBody,q('[data-performance-settings]'),q('[data-gekisou-scenario]'));move(main,q('.score-output'));
    for(const node of [...host.querySelectorAll(':scope > .tool-help,:scope > .scoring-snapshot-details')])main.append(node);
    q('.score-preparation')?.setAttribute('hidden','');
  } else {
    move(conditionBody,q('.tool-task-tabs'),q('.event-context'),q('[data-mode-hint]'));
    const team=q('#event-team'),yieldPanel=q('[data-yield-optimizer]');
    for(const child of [...team.children]) {
      if(child.matches('.event-panel-heading'))continue;
      if(child===yieldPanel) {
        const yieldConditions=el('section',null,'task-event-yield-conditions');conditionBody.append(yieldConditions);
        for(const node of [...yieldPanel.children])move(node.matches('[data-yield-results],[data-yield-status],[data-calculation-progress]')?main:yieldConditions,node);
      }else move(child.matches('[data-team-workspace-summary],[data-team-workspace-status]')||child.querySelector?.('[data-open-team-workspace="teams"]')?current:conditionBody,child);
    }
    move(main,q('.event-summary'),q('#event-results'),q('#event-song'),q('.event-footnote'));
    q('.event-layout')?.setAttribute('hidden','');
  }
  // Match the accepted prototype's task groups while retaining the original fields.
  const group=(title)=>{const section=el('section',null,'task-condition-group');section.append(el('h3',title));conditionBody.append(section);return section;};
  if(kind==='team') {
    const goal=group('推荐目标'),cards=group('卡片与养成'),performance=group('演出与发挥'),limits=group('编成限制');
    const objective=q('[data-pairing-objective]')?.closest('label');move(goal,objective,q('[data-recommendation-goal]')?.closest('label'));
    const objectiveLabels=['平均分','最低分','最高分','综合力'];objective?.querySelectorAll('.tool-options button').forEach((b,i)=>b.querySelector('span').textContent=objectiveLabels[i]);
    move(cards,q('[data-planning-panel]'));cards.append(accountButton);
    move(performance,q('.journey-choices'),q('[data-performance-panel]'),q('[data-gekisou-rank-note]'),q('[data-gekisou-settings]'));
    move(limits,q('.journey-advanced'));
    for(const n of [...conditionBody.children])if(!n.classList.contains('task-condition-group')){if(n.matches('[data-search-scope-hint]'))cards.append(n);else if(n.matches('[data-journey-step="2"]'))n.hidden=true;else if(n.matches('.journey-choices,.journey-next,.journey-back'))n.hidden=true;else limits.append(n);}
  } else {const existing=[...conditionBody.children];if(kind==='score'){const performance=group('演出与发挥');move(performance,...existing);}else {const activity=group('活动与阶段'),planning=group('收益与推荐'),manual=group('加成与稳定评分');planning.classList.add('task-event-planning-group');for(const n of existing){if(n.matches('.tool-task-tabs')){n.classList.add('task-subtabs');current.before(n);}else move(n.matches('.event-context,[data-mode-hint]')?activity:planning,n);}move(manual,q('.event-quick-bonus'));const run=q('[data-yield-run]')?.parentElement;if(run){const toolbar=el('div',null,'calculator-start task-event-toolbar');toolbar.append(el('p','准备好条件后，比较队伍与歌曲的整份预算收益。'),run);main.prepend(toolbar);run.classList.add('optimizer-actions');}q('[data-suggest]')?.setAttribute('hidden','');}const bonusGroup=group('账号加成');bonusGroup.append(accountButton);}
  for(const actions of current.querySelectorAll('.calculator-links,.tool-saved-actions,.event-controls:has([data-open-team-workspace="teams"])'))currentHeader.append(actions);
  const summary=current.querySelector('[data-team-workspace-summary],[data-score-team]');if(summary)summary.classList.add('task-current-roster');const actions=currentHeader.querySelector('.calculator-links,.tool-saved-actions,.event-controls');if(actions){const edit=el('button','编辑配对');edit.type='button';edit.dataset.openTeamWorkspace='editor';actions.prepend(edit);actions.querySelector('[data-open-team-workspace="teams"]')?.replaceChildren(document.createTextNode('更换队伍'));}
  const searchNotes=q('.calculator-notes');if(searchNotes)move(searchNotes,q('[data-practical-progress]'),q('[data-practical-summary]'));
  const songDetails=q('[data-score-song-picker],[data-song-disclosure]'),picker=q('[data-song-picker]');
  const songPanel=createWorkbenchDialog(host,'选择歌曲与谱面',{className:'task-song-dialog',onClose:()=>{delete picker?.pendingSelection;host.songPicker?.sync();}});
  move(songPanel.body,picker);if(songDetails)songDetails.hidden=true;else q('[data-journey-step="0"]')?.setAttribute('hidden','');
  if(picker){
    const extra=picker.querySelector('.filter-drawer-body'),drawer=picker.querySelector('filter-drawer');
    if(extra){const inline=el('div',null,'task-song-extra-filters');move(inline,...extra.childNodes);picker.querySelector('.selection-quick')?.append(inline);if(drawer)drawer.hidden=true;}
    const strip=el('div',null,'task-level-strip');strip.append(el('span','等级'));
    const levels=[...new Set([...picker.querySelectorAll('[data-song-choice]')].filter(b=>!b.disabled).map(b=>Number(b.dataset.level)))].sort((a,b)=>a-b);
    for(const [label,min,max] of [['不限','',''],['≤20','',20],['21–25',21,25],['26–30',26,30],['31+',31,'']]){const b=el('button',label);b.type='button';b.addEventListener('click',()=>{for(const [key,value] of [['min',min],['max',max]]){const input=picker.querySelector(`[data-song-${key}]`);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}});strip.append(b);}
    const exact=el('select');exact.setAttribute('aria-label','指定谱面等级');const all=el('option','指定等级');all.value='';exact.append(all);for(const level of levels){const o=el('option',`Lv.${level}`);o.value=level;exact.append(o);}exact.addEventListener('change',()=>{for(const key of ['min','max']){const field=picker.querySelector(`[data-song-${key}]`);field.value=exact.value;field.dispatchEvent(new Event('input',{bubbles:true}));}});strip.append(exact);picker.querySelector('.selection-quick')?.append(strip);
  }
  const songActions=el('footer'),cancelSong=el('button','取消'),applySong=el('button','使用这张谱面');cancelSong.type=applySong.type='button';songActions.append(cancelSong,applySong);songPanel.dialog.append(songActions);
  if(picker)picker.stageSelection=selection=>{picker.pendingSelection=selection;host.songPicker?.sync();};
  cancelSong.addEventListener('click',()=>songPanel.close());applySong.addEventListener('click',()=>{if(!picker?.pendingSelection){showWorkbenchToast('先选择一张谱面');return;}if(kind==='event'&&host.dataset.task==='team')q('[data-yield-songs]').value='selected';host.songPicker?.applySelection(picker.pendingSelection);songPanel.close();showWorkbenchToast('已更新歌曲与谱面');});
  songButton.addEventListener('click',()=>{delete picker?.pendingSelection;host.songPicker?.sync();songPanel.open();});
  const commitAccount=modifiers=>{
    host.teamWorkspaceContext?.invalidate?.();host.draft.modifiers=modifiers;
    if(kind==='team')host.commit();else if(kind==='score')host.refreshInput();else host.render();refresh();
  };
  const account=createAccountEditor(host,commitAccount);accountButton.addEventListener('click',()=>account.open());
  const conditions=createWorkbenchDialog(host,'调整计算条件',{className:'task-conditions-dialog',onClose:()=>{move(aside,conditionBody);conditionBody.hidden=shell.classList.contains('task-conditions-collapsed');refresh();}});
  adjust.addEventListener('click',()=>{conditionBody.hidden=false;conditions.body.append(conditionBody);conditions.open();});
  collapse.addEventListener('click',()=>{const closed=shell.classList.toggle('task-conditions-collapsed');collapse.textContent=closed?'›':'收起';collapse.setAttribute('aria-expanded',String(!closed));collapse.setAttribute('aria-label',closed?'展开计算条件':'收起计算条件');collapse.title=closed?'展开计算条件':'向左收起计算条件';conditionBody.hidden=closed;});
  const view=kind==='score'?setupScoreWorkbenchView(host,{main,conditionBody,current,context,accountButton,tags}):kind==='event'?setupEventWorkbenchView(host,{main,conditionBody,current,context,songRow,songLabel,songButton,accountButton,tags}):null;if(kind==='score')host.scoreView=view;
  const conditionSelector='select,input:not([type=file]):not([type=search]),textarea',conditionFields=new Set([...conditionBody.querySelectorAll(conditionSelector),...(kind==='event'?[...context.querySelectorAll(conditionSelector),q('[data-yield-basis]')]:[])]);
  for(const details of host.querySelectorAll('[data-performance-settings],[data-performance-panel] > details,[data-gekisou-scenario],[data-gekisou-settings],.tool-help,.scoring-snapshot-details,.journey-help,.calculator-notes'))modalizeDetails(host,details);
  enhanceNumericInputs(conditionBody);
  function refresh() {
    const draft=host.draft,track=host.data.tracks?.find(t=>t.id===draft.selectedSongId);songLabel.textContent=track?`${track.title} · ${draft.selectedDifficulty?.toUpperCase()??'未选难度'}`:'未选谱面';songButton.textContent=track?'更换谱面 ›':'选择歌曲 / 谱面';songRow.querySelector('.task-song-cover')?.remove();const jacket=track&&picker?.querySelector(`[data-song-row="${track.id}"] .song-picker-jacket`);if(jacket){const cover=jacket.cloneNode();cover.className='task-song-cover';cover.alt='';songRow.prepend(cover);}
    view?.refresh();
    for(const link of nav.querySelectorAll('a:not(.task-ranking-link)')){const url=new URL(link.href);url.search=serializeTeamDraftSearch(draft);const server=new URLSearchParams(location.search).get('server');if(server)url.searchParams.set('server',server);link.href=url.href;}
    if(kind==='score')q('[data-score-team]')?.replaceChildren(createWorkbenchTeamView(host,draft));
    tags.replaceChildren();
    const entries=[],explicitPerformance=q('[data-performance-mode]')?.value==='explicit',savedPerformance=draft.modifiers?.performanceScenario;
    for(const field of [...conditionBody.querySelectorAll(conditionSelector),...(kind==='event'?[...context.querySelectorAll(conditionSelector),q('[data-yield-basis]')]:[])])conditionFields.add(field);
    for(const field of conditionFields) {
      if(!field.isConnected){conditionFields.delete(field);continue;}
      if(kind==='event'){
        const task=host.dataset.task;
        const active=task==='quick'?'[data-event],[data-mode],[data-boost],[data-cost],[data-manual-bonus],[data-manual-point-bonus],[data-rank]':task==='challenge'?'[data-event],[data-cost],[data-challenge-opt-scope],[data-challenge-opt-objective],[data-challenge-opt-rewards],[data-challenge-opt-reward-growth]':'[data-event],[data-mode],[data-boost],[data-cost],[data-pool],[data-yield-goal],[data-yield-stages],[data-yield-budget],[data-yield-starting],[data-yield-basis],[data-yield-songs],[data-yield-difficulty],[data-yield-level],[data-yield-band],[data-yield-attribute],[data-yield-depth],[data-yield-eco],[data-yield-challenge-scope],[data-yield-challenge-basis],[data-yield-challenge-difficulty],[data-yield-challenge-level],[data-yield-rewards],[data-yield-reward-growth]';
        if(!field.matches(active))continue;
        if(field.matches('[data-yield-reward-growth]')&&!q('[data-yield-rewards]').checked||field.matches('[data-challenge-opt-reward-growth]')&&(!q('[data-challenge-opt-rewards]').checked||q('[data-challenge-opt-scope]').value==='reference'))continue;
        if(field.matches('[data-yield-challenge-scope],[data-yield-challenge-basis],[data-yield-challenge-difficulty],[data-yield-challenge-level]')&&(q('[data-mode]').value!=='ordinary'||q('[data-yield-stages]').value!=='cycle'))continue;
      }
      const label=field.closest('label'),hidden=field.parentElement.closest('[hidden]');
      const opponents=field.closest('[data-gekisou-opponent]');if(opponents&&!opponents.querySelector('[data-opponent-enabled]')?.checked)continue;
      if(!label||label.hidden||hidden&&hidden!==conditionBody&&(conditionBody.contains(hidden)||context.contains(hidden))||field.disabled||field.type==='checkbox'&&!field.checked)continue;
      if(field.matches('[data-gekisou-rank],[data-gekisou-offset],[data-gekisou-batches],[data-gekisou-seed],[data-gekisou-fps],[data-opponent-field],[data-opponent-enabled]')&&q('[data-pairing-mode],[data-scoring-mode]')?.value!=='gekisou')continue;
      if(field.matches('[data-pairing-mode],[data-scoring-mode]'))continue;
      if(field.matches('[data-performance-mode]')&&!explicitPerformance)continue;
      if(field.matches('[data-performance-json]')&&!explicitPerformance)continue;
      if(field.matches('[data-score-performance-profile]')&&explicitPerformance)continue;
      if(field.closest('[data-planning-card-locks]')&&!field.value)continue;
      const copy=label.cloneNode(true);copy.querySelectorAll('input,select,textarea,button,.tool-options,.tw-card-view').forEach(n=>n.remove());
      let name=copy.textContent.trim().replace(/\s+/g,' '),value=field.tagName==='SELECT'?field.selectedOptions[0]?.textContent:field.type==='checkbox'?'开启':field.tagName==='TEXTAREA'?field.value.trim()&&field.value.trim()!=='{}'?'自定义':'默认':field.value||'默认';
      if(field.matches('[data-score-performance-profile]')){name='发挥';if(field.value==='saved')value=({steady:'参考发挥',practice:'练习中的发挥',ideal:'理想发挥'})[savedPerformance?.profile]??(savedPerformance?'保存的发挥情景':'全 Perfect、满生命参考');}
      if(name){let group=field.matches('[data-gekisou-rank]')?'激奏名次':field.matches('[data-opponent-field],[data-opponent-enabled]')?'对手条件':field.matches('[data-gekisou-batches],[data-gekisou-seed],[data-gekisou-fps]')?'激奏抽样':field.matches('[data-performance-bias],[data-performance-spread],[data-performance-miss],[data-performance-start],[data-performance-end],[data-performance-explicit]')?'精细发挥':field.matches('[data-planning-variant-limit],[data-planning-window-limit]')?'搜索设置':field.closest('[data-planning-card-locks]')?'固定卡片':'';entries.push([name,value,group]);}
    }
    const mods=draft.modifiers??{};const accountSummary=`乐器 ${Object.keys(mods.bandItems??{}).length} 件 · 评级 ${Object.keys(mods.characterRanks??{}).length} 位 · TGW ${mods.tgwCardRank??1}`;accountButton.replaceChildren(el('span','账号加成'),el('small',accountSummary));const server=document.querySelector('.context-switcher summary')?.textContent.trim().replace(/\s+/g,' ');if(server)entries.unshift(['区服与语言',server]);if(track&&(kind!=='score'||host.dataset.scoreView!=='songs')&&(kind!=='event'||host.dataset.task!=='quick'))entries.unshift(['歌曲',track.title],['谱面',draft.selectedDifficulty?.toUpperCase()??'未选难度']);if((kind!=='event'||host.dataset.task!=='quick')&&mods.planningScenario?.scope==='reference')entries.push(['养成','满养成参考']);if(kind!=='event'||host.dataset.task!=='quick')entries.push(['TGW',`Lv.${mods.tgwCardRank??1}`],['乐器',`${Object.keys(mods.bandItemTotals??{}).length? '总等级 / ':''}${Object.keys(mods.bandItems??{}).length} 件记录`],['角色评级',`${Object.keys(mods.characterRanks??{}).length} 位`],['回忆',`${Object.keys(mods.memoryPoints??{}).length} 位`]);
    const mode=q('[data-pairing-mode],[data-scoring-mode]');if(mode)entries.unshift(['演出',kind==='score'&&host.dataset.scoreView==='songs'?'普通 · AP':mode.value==='gekisou'?'激奏':'普通']);
    const short=(value,max)=>String(value).length>max?String(value).slice(0,max-1)+'…':String(value);
    if(kind==='event'){
      const groups=new Map();
      const add=(group,name,value)=>{if(!groups.has(group))groups.set(group,[]);groups.get(group).push(`${name}：${value}`);};
      for(const [name,value] of entries){
        if(['区服与语言','歌曲','谱面'].includes(name))continue;
        const group=name==='活动'||name==='演出类型'||name==='每次耗火'||name==='每次挑战消耗'?'活动':/加成|稳定|评分/.test(name)?'加成与评分':/预算|已有挑战/.test(name)?'预算':/从哪里选卡|搜索范围|养成/.test(name)?'队伍':/目标|档位估算|计算阶段/.test(name)?'计算目标':/歌曲|乐队|属性|难度|等级/.test(name)?'选曲条件':/TGW|乐器|角色评级|回忆/.test(name)?'账号加成':'搜索设置';
        add(group,name,value);
      }
      const selected=s=>q(s)?.selectedOptions?.[0]?.textContent;
      const mode=q('[data-mode]').value;
      const summaries={
        '活动':`${mode==='challenge'?'挑战':'普通'} · ${mode==='challenge'?q('[data-cost]').value+' pt':q('[data-boost]').value+' 火'}`,
        '加成与评分':`道具 +${q('[data-manual-bonus]').value}% · pt +${q('[data-manual-point-bonus]').value}%`,
        '队伍':host.dataset.task==='challenge'?selected('[data-challenge-opt-scope]'):selected('[data-pool]'),
        '计算目标':host.dataset.task==='challenge'?selected('[data-challenge-opt-objective]'):selected('[data-yield-goal]'),
        '预算':`${q('[data-yield-budget]').value} 火 · CP ${q('[data-yield-starting]').value}`,
        '选曲条件':q('[data-yield-songs]').value==='selected'?`指定谱面 · ${(draft.selectedDifficulty??'expert').toUpperCase()}`:`自动选曲 · ${selected('[data-yield-difficulty]')}`,
        '账号加成':Object.keys(mods.bandItems??{}).length||Object.keys(mods.characterRanks??{}).length||Object.keys(mods.memoryPoints??{}).length||(mods.tgwCardRank??1)>1?'账号加成':'账号默认',
      };
      for(const [name,values] of groups)appendConditionTag(short(summaries[name]??name,22),values,name);
      return;
    }
    const grouped=new Map();for(const [name,value,group] of entries){if(group){if(!grouped.has(group))grouped.set(group,[]);grouped.get(group).push(`${name}：${value}`);}else {const shortValue=name==='游戏显示的道具加成（%）'?`道具 +${value}%`:name==='游戏显示的活动 pt 加成（%）'?`活动 pt +${value}%`:name==='方案耗火预算'?`预算 ${value} 火`:name==='已有挑战 pt'?`已有 CP ${value}`:name==='TGW'?`TGW ${value}`:name==='乐器'?`乐器 ${value}`:name==='角色评级'?`评级 ${value}`:name==='回忆'?`回忆 ${value}`:name==='搜索约束'&&value==='默认'?'无额外约束':name==='优化目标'?({'expected_song_score':'平均分','minimum_song_score':'最低分','maximum_song_score':'最高分','formation_power':'综合力'}[q('[data-pairing-objective]')?.value]??value):value;appendConditionTag(short(shortValue,16),`${name}：${value}`,name);}}for(const [name,values] of grouped)appendConditionTag(name==='激奏名次'?values.map(v=>v.split('：').at(-1)).join('/')+' 名':name==='精细发挥'?'精细发挥':name,values,name);
  }
  const statusObserver=new MutationObserver(records=>{for(const record of records){const status=record.target.nodeType===1?record.target:record.target.parentElement;if(status?.matches('[data-team-workspace-status],[data-performance-status],[data-manual-growth-status]')||status?.matches('[data-yield-status],[data-pairing-progress],[data-team-status]')&&/完成|失败|已停止/.test(status.textContent))showWorkbenchToast(status.textContent);}});
  statusObserver.observe(host,{subtree:true,childList:true,characterData:true});
  const detailObserver=new MutationObserver(records=>{for(const record of records)for(const n of record.addedNodes){if(n.nodeType!==1)continue;for(const d of [...(n.matches('details.recommendation-details,details.skill-activation')?[n]:[]),...n.querySelectorAll('details.recommendation-details,details.skill-activation')])modalizeDetails(host,d);}for(const entry of host.taskDetailPanels??[])if(!entry.details.isConnected)entry.destroy();});
  detailObserver.observe(host,{subtree:true,childList:true});
  const update=()=>refresh();host.addEventListener('change',update);host.addEventListener('optimizer-ui-state',update);const onDraft=e=>{if(e.detail.context?.host===host)refresh();};document.addEventListener('team-workspace:draft',onDraft);
  const readyObserver=new MutationObserver(refresh);readyObserver.observe(host,{attributes:true,attributeFilter:['hidden']});
  refresh();host.taskWorkbench={refresh,destroy(){view?.destroy();nav.remove();studio?.classList.remove('task-studio');destroySkillPopover(host);statusObserver.disconnect();detailObserver.disconnect();readyObserver.disconnect();for(const entry of host.taskDetailPanels??[])entry.destroy();host.removeEventListener('change',update);host.removeEventListener('optimizer-ui-state',update);document.removeEventListener('team-workspace:draft',onDraft);}};return host.taskWorkbench;
}
