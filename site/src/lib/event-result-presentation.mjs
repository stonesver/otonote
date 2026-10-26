const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const fmt=n=>Number.isFinite(n)?n.toLocaleString('zh-CN',{maximumFractionDigits:1}):'—';
const grades=['D','C','B','A','S','SS'];
const rank=n=>grades[n-2]??'—';
export function eventSongHeading(data,song,{label='',grade,plays}={}) {
 const track=data.tracks?.find(track=>track.id===song.trackId),root=el('header',null,'event-result-song');
 if(track?.jacketUrl){const art=el('img',null,'event-song-cover');art.src=track.jacketUrl;art.alt='';art.loading='lazy';root.append(art);}
 const copy=el('div',null,'event-song-copy'),title=el('h4',song.title??track?.title??song.trackId),meta=el('div',null,'event-song-meta');
 if(label)meta.append(el('small',label,'task-result-eyebrow'));
 const difficulty=el('span',`${song.difficulty?.toUpperCase()??'—'}${song.level!=null?' · '+song.level:''}`,'event-difficulty');difficulty.dataset.difficulty=song.difficulty;meta.append(difficulty);
 if(grade)meta.append(el('span',`${grade} 档`,'event-song-grade'));
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
 return eventMetricList([[row.performanceScenario?'预计得分':'AP 得分',fmt(row.estimatedScore)],['档位范围',range],['综合力',fmt(row.power)],['道具加成',`+${fmt(row.bonuses.rewardBP/100)}%`],['活动 pt 加成',`+${fmt(row.bonuses.eventPointBP/100)}%`]],'event-performance-facts');
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
