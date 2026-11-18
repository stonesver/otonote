import { createOrdinaryScoreBound } from './ordinary-score-bound.mjs';
import { createFrameClock, skillEndFrame } from './formal-frame-clock.mjs';
import { formalJudgementType } from './formal-judgement.mjs';

/** The robust plan score is <= its 60 Hz, phase 0, bias 0 replay. Relax each
 * manual input to its entire AP window in that clock. For each skill, count
 * every note at its earliest possible frame at/after activation, including
 * notes whose windows straddle activation. Independent choices overestimate
 * concurrent counters; they never remove a legal timing plan. */
export function createApTimingScoreBound({ rules, ...options }) {
  const { song, pairSkills } = options, clock = createFrameClock({frameRate:60});
  const maximumLife = Number(rules.tables.LiveSettings.find(r => r._key === 'life_base')._value);
  const relaxedSkills = new Map();
  for (const [key, skill] of pairSkills) {
    if (skill.supportEffects.some(e => e.type === 12006 && e.targets.includes(5) && e.value !== 5)
      || skill.liveEffects.some(e => e.release?.includes(5) || e.rate < 0)) return null;
    // Recovery can activate an overheal condition. Granting every potentially
    // active positive effect relaxes the team/order-dependent life history.
    const liveEffects = skill.liveEffects.map(e => ({...e, active: e.active ||
      e.condition?.kind === 'life_at_least' && e.condition.positive && e.condition.threshold <= 2 * maximumLife}));
    relaxedSkills.set(key, {...skill,liveEffects});
  }
  let lag = 0;
  const choices = song.timeline.events.map(event => {
    const manual = [1,20,40].includes(event.type) && event.kind === 'authored';
    const window = manual ? rules.tables.LiveJudgementTiming.find(row => row._assistLevel === 0
      && row._noteSimulateJudgement === 5 && row._noteJudgementType === formalJudgementType(event.type,event.critical)) : null;
    const first = clock.indexAt(Math.max(0,event.timeMs-(window?._beforeMs??0)));
    const last = clock.indexAt(event.timeMs+(window?._afterMs??0));
    lag = Math.max(lag,clock.at(last).timeMs-event.timeMs);
    return {first,last};
  });
  for (const start of song.timeline.skillTimes) for (const skill of relaxedSkills.values()) for (const effect of skill.liveEffects) {
    const end = skillEndFrame(clock,start,effect.durationRawMs);
    lag = Math.max(lag,clock.at(end.frame).timeMs-end.timeMs,clock.at(end.startFrame).timeMs-start);
  }
  // Early arrival cannot execute a future score bucket before its chart time.
  // Late arrivals bound the time until that bucket becomes immutable. Keep
  // the full command-count bound inside a bucket: timings can move updates.
  const regular = song.timeline.events.every(e => Number.isSafeInteger(e.timeMs) && e.timeMs >= 0 && e.timeMs+lag < 2**20);
  return createOrdinaryScoreBound({...options,pairSkills:relaxedSkills,metric:'maximumScore',frameRate:60,
    inputWindows:{choices,applicationLimit:regular?2*(Math.ceil((40+lag)*60/1000)+2)+1:Infinity}});
}
