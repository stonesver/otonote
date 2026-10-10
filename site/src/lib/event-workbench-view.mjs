import {modalizeDetails} from './workbench-dialog.mjs';
import {eventRewardOptions} from './event-reward-options.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
/** Reshape live reward nodes; their original controllers still own every value. */
export function setupEventWorkbenchView(host,{main,conditionBody,current,context,songRow,songLabel,songButton,accountButton,tags}){
 const q=s=>host.querySelector(s),summary=q('.event-summary'),reward=q('#event-results'),legacySong=q('#event-song'),challenge=q('[data-challenge-optimizer]'),planning=q('.task-event-planning-group'),manual=q('.event-quick-bonus').closest('.task-condition-group'),bonus=accountButton.closest('.task-condition-group'),activity=conditionBody.firstElementChild;
 const originalYield=planning.querySelector('.task-event-yield-conditions');if(originalYield)originalYield.replaceWith(...originalYield.childNodes);
 const primary=el('section',null,'task-condition-group task-event-primary');primary.append(el('h3','卡片与预算'));conditionBody.insertBefore(primary,planning);
 for(const s of ['[data-pool]','[data-yield-goal]','[data-yield-stages]','[data-yield-budget]','[data-yield-starting]'])primary.append(q(s).closest('label'));
 primary.append(accountButton);bonus.remove();
 const yieldRewards=eventRewardOptions(host,'yield');primary.append(yieldRewards.root);
 const range=q('[data-yield-songs]'),autoFilters=el('div',null,'task-event-auto-filters'),songBasis=q('[data-yield-basis]').closest('label');
 const songFilters=q('[data-yield-song-filters]');autoFilters.append(q('[data-yield-difficulty]').closest('label'),q('[data-yield-level]').closest('label'),songFilters);
 const continuation=el('section',null,'task-condition-group task-event-continuation');continuation.append(el('h3','后续挑战'),q('[data-yield-challenge-settings]'));continuation.querySelector('h4')?.remove();conditionBody.insertBefore(continuation,planning);
 planning.querySelector('h3').textContent='搜索设置';planning.querySelector('#event-yield-title')?.remove();
 planning.append(q('[data-yield-depth]').closest('label'),q('[data-yield-eco]').closest('label'));planning.querySelector('.tool-help')?.remove();
 const advanced=el('details',null,'task-event-advanced');advanced.append(el('summary','计算范围与说明'));
 for(const s of ['[data-yield-hint]','[data-yield-goal-help]','[data-pool-hint]','[data-team-status]','[data-bonus]']){const n=q(s);if(n)advanced.append(n);}
 for(const n of [...planning.children])if(n!==planning.firstElementChild&&!n.contains(range)&&n!==songBasis&&!n.contains(q('[data-yield-depth]'))&&!n.contains(q('[data-yield-eco]'))&&!n.contains(q('[data-open-team-workspace="inventory"]')))advanced.append(n);
 planning.append(advanced);modalizeDetails(host,advanced);
 const challengeConditions=el('section',null,'task-condition-group task-challenge-conditions');challengeConditions.append(el('h3','冲榜配队条件'),q('[data-challenge-opt-scope]').closest('label'),q('[data-challenge-opt-objective]').closest('label'),el('p','活动能力加成计入出分；奖励加成不乘入歌曲分数。','task-input-note'));conditionBody.append(challengeConditions);
 const rushRewards=eventRewardOptions(host,'challengeOpt');challengeConditions.append(rushRewards.root);
 const challengeNotes=el('details',null,'task-event-advanced');challengeNotes.append(el('summary','冲榜计算范围与说明'));for(const n of [...challenge.children])if(n.tagName==='P'&&!n.hasAttribute('data-challenge-opt-song')&&!n.hasAttribute('data-challenge-opt-status'))challengeNotes.append(n);challengeConditions.append(challengeNotes);modalizeDetails(host,challengeNotes);
 challenge.classList.add('task-challenge-result');main.append(challenge);challenge.querySelector('h3').textContent='活动曲冲榜';const challengeAction=q('[data-challenge-opt-run]').parentElement;challengeAction.classList.add('task-challenge-toolbar');main.insertBefore(challengeAction,tags);
 // The remaining song inputs are accessed through the standalone song picker.
 legacySong.hidden=true;
 // Quick view mirrors the prototype: four numbers, then comparison and next step.
 summary.classList.add('task-quick-result');summary.querySelector('.event-summary-label').textContent='即时收益';summary.querySelector('[data-next-step]').hidden=true;
 const grid=el('div',null,'task-reward-grid');for(const s of ['badges','points','cp'])grid.append(q(`[data-summary-${s}]`).closest('div'));const unit=q('.event-summary-main');unit.classList.add('task-reward-unit');grid.append(unit);summary.querySelector('dl').before(grid);
 summary.append(q('[data-save]'),q('[data-comparison]'));const toPlan=el('button','转入活动收益配队 →');toPlan.type='button';toPlan.addEventListener('click',()=>q('[data-event-task="team"]').click());const footer=el('footer');footer.append(el('span','需要队伍与后续挑战的完整收益？'),toPlan);summary.append(footer);
 const rewardDetails=el('details',null,'task-event-advanced');rewardDetails.append(el('summary','各评分档位与后续挑战速算'),reward);summary.append(rewardDetails);modalizeDetails(host,rewardDetails);modalizeDetails(host,q('[data-budget-details]'));
 q('.event-quick-bonus > h2')?.remove();q('.event-quick-bonus > label')?.setAttribute('hidden','');q('.event-quick-bonus > summary').textContent='填写游戏加成';q('.event-quick-bonus').open=true;
 const empty=el('section',null,'task-event-plan-empty');empty.append(el('small','完整刷取方案'),el('h2','比较队伍、歌曲和整份预算收益'),el('p','普通与后续挑战分别配队。计算后展示两阶段编成、次数与道具 / 活动 pt 总收益。'));main.insertBefore(empty,q('[data-yield-results]'));
 const instant=el('div',null,'calculator-start task-quick-toolbar');instant.append(el('strong','调整条件，收益即时更新'),el('small','输入游戏中的两项加成与稳定档位'));main.insertBefore(instant,tags);
 const footnote=q('.event-footnote');main.append(footnote);modalizeDetails(host,footnote);
 // Song choice has its own visible home; current-team context only appears on demand.
 context.classList.add('task-event-song-card');const songHead=el('header'),scope=range.closest('label');scope.classList.add('task-event-song-scope');songHead.append(el('h2','选歌与谱面'),scope);
 for(const [index,name] of ['自动选曲','指定谱面'].entries()){range.options[index].textContent=name;const button=scope.querySelectorAll('.tool-options button')[index];if(button){button.setAttribute('aria-label',name);button.querySelector('span').textContent=name;}}
 const songCopy=el('div',null,'task-event-song-copy'),difficulty=el('span',null,'task-event-song-difficulty'),songHint=el('p',null,'task-event-song-hint'),placeholder=el('span','♪','task-event-song-placeholder'),songFooter=el('div',null,'task-event-song-footer');songBasis.classList.add('task-event-song-basis');songCopy.append(songLabel,difficulty);songRow.append(songCopy,songButton);songFooter.append(songBasis,songHint);context.replaceChildren(songHead,autoFilters,songRow,songFooter);main.prepend(context);
 const reference=el('details',null,'task-event-current-source');reference.append(el('summary','当前队伍 · 配对与养成'),current);context.after(reference);current.querySelector('header small').textContent='本次使用的队伍';let wasCurrent=false;
 const rushSongs=el('section',null,'task-event-rush-songs'),rushChoices=el('div',null,'task-event-rush-choices'),rushCopy=el('p'),rushAdvice=el('p','建议先获取并养成本期商店兑换与活动 pt 奖励卡，再进行冲榜。可用左侧「临时纳入本期奖励卡」预先比较。','task-event-rush-advice'),challengeBasis=el('div',null,'task-event-challenge-basis');rushSongs.setAttribute('aria-label','本期活动曲选择');rushSongs.append(el('h2','本期活动曲'),rushCopy,rushAdvice,rushChoices,challengeBasis);main.insertBefore(rushSongs,context);let rushKey='';
 function refreshRushSongs(){
  const eventId=Number(q('[data-event]').value),selected=host.draft.selectedSongId,selectedDifficulty=host.draft.selectedDifficulty??'expert',next=`${eventId}:${selected}:${selectedDifficulty}`;if(next===rushKey)return;rushKey=next;rushChoices.replaceChildren();
  const ids=[...new Set(host.data.rules.tables.ChallengeMusic.filter(row=>row._eventId===eventId).map(row=>`music-${row._liveMusicId}`))];
  for(const id of ids){const source=q(`[data-song-row="${id}"]`),track=host.data.tracks.find(row=>row.id===id);if(!track||!source)continue;
   const card=el('div',null,'task-event-rush-song');card.dataset.selected=String(id===selected);const title=el('button',track.title),cover=source.querySelector('.song-picker-jacket')?.cloneNode();title.type='button';if(cover){cover.alt='';title.prepend(cover);}card.append(title);
   const charts=[...source.querySelectorAll('[data-song-choice]')],levels=el('div',null,'task-event-rush-levels');
   const choose=difficulty=>{if(host.dataset.task==='team')range.value='selected';host.songPicker.applySelection({selectedSongId:id,selectedDifficulty:difficulty});};
   title.addEventListener('click',()=>{const chart=charts.find(c=>!c.disabled&&c.dataset.difficulty===selectedDifficulty)??charts.find(c=>!c.disabled&&c.dataset.difficulty==='expert')??charts.find(c=>!c.disabled);if(chart)choose(chart.dataset.difficulty);});title.disabled=!charts.some(c=>!c.disabled);
   for(const chart of charts){const difficulty=chart.dataset.difficulty,button=el('button',`${({easy:'EZ',normal:'NM',hard:'HD',expert:'EX'})[difficulty]??difficulty} ${chart.dataset.level}`);button.type='button';button.dataset.difficulty=difficulty;button.disabled=chart.disabled;button.setAttribute('aria-label',`${track.title} · ${difficulty.toUpperCase()} · Lv.${chart.dataset.level}`);button.setAttribute('aria-pressed',String(selected===id&&selectedDifficulty===difficulty));button.addEventListener('click',()=>choose(difficulty));levels.append(button);}card.append(levels);rushChoices.append(card);
  }
  if(!rushChoices.children.length)rushChoices.append(el('p','本期活动曲暂不可用，请切换活动。'));
 }
 function refresh(){
  const task=host.dataset.task,quick=task==='quick',rush=task==='challenge';
  yieldRewards.refresh();rushRewards.refresh();
  const useCurrent=!quick&&(rush?q('[data-challenge-opt-scope]').value==='selected':q('[data-pool]').value==='selected');reference.hidden=current.hidden=!useCurrent;if(useCurrent&&!wasCurrent)reference.open=true;wasCurrent=useCurrent;
  const challengeYield=!quick&&!rush&&q('[data-mode]').value==='challenge',showChallengeSongs=rush||challengeYield;
  context.hidden=quick||showChallengeSongs;rushSongs.hidden=!showChallengeSongs;if(showChallengeSongs)refreshRushSongs();
  rushCopy.textContent=rush?'直接点选歌曲和难度，活动能力加成计入出分。':'直接点选本期活动曲与难度，按所选谱面计算挑战收益。';rushAdvice.hidden=!rush||!(host.data.eventRewardCards?.[Number(q('[data-event]').value)]?.length);challengeBasis.hidden=!challengeYield;
  if(challengeYield&&songBasis.parentElement!==challengeBasis)challengeBasis.append(songBasis);else if(!challengeYield&&songBasis.parentElement!==songFooter)songFooter.prepend(songBasis);
  const track=host.data.tracks.find(row=>row.id===host.draft.selectedSongId),selectedOnly=q('[data-yield-songs]').value==='selected',chart=host.data.charts.find(row=>row.trackId===track?.id&&row.difficulty===(host.draft.selectedDifficulty??'expert'));
  songRow.hidden=!selectedOnly;autoFilters.hidden=selectedOnly;continuation.hidden=quick||rush||q('[data-mode]').value!=='ordinary'||q('[data-yield-stages]').value!=='cycle';
  context.dataset.required=String(selectedOnly&&!track);songLabel.textContent=track?track.title:selectedOnly?'先选择要计算的谱面':'自动比较歌曲，寻找收益靠前的方案';difficulty.textContent=track?`${(host.draft.selectedDifficulty??'expert').toUpperCase()}${chart?.level?' · Lv.'+chart.level:''}`:'尚未选择单曲';difficulty.hidden=!track;songButton.textContent=track?'更换谱面':'选择谱面';
  if(!songRow.querySelector('.task-song-cover'))songRow.prepend(placeholder);else placeholder.remove();
  songHint.textContent=selectedOnly?'仅计算所选谱面':'按筛选范围自动比较';songHint.title='后续挑战的选曲范围与判档依据在左侧单独设置。';
  primary.hidden=quick||rush;planning.hidden=quick||rush;manual.hidden=!quick;challengeConditions.hidden=!rush;summary.hidden=!quick;instant.hidden=!quick;const toolbar=q('.task-event-toolbar');if(toolbar)toolbar.hidden=quick||rush;challengeAction.hidden=!rush;
  if(rush&&accountButton.parentElement!==challengeConditions)challengeConditions.append(accountButton);else if(!rush&&accountButton.parentElement!==primary)primary.append(accountButton);
  q('[data-yield-status]').hidden=quick||rush;q('[data-yield-results]').hidden=quick||rush;empty.hidden=quick||rush||!!q('[data-yield-results]').children.length;challenge.hidden=!rush;
  // These inputs retain their values across tasks; the rush task fixes the phase.
  q('[data-mode]').closest('label').hidden=rush;for(const s of ['[data-boost-wrap]','[data-cost-wrap]'])q(s).classList.toggle('task-rush-hidden',rush);
  activity.querySelector('h3').textContent=rush?'本期活动':'活动与阶段';
 }
 const observer=new MutationObserver(refresh);observer.observe(q('[data-yield-results]'),{childList:true});refresh();return {refresh,destroy(){observer.disconnect();}};
}
