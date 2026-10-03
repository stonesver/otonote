import { createFrameClock, gekisouReleaseFrames, nativeSkillDuration, skillEndFrame } from './formal-frame-clock.mjs';
import { createGekisouLuckMachine, createScoringRandom } from './gekisou-luck.mjs';
import { formalJudgementType } from './formal-judgement.mjs';
import { roundToEven } from './formal-time.mjs';
import { resolveTimingJudgement } from './performance-scenarios.mjs';
import { createLifeReplay, createComboReplay, createOrdinarySkillLifecycle } from './formal-performance-state.mjs';

const f32 = Math.fround;
const sum32 = xs => xs.reduce((s, n) => f32(s + n), 0);
const quantize = n => f32(Math.floor(f32(n * 100000)) / 100000);

/** Native RecalculateBonusDependentCounts judgement block, build 25,
 * 0x55d6d20..0x55d6e8c. Protection affects task combo only. */
export function applyGekisouComboJudgement(state, judgement, gain, guards = []) {
  let protectedCombo = false;
  const remaining = guards.map(guard => {
    if (judgement > 2 || guard.remaining === 0 || !guard.targets.includes(judgement)) return guard.remaining;
    protectedCombo = true;
    return guard.remaining === null ? null : guard.remaining - 1;
  });
  const combo = judgement >= 3 ? state.combo + Math.floor(gain) : protectedCombo ? state.combo : 0;
  return { combo, maxCombo: Math.max(state.maxCombo, combo), protectedCombo, remaining };
}

/** AP replay on an explicit ideal device clock. Native order:
 * BeforeUpdate -> judgements -> skill phase 2 -> Gekisou.Update.
 * Score commands retain their native authored/override timestamps and are
 * replayed separately, so a later frame can change an earlier note's score.
 * This is not a recording of the game's input scheduler or random stream. */
export function replayGekisouFrames(rules, timeline, ranges, effects, scenario, seed, { trace = false, performanceInput = null, ordinarySkills = null, skillOrder = [0,1,2,3,4] } = {}) {
  const random = createScoringRandom(seed);
  const clock = createFrameClock({ frameRate: scenario.frameRate, frames: scenario.frames });
  const setting = key => Number(rules.tables.LiveSettings.find(row => row._key === key)?._value);
  const maximumLife = setting('life_base'), musicLengthMs = Math.max(...timeline.events.map(e => e.timeMs), ...(timeline.skillTimes ?? []));
  const life = performanceInput ? createLifeReplay(maximumLife, musicLengthMs) : null;
  const combo = performanceInput ? createComboReplay(rules.tables.LiveComboScoreBonus) : null;
  const ordinary = ordinarySkills ? createOrdinarySkillLifecycle({ skills: ordinarySkills, skillTimes: timeline.skillTimes, skillOrder,
    clock, life, skillEndFrame }) : null;
  let lowestLife = maximumLife, totalDamage = 0, convertedCount = 0;
  const judgementCounts = Object.fromEntries([1,2,3,4,5,6].map(j => [j,0]));
  const stateTrace = [];
  const windows = new Map(rules.tables.LiveJudgementTiming.filter(r => r._assistLevel === 0 && r._noteSimulateJudgement === 6).map(r => [r._noteJudgementType, r]));
  const commands = [], comboUpdates = [], luckEvents = [], transitions = [];
  // CreateGekisouLiveSettings: maximum Master AfterMs, then 500 ms complete
  // delay. BeforeUpdate enters state 8 one frame after state 7 releases skills.
  const slowJudgeDelay = Math.max(...rules.tables.LiveJudgementTiming.map(r => r._afterMs));
  const states = ranges.map((range, i) => ({ ...range, rank: scenario.ranks[i], combo: 0, maxCombo: 0, just: 0, rawJust: 0,
    justBase: 0, perfectCount: 0, noteScore: 0, baseNoteScore: 0, entered: false, closed: false,
    history: [], comboHistory: [], countCommands: [], previousLots: [], rushFactor: 0,
    effects: effects.filter(e => e.active && e.missionType === range.missionType).map(e => ({ ...e,
      uses: 0, pending: 0, counter: 0, executing: false, triggered: false, scoreFactor: 0, startMs: null, endMs: Infinity,
      cumulativeRaw: 0, exhaustedFrame: -1 })), luck: createGekisouLuckMachine(rules, { random }) }));
  const events = (performanceInput?.judgements ?? timeline.events).map(event => ({ ...event,
    inputFrame: event.inputFrame ?? clock.indexAt(event.timeMs + scenario.timingOffsetMs),
    sectionIndex: ranges.findIndex(r => event.timeMs >= r.startMs && event.timeMs <= r.endMs) + 1,
    judgement: 5 })).sort((a,b) => a.inputFrame - b.inputFrame || (a.inputSequence ?? a.scoreIndex) - (b.inputSequence ?? b.scoreIndex));
  const frames = new Map();
  for (const note of events) {
    if (!frames.has(note.inputFrame)) frames.set(note.inputFrame, []);
    frames.get(note.inputFrame).push(note);
  }
  // Empty frames matter for pending lotteries, cumulative factors and release.
  for (const s of states) {
    s.lastInputFrame = Math.max(clock.indexAt(s.endMs),
      ...events.filter(n => n.sectionIndex === s.index).map(n => n.inputFrame));
    Object.assign(s, gekisouReleaseFrames(clock, s.endMs, slowJudgeDelay));
    for (let f = clock.indexAt(s.startMs); f <= s.releaseFrame + 1; f++) {
      if (!frames.has(f)) frames.set(f, []);
    }
  }
  function command(s, e, timeMs, value, type = 2000, phase = 'skill') {
    commands.push({ timeMs, arrivalFrame: currentFrame, arrivalTimeMs: clock.at(currentFrame).timeMs,
      ownerId: e ? e.slotIndex * 100 + (e.kind === 'support' ? 2 : 1) : -1, type, value, perfect: true, just: true, ending: value < 0,
      sectionIndex: s.index, source: e?.key ?? 'rush', phase, sequence: commands.length });
  }
  function updateScoreFactor(s, e, value, timeMs) {
    if (value === e.scoreFactor) return;
    // Native replaces the old handle, preserving float32 subtraction/addition.
    if (e.scoreFactor) command(s, e, timeMs, -e.scoreFactor);
    if (value) command(s, e, timeMs, value);
    if (trace) transitions.push({ frame: currentFrame, timeMs, sectionIndex: s.index, source: e.key, action: 'factor', value });
    e.scoreFactor = value;
  }
  function start(s, e, timeMs) {
    if (e.eligible && !e.eligible(life?.at(clock.at(currentFrame).timeMs) ?? maximumLife)) return false;
    s.countsDirty = true;
    e.remaining = e.definition._effectLimitCount > 0 ? e.definition._effectLimitCount : null;
    e.triggered = e.executing = true; e.startMs = timeMs;
    e.durationRawMs = nativeSkillDuration(e.definition._activationTimeSecond);
    // Trigger timestamps can be backdated: the lifecycle starts on THIS update.
    e.executeFrame = currentFrame; e.endMs = Infinity;
    if (e.durationRawMs > 0) {
      const nextMs = clock.at(currentFrame + 1).timeMs;
      e.endFrame = f32(nextMs - timeMs) >= e.durationRawMs ? currentFrame + 1
        : Math.max(currentFrame + 2, clock.indexAt(timeMs + Math.floor(e.durationRawMs) + 1));
      e.endMs = e.endFrame === currentFrame + 1 ? nextMs : timeMs + Math.ceil(e.durationRawMs);
    } else e.endFrame = Infinity;
    if ([12000, 13000].includes(e.definition._skillEffectType)) {
      s.countCommands.push({ timeMs, sequence: judgementSequence - 1, value: e.definition._effectValue, type: e.definition._skillEffectType });
    }
    if (trace) transitions.push({ frame: currentFrame, timeMs, sectionIndex: s.index, source: e.key, action: 'start' });
    return true;
  }
  function recount(s) {
    // RecalculateBonusDependentCounts merges timestamped bonus commands with
    // authored note history; threshold skills can backdate their first bonus.
    // Append-only frames extend the previous result. Only a new/backdated
    // command invalidates that prefix; replay it then to preserve native order.
    if (!s.countReplay || s.countsDirty) {
      s.countReplay = { sorted: s.countCommands.slice().sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence),
        cursor: 0, processed: 0, comboGain: 1, justGain: 1, protectionUses: new Map() };
      s.combo = s.maxCombo = s.just = s.justBase = s.rawJust = 0; s.comboHistory = [];
    }
    const cache = s.countReplay, sorted = cache.sorted;
    let i = cache.cursor, comboGain = cache.comboGain, justGain = cache.justGain;
    for (let n = cache.processed; n < s.history.length; n++) {
      const note = s.history[n];
      while (i < sorted.length && (sorted[i].timeMs < note.timeMs ||
        sorted[i].timeMs === note.timeMs && sorted[i].sequence <= note.judgementSequence)) {
        const c = sorted[i++];
        if (c.type === 12000) comboGain = f32(comboGain + c.value);
        else justGain = f32(justGain + c.value);
      }
      if (s.missionType === 1) {
        const guards = note.judgement > 2 ? [] : s.effects.filter(e => e.definition._skillEffectType === 12004 && e.triggered &&
          note.timeMs >= e.startMs && note.timeMs < e.endMs).map(guard => ({ key: guard.key,
            targets: guard.targets?.length ? guard.targets : [1, 2],
            remaining: guard.definition._effectLimitCount > 0 ? Math.max(0, guard.definition._effectLimitCount - (cache.protectionUses.get(guard.key) ?? 0)) : null,
          }));
        const next = applyGekisouComboJudgement(s, note.judgement, comboGain, guards);
        guards.forEach((guard, i) => { if (guard.remaining !== null) cache.protectionUses.set(guard.key,
          (cache.protectionUses.get(guard.key) ?? 0) + guard.remaining - next.remaining[i]); });
        note.gekisouComboProtected = next.protectedCombo;
        s.combo = next.combo; s.maxCombo = next.maxCombo;
        s.comboHistory.push({ timeMs: note.timeMs, combo: s.combo });
      }
      if (note.judgement === 6) {
        s.rawJust++; const gain = Math.floor(justGain); s.justBase += gain;
        const extra = s.effects.filter(e => e.definition._skillEffectType === 13002 && e.triggered &&
          note.timeMs >= e.startMs && note.timeMs < e.endMs).reduce((sum, e) => sum +
          Math.min(e.cumulative._maxCumulativeCount, Math.floor(s.justBase / e.cumulative._conditionValues[0])) * e.definition._effectValue, 0);
        s.just += gain + extra;
      }
    }
    Object.assign(cache, { cursor: i, processed: s.history.length, comboGain, justGain });
    if (s.missionType === 1) comboUpdates.push({ frame: currentFrame, sectionIndex: s.index,
      // Appends preserve this prefix. Recounts allocate a new array, so earlier
      // frame views never see future/backdated bonuses before they arrive.
      history: s.comboHistory, length: s.comboHistory.length });
  }
  function consume(s, timeMs, origin, nextLots) {
    const before = s.luck.scoreFactorPercent();
    const result = s.luck.consume();
    if (result == null) return false;
    const after = s.luck.scoreFactorPercent();
    if (after !== before) command(s, null, timeMs, after - before, 'luck', 'after');
    s.rushFactor = after - 100;
    nextLots.push({ result, timeMs });
    if (trace) luckEvents.push({ sectionIndex: s.index, inputFrame: currentFrame, timeMs, origin, result, ...structuredClone(s.luck.state) });
    return true;
  }
  let currentFrame = 0, judgementSequence = 0;
  // FeverEventUpdater advances at most one state per frame. BeforeUpdate
  // enables grade 6 globally at Start and disables it at End, before inputs.
  const justWindows = states.filter(s => s.missionType === 3).map(s => ({
    start: clock.indexAt(s.startMs),
    end: Math.max(clock.indexAt(s.startMs) + 1, clock.indexAt(s.endMs)),
  }));
  const lastFrame = Math.max(...frames.keys(), ordinary?.lastFrame ?? 0);
  for (let frame = 0; frame <= Math.max(lastFrame, ordinary?.lastFrame ?? 0); frame++) {
    if (!performanceInput && !frames.has(frame)) continue;
    const frameNotes = frames.get(frame) ?? [];
    currentFrame = frame;
    const timeMs = clock.at(frame).timeMs;
    frameNotes.forEach((note, i) => { note.judgementSequence = judgementSequence + i; });
    // Judgements see the PREVIOUS skill phase's converters and window handles.
    const justEnabled = justWindows.some(w => frame >= w.start && frame < w.end);
    const judgementEffects = states.flatMap(s => s.effects).filter(e => e.executing);
    for (const note of frameNotes) {
      note.inputTimeMs = timeMs;
      const offset = note.timingOffsetMs ?? scenario.timingOffsetMs;
      const expansionFor = base => sum32(judgementEffects.filter(e => e.definition._skillEffectType === 4004).map(e =>
        roundToEven(f32(f32(e.definition._effectValue / 10000) * base))));
      if (performanceInput) note.judgement = resolveTimingJudgement(rules, note, { justEnabled, justExpansion: expansionFor });
      else {
        const window = windows.get(formalJudgementType(note.type, note.critical));
        if (window) {
          const baseWindow = offset < 0 ? window._beforeMs : window._afterMs;
          if (justEnabled && Math.abs(offset) <= baseWindow + expansionFor(baseWindow)) note.judgement = 6;
        }
      }
      note.originalJudgement = performanceInput ? resolveTimingJudgement(rules, note, { justEnabled }) : 5;
      note.windowJudgement = note.judgement;
      // Ordinary converters resolve first in owner/activation order, then
      // Gekisou converters consume only a matching, actually changed grade.
      if (ordinary) Object.assign(note, ordinary.convert(note.judgement));
      for (const effect of judgementEffects) {
        const type = effect.definition._skillEffectType;
        const targets = effect.targets ?? (type === 13005 ? [5] : []);
        if (type === 13005 && effect.pending > 0 && targets.includes(note.judgement) && note.judgement !== 6) {
          note.judgement = 6; effect.pending--; note.convertedBy = { source: effect.key, effectId: effect.definition._id, kind: 'gekisou' };
          if (!effect.pending) effect.exhaustedFrame = frame;
          break;
        }
        if (type === 12006 && effect.remaining !== 0 && targets.includes(note.judgement) && note.judgement !== effect.definition._effectValue) {
          note.judgement = effect.definition._effectValue; if (effect.remaining !== null) effect.remaining--;
          note.convertedBy = { source: effect.key, effectId: effect.definition._id, kind: 'gekisou' }; break;
        }
      }
      if (performanceInput) {
        if (note.convertedBy) convertedCount++;
        judgementCounts[note.judgement]++;
        combo.add(note.timeMs, note.judgement);
        const damage = rules.tables.LiveJudgementParameter.find(row => row._noteSimulateJudgement === note.judgement)?._damage;
        if (!Number.isInteger(damage) || damage < 0) throw new Error('缺少判定生命参数');
        if (damage) { life.add({ timeMs: note.timeMs, kind: 0, value: damage }); totalDamage += damage; }
        note.lifeAtInput = life.at(note.timeMs); lowestLife = Math.min(lowestLife, note.lifeAtInput);
      }
    }
    ordinary?.advance(frame);
    if (performanceInput) {
      lowestLife = Math.min(lowestLife, life.at(timeMs));
      if (trace && (frameNotes.length || ordinary?.skillTrace.at(-1)?.frame === frame)) stateTrace.push({ frame, timeMs, life: life.at(timeMs), combo: combo.state.combo, maxCombo: combo.state.maxCombo });
    }
    for (const s of states) {
      const notes = frameNotes.filter(n => n.sectionIndex === s.index);
      if (s.closed || (!s.entered && timeMs < s.startMs)) {
        // Early AP input retains authored section membership. Start effects
        // are not yet installed; recount after entry can still backdate them.
        s.history.push(...notes); s.perfectCount += notes.filter(n => n.judgement >= 5).length;
        continue;
      }
      const entering = !s.entered;
      s.entered = true;
      const closing = frame >= s.releaseFrame;
      if (frame > s.releaseFrame) {
        if (s.rushFactor) command(s, null, timeMs, -s.rushFactor, 'luck', 'before');
        s.closed = true; continue;
      }
      // Skill phase: previous-frame counters/lots, current judgement results.
      for (const e of s.effects) {
        const r = e.definition, type = r._skillEffectType;
        const eligible = !e.eligible || e.eligible(life?.at(timeMs) ?? maximumLife);
        if (e.executing && (frame >= e.endFrame || closing)) {
          e.executing = false;
          if ([12000, 13000].includes(type)) {
            s.countCommands.push({ timeMs: closing ? timeMs : e.endMs, sequence: judgementSequence - 1,
              value: -r._effectValue, type });
            s.countsDirty = true;
          }
          updateScoreFactor(s, e, 0, closing ? timeMs : e.endMs);
          if (trace) transitions.push({ frame, timeMs, sectionIndex: s.index, source: e.key, action: 'end' });
        }
        if (closing) continue;
        if (entering && e.trigger.some(c => c._conditionType === 7010 ||
          (c._conditionType === 7020 && r._skillTriggerType === 2)) && random() < e.probability / 100) {
          const started = start(s, e, s.startMs);
          if (started && type === 11005) s.luck.addMinimum(r._effectValue - 1, r._effectLimitCount);
          if (started && type === 11003) s.luck.addGaugePercent(r._effectValue);
        }
        if (type === 12000 && e.comboThreshold && !e.triggered && s.combo >= e.comboThreshold) {
          start(s, e, s.history.at(-1)?.timeMs ?? timeMs);
        }
        for (const lot of eligible ? s.previousLots : []) {
          if (type === 11002 && lot.result === 3) { s.luck.addBonusPoints(r._effectValue);
            if (trace) transitions.push({ frame, timeMs, sectionIndex: s.index, source: e.key, action: 'bonus', value: r._effectValue });
          }
          if (type === 11003 && lot.result === 0 && e.trigger.some(c => c._conditionType === 7000) && e.uses < r._effectExecuteLimitCount) {
            s.luck.addGaugePercent(r._effectValue); e.uses++;
            if (trace) transitions.push({ frame, timeMs, sectionIndex: s.index, source: e.key, action: 'gauge', value: r._effectValue });
          }
        }
        if (type === 13005) {
          if (frame < s.settleFrame && !e.pending && e.exhaustedFrame < frame) {
            e.executing = false;
            e.counter += notes.filter(n => n.judgement === 5).length;
            if (eligible && e.counter >= e.perfectInterval && e.perfectInterval > 0 && e.uses < r._effectExecuteLimitCount) {
              e.counter %= e.perfectInterval; e.pending = r._effectLimitCount; e.uses++;
              start(s, e, timeMs);
            }
          }
        }
        if (type === 2000) {
          // Sustained RUSH support condition reads the previous G frame. The
          // native base RUSH multiplier is a separate, multiplicative handle.
          updateScoreFactor(s, e, (s.luck.state.rushCombo && (!e.eligible || e.eligible(life?.at(timeMs) ?? maximumLife))) ? quantize(f32(r._effectValue / 10000)) : 0, timeMs);
        }
        if (type === 2001 && e.executing) {
          e.cumulativeRaw += notes.filter(n => n.judgement === 6).length;
          const count = e.cumulative._skillCumulativeConditionType === 7001 ? s.combo : e.cumulativeRaw;
          const n = Math.min(e.cumulative._maxCumulativeCount, Math.floor(count / e.cumulative._conditionValues[0]));
          const value = Math.min(r._maxEffectValue || Infinity, n * r._effectValue);
          updateScoreFactor(s, e, quantize(f32(value / 10000)), timeMs);
        }
      }
      if (closing) {
        continue;
      }
      // Gekisou.Update: append judgements, recalculate count history, lottery.
      s.history.push(...notes); s.perfectCount += notes.filter(n => n.judgement >= 5).length;
      // LUCK AP judgements are always PERFECT, so neither COMBO nor JUST
      // histories change there. Its ranking points live in the luck machine.
      if (notes.length || s.countsDirty) { if (s.missionType !== 2) recount(s); s.countsDirty = false; }
      const nextLots = [];
      if (s.missionType === 2) {
        for (const note of notes) {
          const gauge = sum32(s.effects.filter(e => e.definition._skillEffectType === 11001 && e.triggered &&
            note.timeMs >= e.startMs && note.timeMs < e.endMs).map(e => f32(e.definition._effectValue / 10000)));
          s.luck.addNote(note.type, note.judgement, gauge);
          consume(s, note.timeMs, 'note', nextLots);
        }
        // State 3 is the entry frame; pending-only lotteries require state 4.
        if (!entering && !nextLots.length && timeMs < s.endMs) consume(s, timeMs, 'empty_frame', nextLots);
      }
      s.previousLots = nextLots;
    }
    judgementSequence += frameNotes.length;
  }
  return { clock, states, events, commands, comboUpdates, ordinaryCommands: ordinary?.commands,
    ...(performanceInput ? { performance: { ...combo.state, life: life.at(clock.at(Math.max(lastFrame, ordinary?.lastFrame ?? 0)).timeMs), lowestLife, totalDamage,
      recoveryAmount: ordinary?.recoveryAmount ?? 0, judgementCounts, convertedCount } } : {}),
    ...(trace ? { luckEvents, transitions, stateTrace, ordinarySkillTrace: ordinary?.skillTrace } : {}) };
}
