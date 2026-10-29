import {readCardBandConstraints,cardBandFilterSummary} from './card-band-constraints.mjs';
import {validateEventCardPool} from './event-reward-candidates.mjs';
import {eventYieldStageInput,eventYieldChallengeBandNote} from './event-yield-stage.mjs';
import {eventSongHeading,eventYieldBreakdown,eventChallengeBreakdown} from './event-result-presentation.mjs';
import {eventRewardGrowthNote} from './event-reward-options.mjs';
import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {setupEventScopeControls} from './tool-calculation-scopes.mjs';
import {scopeSummary,selectedChartScope} from './calculation-scope.mjs';
import {planEventSearch} from './event-search-plan.mjs';
import {currentEventDraft,applyEventPlan,eventTeamDetails,eventTeamSaveButton,eventElement as el} from './event-team-view.mjs';
import {EVENT_YIELD_GOAL_LABELS,orderEventYieldRows,eventYieldGaps} from './event-yield-goals.mjs';
import {createCalculationProgress} from './calculation-progress.mjs';
import {createCalculationLiveUpdates,reconcileCalculationView} from './calculation-live-updates.mjs';
import {selectedControlValues} from './filter-controls.mjs';
let phasePanelId=0;
const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:1}),grades=['D','C','B','A','S','SS'];
const gapText=n=>n===0?'相同':`${n>0?'少':'多'} ${fmt(Math.abs(n))}`;
const selectedDifficulties=field=>field.multiple?[...field.selectedOptions].map(o=>o.value).filter(value=>value!=='all'):field.value;

export function eventYieldCompletionText(data){
 const complete=data.coverageComplete??data.complete,proofs=Object.values(data.globalProofs??{});
 const proven=complete&&!data.failures.length&&proofs.length>0&&proofs.every(p=>p.bestProven);
 const covered=data.prunedCharts?`已证明 ${data.fullyOptimizedCharts} 张谱面的单曲第一名，按全局上界覆盖 ${data.prunedCharts} 张谱面`:`已比较 ${data.done} / ${data.available} 张谱面`;
 const ties=proofs.every(p=>p.scoreTieOptimality==='proven');
 const evidence=proven?`所选条件的收益第一名已证明；备选供参考${ties?'，同收益的期望分排序已证明':'，同收益的期望分排序未证明'}`:'当前结果尚未证明所选条件下的第一名';
 const continuation=proofs.some(p=>p.scope==='all_selected_charts_given_challenge_rows')?'；后续挑战以本次已计算方案为范围':'';
 return {complete,proven,label:complete?'活动收益比较完成':'活动收益推荐完成',detail:covered,
   status:`${covered}。${evidence}${continuation}。共找到 ${data.rows.length} 个队伍＋歌曲方案${data.cacheHits?`，复用 ${data.cacheHits} 次估分`:''}。${data.failures.length?'有计算失败，结果不完整。':complete?'':'可重新开始完整比较，已保存的估分缓存可复用。'}`};
}

export function eventYieldStopText(hasResults){
 return {label:'已停止',detail:hasResults?'保留当前显示的方案，可重新开始完整比较':'可调整条件后重新计算',
   status:hasResults?'已停止。保留当前显示的方案。重新开始完整比较会从头搜索，可复用已保存的估分缓存；当前搜索进度不保留。':
     '已停止收益配队计算。重新计算会从头搜索，可复用已保存的估分缓存。'};
}

const progressStages={
 practical:'准备与比较配队','practical-result':'更新当前领先方案',pair_weights:'计算成员与留影的配对能力',leader_weights:'计算队长加成',
 search:'搜索更优配队','event-exact':'验证收益第一名','event-witness':'验证全局收益上界','event-reward-exact':'验证收益配队与加成',
 'event-root-proof':'验证各队长的收益上界','event-group-preparation':'准备跨谱面评分上界','event-group-proof':'验证跨谱面收益第一名','event-group-seeds':'跨谱面复算合法候选'
};
export function eventYieldProgressText(data){
 const raw=typeof data.stage==='string'?data.stage:'',stage=progressStages[raw]??(/[\u3400-\u9fff]/u.test(raw)?raw:'正在比较活动收益');
 const detail=typeof data.detail==='string'&&data.detail?data.detail:'谱面比较进度，单曲内部仍需比较编成';
 return {stage,detail:raw?detail.split(raw).join(stage):detail};
}

export function setupEventYieldOptimizer(tool,{createScopeControls=setupEventScopeControls,validateCardPool=validateEventCardPool}={}){
 const root=tool.q('yield-optimizer'),q=s=>tool.querySelector(`[data-yield-${s}]`);
 const feedback=createCalculationProgress(q('status'),'yield');
 q('continue').textContent='重新开始完整比较';
 let worker=null,key='',result=null,renderKey='',displaySort='yield',displayGoal='badges',page=0,selectedPlan=null;
 let mainScope,challengeScope,runScopes=null;
 let articleCache=new Map(),viewCache=new Map();
 const resultKey=data=>JSON.stringify([data.rows,data.failures]);
 const updates=createCalculationLiveUpdates({hasResults:()=>Boolean(result?.rows.length),
   onResult:data=>{result={...data,calculationScopes:runScopes};render();},onProgress:data=>{
     const progress=eventYieldProgressText(data);feedback.update({label:'正在比较活动收益',completed:data.done,total:data.total,detail:`${data.title??'所有候选歌曲'} · ${progress.detail}`});
     q('status').textContent=`${progress.stage}：${data.title??'所有候选歌曲'}（${data.done} / ${data.total}）`;
   }});
 const stop=(publish=false)=>{worker?.terminate();worker=null;updates.stop({flushResult:publish});if(publish&&result)render();q('cancel').hidden=true;tool.q('suggest').disabled=false;q('run').disabled=false;root.setAttribute('aria-busy','false');};
 function context(){const rewards=q('rewards')?.checked&&tool.q('pool').value!=='reference';return {eventId:Number(tool.q('event').value),mode:tool.q('mode').value,scope:tool.q('pool').value,constraints:readCardBandConstraints(q('member-band'),q('support-band')),draft:currentEventDraft(tool),
   liveBoost:Number(tool.q('boost').value),challengeCost:Number(tool.q('cost').value),budget:Number(q('budget').value),startingCP:Number(q('starting').value),
   rewardCards:rewards?tool.data.eventRewardCards?.[Number(tool.q('event').value)]??[]:[],rewardGrowth:q('reward-growth')?.value??'level',rewardGrowthOverride:rewards??false,searchDepth:q('depth').value,eco:q('eco').checked,goal:q('goal').value,basis:q('basis').value,includeChallenge:q('stages').value==='cycle',songs:q('songs').value,band:selectedControlValues(q('band')),attribute:selectedControlValues(q('attribute')),difficulty:selectedDifficulties(q('difficulty')),maxLevel:Number(q('level').value),challengeScope:q('challenge-scope').value,challengeBandScope:q('challenge-band-scope')?.checked?'same':'all',challengeBasis:q('challenge-basis').value,challengeDifficulty:selectedDifficulties(q('challenge-difficulty')),challengeMaxLevel:Number(q('challenge-level').value)};}
 function filters(c,challenge=false){
   const allowed=tool.data.rules.tables.ChallengeMusic.filter(r=>r._eventId===c.eventId).map(r=>`music-${r._liveMusicId}`);
   if(challenge)return {allowedTrackIds:allowed,difficulty:c.challengeDifficulty,maxLevel:c.challengeMaxLevel};
   const selected=c.songs==='selected',normal=c.mode==='ordinary'&&!selected;
   return {allowedTrackIds:c.mode==='challenge'?allowed:null,difficulty:selected?'all':c.difficulty,maxLevel:selected?40:c.maxLevel,band:normal?c.band:'',attribute:normal?c.attribute:''};
 }
 function sync(){
   if(tool.q('mode').value==='challenge'&&q('goal').value==='grade')q('goal').value='badges';
   const c=context();mainScope?.refresh();challengeScope?.refresh();const next=JSON.stringify([c,mainScope?.snapshot?.fingerprint,challengeScope?.snapshot?.fingerprint]);
   if(next!==key){stop();feedback.reset();key=next;result=null;articleCache.clear();viewCache.clear();selectedPlan=null;renderKey='';q('continue').hidden=true;q('results').replaceChildren();q('status').textContent='条件改变后需重新计算；原有卡组不会自动被替换。';}
   scopeControls?.refresh?.();
   const unsupported=c.mode==='gekisou',needsSong=c.mode==='challenge'&&c.songs==='selected'&&!c.draft.selectedSongId;q('run').disabled=!!worker||unsupported||needsSong;tool.q('suggest').disabled=!!worker||unsupported||needsSong;q('run').title=needsSong?'先点选本期活动曲与难度':'';
   q('challenge-settings').hidden=c.mode!=='ordinary'||!c.includeChallenge;
   const challengeBandNote=eventYieldChallengeBandNote(c,cardBandFilterSummary(q('member-band'),q('support-band')));
   q('challenge-band-note').textContent=challengeBandNote;
   q('card-band-hint').textContent='成员与留影分别筛选；留影包含所选乐队任一角色即可入选。'+(challengeBandNote||'此处筛选限制当前阶段的配队。');
   q('normal-settings').hidden=c.mode==='challenge';q('stages').disabled=c.mode==='challenge';
   q('song-filters').hidden=c.mode!=='ordinary'||c.songs==='selected';
   q('goal').querySelector('[value="grade"]').disabled=c.mode==='challenge';
   q('goal-help').textContent=c.goal==='both'?'比较档位、加成与后续挑战的实际收益，分别给出道具优先和活动 pt 优先方案；不限定稀有度，两种点数不直接相加。':c.goal==='eventPoints'?'先比较活动 pt 总收益，相同再比较道具。若包含后续挑战，挑战队伍与次数也按活动 pt 优化。':c.goal==='grade'?'先比较普通演出的估计档位，相同再比较道具总收益；不一定能获得最多活动 pt。':'先比较道具总收益，相同再比较活动 pt。道具最多的方案不一定活动 pt 最多。';
   q('hint').textContent=c.mode==='challenge'?'比较本期挑战歌曲的直接收益；消耗沿用上方设置，挑战 pt 不参与收益排序。':'按整份耗火预算比较，自动估算队伍在歌曲中的档位。完整循环允许普通和挑战使用不同队伍；已有挑战 pt 单列，不冒充本次刷取所得。';
 }
 function render(){
   scopeControls?.refresh?.();
   const next=JSON.stringify([displaySort,displayGoal,page,Boolean(worker),resultKey(result)]);
   if(next===renderKey)return;renderKey=next;
   const view=[],nextArticles=new Map(),focusedPlan=document.activeElement?.dataset?.yieldPlanKey;
   if(q('rewards')?.checked&&tool.q('pool').value!=='reference')view.push(el('p',`本期兑换 / pt 奖励卡已纳入候选，并不保证入选队伍。${eventRewardGrowthNote(q('reward-growth').value,q('rewards')?.checked??false)}按获取后队伍比较，未扣兑换成本。`,'task-event-reward-result-note'));
   if(tool.q('pool').value==='reference')view.push(el('p','当前阶段使用全卡库满养成参考；账号加成沿用页面设置，不代表实际持有。','event-hint'));
   const cardBands=cardBandFilterSummary(q('member-band'),q('support-band'));if(cardBands)view.push(el('p',cardBands,'event-hint'));
   const challengeBandNote=eventYieldChallengeBandNote(context(),cardBands);if(challengeBandNote)view.push(el('p',challengeBandNote,'event-hint'));
   if(result.calculationScopes){view.push(el('p',scopeSummary(result.calculationScopes.main)));if(result.calculationScopes.challenge)view.push(el('p','后续挑战 · '+scopeSummary(result.calculationScopes.challenge)));}
   const completion=eventYieldCompletionText(result);
   const boundary=el('span',worker?'计算中 · 方案仍在更新':result.failures.length?'部分谱面失败，结果不完整':completion.proven?'所选条件下收益第一 · 备选供参考':'当前推荐 · 尚未证明收益第一','event-result-boundary');
   const target=q('goal').value==='both'?displayGoal:q('goal').value,eligible=result.rows.filter(row=>!row.recommendationGoals||row.recommendationGoals.includes(target));
   const ordered=orderEventYieldRows(eligible,displaySort,target),{reference,gap}=eventYieldGaps(eligible,target),pageCount=Math.max(1,Math.ceil(ordered.length/8));page=Math.min(page,pageCount-1);
   const alternatives=el('details',null,'event-alternatives'),comparisonHeading=el('summary');comparisonHeading.append(el('span',`比较方案 · ${ordered.length} 套`),boundary);alternatives.append(comparisonHeading);alternatives.open=ordered.length>1;
   view.push(alternatives);
   const toolbar=el('div',null,'task-event-plan-sort'),sort=el('div',null,'task-event-sort-options');sort.setAttribute('role','group');sort.setAttribute('aria-label','收益方案排序');
   if(q('goal').value==='both'){const goals=el('div',null,'task-event-result-tabs task-event-goal-tabs');goals.setAttribute('role','group');goals.setAttribute('aria-label','收益优先候选');for(const [goal,name] of [['badges','道具优先'],['eventPoints','pt 优先']]){const button=el('button',name);button.type='button';button.setAttribute('aria-pressed',String(target===goal));button.addEventListener('click',()=>{displayGoal=goal;page=0;selectedPlan=null;render();});goals.append(button);}toolbar.append(goals);}
   for(const [value,name] of [['yield','收益优先'],['short','时长优先']]){const button=el('button',name);button.type='button';button.setAttribute('aria-pressed',String(displaySort===value));button.addEventListener('click',()=>{displaySort=value;page=0;selectedPlan=null;render();});sort.append(button);}const count=el('small',`${ordered.length} 个收益领先候选`);toolbar.append(el('span','方案排序'),sort,count);alternatives.append(toolbar);
   const baseline=el('div',null,'task-event-plan-baseline'),identity=el('div',null,'task-event-baseline-name');identity.append(el('small','比较基准'),el('strong',reference?.song.title??'—'),el('span',reference?.song.difficulty.toUpperCase()??'—','task-event-chart-label'));baseline.append(identity);
   const totals=el('div',null,'task-event-baseline-totals');for(const [field,label] of [['badges','道具'],['eventPoints','pt']]){const metric=el('span');metric.append(el('small',label),el('b',fmt(reference?.total[field]??0)));totals.append(metric);}baseline.append(totals);const comparisonNotes=el('details',null,'event-comparison-notes');comparisonNotes.append(el('summary','比较基准'),baseline);toolbar.append(comparisonNotes);
   comparisonNotes.append(el('p',`${worker?'计算中实时更新领先方案，最终排名以完成结果为准。':''}仅重排${EVENT_YIELD_GOAL_LABELS[target]}的领先候选；差值均与本次搜索的收益第一比较，含当前预算${context().includeChallenge?'与后续挑战':''}。`,'event-hint task-event-gap-note'));
   const tabs=el('div',null,'task-event-result-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','收益方案');alternatives.append(tabs);
   count.hidden=ordered.length<=8;count.textContent=ordered.length?`${page*8+1}–${Math.min(ordered.length,page*8+8)} / ${ordered.length} 套`:'0 套';
   const visible=ordered.slice(page*8,page*8+8),selected=visible.find(r=>r.id===selectedPlan?.id&&r.song.id===selectedPlan?.song)??visible.find(r=>r.song.id===selectedPlan?.song)??visible[0];
   for(const row of visible){
     const signature=JSON.stringify({...row,search:undefined}),cached=articleCache.get(row.id+'|'+row.song.id),reuse=cached?.signature===signature;
     const article=reuse?cached.article:el('article',null,'challenge-opt-result task-event-plan-result');article.hidden=row!==selected;
     if(!reuse)article.className+=' task-event-plan-enter';
     nextArticles.set(row.id+'|'+row.song.id,{signature,article});
     const differenceLabel=gap(row);
     const tab=el('button',null,'task-event-plan-choice'),title=el('span',row.song.title,'task-event-choice-title'),meta=el('span',null,'task-event-choice-meta');meta.append(el('small',row.song.difficulty.toUpperCase(),'task-event-chart-label'),el('small',row.song.seconds==null?'时长未知':`${fmt(row.song.seconds)} 秒`));tab.append(title,meta);tab.dataset.yieldPlanKey=row.id+'|'+row.song.id;tab.title=row.song.title+' · '+row.song.difficulty.toUpperCase();tab.type='button';tab.setAttribute('aria-pressed',String(row===selected));tab.addEventListener('click',()=>{selectedPlan={id:row.id,song:row.song.id};for(const n of q('results').querySelectorAll('.task-event-plan-result'))n.hidden=n!==article;for(const b of tabs.children)b.setAttribute('aria-pressed',String(b===tab));article.scrollIntoView({block:'start',behavior:'instant'});});tabs.append(tab);
     const gapRow=el('span',null,'task-event-choice-gap');for(const [key,label] of [['badges','道具'],['eventPoints','pt']]){const value=differenceLabel[key],cell=el('span');cell.dataset.gap=value===0?'equal':value>0?'less':'more';cell.append(el('small',label),el('b',value===0?'持平':`${value>0?'−':'+'}${fmt(Math.abs(value))}`));gapRow.append(cell);}tab.append(gapRow);
     if(reuse){for(const [index,node] of article.querySelectorAll('.task-event-yield-gap').entries()){const value=gap(row)[['badges','eventPoints'][index]];const text=`比收益第一${gapText(value)}`;if(node.textContent!==text)node.textContent=text;node.hidden=value===0;}}
     if(!reuse){
     const differences=gap(row),metrics=el('div',null,'task-event-total-grid');for(const [key,label] of [['badges','道具总收益'],['eventPoints','活动 pt 总收益']]){const cell=el('div');cell.append(el('small',label),el('strong',fmt(row.total[key])),el('small',`比收益第一${gapText(differences[key])}`,'task-event-yield-gap'));cell.children[2].hidden=differences[key]===0;metrics.append(cell);}article.append(metrics);
     metrics.append(el('p',row.reward.mode==='ordinary'?`${row.spentFire} 火 · ${row.normalPlays} 次普通${row.continuation?' · '+row.continuation.plays+' 次挑战':''}`:`每次 ${row.reward.challengeCost} 挑战 pt`,'event-plan-facts'));
     article.append(eventYieldBreakdown(row));
     const ordinaryPanel=el('section',null,'event-stage-panel');
     ordinaryPanel.append(eventSongHeading(tool.data,row.song,{label:row.reward.mode==='ordinary'?'普通演出':'挑战演出',grade:grades[row.reward.scoreRank-2]}));
     ordinaryPanel.append(eventTeamDetails(tool,row));
     const apply=el('button',row.reward.mode==='challenge'?'使用挑战方案':'使用普通方案');apply.type='button';apply.addEventListener('click',()=>applyEventPlan(tool,row,row.reward.mode));const actions=el('div',null,'event-result-actions');actions.append(apply,eventTeamSaveButton(row.draft,`${row.song.title} · 收益队伍`));ordinaryPanel.append(actions);
     if(row.continuation){
       const section=el('section',null,'event-recommendations event-stage-panel');
       if(!row.continuation.stages.length)section.append(el('p','挑战 pt 尚不足一次挑战；保留余额，本次不计入挑战收益。'));
       const stageTabs=el('div',null,'task-event-result-tabs');stageTabs.setAttribute('role','group');stageTabs.setAttribute('aria-label','后续挑战消耗方案');section.append(stageTabs);
       const priorCost=cached?.article.querySelector?.('[data-yield-stage-cost][aria-pressed="true"]')?.dataset.yieldStageCost;
       const activeCost=row.continuation.stages.some(stage=>String(stage.cost)===priorCost)?priorCost:String(row.continuation.stages[0]?.cost);
       const stagePanels=[];
       for(const stage of row.continuation.stages){
         const panel=el('section');panel.hidden=String(stage.cost)!==activeCost;stagePanels.push(panel);
         const stageTab=el('button',`${stage.cost} pt × ${stage.plays} 次`);stageTab.type='button';stageTab.dataset.yieldStageCost=String(stage.cost);stageTab.setAttribute('aria-pressed',String(String(stage.cost)===activeCost));stageTab.addEventListener('click',()=>{for(const n of stagePanels)n.hidden=n!==panel;for(const b of stageTabs.children)b.setAttribute('aria-pressed',String(b===stageTab));});stageTabs.append(stageTab);
         const r=stage.row;
         panel.append(eventSongHeading(tool.data,r.song,{label:'挑战演出',grade:grades[r.reward.scoreRank-2],plays:stage.plays}),eventChallengeBreakdown(stage),eventTeamDetails(tool,r));
         const use=el('button','使用挑战方案');use.type='button';use.addEventListener('click',()=>{tool.q('cost').value=String(stage.cost);applyEventPlan(tool,r,'challenge');});const stageActions=el('div',null,'event-result-actions');stageActions.append(use,eventTeamSaveButton(r.draft,`${r.song.title} · 后续挑战`));panel.append(stageActions);section.append(panel);
       }
       const phases=el('div',null,'event-phase-tabs');phases.setAttribute('role','tablist');phases.setAttribute('aria-label','演出阶段');
       const phaseEntries=[['ordinary','普通演出',ordinaryPanel],['challenge',`后续挑战 · ${row.continuation.plays} 次`,section]],phaseButtons=[];
       const activePhase=cached?.article.querySelector?.('[data-yield-phase][aria-selected="true"]')?.dataset.yieldPhase??'ordinary';
       const selectPhase=value=>{for(const [index,[phase,,panel]] of phaseEntries.entries()){const active=phase===value;panel.hidden=!active;phaseButtons[index].setAttribute('aria-selected',String(active));phaseButtons[index].tabIndex=active?0:-1;}};
       for(const [index,[phase,label,panel]] of phaseEntries.entries()){
         const tab=el('button',label),id=`event-phase-${++phasePanelId}`;tab.type='button';tab.dataset.yieldPhase=phase;tab.id=id;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',`${id}-panel`);panel.id=`${id}-panel`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',id);
         tab.addEventListener('click',()=>selectPhase(phase));tab.addEventListener('keydown',event=>{const next=event.key==='Home'?0:event.key==='End'?1:['ArrowLeft','ArrowRight'].includes(event.key)?1-index:null;if(next==null)return;event.preventDefault();selectPhase(phaseEntries[next][0]);phaseButtons[next].focus();});phaseButtons.push(tab);phases.append(tab);
       }
       selectPhase(activePhase);article.append(phases,ordinaryPanel,section);
     }else article.append(ordinaryPanel);
     }
     view.push(article);
   }
   if(pageCount>1){const pager=el('div',null,'task-event-plan-sort'),prev=el('button','上一页方案'),nextPage=el('button','下一页方案');prev.type=nextPage.type='button';prev.disabled=page===0;nextPage.disabled=page===pageCount-1;prev.addEventListener('click',()=>{page--;selectedPlan=null;render();});nextPage.addEventListener('click',()=>{page++;selectedPlan=null;render();});pager.append(prev,el('small',`${page+1} / ${pageCount}`),nextPage);alternatives.append(pager);}
   if(result.failures.length){const d=el('details',null,'event-details');d.append(el('summary',`${result.failures.length} 张谱面失败，已排除，结果不完整`));for(const f of result.failures)d.append(el('p',`${f.title}：${f.message}`));view.push(d);}
   // Keep unchanged controls (including keyboard focus) and team subtrees mounted.
   const nextView=new Map();
   for(const [index,node] of view.entries()){
     if(node.className?.includes('task-event-plan-result'))continue;
     const signature=node.outerHTML+((node===alternatives)?JSON.stringify([...nextArticles].map(([key,value])=>[key,value.signature])):'');
     const cached=viewCache.get(index);if(cached?.signature===signature&&node.outerHTML!==undefined)view[index]=cached.node;
     nextView.set(index,{signature,node:view[index]});
   }
   const container=q('results');reconcileCalculationView(container,view);
   if(focusedPlan)for(const button of container.querySelectorAll('.task-event-plan-choice'))if(button.dataset.yieldPlanKey===focusedPlan&&document.activeElement!==button)button.focus({preventScroll:true});
   articleCache=nextArticles;viewCache=nextView;

 }
 function run(depth=q('depth').value){
   if(worker)return;
   try{
     const c=context();assertToolTeamCompatible(tool.teamWorkspaceContext,c.draft);c.searchDepth=depth;if(c.mode==='gekisou')throw Error('激奏请手填团队结算档位');
     if(c.mode==='ordinary'&&(!Number.isInteger(c.liveBoost)||c.liveBoost<1||!Number.isInteger(c.budget)||c.budget<c.liveBoost||c.budget>10000))throw Error('普通收益配队需消耗至少 1 火，预算不少于单次耗火且不超过 10000 火。');
     if(!Number.isInteger(c.startingCP)||c.startingCP<0||c.startingCP>1000000)throw Error('已有挑战 pt 需为 0 至 1000000 的整数。');
     const needsInventory=c.scope==='owned'||c.mode==='ordinary'&&c.includeChallenge&&c.challengeScope==='owned';
     const profile=needsInventory||c.rewardCards.length?tool.personalGrowthStore.read():null;
     if(needsInventory&&!profile)throw Error('请先导入实际卡库与养成，或选择“当前十张卡”。');
     c.draft.modifiers={...profile?.account,...c.draft.modifiers};c.inventory=profile?.inventory;
     try{validateCardPool({rules:tool.data.rules,...c});}catch(error){throw Error('当前阶段卡片范围：'+error.message);}
     if(c.mode==='ordinary'&&c.includeChallenge)try{validateCardPool({rules:tool.data.rules,...eventYieldStageInput(c,'challenge')});}catch(error){throw Error('后续挑战卡片范围：'+error.message);}
     let main;try{main=mainScope.require(filters(c));}catch(error){throw Error('没有符合条件的可计算歌曲，请检查曲目、乐队、歌曲属性或难度范围。'+error.message);}let candidates=main.candidates;
     if(c.songs==='selected'){main=selectedChartScope(main,{...c.draft,selectedDifficulty:c.draft.selectedDifficulty??'expert'});candidates=main.candidates;}
     if(!candidates.length)throw Error('当前谱面不符合活动条件或资料暂缺，请重新选曲。');
     let challenge=null;if(c.mode==='ordinary'&&c.includeChallenge){try{challenge=challengeScope.require(filters(c,true));}catch(error){throw Error('后续挑战没有符合条件的谱面，请检查本期曲池与难度。'+error.message);}}
     const challengeCandidates=challenge?.candidates??[];
     runScopes={main:{...main,candidates,songCount:new Set(candidates.map(r=>r.trackId)).size,chartCount:candidates.length},challenge};
     c.calculationScopes=runScopes;
     if(c.mode==='challenge'&&c.goal==='grade')c.goal='badges';
     result=null;articleCache.clear();viewCache.clear();selectedPlan=null;renderKey='';page=0;q('continue').hidden=true;q('results').replaceChildren();worker=new Worker(new URL('./event-yield-worker.mjs',import.meta.url),{type:'module'});
     feedback.update({label:'准备活动收益比较',detail:'正在读取卡库、实际养成与谱面'});
     const active=worker;q('cancel').hidden=false;q('run').disabled=true;tool.q('suggest').disabled=true;root.setAttribute('aria-busy','true');q('status').textContent='正在准备卡库、实际养成与谱面…';
     worker.addEventListener('message',({data})=>{
       if(worker!==active)return;
       if(data.type==='progress'){updates.progress(data);return;}
       if(data.type==='partial'){updates.result(data);return;}
       stop(data.type!=='result');if(data.type==='result'){
         result={...data,calculationScopes:runScopes};render();const summary=eventYieldCompletionText(data);feedback.finish(summary.label,summary.detail);q('continue').hidden=summary.complete;
         q('status').textContent=scopeSummary(runScopes.main)+'。'+summary.status;
       }else {feedback.finish('计算失败',data.message,'error');q('continue').hidden=!result;q('status').textContent=`计算失败：${data.message}${result?'；保留当前显示的方案，可重新开始完整比较。':''}`;}
     });
     worker.addEventListener('error',()=>{if(worker!==active)return;stop(true);feedback.finish('计算服务加载失败','请重试','error');q('status').textContent='计算服务加载失败，请重试。';});
     const planned=depth==='full'?candidates.length:planEventSearch(candidates,tool.data.rules,c.draft).quick.length;
     q('status').textContent=`${scopeSummary(runScopes.main)}。本轮主阶段计划检查 ${planned} 张谱面${challenge?'；后续挑战 '+challenge.chartCount+' 张谱面':''}。`;
     worker.postMessage({rules:tool.data.rules,eventId:c.eventId,candidates,challengeCandidates,input:c});
   }catch(error){stop();feedback.finish('无法开始计算',error.message,'error');q('status').textContent=error.message;tool.q('team-status').textContent=error.message;}
 }
 const scopeControls=createScopeControls(tool,{getFilters:challenge=>filters(context(),challenge),onChange:()=>{sync();tool.challengeOptimizer?.sync();},getResultCharts:()=>result?.rows.map(r=>r.song).filter(Boolean)??[]});
 mainScope=scopeControls.main;challengeScope=scopeControls.challenge;
 q('run').addEventListener('click',()=>run());q('continue').addEventListener('click',()=>run('full'));q('cancel').addEventListener('click',()=>{stop(true);const summary=eventYieldStopText(Boolean(result));feedback.finish(summary.label,summary.detail,'stopped');q('continue').hidden=!result;q('status').textContent=scopeSummary(runScopes.main)+'。'+summary.status;});
 root.addEventListener('change',event=>{event.stopPropagation();sync();});
 for(const field of [q('member-band'),q('support-band'),q('challenge-band-scope')])field?.addEventListener('change',()=>sync());
 return {sync,run,invalidate:()=>{key='';stop();sync();},destroy:()=>{stop();feedback.destroy();scopeControls.destroy();}};
}
