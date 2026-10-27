import {enhanceTaskSwitcher} from './tool-task-switcher.mjs';
import {createCalculationScopeControl} from './calculation-scope-ui.mjs';
import {scopeSummary,chartKey} from './calculation-scope.mjs';
import {applyAPBasis,withAPScoreThresholds,scoreThresholds} from './ap-grade.mjs';
import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {activationRows,playbackDuration} from './skill-activation-model.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {createWorkbenchDialog} from './workbench-dialog.mjs';
import {createCalculationProgress} from './calculation-progress.mjs';
import {selectedControlValues} from './filter-controls.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt=n=>Number.isFinite(n)?Math.round(n).toLocaleString('zh-CN'):'—';
const grade=n=>['D','C','B','A','S','SS'][n-2]??'—';
const select=(name,options)=>{const label=el('label',name),field=el('select');field.setAttribute('aria-label',name);for(const [value,text] of options){const o=el('option',text);o.value=value;field.append(o);}label.append(field);return {label,field};};

/** Single score and fixed-team song comparison share the website's calculators. */
export function setupScoreWorkbenchView(host,{main,aside,conditionBody,current,context,accountButton,tags,adjust}){
 const q=s=>host.querySelector(s),single=q('.score-output'),tabs=el('div',null,'task-subtabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','估分任务');current.before(tabs);
 const singleTab=el('button','单曲估分'),songsTab=el('button','队伍选曲');singleTab.type=songsTab.type='button';tabs.append(singleTab,songsTab);
 enhanceTaskSwitcher(tabs,[{button:singleTab,icon:'score'},{button:songsTab,icon:'songs'}]);
 const performance=q('.task-condition-group'),bonus=accountButton.closest('.task-condition-group');
 const team=el('section',null,'task-condition-group');team.append(el('h3','用于计算的队伍'),el('p','使用上方编成与此次养成。','task-input-note'));const edit=el('button','编辑当前配对');edit.type='button';edit.dataset.openTeamWorkspace='editor';team.append(edit,accountButton);conditionBody.prepend(team);bonus.remove();
 const range=el('section',null,'task-condition-group');range.append(el('h3','选曲范围'));
 const difficulty=select('谱面难度（可多选）',[['expert','EXPERT'],['hard','HARD'],['normal','NORMAL'],['easy','EASY'],['all','全部']]);difficulty.field.multiple=true;difficulty.field.dataset.quick='';difficulty.field.dataset.quickAll='all';difficulty.field.dataset.quickRequired='';difficulty.field.options[0].selected=true;
 const level=select('最高等级',[...Array.from({length:32},(_,i)=>[String(i+8),`Lv.${i+8}`]),['40','不限']]);level.field.value='40';
 range.append(difficulty.label,level.label,el('p','固定这支队伍，按全 Perfect、满生命比较；不改变单曲的发挥设置。','task-input-note'));conditionBody.append(range);
 const shortcut=setupQuickOptions(range);
 const title=el('strong'),caption=el('small'),run=el('button','计算队伍选曲'),cancel=el('button','停止');run.type=cancel.type='button';run.classList.add('event-primary');cancel.hidden=true;
 const songs=el('section',null,'task-song-comparison'),heading=el('header');heading.append(el('div','队伍选曲','task-result-eyebrow'),el('h2','比较这支队伍的可用谱面'));
 const controls=el('div',null,'task-song-table-controls'),basis=select('判档依据',[['expectedScore','平均分'],['minimumScore','最低分'],['maximumScore','最高分']]),sort=select('排序',[['grade','档位优先'],['score','分数优先'],['short','短歌优先']]),search=el('input');search.type='search';search.placeholder='搜索结果中的歌曲';search.setAttribute('aria-label','搜索选曲结果');controls.append(basis.label,sort.label,search);
 const status=el('p','准备好队伍后，计算符合条件的谱面。','task-input-note');status.setAttribute('role','status');const tableWrap=el('div',null,'task-song-table-wrap'),table=el('table'),thead=el('thead'),tr=el('tr');for(const t of ['歌曲 / 谱面','时长','档位','估计分数',''])tr.append(el('th',t));thead.append(tr);const tbody=el('tbody');table.append(thead,tbody);tableWrap.append(table);
 const empty=el('div','计算后可直接比较档位、分数与时长，再带入单曲查看明细。','task-result-empty'),pages=el('footer'),prev=el('button','上一页'),next=el('button','下一页'),pageLabel=el('span');prev.type=next.type='button';pages.append(prev,pageLabel,next);songs.append(heading,controls,tableWrap,empty,pages);single.after(songs);
 const summary=q('.scoring-research-summary');summary.classList.add('task-single-summary');q('[data-scoring-input-status]')?.closest('div')?.setAttribute('hidden','');summary.querySelector('.tool-status')?.remove();
 const score=q('[data-song-score]').closest('div');score.classList.add('task-single-score');score.querySelector('dt').textContent='平均估计分数';const limits=el('div',null,'task-score-limits');score.append(limits);
 const preview=el('div',null,'task-skill-preview');summary.after(preview);
 const detailPanel=createWorkbenchDialog(host,'计分明细');detailPanel.body.append(q('[data-song-score-details]'));const detailButton=el('button','计分明细');detailButton.type='button';detailButton.addEventListener('click',()=>detailPanel.open());
 const actions=el('div',null,'task-score-actions'),toSongs=el('button','这支队伍选曲');toSongs.type='button';toSongs.addEventListener('click',()=>setView('songs'));actions.append(toSongs,q('[data-event-efficiency-link]'));const detailActions=el('div',null,'task-score-detail-actions');detailActions.append(q('[data-skill-activation]'),detailButton);single.append(actions,detailActions);
 // Redundant legacy shortcuts no longer occupy the roster heading.
 for(const links of current.querySelectorAll('.calculator-links'))if(links.querySelector('a[href="#song-result"]'))links.hidden=true;
 const rail=el('aside',null,'ds-condition-rail'),setup=el('details',null,'ds-score-setup'),setupTitle=el('summary','计算条件'),fields=el('div',null,'ds-score-fields');
 aside.hidden=true;tags.hidden=true;main.before(rail);rail.append(setup);setup.append(setupTitle,fields);
 context.querySelector('header small')?.remove();context.querySelector('header > span').textContent='歌曲与难度';
 const profile=q('[data-score-performance-profile]');profile.hidden=false;profile.closest('label').querySelector('.tool-options')?.setAttribute('hidden','');
 fields.append(context,q('[data-scoring-mode]').closest('label'),profile.closest('label'),range);
 const setupActions=el('div',null,'ds-score-setup-actions');adjust.textContent='高级设置';setupActions.append(edit);setup.append(setupActions);
 main.prepend(summary,current);single.prepend(preview);
 host.classList.add('score-builder-view');
 const dock=el('footer',null,'event-action-dock score-action-dock'),dockCopy=el('div',null,'event-action-copy'),dockActions=el('div',null,'event-dock-actions'),calculation=el('section',null,'event-calculation');
 calculation.setAttribute('aria-label','计算状态');calculation.setAttribute('role','status');status.hidden=true;calculation.append(status);
 const feedback=createCalculationProgress(status,'score');
 dockCopy.append(title,caption);dockActions.append(adjust,run,cancel);dock.append(calculation,dockCopy,dockActions);host.append(dock);
 const conditionSummary=el('section',null,'event-condition-summary score-condition-summary'),conditionText=el('span'),modify=el('button','修改条件');modify.type='button';conditionSummary.append(conditionText,modify);main.closest('.task-workbench-shell').before(conditionSummary);
 const states={single:{state:'setup',label:'更换条件后自动估分',collapsed:false},songs:{state:'setup',label:'准备好队伍后，计算符合条件的谱面。',collapsed:false}};
 let expanded=false;
 function updateDock(){
  const state=states[view],running=state.state==='running';
  rail.hidden=state.collapsed&&!expanded;conditionSummary.hidden=!state.collapsed;
  modify.textContent=expanded?'收起条件':'修改条件';modify.setAttribute('aria-expanded',String(!rail.hidden));
  conditionText.textContent=view==='single'?`${host.data.tracks.find(t=>t.id===host.draft.selectedSongId)?.title??'单曲估分'} · ${host.draft.selectedDifficulty?.toUpperCase()??'未选谱面'}`:`队伍选曲 · ${selectedControlValues(difficulty.field).map(d=>d.toUpperCase()).join(' / ')} · ${level.field.selectedOptions[0]?.textContent??'不限'}`;
  if(view==='songs'&&calculationScope)conditionText.textContent+=' · '+calculationScope.summary;
  calculation.hidden=state.state==='setup';if(!calculation.hidden)feedback.update(state);else feedback.reset();
  run.hidden=false;run.disabled=running;cancel.hidden=!running;
  run.textContent=view==='single'?'重新估分':state.state==='setup'?'计算队伍选曲':'重新选曲';
  single.setAttribute('aria-busy',String(states.single.state==='running'));
  songs.setAttribute('aria-busy',String(states.songs.state==='running'));
 }
 function updateCalculation(task,update){
  const previous=states[task];
  if(update.state==='running'&&previous.state!=='running'&&task===view)expanded=false;
  states[task]={...update,collapsed:update.state==='running'||previous.collapsed};updateDock();
 }
 modify.addEventListener('click',()=>{expanded=!expanded;if(expanded)setup.open=true;updateDock();});
 const dockObserver=new ResizeObserver(()=>host.style.setProperty('--event-dock-height',`${dock.getBoundingClientRect().height}px`));dockObserver.observe(dock);
 const desktop=window.matchMedia('(min-width:901px)'),resize=()=>{setup.open=desktop.matches;};desktop.addEventListener('change',resize);resize();
 let calculationScope,resultScope=null;const checkedCharts=new Set();
 let view=new URLSearchParams(location.search).get('view')==='songs'?'songs':'single',worker=null,rows=null,page=0,key='';
 const stop=()=>{worker?.terminate();worker=null;};
 function setView(next){view=next;expanded=false;refresh();const url=new URL(location.href);url.searchParams.set('view',view);history.replaceState(null,'',url);host.taskWorkbench?.refresh();}
 singleTab.addEventListener('click',()=>setView('single'));songsTab.addEventListener('click',()=>setView('songs'));
 function renderRows(){
  const found=(rows??[]).filter(r=>r.title.toLowerCase().includes(search.value.trim().toLowerCase())).map(r=>applyAPBasis(r,basis.field.value));
  found.sort((a,b)=>(sort.field.value==='grade'?b.scoreRank-a.scoreRank:sort.field.value==='score'?b.estimatedScore-a.estimatedScore:0)||(a.seconds??Infinity)-(b.seconds??Infinity)||a.level-b.level);
  const count=Math.max(1,Math.ceil(found.length/10));page=Math.min(page,count-1);tbody.replaceChildren();
  for(const r of found.slice(page*10,page*10+10)){const row=el('tr'),song=el('td'),songTitle=el('strong',r.title);const check=el('input');check.type='checkbox';check.setAttribute('aria-label',`选择 ${r.title} ${r.difficulty}`);check.checked=checkedCharts.has(chartKey(r));check.addEventListener('change',()=>{check.checked?checkedCharts.add(chartKey(r)):checkedCharts.delete(chartKey(r));updateSaveActions();});song.append(check,songTitle,el('small',`${r.difficulty.toUpperCase()} · Lv.${r.level}`));row.append(song,el('td',r.seconds==null?'—':`${fmt(r.seconds)} s`),el('td',grade(r.scoreRank),'task-grade-cell'));const points=el('td');points.append(el('strong',fmt(r.estimatedScore)),el('small',r.nextRank==null?'已达最高档':`距 ${grade(r.nextRank)} 档 ${fmt(r.nextRankGap)}`));const action=el('td'),use=el('button','单曲');use.type='button';use.addEventListener('click',()=>{q('[data-scoring-mode]').value='ordinary';host.shortcuts?.sync();host.songPicker.applySelection({selectedSongId:r.trackId,selectedDifficulty:r.difficulty});setView('single');});action.append(use);row.append(points,action);tbody.append(row);}
  tableWrap.hidden=!found.length;empty.hidden=!!found.length;empty.textContent=rows?'没有符合搜索条件的歌曲。':'计算后可直接比较档位、分数与时长，再带入单曲查看明细。';pages.hidden=!found.length;pageLabel.textContent=`${page+1} / ${count}`;prev.disabled=page===0;next.disabled=page===count-1;updateSaveActions();
 }
 function refresh(){
  const draft=structuredClone(host.draft);delete draft.selectedSongId;delete draft.selectedDifficulty;delete draft.modifiers.performanceScenario;delete draft.modifiers.event;
  calculationScope?.refresh();setupTitle.textContent=view==='songs'&&calculationScope?`计算条件 · ${calculationScope.summary}`:'计算条件';
  const fingerprint=JSON.stringify([draft,selectedControlValues(difficulty.field),level.field.value,calculationScope?.snapshot?.fingerprint??null]);if(key&&key!==fingerprint){stop();rows=null;checkedCharts.clear();resultScope=null;page=0;states.songs={state:'setup',label:'队伍、养成或范围已改变，请重新计算。',collapsed:false};renderRows();}key=fingerprint;
  summary.hidden=preview.hidden=view!=='single';
  profile.closest('label').hidden=q('[data-scoring-mode]').closest('label').hidden=view!=='single';
  if(view==='songs'&&songs.nextElementSibling!==current)current.before(songs);
  host.dataset.scoreView=view;single.hidden=view!=='single';songs.hidden=view!=='songs';range.hidden=view!=='songs';performance.hidden=view!=='single';context.hidden=view!=='single';
  singleTab.setAttribute('aria-pressed',String(view==='single'));songsTab.setAttribute('aria-pressed',String(view==='songs'));title.textContent=view==='single'?'当前条件下的单曲估分':'固定当前队伍，比较歌曲';caption.textContent=view==='single'?'更换队伍、谱面或发挥后，自动重新计算':'按所选难度与等级，逐谱计算 AP 分数和档位';
  const track=host.data.tracks.find(t=>t.id===host.draft.selectedSongId),resultTitle=q('[data-score-result-title]');resultTitle.textContent=track?`${track.title} · ${host.draft.selectedDifficulty?.toUpperCase()??''}`:'选择谱面，查看单曲结果';updateDock();
 }
 calculationScope=createCalculationScopeControl({host,mount:range,data:host.data,toolKey:'score',getFilters:()=>view==='songs'?{difficulty:selectedControlValues(difficulty.field),maxLevel:Number(level.field.value)}:{},onChange:()=>{refresh();}});
 host.calculationScope=calculationScope;
 const saveChecked=el('button','保存勾选谱面为歌单'),saveFiltered=el('button','保存全部筛选结果为歌单'),addChecked=el('button','加入已有歌单');
 for(const b of [saveChecked,saveFiltered,addChecked]){b.type='button';controls.append(b);}
 function updateSaveActions(){const selected=(rows??[]).filter(r=>checkedCharts.has(chartKey(r))).length,filtered=(rows??[]).filter(r=>r.title.toLowerCase().includes(search.value.trim().toLowerCase())).length;saveChecked.disabled=addChecked.disabled=!selected;saveFiltered.disabled=!filtered;saveChecked.textContent=`保存勾选谱面（${selected}）`;saveFiltered.textContent=`保存全部筛选结果（${filtered}）`; }
 const chosen=()=>{const selected=(rows??[]).filter(r=>checkedCharts.has(chartKey(r)));if(!selected.length){status.textContent='请先勾选要保存的谱面。';updateCalculation('songs',{state:'error',label:status.textContent});return null;}return selected;};
 saveChecked.addEventListener('click',()=>{const selected=chosen();if(selected)calculationScope.saveCharts(selected);});
 addChecked.addEventListener('click',()=>{const selected=chosen();if(selected)calculationScope.addCharts(selected);});
 saveFiltered.addEventListener('click',()=>{const selected=(rows??[]).filter(r=>r.title.toLowerCase().includes(search.value.trim().toLowerCase()));if(selected.length)calculationScope.saveCharts(selected);});
 const carry=event=>{const link=event.target.closest?.('a[href]');if(link?.href.includes('/tools/'))calculationScope.carry(link);};host.addEventListener('click',carry);
 run.addEventListener('click',()=>{if(view==='single'){host.refreshInput();return;}if(worker)return;try{
  assertToolTeamCompatible(host.teamWorkspaceContext);if(host.draft.slots.some(s=>!s.memberCardId||!s.supportCardId))throw Error('请先完成五组成员与留影配对。');
  resultScope=calculationScope.require();const candidates=resultScope.candidates;checkedCharts.clear();
  const draft=structuredClone(host.draft);delete draft.modifiers.performanceScenario;delete draft.modifiers.event;
  rows=null;page=0;renderRows();const active=worker=new Worker(new URL('./ap-grade-worker.mjs',import.meta.url),{type:'module'});run.disabled=true;cancel.hidden=false;songs.setAttribute('aria-busy','true');updateCalculation('songs',{state:'running',label:`正在准备 ${candidates.length} 张谱面…`});
  active.addEventListener('message',({data})=>{if(active!==worker)return;if(data.type==='progress'){updateCalculation('songs',{state:'running',label:'正在计算队伍选曲',completed:data.done,total:data.total});return;}stop();if(data.type==='result'){rows=data.rows;updateCalculation('songs',{state:data.failures.length?'error':'complete',label:`${data.failures.length?'选曲结果不完整':'队伍选曲完成'} · ${rows.length} 张谱面`,detail:`${scopeSummary(resultScope)} · AP / 满生命${data.failures.length?`；${data.failures.length} 张失败`:''}`});renderRows();}else updateCalculation('songs',{state:'error',label:data.message});});
  active.addEventListener('error',()=>{if(active!==worker)return;stop();updateCalculation('songs',{state:'error',label:'选曲计算服务加载失败，请重试。'});});active.postMessage({rules:withAPScoreThresholds(host.data.formalRules,host.data.tracks),draft,candidates,mode:'ordinary',eco:false});
 }catch(e){stop();updateCalculation('songs',{state:'error',label:e.message});}});
 cancel.addEventListener('click',()=>{if(view==='single'){host.stopScoreCalculation();return;}stop();updateCalculation('songs',{state:'stopped',label:'已停止选曲计算。'});});for(const field of [difficulty.field,level.field])field.addEventListener('change',()=>{refresh();host.taskWorkbench?.refresh();});
 for(const field of [basis.field,sort.field])field.addEventListener('change',()=>{page=0;renderRows();});search.addEventListener('input',()=>{page=0;renderRows();});prev.addEventListener('click',()=>{page--;renderRows();});next.addEventListener('click',()=>{page++;renderRows();});
 function renderResult(result){
  limits.replaceChildren();preview.replaceChildren();if(!result){return;}
  let scoreLabel=result.performance?'本次回放估计分数':'平均估计分数';if(q('[data-scoring-mode]').value==='ordinary')try{const lines=scoreThresholds(withAPScoreThresholds(host.data.formalRules,host.data.tracks),Number(host.draft.selectedSongId?.split('-').at(-1)));scoreLabel+=` · ${grade(Math.max(...lines.filter(r=>result.expectedScore>=r.score).map(r=>r.rank)))} 档`;}catch{/* Keep the score visible when this release has no grade thresholds. */}score.querySelector('dt').textContent=scoreLabel;
  limits.append(el('span',`最低 ${fmt(result.minimumScore)}`),el('span',`最高 ${fmt(result.maximumScore)}`));
  const playback=result.skillPlayback,variant=playback?.variants?.[0];if(variant){const duration=playbackDuration(playback,variant),track=el('div',null,'task-skill-mini-track');for(const r of activationRows(playback,variant)){const bar=el('i');bar.style.left=`${r.startMs/duration*100}%`;bar.style.width=`${Math.max(1,(r.endMs-r.startMs)/duration*100)}%`;bar.title=`位置 ${r.slotIndex+1} · ${(r.startMs/1000).toFixed(1)}–${(r.endMs/1000).toFixed(1)} s`;track.append(bar);}preview.append(el('span','0:00'),track,el('span',`${Math.floor(duration/60000)}:${String(Math.floor(duration/1000)%60).padStart(2,'0')}`),el('small','一次实际技能顺序的发动窗口；平均分来自多种顺序。'));}
  refresh();
 }
 renderRows();refresh();return {refresh,renderResult,updateSingle:update=>updateCalculation('single',update),destroy(){feedback.destroy();host.removeEventListener('click',carry);calculationScope.destroy();delete host.calculationScope;dockObserver.disconnect();dock.remove();conditionSummary.remove();host.style.removeProperty('--event-dock-height');desktop.removeEventListener('change',resize);stop();shortcut.destroy();detailPanel.close();detailPanel.dialog.remove();}};
}
