import {setupQuickOptions} from './tool-quick-options.mjs';
import {currentEventDraft} from './event-team-view.mjs';
import {eventToolSearch} from './ap-grade.mjs';
import {setupEventYieldOptimizer} from './event-yield-ui.mjs';
import {setupChallengeOptimizer} from './challenge-optimizer-ui.mjs';
import {setupEventCardPicker} from './event-card-picker.mjs';
import {setupEventSongRanking} from './event-song-ranking-ui.mjs';
import {setupCalculatorSongPicker} from './calculator-song-picker.mjs';
import {createEventEfficiency, planChallengeSpending} from './scoring-rules/event-efficiency.mjs';
import {createTeamDraft,parseTeamDraftSearch,serializeTeamDraftSearch} from './team-draft.mjs';
import {createPersonalGrowthStore, applyPersonalGrowth} from './personal-growth-store.mjs';
import {toolRoute} from './tool-route.mjs';
const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
const ranks=['D','C','B','A','S','SS'];
const id=value=>Number(value.split('-').at(-1));
const percent=node=>{if(node.value.trim()==='')throw Error('请填写游戏显示的加成；没有加成时填 0。');const n=Number(node.value);if(!Number.isFinite(n)||n<0||n>100000)throw Error('加成应为 0–100000%');return Math.round(n*100);};
class EventEfficiencyTool extends HTMLElement {
 connectedCallback(){
  if(this.ready)return;this.ready=true;
  this.data=JSON.parse(this.querySelector('[data-event-inputs]').textContent);
  this.q=s=>this.querySelector(`[data-${s}]`);this.pairs=[...this.querySelectorAll('.event-pair')];
  this.draft=createTeamDraft(parseTeamDraftSearch(location.search,{memberCardIds:new Set(this.data.memberCards.map(c=>c.id)),supportCardIds:new Set(this.data.supportCards.map(c=>c.id)),musicTrackIds:new Set(this.data.tracks.map(t=>t.id))}).draft);
  this.personalGrowthStore=createPersonalGrowthStore({rules:this.data.rules,vipRanks:this.data.vipRanks});
  try{applyPersonalGrowth(this.draft,this.personalGrowthStore.read());}catch(error){this.q('team-status').textContent=`个人养成未载入：${error.message}`;}
  this.pairs.forEach((p,i)=>{for(const kind of ['member','support']){const card=this.draft.slots[i][`${kind}CardId`];p.querySelector(`[data-${kind}]`).value=card??'';p.querySelector(`[data-${kind}-rank]`).value=this.draft.modifiers.growth?.[card]?.rank??1;}});
  if(this.draft.selectedSongId)this.q('song').value=this.draft.selectedSongId;
  const linked=new URLSearchParams(location.search);
  for(const [param,field] of [['eventMode','mode'],['eventId','event'],['scoreRank','rank'],['boost','boost'],['cost','cost']]){
   const value=linked.get(param),node=this.q(field);if(value!=null&&[...node.options].some(o=>o.value===value))node.value=value;
  }
  if(['expectedScore','minimumScore','maximumScore'].includes(linked.get('apBasis')))for(const selector of ['[data-rec-score-basis]','[data-yield-basis]'])this.querySelector(selector).value=linked.get('apBasis');
  this.cardPicker=setupEventCardPicker(this);
  this.songRanking=setupEventSongRanking(this);
  this.challengeOptimizer=setupChallengeOptimizer(this);
  this.yieldOptimizer=setupEventYieldOptimizer(this);
  this.songPicker=setupCalculatorSongPicker(this,{getSelection:()=>this.draft,allowedTrackIds:()=>this.q('mode').value==='challenge'?new Set(this.data.rules.tables.ChallengeMusic.filter(r=>r._eventId===Number(this.q('event').value)).map(r=>`music-${r._liveMusicId}`)):null,onSelect:selection=>{Object.assign(this.draft,selection);this.q('song').value=selection.selectedSongId;this.q('song-disclosure').open=false;this.render();}});
  this.addEventListener('change',event=>{if(event.target.closest('[data-card-dialog]')||event.target.closest('[data-song-picker]'))return;if(event.target.matches('[data-mode],[data-event]'))this.songPicker?.reset();this.render();});this.q('suggest').addEventListener('click',()=>this.suggest());
  this.q('copy-bonus').addEventListener('click',()=>{if(this.rewardBP!=null){this.q('challenge-bonus').value=this.rewardBP/100;this.q('challenge-point-bonus').value=this.eventPointBP/100;this.render();}});
  this.q('save').addEventListener('click',()=>{if(this.current){this.saved={...this.current};this.render();}});
  const bonusPanel=this.querySelector('.event-quick-bonus');bonusPanel.append(this.querySelector('.event-grade'));
  const setTask=task=>{this.dataset.task=task;this.q('bonus-source').value=task==='quick'?'manual':'team';bonusPanel.open=task==='quick';for(const b of this.querySelectorAll('[data-event-task]'))b.setAttribute('aria-pressed',String(b.dataset.eventTask===task));this.render();};
  for(const b of this.querySelectorAll('[data-event-task]'))b.addEventListener('click',()=>setTask(b.dataset.eventTask));
  this.shortcuts=setupQuickOptions(this);
  this.addEventListener('input',event=>{if(event.target.matches('[data-manual-bonus],[data-manual-point-bonus],[data-budget],[data-start-cp]'))this.render();});
  setTask(this.draft.slots.some(s=>s.memberCardId||s.supportCardId)?'team':'quick');
  if(linked.has('apBasis'))this.q('team-status').textContent='已带入 AP 预测的队伍、歌曲和估计档位，可按实打调整。';
 }
 disconnectedCallback(){this.shortcuts?.destroy();this.songRanking?.destroy();this.challengeOptimizer?.destroy();this.yieldOptimizer?.destroy();}
 model(){return createEventEfficiency({tables:this.data.rules.tables,sourceReleaseId:this.data.rules.sourceReleaseId,eventId:Number(this.q('event').value)});}
 suggest(){this.yieldOptimizer?.run();}
 render(){
  this.shortcuts?.sync();
  this.current=null;this.rewardBP=null;this.eventPointBP=null;this.canEstimateTeam=false;
  const mode=this.q('mode').value,manual=this.q('bonus-source').value==='manual';
  this.q('manual-wrap').hidden=!manual;this.q('boost').disabled=mode==='challenge';this.q('cost').disabled=mode!=='challenge';
  this.q('unit').textContent=mode==='challenge'?'徽章 / 挑战 pt':'徽章 / 火';
  this.q('rewards').replaceChildren();this.q('cycle').textContent='';this.q('comparison').textContent='';
  this.q('boost-wrap').hidden=mode==='challenge';this.q('cost-wrap').hidden=mode!=='challenge';
  this.q('budget-details').hidden=mode==='challenge';
  this.q('pool-hint').textContent=this.q('pool').value==='owned'?'使用已保存卡库的实际等级、突破、觉醒与技能，比较队伍和歌曲。':'保留当前十张卡，比较队长、留影配对和歌曲；缺失养成沿用计算器默认值。';
  this.q('mode-hint').textContent=mode==='challenge'?'挑战演出消耗挑战 pt，不耗火。下方仅展示本活动的挑战歌曲。':'普通演出获得徽章、活动 pt 和挑战 pt；后者还能用于挑战演出。';
  this.q('rank-hint').textContent=mode==='challenge'?'填写活动内挑战的稳定评分；普通歌曲估分不包含挑战专属加成。':'填写稳定评分。可用下方分数计算辅助判断，最终以游戏内结算为准。';
  this.songPicker?.refresh();
  const allowed=mode==='challenge'?this.data.rules.tables.ChallengeMusic.filter(r=>r._eventId===Number(this.q('event').value)).map(r=>`music-${r._liveMusicId}`):null;
  if(allowed&&!allowed.includes(this.q('song').value)){this.q('song').value='';this.draft.selectedSongId=null;this.draft.selectedDifficulty=null;this.q('song-disclosure').open=true;this.songPicker?.sync();}
  this.q('selected-song').textContent=this.q('song').value?`${this.q('song').selectedOptions[0].textContent} · ${(this.draft.selectedDifficulty??'expert').toUpperCase()}`:'选择一首歌曲';
  this.cardPicker?.sync();this.q('save').disabled=true;this.q('copy-bonus').disabled=true;
  for(const key of ['value','bonus','point-bonus','badges','points','cp'])this.q('summary-'+key).textContent='—';
  this.q('summary-unit').textContent=mode==='challenge'?'徽章 / 挑战 pt':'徽章 / 火';
  this.q('summary-title').textContent='先准备活动队伍';this.q('summary-context').textContent='选择五组卡牌，或直接填写加成。';this.q('next-step').textContent='推荐候选后，确认卡片突破与稳定评分。';
  this.q('result-caption').textContent='完成队伍或填写加成后，即可查看收益。';
  try{
   const model=this.model();
   const slots=this.pairs.map(p=>({memberId:id(p.querySelector('[data-member]').value),supportId:id(p.querySelector('[data-support]').value),memberRank:Number(p.querySelector('[data-member-rank]').value),supportRank:Number(p.querySelector('[data-support-rank]').value)}));
   if(!manual){const missing=slots.reduce((n,s)=>n+Number(!s.memberId)+Number(!s.supportId),0);if(missing)throw Error(`还差 ${missing} 张卡片。可点击「推荐队伍＋歌曲收益」，或逐个位置选卡。`);const members=slots.map(s=>this.data.rules.tables.MemberCard.find(c=>c._id===s.memberId)?._characterID);if(new Set(members).size!==5)throw Error('一支队伍只能使用五位不同角色，请更换重复角色的成员卡。');if(new Set(slots.map(s=>s.supportId)).size!==5)throw Error('同一张留影不能放入多个位置，请更换重复留影。');}
   let teamBonuses;try{teamBonuses=model.teamBonus(slots);this.canEstimateTeam=true;}catch(error){if(!manual)throw error;}
   const bonuses=manual?{rewardBP:percent(this.q('manual-bonus')),eventPointBP:percent(this.q('manual-point-bonus'))}:teamBonuses;
   const bp=bonuses.rewardBP,pointBP=bonuses.eventPointBP;this.rewardBP=bp;this.eventPointBP=pointBP;
   this.q('bonus').textContent=`道具加成 +${fmt(bp/100)}% · 活动 pt 加成 +${fmt(pointBP/100)}%。两者分别计算，挑战 pt 不受这两项加成影响。`;
   this.draft.slots=this.pairs.map(p=>({memberCardId:p.querySelector('[data-member]').value,supportCardId:p.querySelector('[data-support]').value}));
   this.draft.selectedSongId=this.q('song').value;this.draft.selectedDifficulty??='expert';
   this.draft.modifiers.growth??={};
   for(const [i,s] of slots.entries())for(const kind of ['member','support']){const key=this.draft.slots[i][`${kind}CardId`];if(!key)continue;this.draft.modifiers.growth[key]={...this.draft.modifiers.growth[key],rank:s[`${kind}Rank`]};}
   this.q('score-link').href=toolRoute('/tools/song-calculator/',location.pathname)+serializeTeamDraftSearch(this.draft);
   this.q('score-link').hidden=!this.canEstimateTeam||mode==='challenge'||!this.draft.selectedSongId;
   if(mode==='gekisou')this.q('score-link').href+='&scoreMode=gekisou';
   const opts={mode,rewardBP:bp,eventPointBP:pointBP,liveBoost:mode==='challenge'?0:Number(this.q('boost').value),challengeCost:Number(this.q('cost').value)};
   for(let scoreRank=2;scoreRank<=7;scoreRank++){
    const r=model.rewards({...opts,scoreRank}),tr=document.createElement('tr');tr.setAttribute('aria-current',String(scoreRank===Number(this.q('rank').value)));
    for(const value of [ranks[scoreRank-2],r.challengePoints,r.eventPoints,r.badges,mode==='challenge'?r.badgesPerChallengePoint:r.badgesPerBoost]){const td=document.createElement('td');td.textContent=value==null?'—':typeof value==='number'?fmt(value):value;tr.append(td);}this.q('rewards').append(tr);
    if(scoreRank===Number(this.q('rank').value))this.current={...r,title:this.q('song').value?this.q('song').selectedOptions[0].textContent:'未指定歌曲'};
   }
   const current=this.current;this.q('save').disabled=false;this.q('copy-bonus').disabled=false;
   this.q('summary-title').textContent=`${ranks[current.scoreRank-2]} 评分 · ${mode==='challenge'?current.challengeCost+' pt':current.liveBoost+' 火'}`;
   this.q('summary-context').textContent=this.q('song').value?`${current.title} · ${(this.draft.selectedDifficulty??'expert').toUpperCase()}`:'按游戏评分与填写的加成计算，无需选择歌曲';
   this.q('summary-value').textContent=(mode==='challenge'?current.badgesPerChallengePoint:current.badgesPerBoost)==null?'—':fmt(mode==='challenge'?current.badgesPerChallengePoint:current.badgesPerBoost);
   for(const [key,value] of [['bonus','+'+fmt(bp/100)+'%'],['point-bonus','+'+fmt(pointBP/100)+'%'],['badges',fmt(current.badges)],['points',fmt(current.eventPoints)],['cp',fmt(current.challengePoints)]])this.q('summary-'+key).textContent=value;
   this.q('next-step').textContent=this.dataset.task==='quick'?'调整加成、评分或耗火，结果会立即更新。也可记住方案再比较。':!this.q('song').value?'下一步：选择歌曲与难度，确认能否稳定达到这个评分。':mode==='challenge'?'确认活动内评分后，可记住方案，换一支队伍比较。':'可记住当前方案，再换卡或改变稳定评分，查看同耗火收益差异。';
   this.q('result-caption').textContent=`高亮行是当前 ${ranks[current.scoreRank-2]} 评分，每次${mode==='challenge'?'消耗 '+current.challengeCost+' 挑战 pt':'消耗 '+current.liveBoost+' 火'}，道具加成 +${fmt(bp/100)}%、活动 pt 加成 +${fmt(pointBP/100)}%。`;
   if(this.saved){const s=this.saved,r=this.current;this.q('comparison').textContent=s.eventId!==r.eventId||s.mode!==r.mode||s.liveBoost!==r.liveBoost||s.challengeCost!==r.challengeCost?'已保存方案与当前活动、模式或消耗不同，请使用相同条件比较。':`已保存：${s.title} · ${ranks[s.scoreRank-2]} · 道具 +${fmt(s.rewardBP/100)}% / 活动 pt +${fmt(s.eventPointBP/100)}% · ${fmt(s.badges)} 徽章。当前每次${r.badges>=s.badges?'多':'少'} ${fmt(Math.abs(r.badges-s.badges))} 徽章，活动 pt ${r.eventPoints>=s.eventPoints?'多':'少'} ${fmt(Math.abs(r.eventPoints-s.eventPoints))}。`;}
   if(mode==='challenge'){this.q('cycle').textContent='切换普通或激奏演出，计算刷取与后续挑战的完整预算。';return;}
   try{const budget=Number(this.q('budget').value),start=Number(this.q('start-cp').value),boost=opts.liveBoost;
   if(!Number.isInteger(budget)||budget<1||budget>10000||!Number.isInteger(start)||start<0||start>1000000)throw Error('请使用范围内的整数预算。');
   if(!boost){this.q('cycle').textContent='0 火没有每火比值；设置至少 1 火可计算预算。';return;}
   const normalPlays=Math.floor(budget/boost),challengeBonus=percent(this.q('challenge-bonus')),challengePointBonus=percent(this.q('challenge-point-bonus'));
   const challengeOptions=this.data.rules.tables.ChallengeMusicBoostBonus.map(r=>model.rewards({mode:'challenge',scoreRank:Number(this.q('challenge-rank').value),rewardBP:challengeBonus,eventPointBP:challengePointBonus,challengeCost:r._consumedChallengePointCount}));
   const plan=planChallengeSpending(challengeOptions,start+normalPlays*this.current.challengePoints);
   const badges=normalPlays*this.current.badges+plan.badges,points=normalPlays*this.current.eventPoints+plan.eventPoints;
   this.q('cycle').textContent=`普通阶段 ${normalPlays} 次，消耗 ${normalPlays*boost} 火，预算余 ${budget-normalPlays*boost} 火；挑战 ${plan.plays} 次（${plan.consumption.map(r=>r.cost+' pt × '+r.plays).join('，')||'挑战 pt 不足'}）。共 ${fmt(badges)} 徽章、${fmt(points)} 活动 pt；剩余 ${plan.remainingCP} 挑战 pt。${start?'总收益含已有挑战 pt，不能全归为本次耗火收益。':normalPlays?`折合 ${fmt(badges/(normalPlays*boost))} 徽章 / 火。`:''}`;
  }catch(e){this.q('cycle').textContent=e.message;}
  }catch(e){this.q('bonus').textContent=e.message;this.q('score-link').hidden=true;}
  finally{this.q('ap-link').href=toolRoute('/tools/ap-grade/',location.pathname)+eventToolSearch(currentEventDraft(this),{mode:mode==='challenge'?'challenge':'ordinary',eventId:Number(this.q('event').value),boost:Number(this.q('boost').value),cost:Number(this.q('cost').value)});this.songRanking?.sync();this.challengeOptimizer?.sync();this.yieldOptimizer?.sync();}
 }
}
if(!customElements.get('event-efficiency-tool'))customElements.define('event-efficiency-tool',EventEfficiencyTool);
