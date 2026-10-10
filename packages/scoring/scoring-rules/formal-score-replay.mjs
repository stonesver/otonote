import { createFrameClock, skillEndFrame } from './formal-frame-clock.mjs';
const f32 = Math.fround;
const floatFields = ['combo', 'general', 'just', 'perfect', 'great', 'good'];
const intFields = ['power', 'luck'];
const emptyDelta = () => ({ power: 0, combo: 0, general: 0, just: 0, perfect: 0, great: 0, good: 0, luck: 0 });
export const scoreFrame = timeMs => Math.max(0, Math.ceil(f32(f32(timeMs) / 40)));
const byTime = (a, b) => a.timeMs - b.timeMs;
export const compareScoreFactors = (a, b) => byTime(a, b) || a.ownerId - b.ownerId || (a.sequence ?? 0) - (b.sequence ?? 0);

/** Incremental scoring, independently reconstructed from global build 25:
 * Calculate 0x55e4108, ExecuteCommand 0x55e46c0, UndoCommand 0x55e43bc,
 * ApplyFactorCommand 0x55e2a14, ScoreFactorState.UndoDiff 0x55e5268.
 * Buckets are invalidation units, NOT a rounding of command timestamps.
 * scoreNote must not accumulate side effects: a bucket may execute repeatedly.
 * External count history may change between frames, just as in the client.
 */
export function createScoreReplay({ musicLengthMs, scoreNote, retainNotes = true }) {
  if (!Number.isSafeInteger(musicLengthMs) || musicLengthMs < 0) throw new Error('Invalid score replay length');
  const lastFrame = scoreFrame(musicLengthMs) + 49;
  const frameOf = time => Math.min(lastFrame, scoreFrame(time));
  const buckets = [], notes = [];
  const state = { ...emptyDelta(), general: 1 };
  let previous = -1, changed = Infinity, total = 0, sequence = 0, pendingFixed;
  const bucketAt = frame => {
    return buckets[frame] ??= { factors: [], notes: [], delta: null, score: 0, fixed: 0 };
  };
  function register(command, kind) {
    if (!Number.isSafeInteger(command.timeMs)) throw new Error('Invalid score command timestamp');
    const frame = frameOf(command.timeMs), entry = { ...command, sequence: sequence++ };
    bucketAt(frame)[kind].push(entry);
    changed = Math.min(changed, frame);
    return entry;
  }
  function addFactor(command) {
    if (!Number.isSafeInteger(command.ownerId)) throw new Error('Invalid factor owner');
    for (const key of [...floatFields, ...intFields]) if (command[key] !== undefined && !Number.isFinite(command[key])) throw new Error('Invalid factor delta');
    register(command, 'factors');
  }
  function addNote(note) {
    // Score-only callers do not inspect sequence/result fields. Stable sorting
    // preserves registration order for tied native IDs without copying notes.
    if (!retainNotes) {
      if (!Number.isSafeInteger(note.timeMs)) throw new Error('Invalid score command timestamp');
      const frame = frameOf(note.timeMs);
      bucketAt(frame).notes.push(note); sequence++; changed = Math.min(changed, frame);
      return note;
    }
    const entry = register(note, 'notes');
    notes.push(entry);
    return entry;
  }
  function apply(command, delta) {
    for (const key of floatFields) if (command[key] !== undefined) {
      state[key] = f32(state[key] + command[key]);
      delta[key] = f32(delta[key] + command[key]);
    }
    for (const key of intFields) if (command[key] !== undefined) {
      state[key] = (state[key] + command[key]) | 0;
      delta[key] = (delta[key] + command[key]) | 0;
    }
  }
  function calculate(timeMs) {
    if (!Number.isSafeInteger(timeMs)) throw new Error('Invalid score calculation timestamp');
    const target = frameOf(timeMs), retain = Math.min(target, changed - 1);
    if (retain < previous) {
      for (let frame = previous; frame > retain; frame--) {
        const bucket = buckets[frame];
        if (!bucket) continue;
        total -= bucket.score;
        // Native subtracts each bucket's accumulated diff ONCE. Restoring a
        // state snapshot, or reversing individual commands, loses f32 residue.
        if (bucket.delta) {
          for (const key of floatFields) state[key] = f32(state[key] - bucket.delta[key]);
          for (const key of intFields) state[key] = (state[key] - bucket.delta[key]) | 0;
          bucket.delta = null;
        }
        bucket.score = 0;
      }
      previous = retain;
    }
    for (let frame = previous + 1; frame <= target; frame++) {
      const bucket = buckets[frame];
      if (!bucket) continue;
      if (bucket.factors.length > 1) bucket.factors.sort(compareScoreFactors);
      // A captured native stream can supply its actual ID. Projected charts
      // retain the explicit ideal source order, not a fabricated native ID.
      if (bucket.notes.length > 1) bucket.notes.sort((a, b) => byTime(a, b) || (a.nativeNoteId ?? a.sourceIndex ?? 0) - (b.nativeNoteId ?? b.sourceIndex ?? 0) || (retainNotes ? a.sequence - b.sequence : 0));
      let cursor = 0;
      for (const note of bucket.notes) {
        while (cursor < bucket.factors.length && bucket.factors[cursor].timeMs <= note.timeMs) apply(bucket.factors[cursor++], bucket.delta ??= emptyDelta());
        const result = scoreNote(note, state);
        if (retainNotes) note.result = result;
        if (!Number.isSafeInteger(result.score) || result.score < 0) throw new Error('Invalid replay note score');
        bucket.score += result.score;
      }
      while (cursor < bucket.factors.length) apply(bucket.factors[cursor++], bucket.delta ??= emptyDelta());
      bucket.score += bucket.fixed;
      total += bucket.score;
    }
    previous = target; changed = Infinity;
    // AddFixedScore stores one pending command. Calculate installs it AFTER
    // executing notes; later rewind/forward includes its bucket contribution.
    if (pendingFixed) {
      const bucket = bucketAt(frameOf(pendingFixed.timeMs));
      if (bucket.hasFixed) throw new Error('Duplicate fixed-score bucket');
      bucket.hasFixed = true; bucket.fixed = pendingFixed.score;
      bucket.score += pendingFixed.score; total += pendingFixed.score;
      pendingFixed = undefined;
    }
    return total;
  }
  function addFixedScore(command) {
    if (!Number.isSafeInteger(command.timeMs) || !Number.isSafeInteger(command.score) || command.score < 0) throw new Error('Invalid fixed score');
    pendingFixed = { ...command };
  }
  return { addFactor, addNote, addFixedScore, calculate, notes, state, get score() { return total; } };
}


/** Owner = member position * 100 + native owner kind (member 1, support 2).
 * SkillStatus.CreateLiveSkillDictionary passes the deck position to LiveSkill;
 * ConvertOwnerId's native lookup maps LiveSkill (1) and GekisouSkill (4) to 1.
 * Arrival clock is explicitly ideal; no device timing is inferred here.
 */
export function liveSkillCommands(order, perfectSkills, times, frameRate, justSkills = perfectSkills, clockInput = null) {
  const clock = clockInput ?? createFrameClock({ frameRate });
  return order.flatMap((slot, i) => perfectSkills[slot].liveEffects.flatMap((effect, j) => {
    const just = justSkills[slot].liveEffects[j];
    if (!effect.active && !just.active) return [];
    const value = f32(Math.floor(f32(f32(effect.rate) * 100000)) / 100000);
    const start = times[i], ending = skillEndFrame(clock, start, effect.durationRawMs ?? effect.durationMs);
    const end = ending.timeMs;
    const delta = effect.type === 2000 ? { general: value } : { perfect: effect.active ? value : 0, just: just.active ? value : 0 };
    return [{ timeMs: start, arrivalFrame: clock.indexAt(start), arrivalTimeMs: clock.at(clock.indexAt(start)).timeMs, ownerId: slot * 100 + 1, ...delta },
      { timeMs: end, arrivalFrame: ending.frame, arrivalTimeMs: clock.at(ending.frame).timeMs, ownerId: slot * 100 + 1,
        ...Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, -value])) }];
  }));
}

/** Compile immutable chart arrivals once for repeated ideal skill-order replays.
 * Dynamic commands, rollback buckets, score state and trace notes remain per run. */
export function createScoreTimelineReplay(events, frameRate = 60) {
  const clock = createFrameClock({ frameRate }), arrivals = new Map();
  for (const event of events) {
    const frame = event.inputFrame ?? clock.indexAt(event.timeMs);
    if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid arrival frame');
    if (!arrivals.has(frame)) arrivals.set(frame, []);
    arrivals.get(frame).push(event);
  }
  const preparedNotes = { frames: [...arrivals].sort((a,b)=>a[0]-b[0]), musicLengthMs: Math.max(0,...events.map(e=>e.timeMs)) };
  return options => replayScoreTimeline({ ...options, events, frameRate, clock, preparedNotes });
}

/** Native update order: before-update factors, input/score, skill factors/score,
 * then Gekisou state updates and historical queries. After-score factors and
 * pending awards are evaluated on the NEXT frame. Empty frames with no state
 * changes may be skipped, preserving the first and last frame of each gap.
 * frameActions run after scoring; callers can update count-history views,
 * query endpoints, or enqueue a fixed award without a second scoring engine.
 */
export function replayScoreTimeline({ events, commands, frameRate = 60, scoreNote, frameActions = [], clock: clockInput = null, beforeInputs = () => {}, retainNotes = true, preparedNotes = null }) {
  const clock = clockInput ?? createFrameClock({ frameRate });
  const arrivals = new Map();
  function enqueue(frame, kind, value) {
    if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid arrival frame');
    if (!arrivals.has(frame)) arrivals.set(frame, { notes: [], before: [], skill: [], after: [], actions: [] });
    arrivals.get(frame)[kind].push(value);
  }
  if (!preparedNotes) for (const event of events) enqueue(event.inputFrame ?? clock.indexAt(event.timeMs), 'notes', event);
  for (const command of commands) {
    const phase = command.phase ?? 'skill';
    if (!['before', 'skill', 'after'].includes(phase)) throw new Error('Invalid factor phase');
    enqueue(command.arrivalFrame ?? clock.indexAt(command.arrivalTimeMs ?? command.timeMs), phase, command);
  }
  for (const action of frameActions) enqueue(action.frame, 'actions', action.run);
  const musicLengthMs = Math.max(preparedNotes?.musicLengthMs ?? Math.max(0, ...events.map(e => e.timeMs)), ...commands.map(c => c.timeMs));
  const replay = createScoreReplay({ musicLengthMs, scoreNote, retainNotes });
  let previousFrame = -1;
  const dynamicFrames = [...arrivals].sort((a,b)=>a[0]-b[0]), noteFrames = preparedNotes?.frames ?? [];
  const empty = { notes: [], before: [], skill: [], after: [], actions: [] };
  let dynamicIndex = 0, noteIndex = 0;
  while (dynamicIndex < dynamicFrames.length || noteIndex < noteFrames.length) {
    const frame = Math.min(dynamicFrames[dynamicIndex]?.[0] ?? Infinity, noteFrames[noteIndex]?.[0] ?? Infinity);
    const entries = dynamicFrames[dynamicIndex]?.[0] === frame ? dynamicFrames[dynamicIndex++][1] : empty;
    const inputNotes = noteFrames[noteIndex]?.[0] === frame ? noteFrames[noteIndex++][1] : entries.notes;
    if (frame > previousFrame + 1) {
      // A query can leave the cursor in the past, and an after-score command
      // can invalidate a bucket. Flush on the actual next frame, not on the
      // previous frame again or only when the next judgement arrives.
      if (previousFrame >= 0) replay.calculate(clock.at(previousFrame + 1).timeMs);
      if (frame > previousFrame + 2) replay.calculate(clock.at(frame - 1).timeMs);
    }
    entries.before.forEach(replay.addFactor);
    beforeInputs(inputNotes, frame);
    inputNotes.forEach(replay.addNote);
    replay.calculate(clock.at(frame).timeMs);
    if (entries.skill.length) {
      entries.skill.forEach(replay.addFactor);
      replay.calculate(clock.at(frame).timeMs);
    }
    entries.after.forEach(replay.addFactor);
    for (const run of entries.actions) run(replay);
    previousFrame = frame;
  }
  // Include authored timestamps ahead of early AP input and delayed releases.
  replay.calculate(Math.max(musicLengthMs, clock.at(previousFrame + 1).timeMs));
  return replay;
}
