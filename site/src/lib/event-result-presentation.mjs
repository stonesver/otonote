import {eventMistakeReference} from './event-mistake-reference-view.mjs';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const fmt=n=>Number.isFinite(n)?n.toLocaleString('zh-CN',{maximumFractionDigits:1}):'—';
const grades=['D','C','B','A','S','SS'];
const rank=n=>grades[n-2]??'—';
export function eventSongHeading(data,song,{label='',grade,basis,plays}={}) {
 const track=data.tracks?.find(track=>track.id===song.trackId),root=el('header',null,'event-result-song');
 if(track?.jacketUrl){const art=el('img',null,'event-song-cover');art.src=track.jacketUrl;art.alt='';art.loading='lazy';root.append(art);}
 const copy=el('div',null,'event-song-copy'),title=el('h4',song.title??track?.title??song.trackId),meta=el('div',null,'event-song-meta');
 if(label)meta.append(el('small',label,'task-result-eyebrow'));
 const difficulty=el('span',`${song.difficulty?.toUpperCase()??'—'}${song.level!=null?' · '+song.level:''}`,'event-difficulty');difficulty.dataset.difficulty=song.difficulty;meta.append(difficulty);
 if(grade)meta.append(el('span',`${grade} 档${basis?' · '+basis:''}`,'event-song-grade'));
 for(const band of track?.bandVisuals??[]){if(!band.icon)continue;const icon=el('img',null,'event-song-band');icon.src=band.icon;icon.alt=band.label;icon.title=band.label;meta.append(icon);}
 if(plays!=null)meta.append(el('span',`${plays} 次`));
 copy.append(title,meta);root.append(copy);return root;
}
export function eventMetricList(entries,cls=''){
 const list=el('dl',null,`event-metric-list ${cls}`);
 for(const [label,value] of entries){const cell=el('div');cell.append(el('dt',label),el('dd',value));list.append(cell);}return list;
}
export function eventPerformanceFacts(row){
 const range=row.minimumRank===row.maximumRank?rank(row.minimumRank):`${rank(row.minimumRank)}–${rank(row.maximumRank)}`;
 const basis=row.scoreBasis==='minimumScore'?'最低分':row.scoreBasis==='maximumScore'?'最高分':'平均分';
 return eventMetricList([[`${row.performanceScenario?'预计':'AP'} ${basis}`,fmt(row.estimatedScore)],['档位范围',range],['综合力',fmt(row.power)],['道具加成',`+${fmt(row.bonuses.rewardBP/100)}%`],['活动 pt 加成',`+${fmt(row.bonuses.eventPointBP/100)}%`]],'event-performance-facts');
}
function gradeFacts(row,rules){
 const target=row.reward.scoreRank,music=rules.tables.LiveMusic.find(m=>`music-${m._id}`===row.song.trackId);
 const threshold=rules.tables.LiveScoreRank.find(r=>r._group===music._liveScoreRankGroup&&r._liveScoreRank===target)._requiredScore;
 const minimum=Math.floor(row.minimumScore),margin=minimum-threshold;
 return {target,threshold,minimum,margin,lowest:target===2,stable:margin>=0};
}
const summaryChip=(label,value,tone)=>{const chip=el('span',null,'event-summary-chip');chip.dataset.tone=tone;chip.append(el('span',label),el('b',value));return chip;};
export function eventPlanHeading(data,row,{label='',plays,referenceCache}={}){
 const {target,threshold,minimum,margin,lowest,stable}=gradeFacts(row,data.rules);
 const basis=row.scoreBasis==='minimumScore'?'稳定刷取':row.scoreBasis==='maximumScore'?'最高分判档':'平均分判档';
 const heading=eventSongHeading(data,row.song,{label,plays,grade:rank(target),basis});heading.className+=' event-plan-heading';
 const summary=el('div',null,'event-plan-summary');summary.setAttribute('aria-label','奖励档位与稳定性摘要');
 const share=Math.abs(margin)/(stable?minimum:threshold)*100;
 const value=lowest?'D 档':share>0&&share<.1?'不足 0.1%':`${stable?'+':'−'}${fmt(share)}%`;
 const budget=summaryChip(lowest?'最低档位':stable?'余量':'缺口',value,lowest?'neutral':stable?'good':'warn');
 budget.title=`${rank(target)} 门槛 ${fmt(threshold)} 分；AP 最低分 ${fmt(minimum)} 分；${stable?'高出':'还差'} ${fmt(Math.abs(margin))} 分`;
 summary.append(budget);
 const drop=row.gradeProbabilities?.length?row.gradeProbabilities.reduce((sum,g)=>sum+(g.rank<target?g.probability:0),0):null;
 summary.append(summaryChip('AP 掉档',drop==null?'未知':`${fmt(drop*100)}%`,drop==null?'neutral':drop>0?'warn':'good'));
 const details=el('details',null,'event-summary-details'),toggle=el('summary','详情'),facts=eventGradeRisk(row,data.rules);
 details.append(toggle,facts);details.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();details.open=false;toggle.focus();}});
 if(!lowest&&stable){
  const referenceDetails=el('div',null,'event-reference-details');facts.append(referenceDetails);
  summary.append(eventMistakeReference(row,data.rules,{details:referenceDetails,cache:referenceCache}));
 }
 summary.append(details);if(!lowest&&stable)summary.append(el('small','容错参考','event-summary-note'));heading.append(summary);return heading;
}
export function eventGradeRisk(row,rules){
 const root=el('section',null,'event-grade-risk'),{target,threshold,minimum,margin,lowest,stable}=gradeFacts(row,rules);
 root.setAttribute('aria-label','奖励档位与稳定性');
 const label=row.scoreBasis==='minimumScore'?'最低分':row.scoreBasis==='maximumScore'?'最高分':'平均分';
 root.dataset.state=lowest?'neutral':stable?'stable':'risk';
 const head=el('div',null,'event-risk-heading'),identity=el('div',null,'event-risk-identity');
 identity.append(el('strong',rank(target),'event-grade-badge'),el('span',row.scoreBasis==='minimumScore'?'稳定刷取 · 最低分':`${label}判档`));
 head.append(identity,el('span',lowest?'最低奖励档位':stable?'最低分达标':'有掉档风险','event-risk-chip'));root.append(head);
 const metrics=eventMetricList([[`${rank(target)} 档门槛`,`${fmt(threshold)} 分`],['AP 最低分',`${fmt(minimum)} 分`],
  [lowest?'当前档位':stable?'稳定分数余量':'最低分缺口',lowest?'D 档':`${stable?'+':'−'}${fmt(Math.abs(margin))} 分`]],'event-risk-metrics');root.append(metrics);
 if(row.scoreBasis!=='minimumScore'){
  const difference=Math.floor(row.estimatedScore)-threshold;
  root.append(el('p',`${label} ${fmt(row.estimatedScore)} 分 · ${difference>0?'高出 '+fmt(difference)+' 分':difference<0?'还差 '+fmt(-difference)+' 分':'刚好达到门槛'}`,'event-risk-basis'));
 }
 if(!lowest){
  const ceiling=Math.max(threshold,minimum),width=100*Math.min(threshold,minimum)/ceiling;
  const bar=el('div',null,'event-score-budget');bar.setAttribute('role','img');
  bar.setAttribute('aria-label',stable?`最低分高出门槛 ${fmt(margin)} 分`:`最低分还差 ${fmt(-margin)} 分`);
  for(const [part,value] of [['covered',width],['remaining',100-width]]){const segment=el('span',null,`event-score-${part}`);segment.style.width=`${value}%`;bar.append(segment);}
  const share=margin/minimum*100;
  const budget=el('div',null,'event-budget-row');budget.append(bar,el('p',margin>0?`分数余量占最低分${share<.1?'不足 0.1%':`约 ${fmt(share)}%`}`:
   margin===0?'最低分刚好达到门槛，稳定分数余量为 0。':`最低分还差 ${fmt(-margin)} 分，暂无稳定分数余量。`,'event-budget-caption'));root.append(budget);
 }else root.append(el('p','当前已是最低奖励档位，没有更低的分数档位。','event-budget-caption'));
 if(row.gradeProbabilities?.length){
  const drop=row.gradeProbabilities.reduce((n,g)=>n+(g.rank<target?g.probability:0),0),distribution=el('div',null,'event-grade-distribution');
  const title=el('div',null,'event-risk-heading');
  const chart=el('div',null,'event-probability-bar'),legend=el('div',null,'event-probability-legend');
  legend.append(el('small','AP 档位'));
  chart.setAttribute('role','img');chart.setAttribute('aria-label',row.gradeProbabilities.map(g=>`${rank(g.rank)} ${fmt(g.probability*100)}%`).join(' · '));
  for(const g of row.gradeProbabilities){
   const segment=el('span',null,'event-probability-segment');segment.dataset.rank=String(g.rank);segment.dataset.met=String(g.rank>=target);segment.style.width=`${g.probability*100}%`;chart.append(segment);
   const chip=el('span',`${rank(g.rank)} ${fmt(g.probability*100)}%`);chip.dataset.met=String(g.rank>=target);legend.append(chip);
  }
  title.append(legend,el('strong',`掉档概率 ${fmt(drop*100)}%`));distribution.append(title,chart);root.append(distribution);
 }else root.append(el('small','当前结果没有完整技能顺序分布，无法计算掉档概率。'));
 const method=el('details',null,'event-risk-method');method.append(el('summary','计算说明'));
 method.append(el('p',`${row.gradeProbabilities?.length?`按相同 AP 条件下全部 ${row.orderCount} 种技能顺序等权计算，不含操作失误。`:''}分数余量是最低分到当前档位门槛的差值，失误影响随音符位置、连击与技能变化。`));root.append(method);
 return root;
}
export function eventYieldBreakdown(row){
 const detail=el('details',null,'event-plan-details');detail.append(el('summary','收益明细'));
 const table=el('table',null,'event-yield-table'),head=el('thead'),heading=el('tr');
 for(const label of ['阶段','次数','道具','活动 pt'])heading.append(el('th',label));head.append(heading);table.append(head);
 const body=el('tbody'),line=(label,plays,badges,points)=>{const tr=el('tr');tr.append(el('th',label),el('td',plays),el('td',fmt(badges)),el('td',fmt(points)));body.append(tr);};
 line('单次',1,row.reward.badges,row.reward.eventPoints);
 if(row.reward.mode==='ordinary'){
   line('普通',row.normalPlays,row.normalPlays*row.reward.badges,row.normalPlays*row.reward.eventPoints);
   if(row.continuation)line('挑战',row.continuation.plays,row.continuation.badges,row.continuation.eventPoints);
   line('合计',row.normalPlays+(row.continuation?.plays??0),row.total.badges,row.total.eventPoints);
 }
 table.append(body);detail.append(table,eventPerformanceFacts(row));
 const ordinary=row.reward.mode==='ordinary',cost=ordinary?row.spentFire:row.reward.challengeCost;
 const entries=ordinary?[
   ['单次挑战 pt',fmt(row.reward.challengePoints)],['新获挑战 pt',fmt(row.earnedCP)],['已有挑战 pt',fmt(row.startingCP??0)],
   ['剩余挑战 pt',fmt(row.continuation?.remainingCP??(row.earnedCP+(row.startingCP??0)))],['剩余火',fmt(row.remainingFire)]
 ]:[['消耗挑战 pt',fmt(cost)]];
 entries.push([ordinary?(row.startingCP?'预算比值 · 道具 / 火':'道具 / 火'):'道具 / 挑战 pt',fmt(cost>0?row.total.badges/cost:null)],[ordinary?(row.startingCP?'预算比值 · pt / 火':'活动 pt / 火'):'活动 pt / 挑战 pt',fmt(cost>0?row.total.eventPoints/cost:null)]);
 if(row.song.seconds!=null)entries.push(['歌曲时长',`${fmt(row.song.seconds)} 秒`]);
 detail.append(eventMetricList(entries));return detail;
}
export function eventChallengeBreakdown(stage){
 const root=el('section',null,'event-challenge-yield');root.setAttribute('aria-label','挑战收益');
 root.append(eventMetricList([['消耗 / 次',`${fmt(stage.cost)} pt`],['道具 / 次',fmt(stage.reward.badges)],['活动 pt / 次',fmt(stage.reward.eventPoints)],['挑战次数',fmt(stage.plays)]],'event-challenge-metrics'));
 const details=el('details',null,'event-plan-details');details.append(el('summary','挑战收益明细'),eventPerformanceFacts(stage.row));root.append(details);return root;
}
