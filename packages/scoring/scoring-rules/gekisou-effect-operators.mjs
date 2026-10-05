import { roundToEven } from './formal-time.mjs';

const f32 = Math.fround;
const scoreRate = value => f32(Math.floor(f32(f32(value / 10000) * 100000)) / 100000);
const count = channel => ({
  countChannel: channel,
  start(e, ctx, timeMs) { ctx.count(e, timeMs, e.definition._effectValue); },
  stop(e, ctx, timeMs) { ctx.count(e, timeMs, -e.definition._effectValue); },
});
const conversion = charged => ({
  targeted: true, limited: true,
  ...(charged ? {
    start(e) { e.pending = e.remaining; },
    exhausted: e => e.pending === 0,
    ready: (e, ctx) => e.exhaustedFrame < ctx.frame,
  } : {}),
  convert(e, judgement, frame) {
    const remaining = charged ? e.pending : e.remaining;
    const value = charged ? 6 : e.definition._effectValue;
    if (remaining === 0 || judgement === value || !e.targets.includes(judgement)) return null;
    if (remaining !== null) {
      if (charged) { if (--e.pending === 0) e.exhaustedFrame = frame; }
      else e.remaining--;
    }
    return value;
  },
});

/** Primitive operations only. Activation, duration, release and execution
 * limits live in the skill runtime; no operator knows a trigger/card ID. */
export const gekisouEffectOperators = Object.freeze({
  12000: count('combo'),
  13000: count('just'),
  11001: { gaugeFactor: e => f32(e.definition._effectValue / 10000) },
  13002: { needsCumulative: true, justBonus: (e, ctx) => e.cumulativeProgram.value(ctx) },
  11002: { instant: true, start(e, ctx) {
    ctx.section.luck.addBonusPoints(e.definition._effectValue); ctx.trace(e, 'bonus', e.definition._effectValue);
  } },
  11003: { instant: true, start(e, ctx) {
    ctx.section.luck.addGaugePercent(e.definition._effectValue); ctx.trace(e, 'gauge', e.definition._effectValue);
  } },
  11005: {
    limited: true,
    start(e, ctx) { e.minimum = ctx.section.luck.addMinimum(e.definition._effectValue - 1, e.definition._effectLimitCount); },
    stop(e, ctx) { ctx.section.luck.removeMinimum(e.minimum); },
  },
  2000: { score: true, start(e, ctx, timeMs) { ctx.factor(e, scoreRate(e.definition._effectValue), timeMs); } },
  2001: { score: true, needsCumulative: true, update(e, ctx) {
    e.cumulativeRaw += e.cumulativeProgram.increment(ctx.notes);
    ctx.factor(e, scoreRate(e.cumulativeProgram.value({ ...ctx, count: e.cumulativeRaw })), ctx.timeMs);
  } },
  // Same basis-point handles as ordinary life replay. AP has no damage.
  3004: {
    start(e, ctx, timeMs) { ctx.lifeReplay?.add({ timeMs, kind: 5, value: e.definition._effectValue }); },
    stop(e, ctx, timeMs) { ctx.lifeReplay?.add({ timeMs, kind: 6, value: e.definition._effectValue }); },
  },
  4004: { targeted: true, windowExpansion: (e, base) => roundToEven(f32(f32(e.definition._effectValue / 10000) * base)) },
  12006: conversion(false),
  13005: conversion(true),
  12004: { comboGuard: true, targeted: true, limited: true },
});

export function compileGekisouCumulative(cumulative, definition, tables, unsupported) {
  if (!cumulative) return null;
  const type = cumulative._skillCumulativeConditionType;
  if (![1000, 7001].includes(type)) unsupported('cumulative condition', type);
  const threshold = cumulative._conditionValues[0], maximum = cumulative._maxCumulativeCount;
  if (cumulative._conditionValues.length !== 1 || !(threshold > 0) || !Number.isFinite(threshold) || !Number.isInteger(maximum) || maximum < 0) throw new Error('Invalid cumulative parameters');
  const targets = (cumulative._conditionTargetIDs ?? []).map(id => {
    const target = tables.SkillTarget.find(row => row._id === id);
    if (!target) throw new Error(`Missing skill target ${id}`);
    if (target._skillTargetType !== 4 || ![1,2,3,4,5,6].includes(target._judgement) || type === 7001) unsupported('cumulative target', id);
    return target._judgement;
  });
  return {
    increment: notes => notes.filter(note => targets.includes(note.judgement)).length,
    value(ctx) {
      const count = type === 7001 ? ctx.section.combo : ctx.count ?? targets.reduce((sum, target) => sum + (ctx.counts[target] ?? 0), 0);
      return Math.min(definition._maxEffectValue || Infinity,
        Math.min(maximum, Math.floor(count / threshold)) * definition._effectValue);
    },
  };
}
