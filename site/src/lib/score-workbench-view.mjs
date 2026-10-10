import {eventSongCandidates} from './event-song-ranking.mjs';
import {applyAPBasis,withAPScoreThresholds,scoreThresholds} from './ap-grade.mjs';
import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {activationRows,playbackDuration} from './skill-activation-model.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {createWorkbenchDialog} from './workbench-dialog.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt=n=>Number.isFinite(n)?Math.round(n).toLocaleString('zh-CN'):'—';
const grade=n=>['D','C','B','A','S','SS'][n-2]??'—';
const select=(name,options)=>{const label=el('label',name),field=el('select');field.setAttribute('aria-label',name);for(const [value,text] of options){const o=el('option',text);o.value=value;field.append(o);}label.append(field);return {label,field};};

/** Single score and fixed-team song comparison share the website's calculators. */
export function setupScoreWorkbenchView(host,{main,conditionBody,current,context,accountButton,tags}){
 const q=s=>host.querySelector(s),single=q('.score-output'),tabs=el('div',null,'task-subtabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','估分任务');current.before(tabs);
 const singleTab=el('button','单曲估分'),songsTab=el('button','队伍选曲');singleTab.type=songsTab.type='button';tabs.append(singleTab,songsTab);
 const performance=q('.task-condition-group'),bonus=accountButton.closest('.task-condition-group');
 const team=el('section',null,'task-condition-group');team.append(el('h3','用于计算的队伍'),el('p','使用上方编成与此次养成。','task-input-note'));const edit=el('button','编辑当前配对');edit.type='button';edit.dataset.openTeamWorkspace='editor';team.append(edit,accountButton);conditionBody.prepend(team);bonus.remove();
 const range=el('section',null,'task-condition-group');range.append(el('h3','选曲范围'));
 const difficulty=select('谱面难度',[['expert','EXPERT'],['hard','HARD'],['normal','NORMAL'],['easy','EASY'],['all','全部']]);difficulty.field.dataset.quick='';
 const level=select('最高等级',[...Array.from({length:32},(_,i)=>[String(i+8),`Lv.${i+8}`]),['40','不限']]);level.field.value='40';
 range.append(difficulty.label,level.label,el('p','固定这支队伍，按全 Perfect、满生命比较；不改变单曲的发挥设置。','task-input-note'));conditionBody.append(range);
 const shortcut=setupQuickOptions(range);
 const toolbar=el('div',null,'calculator-start task-score-toolbar'),intro=el('div'),title=el('strong'),caption=el('small'),run=el('button','计算队伍选曲'),cancel=el('button','停止');run.type=cancel.type='button';cancel.hidden=true;intro.append(title,caption);toolbar.append(intro,run,cancel);main.insertBefore(toolbar,tags);
 const songs=el('section',null,'task-song-comparison'),heading=el('header');heading.append(el('div','队伍选曲','task-result-eyebrow'),el('h2','比较这支队伍的可用谱面'));
 const controls=el('div',null,'task-song-table-controls'),basis=select('判档依据',[['expectedScore','平均分'],['minimumScore','最低分'],['maximumScore','最高分']]),sort=select('排序',[['grade','档位优先'],['score','分数优先'],['short','短歌优先']]),search=el('input');search.type='search';search.placeholder='搜索结果中的歌曲';search.setAttribute('aria-label','搜索选曲结果');controls.append(basis.label,sort.label,search);
 const status=el('p','准备好队伍后，计算符合条件的谱面。','task-input-note');status.setAttribute('role','status');const tableWrap=el('div',null,'task-song-table-wrap'),table=el('table'),thead=el('thead'),tr=el('tr');for(const t of ['歌曲 / 谱面','时长','档位','估计分数',''])tr.append(el('th',t));thead.append(tr);const tbody=el('tbody');table.append(thead,tbody);tableWrap.append(table);
 const empty=el('div','计算后可直接比较档位、分数与时长，再带入单曲查看明细。','task-result-empty'),pages=el('footer'),prev=el('button','上一页'),next=el('button','下一页'),pageLabel=el('span');prev.type=next.type='button';pages.append(prev,pageLabel,next);songs.append(heading,controls,status,tableWrap,empty,pages);single.after(songs);
 const summary=q('.scoring-research-summary');summary.classList.add('task-single-summary');q('[data-scoring-input-status]')?.closest('div')?.setAttribute('hidden','');summary.querySelector('.tool-status')?.remove();
 const score=q('[data-song-score]').closest('div');score.classList.add('task-single-score');score.querySelector('dt').textContent='平均估计分数';const limits=el('div',null,'task-score-limits');score.append(limits);
 const preview=el('div',null,'task-skill-preview');summary.after(preview);
 const detailPanel=createWorkbenchDialog(host,'计分明细');detailPanel.body.append(q('[data-song-score-details]'));const detailButton=el('button','计分明细');detailButton.type='button';detailButton.addEventListener('click',()=>detailPanel.open());
 const actions=el('div',null,'task-score-actions'),toSongs=el('button','这支队伍选曲');toSongs.type='button';toSongs.addEventListener('click',()=>setView('songs'));actions.append(toSongs,q('[data-event-efficiency-link]'));const detailActions=el('div',null,'task-score-detail-actions');detailActions.append(q('[data-skill-activation]'),detailButton);single.append(actions,detailActions);
 // Redundant legacy shortcuts no longer occupy the roster heading.
 for(const links of current.querySelectorAll('.calculator-links'))if(links.querySelector('a[href="#song-result"]'))links.hidden=true;
 let view=new URLSearchParams(location.search).get('view')==='songs'?'songs':'single',worker=null,rows=null,page=0,key='';
 const stop=()=>{worker?.terminate();worker=null;run.disabled=false;cancel.hidden=true;songs.removeAttribute('aria-busy');};
 function setView(next){view=next;refresh();const url=new URL(location.href);url.searchParams.set('view',view);history.replaceState(null,'',url);host.taskWorkbench?.refresh();}
 singleTab.addEventListener('click',()=>setView('single'));songsTab.addEventListener('click',()=>setView('songs'));
 function renderRows(){
  const found=(rows??[]).filter(r=>r.title.toLowerCase().includes(search.value.trim().toLowerCase())).map(r=>applyAPBasis(r,basis.field.value));
  found.sort((a,b)=>(sort.field.value==='grade'?b.scoreRank-a.scoreRank:sort.field.value==='score'?b.estimatedScore-a.estimatedScore:0)||(a.seconds??Infinity)-(b.seconds??Infinity)||a.level-b.level);
  const count=Math.max(1,Math.ceil(found.length/10));page=Math.min(page,count-1);tbody.replaceChildren();
  for(const r of found.slice(page*10,page*10+10)){const row=el('tr'),song=el('td'),songTitle=el('strong',r.title);song.append(songTitle,el('small',`${r.difficulty.toUpperCase()} · Lv.${r.level}`));row.append(song,el('td',r.seconds==null?'—':`${fmt(r.seconds)} s`),el('td',grade(r.scoreRank),'task-grade-cell'));const points=el('td');points.append(el('strong',fmt(r.estimatedScore)),el('small',r.nextRank==null?'已达最高档':`距 ${grade(r.nextRank)} 档 ${fmt(r.nextRankGap)}`));const action=el('td'),use=el('button','单曲 ↗');use.type='button';use.addEventListener('click',()=>{q('[data-scoring-mode]').value='ordinary';host.shortcuts?.sync();host.songPicker.applySelection({selectedSongId:r.trackId,selectedDifficulty:r.difficulty});setView('single');});action.append(use);row.append(points,action);tbody.append(row);}
  tableWrap.hidden=!found.length;empty.hidden=!!found.length;empty.textContent=rows?'没有符合搜索条件的歌曲。':'计算后可直接比较档位、分数与时长，再带入单曲查看明细。';pages.hidden=!found.length;pageLabel.textContent=`${page+1} / ${count}`;prev.disabled=page===0;next.disabled=page===count-1;
 }
 function refresh(){
  const draft=structuredClone(host.draft);delete draft.selectedSongId;delete draft.selectedDifficulty;delete draft.modifiers.performanceScenario;delete draft.modifiers.event;
  const fingerprint=JSON.stringify([draft,difficulty.field.value,level.field.value]);if(key&&key!==fingerprint){stop();rows=null;page=0;status.textContent='队伍、养成或范围已改变，请重新计算。';renderRows();}key=fingerprint;
  host.dataset.scoreView=view;single.hidden=view!=='single';songs.hidden=view!=='songs';range.hidden=view!=='songs';performance.hidden=view!=='single';context.hidden=view!=='single';run.hidden=view!=='songs';cancel.hidden=!worker||view!=='songs';
  singleTab.setAttribute('aria-pressed',String(view==='single'));songsTab.setAttribute('aria-pressed',String(view==='songs'));title.textContent=view==='single'?'当前条件下的单曲估分':'固定当前队伍，比较歌曲';caption.textContent=view==='single'?'更换队伍、谱面或发挥后，自动重新计算':'按所选难度与等级，逐谱计算 AP 分数和档位';
  const track=host.data.tracks.find(t=>t.id===host.draft.selectedSongId),resultTitle=q('[data-score-result-title]');resultTitle.textContent=track?`${track.title} · ${host.draft.selectedDifficulty?.toUpperCase()??''}`:'选择谱面，查看单曲结果';
 }
 run.addEventListener('click',()=>{if(worker)return;try{
  assertToolTeamCompatible(host.teamWorkspaceContext);if(host.draft.slots.some(s=>!s.memberCardId||!s.supportCardId))throw Error('请先完成五组成员与留影配对。');
  const candidates=eventSongCandidates({...host.data,difficulty:difficulty.field.value,maxLevel:Number(level.field.value)});if(!candidates.length)throw Error('没有符合条件的可计算谱面。');
  const draft=structuredClone(host.draft);delete draft.modifiers.performanceScenario;delete draft.modifiers.event;
  rows=null;page=0;renderRows();const active=worker=new Worker(new URL('./ap-grade-worker.mjs',import.meta.url),{type:'module'});run.disabled=true;cancel.hidden=false;songs.setAttribute('aria-busy','true');status.textContent=`正在准备 ${candidates.length} 张谱面…`;
  active.addEventListener('message',({data})=>{if(active!==worker)return;if(data.type==='progress'){status.textContent=`正在计算 ${data.done} / ${data.total} 张谱面…`;return;}stop();if(data.type==='result'){rows=data.rows;status.textContent=`已计算 ${rows.length} 张谱面 · AP / 满生命 · 120 种技能顺序${data.failures.length?`；${data.failures.length} 张失败，结果不完整`:''}`;renderRows();}else status.textContent=data.message;});
  active.addEventListener('error',()=>{if(active!==worker)return;stop();status.textContent='选曲计算服务加载失败，请重试。';});active.postMessage({rules:withAPScoreThresholds(host.data.formalRules,host.data.tracks),draft,candidates,mode:'ordinary',eco:true});
 }catch(e){stop();status.textContent=e.message;}});
 cancel.addEventListener('click',()=>{stop();status.textContent='已停止计算。';});for(const field of [difficulty.field,level.field])field.addEventListener('change',()=>{refresh();host.taskWorkbench?.refresh();});
 for(const field of [basis.field,sort.field])field.addEventListener('change',()=>{page=0;renderRows();});search.addEventListener('input',()=>{page=0;renderRows();});prev.addEventListener('click',()=>{page--;renderRows();});next.addEventListener('click',()=>{page++;renderRows();});
 function renderResult(result){
  limits.replaceChildren();preview.replaceChildren();if(!result){return;}
  let scoreLabel=result.performance?'本次回放估计分数':'平均估计分数';if(q('[data-scoring-mode]').value==='ordinary')try{const lines=scoreThresholds(withAPScoreThresholds(host.data.formalRules,host.data.tracks),Number(host.draft.selectedSongId?.split('-').at(-1)));scoreLabel+=` · ${grade(Math.max(...lines.filter(r=>result.expectedScore>=r.score).map(r=>r.rank)))} 档`;}catch{/* Keep the score visible when this release has no grade thresholds. */}score.querySelector('dt').textContent=scoreLabel;
  limits.append(el('span',`最低 ${fmt(result.minimumScore)}`),el('span',`最高 ${fmt(result.maximumScore)}`));
  const playback=result.skillPlayback,variant=playback?.variants?.[0];if(variant){const duration=playbackDuration(playback,variant),track=el('div',null,'task-skill-mini-track');for(const r of activationRows(playback,variant)){const bar=el('i');bar.style.left=`${r.startMs/duration*100}%`;bar.style.width=`${Math.max(1,(r.endMs-r.startMs)/duration*100)}%`;bar.title=`位置 ${r.slotIndex+1} · ${(r.startMs/1000).toFixed(1)}–${(r.endMs/1000).toFixed(1)} s`;track.append(bar);}preview.append(el('span','0:00'),track,el('span',`${Math.floor(duration/60000)}:${String(Math.floor(duration/1000)%60).padStart(2,'0')}`),el('small','一次实际技能顺序的发动窗口；平均分来自多种顺序。'));}
  refresh();
 }
 renderRows();refresh();return {refresh,renderResult,destroy(){stop();shortcut.destroy();detailPanel.close();detailPanel.dialog.remove();}};
}
