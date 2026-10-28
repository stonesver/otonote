import { createOrdinarySkillLifecycle } from './formal-performance-state.mjs';
import { createFrameClock, skillEndFrame } from './formal-frame-clock.mjs';

/** Ideal AP inputs still drive cumulative ordinary skills. Empty frames are
 * identity transitions here; retain every input, activation and expiration. */
export function ordinaryIdealSkillCommands(skills, timeline, order, frameRate, maximumLife) {
  const clock = createFrameClock({ frameRate }), arrivals = new Map(), frames = new Set([0]);
  for (const note of timeline.events) {
    const frame = clock.indexAt(note.timeMs);
    if (!arrivals.has(frame)) arrivals.set(frame, []);
    arrivals.get(frame).push({ timeMs: note.timeMs, judgement: 5 }); frames.add(frame);
  }
  timeline.skillTimes.forEach((start, i) => {
    frames.add(clock.indexAt(start));
    for (const effect of [...skills[order[i]].liveEffects, ...skills[order[i]].supportEffects.filter(e => e.type === 12006 && !e.startup)]) {
      if (effect.durationRawMs > 0) frames.add(skillEndFrame(clock, start, effect.durationRawMs).frame);
    }
  });
  const lifecycle = createOrdinarySkillLifecycle({ skills, skillTimes: timeline.skillTimes, skillOrder: order,
    clock, life: { at: () => maximumLife, add: () => {} }, skillEndFrame });
  for (const frame of [...frames].sort((a,b) => a-b)) lifecycle.advance(frame, arrivals.get(frame) ?? []);
  return lifecycle.commands;
}

/** At ideal AP/full life each slot's lifecycle is independent. Compile it for
 * one activation position once, then reuse it across teams and all 120 orders.
 * Native replay sorts simultaneous factors by timestamp and owner; preserve
 * each owner's internal command sequence when concatenating independent slots.
 * Keep the cache local to one immutable chart/clock/life context and bounded. */
export function createOrdinaryIdealSkillCommands(timeline, frameRate, maximumLife) {
  const cache=new Map(),empty=()=>({liveEffects:[],supportEffects:[]});
  let commandCount=0;
  return (skills,order)=>order.flatMap((slot,position)=>{
    const skill=skills[slot],key=JSON.stringify([slot,position,skill.liveEffects,skill.supportEffects]);
    let commands=cache.get(key);
    if(!commands){
      const isolated=Array.from({length:5},empty);isolated[slot]=skill;
      commands=ordinaryIdealSkillCommands(isolated,timeline,order,frameRate,maximumLife);
      while(cache.size&&(cache.size>=512||commandCount+commands.length>32768)){
        const oldest=cache.keys().next().value;commandCount-=cache.get(oldest).length;cache.delete(oldest);
      }
      if(commands.length<=32768){cache.set(key,commands);commandCount+=commands.length;}
    }
    return commands;
  });
}
