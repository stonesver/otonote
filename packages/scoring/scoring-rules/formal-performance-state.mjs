import { scoreFrame } from './formal-score-replay.mjs';

/** LiveLifeController.ApplyCommand 0x55c7b04. Values use native int32 math.
 * Commands: note damage, skill damage, recovery, guard +/- and reduction +/-. */
export function applyLifeCommand(state, command, maximumLife) {
  let { life, guard, reduction } = state;
  const { kind, value = 0, safety = false, overHeal = false } = command;
  const damage = reduction <= 0 ? value : reduction >= 10000 ? 0
    : Math.max(0, Math.trunc(Math.imul(10000 - reduction, value) / 10000));
  if (kind === 0 && guard <= 0) life = Math.max(0, (life - damage) | 0);
  else if (kind === 1 && guard <= 0 && (life > 0 || !safety)) life = Math.max(safety ? 1 : 0, (life - damage) | 0);
  else if (kind === 2 && life > 0) life = Math.min((life + value) | 0, maximumLife * (overHeal ? 2 : 1));
  else if (kind === 3) guard = (guard + 1) | 0;
  else if (kind === 4) guard = Math.max(0, guard - 1);
  else if (kind === 5) reduction = (reduction + value) | 0;
  else if (kind === 6) reduction = Math.max(0, (reduction - value) | 0);
  return { life, guard, reduction };
}

/** GetLifeAtMs 0x55c77e4 and AddCommand 0x55c73a8.
 * Preserve the native cached prefix, including its cursor-only invalidation
 * when a late command is inserted. Rebuilding a clean historical fold would
 * differ from the client for explicitly delayed inputs. */
export function createLifeReplay(maximumLife, musicLengthMs) {
  const lastBucket = scoreFrame(musicLengthMs) + 49;
  const bucketOf = time => Math.min(lastBucket, scoreFrame(time));
  const buckets = new Map(), occupied = [];
  const lowerBucket = value => {
    let lo = 0, hi = occupied.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (occupied[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  let cacheBucket = -1, cache = { life: maximumLife, guard: 0, reduction: 0 };
  function add(command) {
    const bucket = bucketOf(command.timeMs);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, []);
      occupied.splice(lowerBucket(bucket), 0, bucket);
    }
    const commands = buckets.get(bucket);
    let index = commands.length;
    while (index && commands[index - 1].timeMs > command.timeMs) index--;
    commands.splice(index, 0, { ...command });
    if (cacheBucket >= bucket) cacheBucket = bucket - 1;
  }
  function at(timeMs) {
    const target = bucketOf(timeMs), reuse = cacheBucket >= 0 && cacheBucket < target;
    let state = reuse ? { ...cache } : { life: maximumLife, guard: 0, reduction: 0 };
    const first = reuse ? cacheBucket + 1 : 0;
    // Empty buckets are identity transitions. Skip them without changing the
    // native cached prefix or its cursor-only invalidation after late input.
    for (let i = lowerBucket(first); i < occupied.length && occupied[i] < target; i++) {
      for (const command of buckets.get(occupied[i])) state = applyLifeCommand(state, command, maximumLife);
    }
    if (cacheBucket < target || cacheBucket < 0) { cacheBucket = target - 1; cache = { ...state }; }
    for (const command of buckets.get(target) ?? []) {
      if (command.timeMs > timeMs) break;
      state = applyLifeCommand(state, command, maximumLife);
    }
    return state.life;
  }
  return { add, at };
}

/** ComboCounter.RecomputeStateFrom 0x6a57284 / GetTimingCombo 0x6a57398.
 * Entries retain arrival order within a timestamp; scoring queries are strict
 * '< chart time', so simultaneous notes share the pre-group combo. */
export function createComboReplay(bonusRows) {
  const entries = [];
  const steps = bonusRows.filter(row => row._comboBonusType === 0).sort((a, b) => a._requiredComboCount - b._requiredComboCount);
  let sum = 0;
  const bonuses = steps.map(row => ({ count: row._requiredComboCount,
    factor: Math.fround(1 + Math.min(1, sum = Math.fround(sum + Math.fround(row._bonusFactor)))) }));
  function add(timeMs, judgement) {
    let index = entries.length;
    while (index && entries[index - 1].timeMs > timeMs) index--;
    entries.splice(index, 0, { timeMs, judgement });
    let combo = index ? entries[index - 1].combo : 0;
    let maxCombo = index ? entries[index - 1].maxCombo : 0;
    let allPerfect = index ? entries[index - 1].allPerfect : true;
    let fullCombo = index ? entries[index - 1].fullCombo : true;
    for (; index < entries.length; index++) {
      const entry = entries[index];
      combo = entry.judgement <= 2 ? 0 : combo + 1;
      maxCombo = Math.max(maxCombo, combo);
      allPerfect &&= entry.judgement >= 5;
      fullCombo &&= entry.judgement >= 3;
      Object.assign(entry, { combo, maxCombo, allPerfect, fullCombo });
    }
  }
  function at(timeMs) {
    let lo = 0, hi = entries.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (entries[mid].timeMs < timeMs) lo = mid + 1; else hi = mid; }
    const combo = lo ? entries[lo - 1].combo : 0;
    return { combo, comboFactor: bonuses.findLast(step => step.count <= combo)?.factor ?? 1 };
  }
  return { add, at, get state() { return entries.at(-1) ?? { combo: 0, maxCombo: 0, allPerfect: true, fullCombo: true }; } };
}

/** Shared ordinary-skill lifecycle for both live modes. Call convert before
 * note damage, then advance after this frame's inputs. Recovery is phase 1;
 * life-conditioned score skills are phase 2; converters expire after input. */
export function createOrdinarySkillLifecycle({ skills, skillTimes, skillOrder, clock, life, skillEndFrame, onFactor = () => {}, withoutSkills = false }) {
  const triggers = new Map(), endings = new Map(), converters = [], skillTrace = [], commands = [];
  let recoveryAmount = 0, lastFrame = 0;
  const enqueue = (map, frame, value) => { if (!map.has(frame)) map.set(frame, []); map.get(frame).push(value); lastFrame = Math.max(lastFrame, frame); };
  for (let i = 0; i < 5; i++) enqueue(triggers, clock.indexAt(skillTimes[i]), { slot: skillOrder[i], startMs: skillTimes[i] });
  const matches = condition => condition.kind === 'life_at_least'
    ? (life.at(currentTime) >= condition.threshold) === Boolean(condition.positive) : condition.active;
  const fields = { 3: 'good', 4: 'great', 5: 'perfect', 6: 'just' };
  let currentTime = 0;
  const addFactor = (command, frame) => { const full = { ...command, arrivalFrame: frame }; commands.push(full); onFactor(full); };
  function endAt(effect, startMs, entry) {
    if (!(effect.durationRawMs > 0) || !Number.isFinite(effect.durationRawMs)) throw new Error(`不支持的持续技能时长：${effect.id}`);
    const end = skillEndFrame(clock, startMs, effect.durationRawMs);
    enqueue(endings, end.frame, { ...entry, timeMs: end.timeMs });
  }
  return {
    commands, skillTrace, converters,
    get lastFrame() { return lastFrame; }, get recoveryAmount() { return recoveryAmount; },
    convert(judgement) {
      for (const converter of converters) {
        if (!converter.active || converter.remaining === 0 || !converter.effect.targets.includes(judgement) || converter.effect.value === judgement) continue;
        if (converter.remaining !== null && --converter.remaining === 0) converter.active = false;
        return { judgement: converter.effect.value, convertedBy: { slotIndex: converter.slot, effectId: converter.effect.id, kind: 'ordinary' } };
      }
      return { judgement, convertedBy: null };
    },
    advance(frame) {
      currentTime = clock.at(frame).timeMs;
      let changed = false;
      const fired = withoutSkills ? [] : (triggers.get(frame) ?? []).sort((a, b) => a.slot - b.slot);
      for (const { slot, startMs } of fired) for (const effect of skills[slot].supportEffects.filter(e => e.type === 3001)) {
        const active = matches(effect.condition);
        skillTrace.push({ frame, timeMs: startMs, slotIndex: slot, effectId: effect.id, type: effect.type, active });
        if (active) { life.add({ timeMs: startMs, kind: 2, value: effect.value, overHeal: true }); recoveryAmount += effect.value; changed = true; }
      }
      for (const { slot, startMs } of fired) for (const effect of skills[slot].liveEffects) {
        const currentLife = effect.condition.kind === 'life_at_least' ? life.at(currentTime) : null, active = matches(effect.condition);
        skillTrace.push({ frame, timeMs: startMs, slotIndex: slot, effectId: effect.id, type: effect.type, currentLife, active });
        if (!active) continue;
        const rate = Math.fround(Math.floor(Math.fround(Math.fround(effect.rate) * 100000)) / 100000);
        if (effect.type !== 2000 && effect.targets.some(target => !fields[target])) throw new Error(`不支持的得分判定目标：${effect.id}`);
        const delta = effect.type === 2000 ? { general: rate } : Object.fromEntries(effect.targets.map(target => [fields[target], rate]));
        const ownerId = slot * 100 + 1;
        addFactor({ timeMs: startMs, ownerId, ...delta }, frame);
        endAt(effect, startMs, { kind: 'score', ownerId, delta, slot, effectId: effect.id });
        changed = true;
      }
      for (const ending of (endings.get(frame) ?? []).sort((a, b) => a.slot - b.slot)) {
        if (ending.kind === 'score') addFactor({ timeMs: ending.timeMs, ownerId: ending.ownerId,
          ...Object.fromEntries(Object.entries(ending.delta).map(([key, value]) => [key, -value])) }, frame);
        else ending.converter.active = false;
        changed = true;
      }
      for (const { slot, startMs } of fired) for (const effect of skills[slot].supportEffects.filter(e => e.type === 12006)) {
        const active = matches(effect.condition);
        skillTrace.push({ frame, timeMs: startMs, slotIndex: slot, effectId: effect.id, type: effect.type, active });
        if (!active) continue;
        const converter = { slot, effect, active: true, remaining: effect.limitCount > 0 ? effect.limitCount : null };
        converters.push(converter); endAt(effect, startMs, { kind: 'conversion', slot, converter }); changed = true;
      }
      return changed;
    },
  };
}
