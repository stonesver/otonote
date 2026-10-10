import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {eventSongCandidates} from './event-song-ranking.mjs';
import {currentEventDraft,applyEventPlan,eventTeamDetails,eventTeamSaveButton,eventElement as el} from './event-team-view.mjs';
import {EVENT_YIELD_GOAL_LABELS,orderEventYieldRows,eventYieldGaps} from './event-yield-goals.mjs';
const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:1}),grades=['D','C','B','A','S','SS'];
const gapText=n=>n===0?'相同':`${n>0?'少':'多'} ${fmt(Math.abs(n))}`;

export function setupEventYieldOptimizer(tool){
 const root=tool.q('yield-optimizer'),q=s=>tool.querySelector(`[data-yield-${s}]`);
 let worker=null,key='',result=null,renderKey='',displaySort='yield',displayGoal='badges',page=0;
 const stop=()=>{worker?.terminate();worker=null;q('cancel').hidden=true;tool.q('suggest').disabled=false;q('run').disabled=false;root.setAttribute('aria-busy','false');};
 function context(){return {eventId:Number(tool.q('event').value),mode:tool.q('mode').value,scope:tool.q('pool').value,draft:currentEventDraft(tool),
   liveBoost:Number(tool.q('boost').value),challengeCost:Number(tool.q('cost').value),budget:Number(q('budget').value),startingCP:Number(q('starting').value),
   rewardCards:q('rewards')?.checked?tool.data.eventRewardCards?.[Number(tool.q('event').value)]??[]:[],rewardGrowth:q('reward-growth')?.value??'level',searchDepth:q('depth').value,eco:q('eco').checked,goal:q('goal').value,basis:q('basis').value,includeChallenge:q('stages').value==='cycle',songs:q('songs').value,band:q('band').value,attribute:q('attribute').value,difficulty:q('difficulty').value,maxLevel:Number(q('level').value),challengeScope:q('challenge-scope').value,challengeBasis:q('challenge-basis').value,challengeDifficulty:q('challenge-difficulty').value,challengeMaxLevel:Number(q('challenge-level').value)};}
 function sync(){
   if(tool.q('mode').value==='challenge'&&q('goal').value==='grade')q('goal').value='badges';
   const c=context(),next=JSON.stringify(c);
   if(next!==key){stop();key=next;result=null;renderKey='';q('continue').hidden=true;q('results').replaceChildren();q('status').textContent='条件改变后需重新计算；原有卡组不会自动被替换。';}
   const unsupported=c.mode==='gekisou',needsSong=c.mode==='challenge'&&c.songs==='selected'&&!c.draft.selectedSongId;q('run').disabled=!!worker||unsupported||needsSong;tool.q('suggest').disabled=!!worker||unsupported||needsSong;q('run').title=needsSong?'先点选本期活动曲与难度':'';
   q('challenge-settings').hidden=c.mode!=='ordinary'||!c.includeChallenge;
   q('normal-settings').hidden=c.mode==='challenge';q('stages').disabled=c.mode==='challenge';
   q('song-filters').hidden=c.mode!=='ordinary'||c.songs==='selected';
   q('goal').querySelector('[value="grade"]').disabled=c.mode==='challenge';
   q('goal-help').textContent=c.goal==='both'?'比较档位、加成与后续挑战的实际收益，分别给出道具优先和活动 pt 优先方案；不限定稀有度，两种点数不直接相加。':c.goal==='eventPoints'?'先比较活动 pt 总收益，相同再比较道具。若包含后续挑战，挑战队伍与次数也按活动 pt 优化。':c.goal==='grade'?'先比较普通演出的估计档位，相同再比较道具总收益；不一定能获得最多活动 pt。':'先比较道具总收益，相同再比较活动 pt。道具最多的方案不一定活动 pt 最多。';
   q('hint').textContent=c.mode==='challenge'?'比较本期挑战歌曲的直接收益；消耗沿用上方设置，挑战 pt 不参与收益排序。':'按整份耗火预算比较，自动估算队伍在歌曲中的档位。完整循环允许普通和挑战使用不同队伍；已有挑战 pt 单列，不冒充本次刷取所得。';
 }
 function render(){
   const next=JSON.stringify([displaySort,displayGoal,page,result.rows.map(r=>[r.id,r.song.id,r.total,r.expectedScore,r.recommendationGoals]),result.failures]);
   if(next===renderKey)return;renderKey=next;
   q('results').replaceChildren();
   if(q('rewards')?.checked)q('results').append(el('p',`已临时纳入本期兑换 / pt 奖励卡。新增卡按${q('reward-growth').value==='maximum'?'全满养成假设':'满等级、初始突破 / 觉醒、技能 1'}计算；按获取后队伍比较，未扣兑换成本。`,'task-event-reward-result-note'));
   const target=q('goal').value==='both'?displayGoal:q('goal').value,eligible=result.rows.filter(row=>!row.recommendationGoals||row.recommendationGoals.includes(target));
   const ordered=orderEventYieldRows(eligible,displaySort,target),{reference,gap}=eventYieldGaps(eligible,target),pageCount=Math.max(1,Math.ceil(ordered.length/8));page=Math.min(page,pageCount-1);
   const toolbar=el('div',null,'task-event-plan-sort'),sort=el('div',null,'task-event-sort-options');sort.setAttribute('role','group');sort.setAttribute('aria-label','收益方案排序');
   if(q('goal').value==='both'){const goals=el('div',null,'task-event-result-tabs task-event-goal-tabs');goals.setAttribute('role','group');goals.setAttribute('aria-label','收益优先候选');for(const [goal,name] of [['badges','道具优先方案'],['eventPoints','pt 优先方案']]){const button=el('button',name);button.type='button';button.setAttribute('aria-pressed',String(target===goal));button.addEventListener('click',()=>{displayGoal=goal;page=0;render();});goals.append(button);}q('results').append(goals);}
   for(const [value,name] of [['yield','收益优先'],['short','时长优先']]){const button=el('button',name);button.type='button';button.setAttribute('aria-pressed',String(displaySort===value));button.addEventListener('click',()=>{displaySort=value;page=0;render();});sort.append(button);}toolbar.append(el('span','方案排序'),sort,el('small',`${ordered.length} 个收益领先候选`));q('results').append(toolbar);
   const baseline=el('div',null,'task-event-plan-baseline'),identity=el('div',null,'task-event-baseline-name');identity.append(el('small','比较基准'),el('strong',reference?.song.title??'—'),el('span',reference?.song.difficulty.toUpperCase()??'—','task-event-chart-label'));baseline.append(identity);
   const totals=el('div',null,'task-event-baseline-totals');for(const [field,label] of [['badges','道具'],['eventPoints','pt']]){const metric=el('span');metric.append(el('small',label),el('b',fmt(reference?.total[field]??0)));totals.append(metric);}baseline.append(totals);q('results').append(baseline);
   q('results').append(el('p',`仅重排${EVENT_YIELD_GOAL_LABELS[target]}的领先候选；差值均与本次搜索的收益第一比较，含当前预算${context().includeChallenge?'与后续挑战':''}。`,'event-hint task-event-gap-note'));
   const tabs=el('div',null,'task-event-result-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','收益方案');q('results').append(tabs);
   for(const [i,row] of ordered.slice(page*8,page*8+8).entries()){
     const article=el('article',null,'challenge-opt-result task-event-plan-result');article.hidden=i!==0;
     const differenceLabel=gap(row);
     const tab=el('button',null,'task-event-plan-choice'),title=el('span',row.song.title,'task-event-choice-title'),meta=el('span',null,'task-event-choice-meta');meta.append(el('small',row.song.difficulty.toUpperCase(),'task-event-chart-label'),el('small',row.song.seconds==null?'时长未知':`${fmt(row.song.seconds)} 秒`));tab.append(title,meta);tab.title=row.song.title+' · '+row.song.difficulty.toUpperCase();tab.type='button';tab.setAttribute('aria-pressed',String(i===0));tab.addEventListener('click',()=>{for(const n of q('results').querySelectorAll('.task-event-plan-result'))n.hidden=n!==article;for(const b of tabs.children)b.setAttribute('aria-pressed',String(b===tab));});tabs.append(tab);
     const differences=gap(row),metrics=el('div',null,'task-event-total-grid');for(const [key,label] of [['badges','道具总收益'],['eventPoints','活动 pt 总收益']]){const cell=el('div');cell.append(el('small',label),el('strong',fmt(row.total[key])),el('small',`比收益第一${gapText(differences[key])}`,'task-event-yield-gap'));metrics.append(cell);}article.append(metrics);
     const gapRow=el('span',null,'task-event-choice-gap');for(const [key,label] of [['badges','道具'],['eventPoints','pt']]){const value=differenceLabel[key],cell=el('span');cell.dataset.gap=value===0?'equal':value>0?'less':'more';cell.append(el('small',label),el('b',value===0?'持平':`${value>0?'−':'+'}${fmt(Math.abs(value))}`));gapRow.append(cell);}tab.append(gapRow);
     article.append(el('small',row.reward.mode==='ordinary'?'普通演出阶段':'挑战演出阶段','task-result-eyebrow'),el('h4',`${row.song.title} · ${row.song.difficulty.toUpperCase()} · ${grades[row.reward.scoreRank-2]}`));
     if(row.recommendationGoals?.length)article.append(el('strong',row.recommendationGoals.map(goal=>EVENT_YIELD_GOAL_LABELS[goal]).join(' / ')));
     article.append(el('p',`${row.performanceScenario?'当前发挥':'AP'} ${fmt(row.estimatedScore)} 分 · 估计档位范围 ${grades[row.minimumRank-2]}–${grades[row.maximumRank-2]} · 综合力 ${fmt(row.power)} · ${row.song.seconds==null?'时长未知':fmt(row.song.seconds)+' 秒'}`,'event-hint'));
     article.append(eventTeamDetails(tool,row));
     article.append(el('p',`道具加成 +${fmt(row.bonuses.rewardBP/100)}% · 活动 pt 加成 +${fmt(row.bonuses.eventPointBP/100)}%`));
     article.append(el('p',`每次：${fmt(row.reward.badges)} 道具 · ${fmt(row.reward.eventPoints)} 活动 pt · ${fmt(row.reward.challengePoints)} 挑战 pt`));
     if(row.reward.mode==='ordinary'){
       article.append(el('strong',`${row.continuation?'普通＋挑战总计':'普通阶段总计'}：${fmt(row.total.badges)} 道具 · ${fmt(row.total.eventPoints)} 活动 pt`));
       article.append(el('p',`${row.normalPlays} 次普通演出，耗 ${row.spentFire} 火（预算余 ${row.remainingFire} 火），新获得 ${fmt(row.earnedCP)} 挑战 pt${row.startingCP?`；另有 ${fmt(row.startingCP)} 已有挑战 pt`:''}。${row.continuation?`后续挑战 ${row.continuation.plays} 次，剩余 ${row.continuation.remainingCP} 挑战 pt。`:'挑战 pt 尚未兑换。'}`));
       article.append(el('p',`${row.startingCP?'含已有挑战 pt 的预算比值':'完整方案每火'}：${fmt(row.total.badges/row.spentFire)} 道具 / ${fmt(row.total.eventPoints/row.spentFire)} 活动 pt`,'event-hint'));
     }else article.append(el('strong',`每挑战 pt：${fmt(row.reward.badges/row.reward.challengeCost)} 道具 · ${fmt(row.reward.eventPoints/row.reward.challengeCost)} 活动 pt`));
     const apply=el('button',row.reward.mode==='challenge'?'应用挑战收益队伍和歌曲':'应用普通队伍、歌曲和估计档位');apply.type='button';apply.addEventListener('click',()=>applyEventPlan(tool,row,row.reward.mode));article.append(apply,eventTeamSaveButton(row.draft,`${row.song.title} · 收益队伍`));
     if(row.continuation){
       const section=el('section',null,'event-recommendations');section.append(el('h4','后续挑战 · 独立队伍'));
       section.append(el('p',`普通阶段小计：${fmt(row.normalPlays*row.reward.badges)} 道具 · ${fmt(row.normalPlays*row.reward.eventPoints)} 活动 pt`));
       section.append(el('strong',`挑战阶段小计：${fmt(row.continuation.badges)} 道具 · ${fmt(row.continuation.eventPoints)} 活动 pt`));
       if(!row.continuation.stages.length)section.append(el('p','挑战 pt 尚不足一次挑战；保留余额，本次不计入挑战收益。'));
       const stageTabs=el('div',null,'task-event-result-tabs');stageTabs.setAttribute('role','group');stageTabs.setAttribute('aria-label','后续挑战消耗方案');section.append(stageTabs);
       const stagePanels=[];
       for(const [stageIndex,stage] of row.continuation.stages.entries()){
         const panel=el('section');panel.hidden=stageIndex!==0;stagePanels.push(panel);
         const stageTab=el('button',`${stage.cost} pt × ${stage.plays} 次`);stageTab.type='button';stageTab.setAttribute('aria-pressed',String(stageIndex===0));stageTab.addEventListener('click',()=>{for(const n of stagePanels)n.hidden=n!==panel;for(const b of stageTabs.children)b.setAttribute('aria-pressed',String(b===stageTab));});stageTabs.append(stageTab);
         const r=stage.row;
         panel.append(el('h5',`${r.song.title} · ${r.song.difficulty.toUpperCase()} · ${grades[r.reward.scoreRank-2]} 档 · ${stage.cost} 挑战 pt × ${stage.plays} 次`));
         panel.append(el('p',`活动内综合力 ${fmt(r.power)} · ${r.performanceScenario?'当前发挥':'AP'} ${fmt(r.estimatedScore)} 分 · 估计档位范围 ${grades[r.minimumRank-2]}–${grades[r.maximumRank-2]}`,'event-hint'));
         panel.append(el('p',`道具加成 +${fmt(r.bonuses.rewardBP/100)}% · 活动 pt 加成 +${fmt(r.bonuses.eventPointBP/100)}%；每次 ${fmt(stage.reward.badges)} 道具 · ${fmt(stage.reward.eventPoints)} 活动 pt`));
         panel.append(eventTeamDetails(tool,r));
         const use=el('button','应用这支后续挑战队伍');use.type='button';use.addEventListener('click',()=>{tool.q('cost').value=String(stage.cost);applyEventPlan(tool,r,'challenge');});panel.append(use,eventTeamSaveButton(r.draft,`${r.song.title} · 后续挑战`));section.append(panel);
       }article.append(section);
     }
     q('results').append(article);
   }
   if(pageCount>1){const pager=el('div',null,'task-event-plan-sort'),prev=el('button','上一页方案'),nextPage=el('button','下一页方案');prev.type=nextPage.type='button';prev.disabled=page===0;nextPage.disabled=page===pageCount-1;prev.addEventListener('click',()=>{page--;render();});nextPage.addEventListener('click',()=>{page++;render();});pager.append(prev,el('small',`${page+1} / ${pageCount}`),nextPage);q('results').append(pager);}
   if(result.failures.length){const d=el('details',null,'event-details');d.append(el('summary',`${result.failures.length} 张谱面失败，已排除，结果不完整`));for(const f of result.failures)d.append(el('p',`${f.title}：${f.message}`));q('results').append(d);}
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
     const allowed=tool.data.rules.tables.ChallengeMusic.filter(r=>r._eventId===c.eventId).map(r=>`music-${r._liveMusicId}`);
     const filterSongs=c.mode==='ordinary'&&c.songs!=='selected';
     let candidates=eventSongCandidates({...tool.data,allowedTrackIds:c.mode==='challenge'?allowed:null,difficulty:c.songs==='selected'?'all':c.difficulty,maxLevel:c.songs==='selected'?40:c.maxLevel,band:filterSongs?c.band:'',attribute:filterSongs?c.attribute:''});
     if(c.songs==='selected')candidates=candidates.filter(r=>r.trackId===c.draft.selectedSongId&&r.difficulty===(c.draft.selectedDifficulty??'expert'));
     if(!candidates.length)throw Error(filterSongs?'没有符合条件的可计算歌曲，请放宽乐队、歌曲属性或难度范围。':'没有可计算的歌曲，请选歌或调整难度范围。');
     const challengeCandidates=eventSongCandidates({...tool.data,allowedTrackIds:allowed,difficulty:c.challengeDifficulty,maxLevel:c.challengeMaxLevel});
     if(c.mode==='ordinary'&&c.includeChallenge&&!challengeCandidates.length)throw Error('后续挑战没有符合难度范围的谱面，请放宽条件或只比较普通阶段。');
     if(c.mode==='challenge'&&c.goal==='grade')c.goal='badges';
     result=null;renderKey='';page=0;q('continue').hidden=true;q('results').replaceChildren();worker=new Worker(new URL('./event-yield-worker.mjs',import.meta.url),{type:'module'});
     const active=worker;q('cancel').hidden=false;q('run').disabled=true;tool.q('suggest').disabled=true;root.setAttribute('aria-busy','true');q('status').textContent='正在准备卡库、实际养成与谱面…';
     worker.addEventListener('message',({data})=>{
       if(worker!==active)return;
       if(data.type==='progress'){q('status').textContent=`${data.stage}：${data.title}（${data.done} / ${data.total}）`;return;}
       if(data.type==='partial'){result=data;render();q('status').textContent=`已比较 ${data.done} / ${data.total} 张谱面，展示目前领先方案；还在计算，排名可能改变。`;return;}
       stop();if(data.type==='result'){
         result=data;render();q('continue').hidden=data.complete;
         q('status').textContent=`${data.complete?'完整比较完成':'快速推荐完成'}：已比较 ${data.done} / ${data.available} 张谱面。${data.complete?'':'可继续比较其余谱面，已算结果会复用。'}展示 ${data.rows.length} 个队伍＋歌曲方案${data.cacheHits?`，复用 ${data.cacheHits} 次估分`:''}。有限候选搜索，不保证全卡库最优${data.failures.length?'；有计算失败，结果不完整':''}。`;
       }else {q('continue').hidden=!result;q('status').textContent=`计算失败：${data.message}${result?'；保留已完成的方案，可继续比较。':''}`;}
     });
     worker.addEventListener('error',()=>{if(worker!==active)return;stop();q('status').textContent='计算服务加载失败，请重试。';});
     worker.postMessage({rules:tool.data.rules,eventId:c.eventId,candidates,challengeCandidates,input:c});
   }catch(error){stop();q('status').textContent=error.message;tool.q('team-status').textContent=error.message;}
 }
 q('run').addEventListener('click',()=>run());q('continue').addEventListener('click',()=>run('full'));q('cancel').addEventListener('click',()=>{stop();q('continue').hidden=!result;q('status').textContent=result?'已停止。保留已完成的方案，仍有谱面未比较；继续时会复用计算缓存。':'已停止收益配队计算。';});
 root.addEventListener('change',event=>{event.stopPropagation();sync();});
 return {sync,run,invalidate:()=>{key='';stop();sync();},destroy:stop};
}
