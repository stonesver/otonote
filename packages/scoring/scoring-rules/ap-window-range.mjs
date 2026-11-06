import { createPerformanceSongCalculator } from './formal-performance-replay.mjs';
import { createScoreReplay } from './formal-score-replay.mjs';
import { createFrameClock, skillEndFrame } from './formal-frame-clock.mjs';
import { calculateFormalNoteCore } from './formal-note-core.mjs';
import { formalJudgementType } from './formal-judgement.mjs';
import { createEventPipeline } from './event-rules.mjs';
import { apTimingPerformance, apTimingClocks } from './ap-timing-plan.mjs';
import { prepareFormalChart } from './formal-song-score.mjs';

const f32 = Math.fround;
const rateOf = raw => f32(Math.floor(f32(f32(raw) * 100000)) / 100000);
const manualTypes = new Set([1, 20, 40, 41, 42, 101, 102]);
const field = {3:'good',4:'great',5:'perfect',6:'just'};
const bit = index => 1n << BigInt(index);
const population = value => { let count=0; for(;value;value&=value-1n) count++; return count; };

/** Complete integer-ms AP input-frame choices for player-operated judgements.
 * Automatic hold/trace ticks stay on the chart clock. Touch hit testing is not
 * modeled. A hold head must arrive before its first automatic continuation. */
export function apWindowChoices(rules, timeline, clock) {
  return timeline.events.map(event => {
    const window = rules.tables.LiveJudgementTiming.find(row => row._assistLevel === 0 && row._noteSimulateJudgement === 5
      && row._noteJudgementType === formalJudgementType(event.type,event.critical));
    const manual = manualTypes.has(event.type) && event.kind === 'authored';
    const next = [20,41,101,102].includes(event.type) ? timeline.events.find(n=>n.noteId===event.noteId && n.timeMs>event.timeMs) : null;
    const early = manual ? Math.min(window._beforeMs,event.timeMs) : 0;
    const late = manual ? Math.min(window._afterMs,next ? next.timeMs-event.timeMs-1 : Infinity) : 0;
    const frames=new Map();
    for(let offset=-early;offset<=late;offset++) {
      const frame=clock.indexAt(event.timeMs+offset), previous=frames.get(frame);
      if(previous===undefined || Math.abs(offset)<Math.abs(previous)) frames.set(frame,offset);
    }
    return {event,frames,early,late,first:Math.min(...frames.keys()),last:Math.max(...frames.keys())};
  });
}

/** Dynamic programming over every legal input frame, keeping the native
 * rollback buckets and float32 state. Equal continuation states share future
 * outcomes; only their lowest/highest closed scores and witnesses are kept.
 * A resource limit fails explicitly; it never turns candidates into extrema. */
export function calculateApWindowRange(rules,chart,draft,{order,frameRate=60,phaseMs=0,eventAdapters=[],maxStates=20000,maxTransitions=2000000,onProgress=()=>{}}={}) {
  const timeline=prepareFormalChart(rules,{...chart,sourceReleaseId:chart.sourceReleaseId??rules.sourceReleaseId});
  const clock=createFrameClock({frameRate,phaseMs}), plan={order,adjustments:[]};
  const performance=apTimingPerformance(timeline,plan,{frameRate,phaseMs});
  const engine=createPerformanceSongCalculator(rules,chart,{performance,eventAdapters});
  const baseline=engine.calculate(draft,{includeTrace:true});
  const pipeline=createEventPipeline(rules,draft.modifiers?.event,eventAdapters);
  if(pipeline.context.effects.some(effect=>['note_score','fixed_score'].includes(effect.phase))) throw Error('AP 全窗口范围尚不支持改变逐键得分或结算分的活动机制');
  const setting=key=>Number(rules.tables.LiveSettings.find(row=>row._key===key)._value);
  const musicLengthMs=Math.max(...timeline.events.map(n=>n.timeMs),...timeline.skillTimes);
  const choices=apWindowChoices(rules,timeline,clock);
  const starts=new Map(),ends=new Map(),effects=[];
  const enqueue=(map,frame,value)=>{if(!map.has(frame))map.set(frame,[]);map.get(frame).push(value);};
  // Under AP, recovery and life conditions are independent of input timing.
  // Resolve their activation with the shared lifecycle, then vary only input
  // arrivals and cumulative counters. AP-targeting converters/releases need
  // a larger state and are deliberately outside this solver's vocabulary.
  for(const skill of baseline.skills) {
    if(skill.supportEffects.some(e=>e.type===12006&&e.targets.includes(5)&&e.value!==5)
      ||skill.liveEffects.some(e=>e.release?.includes(5))) throw Error('AP 全窗口范围尚不支持改变 PERFECT 的转换或解除技能');
  }
  for(let position=0;position<5;position++) {
    const slot=order[position],startMs=timeline.skillTimes[position],startFrame=clock.indexAt(startMs);
    for(const effect of baseline.skills[slot].liveEffects) {
      const active=baseline.skillTrace.find(row=>row.frame===startFrame&&row.slotIndex===slot&&row.effectId===effect.id&&row.type===effect.type&&!row.action)?.active;
      if(!active)continue;
      const ending=skillEndFrame(clock,startMs,effect.durationRawMs),rate=effect.cumulative?0:rateOf(effect.rate);
      const delta=[2000,2001].includes(effect.type)?{general:rate}:Object.fromEntries(effect.targets.map(target=>[field[target],rate]));
      const item={index:effects.length,effect,slot,ownerId:slot*100+(effect.sourceKind==='support'?2:1),delta,startMs,startFrame,...{endFrame:ending.frame,endMs:ending.timeMs}};
      effects.push(item);enqueue(starts,startFrame,item);enqueue(ends,ending.frame,item);
    }
  }
  for(const rows of [...starts.values(),...ends.values()]) rows.sort((a,b)=>a.slot-b.slot);
  const frames=[...new Set([...choices.flatMap(c=>[...c.frames.keys()]),...starts.keys(),...ends.keys()])].sort((a,b)=>a-b);
  const lastInLine=new Map(),predecessors=timeline.events.map(event=>{
    const previous=lastInLine.get(event.noteId);lastInLine.set(event.noteId,event.scoreIndex);return previous;
  });
  const earlier=timeline.events.map(event=>timeline.events.reduce((mask,n)=>n.timeMs<event.timeMs?mask|bit(n.scoreIndex):mask,0n));
  let bonus=0;
  const bonuses=rules.tables.LiveComboScoreBonus.filter(row=>row._comboBonusType===0).sort((a,b)=>a._requiredComboCount-b._requiredComboCount)
    .map(row=>({count:row._requiredComboCount,factor:f32(1+Math.min(1,bonus=f32(bonus+f32(row._bonusFactor))))}));
  const values=new Map();
  const scoreNoteFor=state=>(event,factors)=>{
    const combo=population(state.done&earlier[event.scoreIndex]);
    const scoreUpFactor=f32(factors.general+factors.perfect),key=`${event.scoreIndex}|${combo}|${scoreUpFactor}`;
    if(!values.has(key)) values.set(key,calculateFormalNoteCore(pipeline.apply('note_score',{
      totalPower:baseline.power,scoreAdjustmentFactor:setting('note_score_adjustment_factor'),musicScoreLevelFactor:timeline.difficultyFactor,
      luckScoreFactorPercent:100,convertedNoteCount:timeline.convertedNoteCount,eventBonusFactor:1,
      lifeOnusFactor:setting('note_score_life_onus_factor'),assistModeNoteScoreFactor:1,currentLife:setting('life_base'),
      noteFactorPercent:event.weight,judgementFactorPercent:rules.tables.LiveJudgementParameter.find(row=>row._noteSimulateJudgement===5)._scorePercent,
      comboBonusFactor:bonuses.findLast(row=>row.count<=combo)?.factor??1,scoreUpFactor
    },{draft,note:event})).score);
    return {score:values.get(key)};
  };
  const initial={done:0n,counts:effects.map(()=>0),low:0,high:0,lowPath:null,highPath:null,lowEffort:0,highEffort:0};
  initial.replay=createScoreReplay({musicLengthMs,retainNotes:false,scoreNote:scoreNoteFor(initial)});
  let states=[initial],transitions=0,peakStates=1,previousFrame=-1;
  for(let fi=0;fi<frames.length;fi++) {
    const frame=frames[fi],now=clock.at(frame).timeMs,next=new Map();
    const available=choices.filter(c=>c.first<=frame&&c.last>=frame);
    for(const state of states) {
      if(frame>previousFrame+1) {
        if(previousFrame>=0)state.replay.calculate(clock.at(previousFrame+1).timeMs);
        if(frame>previousFrame+2)state.replay.calculate(clock.at(frame-1).timeMs);
      }
      const pending=available.filter(c=>!(state.done&bit(c.event.scoreIndex))),forced=pending.filter(c=>c.last===frame),optional=pending.filter(c=>c.last!==frame);
      const visit=(index,selected)=>{
        if(index<optional.length){visit(index+1,selected);visit(index+1,[...selected,optional[index]]);return;}
        if(++transitions>maxTransitions)throw Error('AP 全窗口精确计算超出搜索预算；尚不能给出最低／最高分');
        const chosen=[...forced,...selected].sort((a,b)=>a.event.scoreIndex-b.event.scoreIndex);
        const current={...state,counts:[...state.counts],done:chosen.reduce((mask,c)=>mask|bit(c.event.scoreIndex),state.done)};
        // An early manual endpoint cannot precede its own hold/guide nodes.
        // Same-frame events retain the chart's authoritative input order.
        if(chosen.some(c=>predecessors[c.event.scoreIndex]!==undefined&&!(current.done&bit(predecessors[c.event.scoreIndex]))))return;
        current.replay=state.replay.fork({scoreNote:scoreNoteFor(current)});
        for(const choice of chosen)current.replay.addNote({...choice.event,judgement:5,lifeAtInput:setting('life_base'),inputFrame:frame,inputTimeMs:now});
        current.replay.calculate(now);
        for(const item of starts.get(frame)??[])current.replay.addFactor({timeMs:item.startMs,ownerId:item.ownerId,...item.delta});
        for(const item of effects) {
          const cumulative=item.effect.cumulative;
          if(!cumulative||frame<item.startFrame||frame>=item.endFrame||!cumulative.targets.includes(5))continue;
          const before=current.counts[item.index],after=Math.min(cumulative.maximum*cumulative.unit,before+chosen.length);
          const rate=count=>rateOf(f32(Math.min(cumulative.maximumBP,Math.imul(Math.min(cumulative.maximum,Math.floor(f32(f32(count)/f32(cumulative.unit)))),cumulative.stepBP))/10000));
          const old=rate(before),value=rate(after);current.counts[item.index]=after;
          if(value!==old){current.replay.addFactor({timeMs:now,ownerId:item.ownerId,general:-old});current.replay.addFactor({timeMs:now,ownerId:item.ownerId,general:value});}
        }
        for(const item of ends.get(frame)??[]) {
          const cumulative=item.effect.cumulative;
          const delta=cumulative?{general:rateOf(f32(Math.min(cumulative.maximumBP,Math.imul(Math.min(cumulative.maximum,Math.floor(f32(f32(current.counts[item.index])/f32(cumulative.unit)))),cumulative.stepBP))/10000))}:item.delta;
          current.replay.addFactor({timeMs:item.endMs,ownerId:item.ownerId,...Object.fromEntries(Object.entries(delta).map(([key,value])=>[key,-value]))});
          current.counts[item.index]=0;
        }
        current.replay.calculate(now);
        // Future input may invalidate an earlier chart bucket; preserve it
        // and every bucket after it, including already calculated late notes.
        const nextFrame=frames[fi+1],cutoff=Math.min(now,nextFrame===undefined?Infinity:clock.at(nextFrame).timeMs,
          ...choices.filter(c=>!(current.done&bit(c.event.scoreIndex))).map(c=>c.event.timeMs),
          ...effects.filter(e=>e.startFrame>frame).map(e=>e.startMs),...effects.filter(e=>e.endFrame>frame).map(e=>e.endMs));
        const closed=current.replay.sealBefore(Number.isFinite(cutoff)?cutoff:musicLengthMs+2000);
        current.low+=closed;current.high+=closed;
        const offsets=chosen.filter(c=>c.frames.get(frame)!==0).map(c=>({scoreIndex:c.event.scoreIndex,timingOffsetMs:c.frames.get(frame)}));
        const effort=offsets.reduce((sum,row)=>sum+10000+Math.abs(row.timingOffsetMs),0);
        current.lowEffort+=effort;current.highEffort+=effort;
        if(offsets.length){current.lowPath={previous:state.lowPath,offsets};current.highPath={previous:state.highPath,offsets};}
        const key=`${current.done}|${current.counts}|${current.replay.frontierKey()}`,existing=next.get(key);
        if(!existing)next.set(key,current);
        else {
          if(current.low<existing.low||current.low===existing.low&&current.lowEffort<existing.lowEffort){existing.low=current.low;existing.lowPath=current.lowPath;existing.lowEffort=current.lowEffort;}
          if(current.high>existing.high||current.high===existing.high&&current.highEffort<existing.highEffort){existing.high=current.high;existing.highPath=current.highPath;existing.highEffort=current.highEffort;}
        }
      };
      visit(0,[]);
    }
    states=[...next.values()];peakStates=Math.max(peakStates,states.length);previousFrame=frame;
    if(states.length>maxStates)throw Error('AP 全窗口精确计算超出状态预算；尚不能给出最低／最高分');
    if(fi%100===0)onProgress({frame,frames:frames.length,processed:fi+1,states:states.length,transitions});
  }
  for(const state of states) {
    state.replay.calculate(Math.max(musicLengthMs,clock.at(previousFrame+1).timeMs));
    state.low=pipeline.apply('fixed_score',state.low+state.replay.score,{draft,order});
    state.high=pipeline.apply('fixed_score',state.high+state.replay.score,{draft,order});
  }
  const low=states.reduce((a,b)=>a.low<b.low||a.low===b.low&&a.lowEffort<=b.lowEffort?a:b);
  const high=states.reduce((a,b)=>a.high>b.high||a.high===b.high&&a.highEffort<=b.highEffort?a:b);
  const witness=(state,kind)=>{
    const adjustments=[];for(let path=state[`${kind}Path`];path;path=path.previous)adjustments.push(...path.offsets);
    adjustments.sort((a,b)=>a.scoreIndex-b.scoreIndex);
    for(const row of adjustments){
      const {event,early,late}=choices[row.scoreIndex],source=chart.notes.find(note=>note.id===event.noteId),node=source?.nodes?.[event.nodeIndex??0]??source;
      Object.assign(row,{timeMs:event.timeMs,noteId:event.noteId,nodeIndex:event.nodeIndex??null,position:node?.position??0,size:node?.size??1,
        apEarlyMs:early,apLateMs:late,apMarginMs:Math.min(early+row.timingOffsetMs,late-row.timingOffsetMs)});
    }
    const replay=engine.withPerformance(apTimingPerformance(timeline,{order,adjustments},{frameRate,phaseMs})).calculate(draft,{includeTrace:true});
    if(replay.expectedScore!==state[kind]||!replay.performance.allPerfect||replay.performance.convertedCount)throw Error('AP 全窗口搜索与整曲回放不一致，未发布极值');
    return {score:replay.expectedScore,adjustments,variant:{...replay.skillPlayback.variants[0],timingCondition:{frameRate,phaseMs,kind:kind==='low'?'ap_minimum':'ap_maximum'}}};
  };
  return {version:'ap-window-range-v1',status:'exact',scope:'manual_ap_integer_ms_fixed_automatic',frameRate,phaseMs,order:[...order],
    minimum:witness(low,'low'),maximum:witness(high,'high'),search:{transitions,peakStates,clockClasses:1}};
}

/** Keep phase-zero extrema separate from extrema requiring clock alignment. */
export function calculateApWindowRanges(rules,chart,draft,options={}) {
  const rates=[];let completed=0;
  for(const frameRate of [60,120]) {
    let reference,minimum,maximum,transitions=0,peakStates=0;
    for(const phaseMs of apTimingClocks(frameRate)) {
      const result=calculateApWindowRange(rules,chart,draft,{...options,frameRate,phaseMs,onProgress:()=>{}});
      if(phaseMs===0)reference=result;
      if(!minimum||result.minimum.score<minimum.score)minimum={...result.minimum,phaseMs};
      if(!maximum||result.maximum.score>maximum.score)maximum={...result.maximum,phaseMs};
      transitions+=result.search.transitions;peakStates=Math.max(peakStates,result.search.peakStates);
      options.onProgress?.({completed:++completed,total:77,frameRate,phaseMs});
    }
    rates.push({frameRate,reference,minimum,maximum,search:{transitions,peakStates,clockClasses:apTimingClocks(frameRate).length}});
  }
  return {version:'ap-window-range-v1',status:'exact',scope:'manual_ap_integer_ms_fixed_automatic',order:[...options.order],rates};
}
