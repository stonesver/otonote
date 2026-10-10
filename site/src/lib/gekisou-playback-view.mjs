import {gekisouSections,gekisouEffectTrack} from './gekisou-playback-model.mjs';

/** A section/effect inspector sharing the parent replay's selected sample. */
export function renderGekisouPlayback(root,result,variant,data,ui,state={}) {
  const {el,say,fmt,seconds,cardFor,portrait,effectName}=ui,playback=result.skillPlayback;
  const sections=gekisouSections(playback,variant),mission={1:'COMBO',2:'LUCK',3:'JUST'};
  const replayTracks=sections.flatMap(section=>(playback.effects??[]).filter(e=>e.missionType===section.missionType).map(e=>gekisouEffectTrack(e,section)));
  const button=(text,cls,fn)=>{const n=el('button',text,cls);n.type='button';n.addEventListener('click',fn);return n;};
  const metric=(label,value)=>{const n=el('div');n.append(el('dt',label),el('dd',value));return n;};
  const cardName=effect=>cardFor(data,effect.kind,effect.sourceCardId)?.displayName??say(`位置 ${effect.slotIndex+1}`,`Slot ${effect.slotIndex+1}`);
  const actionLabel=e=>e.action==='start'?say('发动','Start'):e.action==='end'?say('结束','End'):e.action==='factor'?say(`加分更新 +${fmt(e.value*100)}%`,`Score boost +${fmt(e.value*100)}%`):e.action==='bonus'?say(`追加 ${fmt(e.value)} LUCK 点数`,`Add ${fmt(e.value)} LUCK points`):say(`追加 ${fmt(e.value/100)}% LUCK 槽`,`Add ${fmt(e.value/100)}% LUCK gauge`);
  const shell=el('section',null,'gk-playback');shell.setAttribute('aria-label',say('激奏段落回放','Gekisou section playback'));root.append(shell);
  const heading=el('div',null,'gk-heading'),headingText=el('div');headingText.append(el('span','GEKISOU','gk-kicker'),el('h3',say('三段激奏，一次完整回放','Three sections. One replay.')));
  heading.append(headingText,el('span',say('本次模拟','Current simulation'),'gk-badge'));shell.append(heading);
  const composition=el('div',null,'gk-composition'),compositionLabels=el('dl',null,'gk-composition-labels');
  for(const [name,value,cls] of [[say('音符得分（含技能）','Note score including skills'),variant.noteScore,'notes'],[say('名次奖励','Rank rewards'),variant.rankingBonus,'rewards']]) {
    const bar=el('span',null,`gk-score-part gk-score-${cls}`);bar.style.flexGrow=String(Math.max(0,value));bar.title=`${name} ${fmt(value)}`;composition.append(bar);compositionLabels.append(metric(name,fmt(value)));
  }
  if(variant.eventFixedScore)compositionLabels.append(metric(say('活动固定修正','Event score adjustment'),fmt(variant.eventFixedScore)));
  shell.append(compositionLabels,composition);
  const scenario=result.scenario??{};
  shell.append(el('p',`${scenario.rankingModel==='opponent_section_results'?say('名次按输入的对手数据','Ranks use entered opponent data'):say('名次按情景设定','Ranks use scenario settings')} · ${fmt(playback.frameRate)} FPS · ${say('判定偏差','Timing offset')} ${fmt(scenario.timingOffsetMs??0)} ms${playback.randomSampling?` · Seed ${variant.seed}`:''}`,'gk-assumptions'));
  if(playback.randomSampling)shell.append(el('p',say('当前展示固定种子的一次抽样；最高／最低样本不是理论极值。','This is one seeded sample; sample extremes are not theoretical bounds.'),'gk-assumptions'));
  const overview=el('div',null,'gk-overview');overview.setAttribute('aria-hidden','true');
  const fullDuration=Math.max(...sections.map(s=>s.endMs),...(variant.notes??[]).map(n=>n.timeMs),1);
  for(const s of sections){const mark=el('span',String(s.index));mark.dataset.mission=s.missionType;mark.dataset.section=s.index;mark.style.left=`${s.startMs/fullDuration*100}%`;mark.style.width=`${(s.endMs-s.startMs)/fullDuration*100}%`;overview.append(mark);}shell.append(overview);
  const cards=el('div',null,'gk-section-cards');cards.setAttribute('role','group');cards.setAttribute('aria-label',say('选择激奏段落','Select Gekisou section'));shell.append(cards);
  const panel=el('div',null,'gk-section-panel');shell.append(panel);
  function selectSection(section){
    state.sectionIndex=section.index;panel.replaceChildren();panel.dataset.mission=section.missionType;
    [...cards.children].forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.section)===section.index)));
    [...overview.children].forEach(b=>b.dataset.selected=String(Number(b.dataset.section)===section.index));
    const intro=el('div',null,'gk-section-heading');intro.append(el('h4',say(`第 ${section.index} 段 · ${mission[section.missionType]}`,`Section ${section.index} · ${mission[section.missionType]}`)),el('span',`${seconds(section.startMs)} — ${seconds(section.endMs)}`));panel.append(intro);
    const live=el('p',null,'gk-live-readout');panel.append(live);
    panel.append(el('small',say('本段最终结算','Final section results'),'gk-final-caption'));
    const stats=el('dl',null,'gk-section-stats');stats.setAttribute('aria-label',say('本段最终结算','Final section results'));
    const count=section.missionType===1?section.combo:section.missionType===2?section.luckPoints:section.just;
    stats.append(metric(say('任务计数','Mission count'),fmt(count)),metric(say('段内音符得分','Section note score'),fmt(section.finalNoteScore)),metric(say('名次奖励','Rank reward'),`+${fmt(section.rankingBonus)}`));panel.append(stats);
    const settlement=el('p',say(`奖励计算：${fmt(section.noteScore)} × ${fmt(section.rankingPercent)}% = ${fmt(section.rankingBonus)} 分（取整）`,`Reward: ${fmt(section.noteScore)} × ${fmt(section.rankingPercent)}% = ${fmt(section.rankingBonus)} points (rounded down)`),'gk-assumptions');panel.append(settlement);
    if(section.replayAdjustment)panel.append(el('p',say(`结算时取分与最终音符回放相差 ${fmt(section.replayAdjustment)} 分；上方音符得分使用最终回放值。`,`The final note replay differs from the settlement snapshot by ${fmt(section.replayAdjustment)} points. The note score above uses the final replay.`),'gk-assumptions'));
    if(section.missionType===2)renderLuck(section,panel);
    else {
      const task=el('div',null,'gk-task-readout');
      if(section.missionType===3){
        task.append(el('strong',`${fmt(section.rawJust)} JUST`),el('span',say(`共 ${fmt(section.perfectCount)} 次判定 · 技能结算后任务计数 ${fmt(section.just)}`,`${fmt(section.perfectCount)} judgements · Mission count after skills: ${fmt(section.just)}`)));
        const meter=el('div',null,'gk-just-meter'),fill=el('i');fill.style.width=`${section.perfectCount?Math.min(100,section.rawJust/section.perfectCount*100):0}%`;meter.append(fill);task.append(meter);
      } else task.append(el('strong',`${fmt(section.combo)} COMBO`),el('span',say(`本段 ${fmt(section.perfectCount)} 次判定；任务计数包含技能加成。`,`${fmt(section.perfectCount)} judgements in this section; mission count includes skill bonuses.`)));
      task.append(el('small',say('任务计数用于段内竞争；名次与奖励还取决于当前情景。','Mission counts affect section competition; rank and reward also depend on the scenario.')));panel.append(task);
    }
    const relevant=(playback.effects??[]).filter(e=>e.missionType===section.missionType).map(e=>gekisouEffectTrack(e,section));
    const recorded=relevant.filter(t=>t.events.length),unrecorded=relevant.filter(t=>!t.events.length);
    const tracks=el('div',null,'gk-effect-tracks'),trackHeading=el('div',null,'gk-tracks-heading');
    trackHeading.append(el('h4',say('本段技能轨迹','Skills in this section')),el('span',say(`${recorded.length} 个效果有记录`,`${recorded.length} effects recorded`)));tracks.append(trackHeading);panel.append(tracks);
    if(section.displayEndMs>section.endMs)tracks.append(el('p',say(`区段结束后仍有技能收尾，时间轴延伸至 ${seconds(section.displayEndMs)}。`,`Skill release continues after the section; the axis extends to ${seconds(section.displayEndMs)}.`),'gk-assumptions'));
    const scale=el('div',null,'gk-track-scale');[section.displayStartMs,(section.displayStartMs+section.displayEndMs)/2,section.displayEndMs].forEach(t=>scale.append(el('span',seconds(t))));tracks.append(scale);
    const trackList=el('div',null,'gk-track-list'),detail=el('div',null,'gk-effect-detail');tracks.append(trackList,detail);
    const x=t=>Math.max(0,Math.min(100,(t-section.displayStartMs)/Math.max(1,section.displayEndMs-section.displayStartMs)*100));
    function selectEffect(track){
      state.effectSource=track.effect.source;for(const b of trackList.children)b.setAttribute('aria-pressed',String(b.dataset.source===state.effectSource));
      detail.replaceChildren();const e=track.effect;detail.style.setProperty('--gk-owner',`var(--activation-${e.slotIndex})`);
      const title=el('div',null,'gk-effect-title'),img=portrait(cardFor(data,e.kind,e.sourceCardId));if(img)title.append(img);
      const name=el('div');name.append(el('small',say(e.kind==='member'?'成员技能':'留影技能',e.kind==='member'?'Member skill':'Snap skill')),el('strong',cardName(e)),el('span',effectName(e.type)));title.append(name);detail.append(title);
      const facts=el('div',null,'gk-effect-facts');
      if(track.starts)facts.append(el('span',say(`发动 ${track.starts} 次`,`Starts: ${track.starts}`)));
      if(track.changes)facts.append(el('span',say(`加分更新 ${track.changes} 次`,`Score updates: ${track.changes}`)),el('span',say(`峰值 +${fmt(track.peakFactor*100)}%`,`Peak +${fmt(track.peakFactor*100)}%`)));
      if(e.comboThreshold)facts.append(el('span',`COMBO ≥ ${fmt(e.comboThreshold)}`));
      if(e.perfectInterval)facts.append(el('span',say(`每 ${e.perfectInterval} 个 Perfect 检查一次`,`Checked every ${e.perfectInterval} Perfects`)));
      if(e.probability<100)facts.append(el('span',say(`条件通过后 ${fmt(e.probability)}% 概率`,`Chance after conditions: ${fmt(e.probability)}%`)));
      detail.append(facts);
      if(track.peakFactor)renderFactorCurve(track,section,detail);
      detail.append(el('p',say('色带表示有起止记录的持续效果，圆点表示发动／追加事件。倍率来自该效果的回放记录，不是独立分数贡献。','Bands show recorded effect lifetimes; dots mark starts or additions. Factors come from this effect’s replay, not a separate score contribution.'),'gk-assumptions'));
      const log=el('details',null,'gk-event-log');log.append(el('summary',say(`逐次记录 · ${track.events.length} 条`,`Event log · ${track.events.length}`)));detail.append(log);
      paginate(log,track.events,event=>{const line=el('div',null,'gk-log-row');line.append(el('time',seconds(event.timeMs)),el('span',actionLabel(event)));return line;});
    }
    for(const track of recorded){
      const e=track.effect,row=button(null,'gk-effect-row',()=>{selectEffect(track);ui.onSeek?.(track.events[0].timeMs);});row.dataset.source=e.source;row._replayWindows=track.windows;row.style.setProperty('--gk-owner',`var(--activation-${e.slotIndex})`);row.setAttribute('aria-label',`${cardName(e)} · ${effectName(e.type)}`);
      const identity=el('span',null,'gk-track-identity');identity.append(el('b',String(e.slotIndex+1)),el('span',`${cardName(e)} · ${effectName(e.type)}`));
      const graph=el('span',null,'gk-track-graph');graph.setAttribute('aria-hidden','true');
      for(const w of track.windows){const band=el('i',null,'gk-effect-window');band.style.left=`${x(w.startMs)}%`;band.style.width=`${x(w.endMs)-x(w.startMs)}%`;band.style.height=`${w.value!=null?7+15*w.value/Math.max(track.peakFactor,.001):15}px`;graph.append(band);}
      for(const event of track.events.filter(e=>['start','bonus','gauge'].includes(e.action))){const dot=el('i',null,'gk-event-dot');dot.style.left=`${x(event.timeMs)}%`;graph.append(dot);}
      graph.append(el('i',null,'task-replay-cursor'));row.append(identity,graph,el('span',say(`${track.events.length} 条`,`${track.events.length} events`),'gk-track-count'));trackList.append(row);
    }
    if(recorded.length)selectEffect(recorded.find(t=>t.effect.source===state.effectSource)??recorded[0]);
    else tracks.append(el('p',say('本段没有记录到卡牌技能触发。任务与名次奖励仍按上方情景计算。','No card skill activation was recorded in this section. Mission and rank rewards still follow the scenario.'),'gk-empty'));
    if(unrecorded.length){const inactive=el('details',null,'gk-inactive');inactive.append(el('summary',say(`本段未发动的效果 · ${unrecorded.length}`,`Effects without events · ${unrecorded.length}`)));
      for(const t of unrecorded){const item=el('div');item.append(el('strong',`${cardName(t.effect)} · ${effectName(t.effect.type)}`),el('span',t.status==='condition_unmet'?say('配对／生命等前置条件未满足','Pairing / life prerequisite unmet'):say('本次未触发；可能未达到计数、区段内条件或概率要求','Not triggered in this replay; count, section conditions or chance may apply')));inactive.append(item);}tracks.append(inactive);}
  }
  function renderFactorCurve(track,section,parent){
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 600 110');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');svg.setAttribute('aria-label',say('该技能的加分倍率阶梯图','Score factor step chart for this skill'));
    const x=t=>10+(t-section.displayStartMs)/Math.max(1,section.displayEndMs-section.displayStartMs)*580;
    const y=v=>96-v/track.peakFactor*78;let d=`M 10 96`;
    for(const e of track.events.filter(e=>e.action==='factor'))d+=` H ${x(e.timeMs)} V ${y(e.value)}`;d+=` H 590`;
    const path=document.createElementNS(ns,'path');path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','2');path.setAttribute('vector-effect','non-scaling-stroke');svg.append(path);
    const chart=el('div',null,'gk-factor-curve'),labels=el('div');labels.append(el('span',say('该效果加分倍率','This effect’s score bonus')),el('strong',`0 → +${fmt(track.peakFactor*100)}%`));chart.append(labels,svg);parent.append(chart);
  }
  function paginate(parent,items,render){
    const list=el('div'),nav=el('div',null,'gk-pager');let page=0;
    const previous=button(say('上一页','Previous'),'',()=>{page--;paint();}),next=button(say('下一页','Next'),'',()=>{page++;paint();}),status=el('span');nav.append(previous,status,next);parent.append(list,nav);
    function paint(){list.replaceChildren(...items.slice(page*10,page*10+10).map(render));previous.disabled=page===0;next.disabled=(page+1)*10>=items.length;status.textContent=`${page+1} / ${Math.max(1,Math.ceil(items.length/10))}`;nav.hidden=items.length<=10;}paint();
  }
  function renderLuck(section,parent){
    const luck=el('div',null,'gk-luck'),header=el('div',null,'gk-luck-heading');header.append(el('strong',say('LUCK 抽奖与 RUSH','LUCK draws & RUSH')),el('span',say(`${section.luckEvents.length} 次抽奖 · 最长连续 RUSH ${section.peakRush}`,`${section.luckEvents.length} draws · Longest RUSH streak ${section.peakRush}`)));luck.append(header);
    const distribution=el('div',null,'gk-luck-distribution');
    for(let i=0;i<4;i++){const cell=el('div');cell.dataset.result=i;cell.append(el('span',i===3?'RUSH':say(`${i} 档`, `Tier ${i}`)),el('strong',fmt(section.luckCounts?.[i]??0)),el('small',say(`每次 ${playback.luckPointsByResult[i]} 点`,` ${playback.luckPointsByResult[i]} points / draw`)));distribution.append(cell);}luck.append(distribution);
    const ribbon=el('div',null,'gk-luck-ribbon');ribbon.setAttribute('aria-label',say('本段抽奖顺序','Draw order in this section'));
    section.luckEvents.forEach((event,i)=>{const mark=el('span',event.result===3?'R':String(event.result));mark.dataset.result=event.result;mark.title=say(`第 ${i+1} 次 · ${seconds(event.timeMs)} · 累计 ${event.bonusPoints} 点`,`Draw ${i+1} · ${seconds(event.timeMs)} · ${event.bonusPoints} points`);ribbon.append(mark);});luck.append(ribbon);
    if(!section.luckEvents.length)luck.append(el('p',say('本次未发生抽奖。','No draws in this replay.')));
    const log=el('details',null,'gk-event-log');log.append(el('summary',say('查看抽奖时刻与累计点数','Draw times and cumulative points')),el('p',say('累计点数是抽奖时刻的快照；最终追加技能点数以本段任务计数为准。','Totals are snapshots at draw time; the mission count includes the final skill point additions.'),'gk-assumptions'));luck.append(log);
    paginate(log,section.luckEvents,event=>{const row=el('div',null,'gk-log-row');row.append(el('time',seconds(event.timeMs)),el('span',`${event.result===3?'RUSH':say(`${event.result} 档`,`Tier ${event.result}`)} · ${say('累计','Total')} ${fmt(event.bonusPoints)} pt${event.rushCombo?` · RUSH ×${event.rushCombo}`:''}`));return row;});parent.append(luck);
  }
  for(const section of sections){const card=button(null,'gk-section-card',()=>{selectSection(section);ui.onSeek?.(section.startMs);});card.dataset.section=section.index;card.dataset.mission=section.missionType;card.setAttribute('aria-label',say(`第 ${section.index} 段 ${mission[section.missionType]}`,`Section ${section.index} ${mission[section.missionType]}`));
    const head=el('span',null,'gk-card-heading');head.append(el('b',String(section.index).padStart(2,'0')),el('strong',mission[section.missionType]),el('span',`#${section.rank}`));
    card.append(head,el('small',`${seconds(section.startMs)} — ${seconds(section.endMs)}`),el('strong',`+${fmt(section.rankingBonus)}`,'gk-card-reward'),el('span',say('名次奖励','Rank reward')));cards.append(card);}
  if(sections.length)selectSection(sections.find(s=>s.index===state.sectionIndex)??sections[0]);
  return {seek(time,{follow=true}={}){
    const active=sections.find(s=>s.startMs<=time&&time<s.endMs);
    if(follow&&active&&active.index!==state.sectionIndex)selectSection(active);
    for(const card of cards.children){const s=sections.find(s=>s.index===Number(card.dataset.section));card.dataset.playing=String(s===active);card.dataset.settled=String(time>=s.endMs);card.querySelector('.gk-card-reward').textContent=time>=s.endMs?`+${fmt(s.rankingBonus)}`:say('待结算','Pending');}
    const activeEffects=replayTracks.flatMap(track=>track.windows.filter(w=>w.startMs<=time&&time<w.endMs).map(window=>({effect:track.effect,window})));
    const section=sections.find(s=>s.index===state.sectionIndex);if(!section)return {activeEffects};
    const scored=(variant.notes??[]).filter(n=>n.scoreSectionIndex===section.index&&n.timeMs<=time),notes=(variant.notes??[]).filter(n=>n.scoreSectionIndex===section.index);
    panel.querySelector('.gk-live-readout').textContent=say(`${time<section.startMs?'尚未开始':time<section.endMs?'正在进行':'已结算'} · 已判定 ${scored.length} / ${notes.length} 音符 · 段内累计 ${fmt(scored.reduce((sum,n)=>sum+n.score,0))} 分 · 奖励 ${time>=section.endMs?'+'+fmt(section.rankingBonus):'待结算'}`,`${time<section.startMs?'Upcoming':time<section.endMs?'Playing':'Settled'} · ${scored.length} / ${notes.length} notes · ${fmt(scored.reduce((sum,n)=>sum+n.score,0))} points · Reward ${time>=section.endMs?'+'+fmt(section.rankingBonus):'pending'}`);
    for(const row of panel.querySelectorAll('.gk-effect-row')){row.dataset.playing=String(row._replayWindows.some(w=>w.startMs<=time&&time<w.endMs));const cursor=row.querySelector('.task-replay-cursor');cursor.hidden=time<section.displayStartMs||time>section.displayEndMs;cursor.style.left=`${Math.max(0,Math.min(100,(time-section.displayStartMs)/Math.max(1,section.displayEndMs-section.displayStartMs)*100))}%`;}
    return {activeEffects};
  }};
}
