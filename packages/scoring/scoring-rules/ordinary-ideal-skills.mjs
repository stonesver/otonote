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
