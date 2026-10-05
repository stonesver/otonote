import { createFormationCalculator } from './formation-power.mjs';
import { resolveGekisouSkills } from './gekisou-rules.mjs';
import { nativeSkillDuration } from './formal-frame-clock.mjs';
import { compileSkillConditions } from './skill-condition-program.mjs';
import { gekisouEffectOperators, compileGekisouCumulative } from './gekisou-effect-operators.mjs';
import { UnsupportedSkillMechanismError } from './skill-mechanism-error.mjs';

export function compileGekisouEffects(rules, draft, dynamic = false, missions = null) {
  const power = createFormationCalculator(rules);
  const maximumLife = Number(rules.tables.LiveSettings.find(r => r._key === 'life_base')._value);
  return resolveGekisouSkills(rules, draft, { missions }).flatMap(skill => {
    const member = power.card(draft.slots[skill.slotIndex].memberCardId, 'member');
    const band = rules.tables.Character.find(c => c._id === member._characterID)._bandID;
    return skill.effects.map(effect => {
      const definition = effect.definition;
      const unsupported = (mechanism, value) => { throw new UnsupportedSkillMechanismError(
        `Unsupported Gekisou ${mechanism} ${value}`, { sourceCardId: skill.sourceCardId,
          skillId: skill.id, level: skill.level, effectId: definition._id, missionType: skill.missionType, mechanism, value }); };
      const operator = gekisouEffectOperators[definition._skillEffectType];
      if (!operator) unsupported('effect', definition._skillEffectType);
      for (const field of ['_effectValue', '_maxEffectValue', '_effectLimitCount', '_effectExecuteLimitCount']) {
        if (!Number.isInteger(definition[field]) || definition[field] < 0) throw new Error(`Invalid effect parameter ${definition._id}: ${field}`);
      }
      if (!Number.isFinite(definition._activationTimeSecond) || definition._activationTimeSecond < 0) throw new Error(`Invalid effect duration ${definition._id}`);
      if (definition._effectLimitCount && !operator.limited) unsupported('effect consumption limit', definition._skillEffectType);
      if (![1, 2].includes(definition._skillTriggerType)) unsupported('trigger type', definition._skillTriggerType);
      if (effect.phase !== 2) unsupported('phase', effect.phase);
      const programs = Object.fromEntries(Object.entries(effect.conditions).map(([key, sets]) =>
        [key, compileSkillConditions(sets, rules.tables, unsupported)]));
      const cumulativeProgram = compileGekisouCumulative(effect.cumulative, definition, rules.tables, unsupported);
      if (operator.needsCumulative && !cumulativeProgram) throw new Error(`Missing cumulative condition for effect ${definition._id}`);
      if (cumulativeProgram && !operator.needsCumulative) unsupported('cumulative effect combination', definition._skillEffectType);
      const targets = definition._skillTargetIDs.map(id => {
        const target = rules.tables.SkillTarget.find(t => t._id === id);
        if (!target) throw new Error(`Missing skill target ${id}`);
        if (target._skillTargetType !== 4 || ![1,2,3,4,5,6].includes(target._judgement)) unsupported('judgement target', id);
        return target._judgement;
      });
      if (targets.length && !operator.targeted) unsupported('effect target', definition._skillEffectType);
      if (operator.windowExpansion && targets.some(t => t !== 6)) unsupported('window target', targets.join(','));
      const chanceConditions = Object.values(effect.conditions).flatMap(sets => sets.flatMap(s => s.conditions)).filter(c => c._conditionType === 4011);
      return { ...effect, key: `${skill.kind}:${skill.slotIndex}:${definition._id}`, missionType: skill.missionType,
        kind: skill.kind, slotIndex: skill.slotIndex, sourceCardId: skill.sourceCardId, band, operator, targets, programs, cumulativeProgram,
        hasIntervals: Object.values(programs).some(p => p.intervals.length),
        active: [programs._skillConditionGroup, programs._skillTriggerConditionGroup].every(p => p.possible({ band, life: maximumLife, dynamic })),
        random: chanceConditions.some(c => c._conditionValues[0] > 0 && c._conditionValues[0] < 100),
        probability: chanceConditions.length === 1 ? (chanceConditions[0]._isPositive ? chanceConditions[0]._conditionValues[0] : 100 - chanceConditions[0]._conditionValues[0]) : chanceConditions.length ? null : 100 };
    });
  });
}

export function createGekisouEffectState(effect, budget = { uses: 0 }) {
  return { ...effect, get uses() { return budget.uses; }, set uses(value) { budget.uses = value; },
    pending: 0, executing: false, triggered: false, windows: [],
    scoreFactor: 0, startMs: null, endMs: Infinity, cumulativeRaw: 0,
    exhaustedFrame: -1, counters: {}, wasMatched: false };
}

/** The sole activation/lifetime controller. Context holds current inputs and
 * previous Gekisou.Update counters/lots; operators only change game state. */
export function advanceGekisouEffect(e, ctx) {
  const r = e.definition, p = e.programs, trigger = p._skillTriggerConditionGroup;
  ctx = { ...ctx, band: e.band, counters: e.counters };
  const end = timeMs => {
    e.operator.stop?.(e, ctx, timeMs);
    ctx.factor(e, 0, timeMs);
    e.executing = false; e.endMs = timeMs;
    e.windows.at(-1).endMs = timeMs;
    ctx.dirty(); ctx.trace(e, 'end');
  };
  const events = [ctx, ...ctx.section.previousLots.map(lot => ({ ...ctx, lot }))];
  if (e.executing && (ctx.closing || ctx.frame >= e.endFrame || e.operator.exhausted?.(e))) {
    end(ctx.frame >= e.endFrame && !ctx.closing ? e.endMs : ctx.timeMs);
  }
  const waiting = !e.executing && (e.operator.ready?.(e, ctx) ?? true);
  if (e.hasIntervals && !ctx.closing && ctx.frame < ctx.section.settleFrame) {
    const intervals = [...(waiting ? trigger.intervals : []), ...p._skillConditionGroup.intervals,
      ...(e.executing ? p._skillReleaseConditionGroup.intervals : []), ...p._effectExecuteLimitResetConditionGroup.intervals];
    for (const c of new Map(intervals.map(c => [c.id, c])).values()) {
      e.counters[c.id] = (e.counters[c.id] ?? 0) + ctx.notes.filter(n => c.targets.includes(n.judgement)).length;
    }
  }
  const consumeEvent = program => {
    if (program.empty) return false;
    for (const event of events) {
      const branch = program.match(event, ctx.random);
      if (branch) { program.consume(branch, e.counters); return true; }
    }
    return false;
  };
  const release = e.executing && consumeEvent(p._skillReleaseConditionGroup);
  if (release) end(ctx.timeMs);
  if (consumeEvent(p._effectExecuteLimitResetConditionGroup)) {
    e.uses = 0;
  }
  if (ctx.closing || release) return;
  const eligible = p._skillConditionGroup.match(ctx);
  const matched = trigger.empty ? (ctx.entering ? [] : null) : trigger.match(ctx);
  // RUSH is a sustained state; threshold conditions are reached events and
  // retain their handle until duration/release. Neither depends on effect ID.
  if (e.executing && r._skillTriggerType === 2 && trigger.sustained(e.activationBranch) &&
    (!trigger.stillMatches(e.activationBranch, ctx) || !eligible)) end(ctx.timeMs);
  const contexts = trigger.lottery || p._skillConditionGroup.lottery ? events : [ctx];
  for (const event of contexts) {
    const branch = trigger.empty ? (event.entering && !event.lot ? [] : null) : trigger.match(event);
    if (!branch || e.executing || !(e.operator.ready?.(e, event) ?? true) ||
      (r._effectExecuteLimitCount > 0 && e.uses >= r._effectExecuteLimitCount) ||
      (!trigger.eventful(branch) && e.wasMatched) || !p._skillConditionGroup.match(event)) continue;
    const successful = trigger.match(event, ctx.random);
    const activationCondition = successful && p._skillConditionGroup.match(event, ctx.random);
    if (!activationCondition) continue;
    // Preserve the established section-entry random stream even for a 100%
    // activation. Other events only draw for an actual probability predicate.
    if (event.entering && trigger.entry && !trigger.random && !p._skillConditionGroup.random) ctx.random();
    trigger.consume(successful, e.counters);
    p._skillConditionGroup.consume(activationCondition, e.counters);
    e.activationBranch = successful;
    const timeMs = trigger.timestamp(successful, event);
    e.remaining = r._effectLimitCount > 0 ? r._effectLimitCount : null;
    e.uses++; e.triggered = e.executing = true; e.startMs = timeMs; e.cumulativeRaw = 0;
    e.durationRawMs = nativeSkillDuration(r._activationTimeSecond);
    e.executeFrame = ctx.frame; e.endMs = e.endFrame = Infinity;
    if (e.durationRawMs > 0) {
      const nextMs = ctx.clock.at(ctx.frame + 1).timeMs;
      e.endFrame = Math.fround(nextMs - timeMs) >= e.durationRawMs ? ctx.frame + 1
        : Math.max(ctx.frame + 2, ctx.clock.indexAt(timeMs + Math.floor(e.durationRawMs) + 1));
      e.endMs = e.endFrame === ctx.frame + 1 ? nextMs : timeMs + Math.ceil(e.durationRawMs);
    }
    e.windows.push({ startMs: timeMs, endMs: e.endMs });
    ctx.dirty(); e.operator.start?.(e, event, timeMs); ctx.trace(e, 'start', undefined, timeMs);
    if (e.operator.instant) e.executing = false;
  }
  e.wasMatched = Boolean(matched && eligible);
  if (e.executing) e.operator.update?.(e, ctx);
}
