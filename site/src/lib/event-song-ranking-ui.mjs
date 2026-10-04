import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {skillActivation} from './skill-activation-view.mjs';
import {eventSongCandidates,eventSongYield,sortEventSongs} from './event-song-ranking.mjs';
const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
const grades=['D','C','B','A','S','SS'];
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};

export function setupEventSongRanking(tool){
 const root=tool.q('song-recommendations'),q=s=>root.querySelector(`[data-rec-${s}]`);
 let worker=null,key='',rows=null,failures=[],page=0,candidates=[],context=null;
 const stop=()=>{worker?.terminate();worker=null;q('cancel').hidden=true;q('run').disabled=false;};
 function sync(){
  const mode=tool.q('mode').value;
  const options={mode,rewardBP:tool.rewardBP,eventPointBP:tool.eventPointBP,scoreRank:Number(tool.q('rank').value),liveBoost:mode==='challenge'?0:Number(tool.q('boost').value),challengeCost:Number(tool.q('cost').value)};
  options.scoreBasis=q('score-basis').value;
  const conditional=mode==='gekisou'||!tool.canEstimateTeam||options.scoreBasis==='manual';
  const next={eventId:Number(tool.q('event').value),options,conditional,difficulty:q('difficulty').value,maxLevel:Number(q('level').value),draft:{slots:tool.draft.slots,modifiers:tool.draft.modifiers}};
  // Song selection doesn't change the fixed team used for ranking.
  const fingerprint=JSON.stringify({...next,options:{...options,scoreRank:conditional?options.scoreRank:null}});
  context=next;
  candidates=eventSongCandidates({...tool.data,allowedTrackIds:mode==='challenge'?tool.data.rules.tables.ChallengeMusic.filter(r=>r._eventId===next.eventId).map(r=>`music-${r._liveMusicId}`):null,difficulty:next.difficulty,maxLevel:next.maxLevel});
  if(fingerprint!==key){stop();key=fingerprint;rows=null;failures=[];page=0;}
  if(conditional&&options.rewardBP!=null){const reward=tool.model().rewards(options);rows=candidates.map(c=>({...c,scoreRank:options.scoreRank,reward,yield:eventSongYield(reward),estimated:false}));}
  q('run').hidden=conditional;q('run').disabled=!!worker||options.rewardBP==null||!candidates.length;
  q('basis').textContent=conditional?(mode==='gekisou'?'按上方填写的团队结算评分比较，不预测随机房间出分。':'按上方填写的稳定评分比较，不估算卡组出分。')+'同评分的歌曲收益相同，再按时长排序。':'收益使用上方分别设置的两项加成。估分使用当前队伍、槽位与养成，平均方式按各技能顺序分别判档计算收益，最低/最高方式按对应分数判档；同时展示 120 种技能顺序的估计档位范围；实际时机误差可能超出范围，不代表实打保底。未保存的养成使用计算器默认值（技能等级 1），突破 5 不等于全部满练。';
  q('unit').textContent=mode==='challenge'?'以下三列均为每消耗 1 挑战 pt 的直接收益；不含后续阶段。':options.liveBoost?'以下三列均为每火直接收益；挑战 pt 可用于后续挑战，暂不折算徽章。':'当前为 0 火：没有每火比值，列表展示每次直接奖励。';
  for(const [value,label] of [['badges','徽章'],['eventPoints','活动 pt']])q('sort').querySelector(`[value="${value}"]`).textContent=`${mode==='challenge'?'每挑战 pt':options.liveBoost?'每火':'每次'}${label}优先`;
  render();
 }
 function render(){
  const metric=q('sort').value;
  const zero=context.options.mode!=='challenge'&&!context.options.liveBoost;
  const source=rows??candidates;
  const ranked=sortEventSongs(zero&&rows?rows.map(r=>({...r,yield:{badges:r.reward.badges,eventPoints:r.reward.eventPoints,challengePoints:r.reward.challengePoints}})):source,rows?metric:'short');
  const pages=Math.max(1,Math.ceil(ranked.length/8));page=Math.min(page,pages-1);
  if(!worker)q('status').textContent=rows?`已比较 ${rows.length} 张谱面${failures.length?`，${failures.length} 张失败并已排除，请重试`:'，同收益优先短歌'}。`:tool.rewardBP==null?`先浏览 ${candidates.length} 张短歌谱面；完成队伍或手填加成后比较收益。`:`共 ${candidates.length} 张谱面。${metric==='short'?'可直接按时长选歌；点击计算可查看收益。':'尚未计算收益，当前仅按时长展示。'}`;
  root.setAttribute('aria-busy',String(!!worker));q('results').replaceChildren();
  for(const [index,row] of ranked.slice(page*8,page*8+8).entries()){
   const card=el('article',null,'event-rec-row'),heading=el('div',null,'event-rec-heading');
   heading.append(el('span',String(page*8+index+1).padStart(2,'0'),'event-rec-position'),el('strong',row.title));
   const seconds=row.seconds==null?'时长未知':`${fmt(row.seconds)} 秒`;
   const meta=el('p',`${seconds} · ${row.difficulty.toUpperCase()} ${row.level}${row.scoreRank?` · ${row.estimated?'AP 估计':'填写评分'} ${grades[row.scoreRank-2]}`:''}`);
   const yields=el('dl',null,'event-rec-yields');
   for(const [metric,label] of [['badges','徽章'],['eventPoints','活动 pt'],['challengePoints','挑战 pt']]){
    const value=zero?row.reward?.[metric]:row.yield?.[metric];const cell=el('div');cell.append(el('dt',label),el('dd',value==null?'待计算':fmt(value)));yields.append(cell);
   }
   const choose=el('button',row.estimated?'选用并填入估计评分':'选择这首歌');choose.type='button';choose.addEventListener('click',()=>{
    tool.draft.selectedSongId=row.trackId;tool.draft.selectedDifficulty=row.difficulty;tool.q('song').value=row.trackId;
    if(row.estimated)tool.q('rank').value=String(row.scoreRank);
    tool.q('song-disclosure').open=false;tool.songPicker?.sync();tool.render();
    q('selection').textContent=`已选择 ${row.title} · ${row.difficulty.toUpperCase()}${row.estimated?'，已填入所选 AP 分数对应的档位；上方单档奖励与列表的平均收益可能不同，请按实打情况调整。':'。'}`;
   });
   card.append(heading,meta);
   if(row.estimated)card.append(el('p',`综合力 ${fmt(row.power)} · AP ${fmt(row.estimatedScore)} 分 · 估计档位范围 ${grades[row.minimumRank-2]}–${grades[row.maximumRank-2]}`,'event-hint'));
   if(row.reward?.rewardBasis==='order_expectation')card.append(el('p',`以下为各顺序先判档、再结算的平均收益。档位分布：${row.gradeProbabilities.filter(g=>g.count).map(g=>`${grades[g.rank-2]} ${fmt(g.probability*100)}%`).join(' / ')}。假定 120 种 AP 技能顺序等可能。`,'event-hint'));
   card.append(yields,choose);
   if(row.estimated)card.append(skillActivation(tool,{...structuredClone(tool.draft),selectedSongId:row.trackId,selectedDifficulty:row.difficulty},{mode:context.options.mode,eventId:context.eventId}));
   q('results').append(card);
  }
  q('page').textContent=`${page+1} / ${pages}`;q('prev').disabled=page===0;q('next').disabled=page===pages-1;
  q('empty').hidden=ranked.length>0;
 }
 q('run').addEventListener('click',()=>{
  if(worker||context.conditional||context.options.rewardBP==null)return;
  rows=null;failures=[];page=0;
  try{assertToolTeamCompatible(tool.teamWorkspaceContext);worker=new Worker(new URL('./event-song-ranking-worker.mjs',import.meta.url),{type:'module'});
   const active=worker;
   q('cancel').hidden=false;q('run').disabled=true;q('status').textContent=`正在计算 0 / ${candidates.length} 张谱面…`;render();
   worker.addEventListener('message',({data})=>{
    if(worker!==active)return;
    if(data.type==='progress'){q('status').textContent=`正在计算 ${data.done} / ${data.total} 张谱面…`;return;}
    stop();if(data.type==='result'){rows=data.rows;failures=data.failures;render();}else{render();q('status').textContent=`计算失败：${data.message}`;}
   });
   worker.addEventListener('error',()=>{if(worker!==active)return;stop();render();q('status').textContent='计算服务加载失败，请重试。';});
   worker.postMessage({rules:tool.data.rules,eventId:context.eventId,candidates,draft:tool.draft,options:context.options});
  }catch(error){stop();render();q('status').textContent=`无法启动计算：${error.message}`;}
 });
 q('cancel').addEventListener('click',()=>{stop();render();q('status').textContent='已停止计算；可调整条件后重新比较。';});
 root.addEventListener('change',e=>{e.stopPropagation();page=0;if(e.target===q('sort'))render();else sync();});
 for(const [name,delta] of [['prev',-1],['next',1]])q(name).addEventListener('click',()=>{page+=delta;render();});
 return {sync,invalidate:()=>{key='';stop();sync();},destroy:stop};
}
