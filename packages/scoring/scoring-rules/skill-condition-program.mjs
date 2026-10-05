/** Compile Master condition sets without losing OR-of-AND structure. The
 * caller supplies frame/event facts; predicates never inspect effect types. */
export function compileSkillConditions(sets, tables, unsupported) {
  const target = (id, type) => {
    const row = tables.SkillTarget.find(r => r._id === id);
    if (!row) throw new Error(`Missing skill target ${id}`);
    if (row._skillTargetType !== type) unsupported('condition target', id);
    return row;
  };
  const groups = sets.map(set => set.conditions.map(row => {
    const values = row._conditionValues ?? [], ids = row._conditionTargetIDs ?? [];
    const c = { id: row._id, type: row._conditionType, positive: Boolean(row._isPositive), value: values[0] };
    switch (c.type) {
      case 2001: case 7005: case 7000: case 4011: case 1030:
        if (values.length !== 1 || !Number.isFinite(c.value)) throw new Error(`Invalid condition value ${c.id}`);
        if (c.type === 1030) {
          if (!Number.isInteger(c.value) || c.value < 1) throw new Error(`Invalid judgement interval ${c.id}`);
          c.targets = ids.map(id => target(id, 4)._judgement);
        }
        if (c.type === 4011 && (c.value < 0 || c.value > 100)) throw new Error(`Invalid probability ${c.id}`);
        break;
      case 5000: c.targets = ids.map(id => target(id, 3)._bandID); break;
      case 7010: case 7020: c.targets = ids.map(id => target(id, 5)._gekisouMissionType); break;
      case 7013: case 7021: break;
      default: unsupported('condition', c.type);
    }
    if (typeof row._isPositive !== 'boolean') throw new Error(`Invalid condition polarity ${c.id}`);
    if (![1030, 5000, 7010, 7020].includes(c.type) && ids.length) unsupported('condition target combination', c.id);
    if ([5000, 7010, 7013, 7020, 7021].includes(c.type) && values.length) unsupported('condition parameters', c.id);
    if (c.type === 1030 && c.targets.some(j => ![1,2,3,4,5,6].includes(j))) unsupported('condition judgement', c.id);
    return c;
  }));
  const conditions = groups.flat();
  function matches(c, ctx, random) {
    let value;
    switch (c.type) {
      case 2001: value = ctx.life >= c.value; break;
      case 5000: value = c.targets.includes(ctx.band); break;
      case 4011: return !random || ((random() < c.value / 100) === c.positive);
      case 7000: if (ctx.lot == null) return false; value = ctx.lot.result === c.value; break;
      case 7005: value = ctx.section.combo >= c.value; break;
      case 7010: value = ctx.entering && ctx.lot == null; break;
      case 7013: value = ctx.closing && ctx.lot == null; break;
      case 7020: value = !ctx.closing; break;
      case 7021: value = ctx.section.luck.state.rushCombo > 0; break;
      case 1030: value = (ctx.counters[c.id] ?? 0) >= c.value; break;
    }
    if (c.targets && [7010, 7020].includes(c.type)) value &&= !c.targets.length || c.targets.includes(ctx.section.missionType);
    return value === c.positive;
  }
  return {
    empty: !groups.length,
    random: conditions.some(c => c.type === 4011),
    intervals: [...new Map(conditions.filter(c => c.type === 1030).map(c => [c.id, c])).values()],
    lottery: conditions.some(c => c.type === 7000),
    eventful: branch => branch.some(c => [7000, 7010, 7013, 1030].includes(c.type)),
    sustained: branch => branch.some(c => c.type === 7021),
    entry: conditions.some(c => [7010, 7020].includes(c.type)),
    // Unknown dynamic facts are possibly true; only static band/life facts
    // can remove an effect before replay. All branches were still validated.
    possible({ band, life, dynamic }) {
      return !groups.length || groups.some(group => group.every(c => {
        if (c.type === 5000) return c.targets.includes(band) === c.positive;
        if (c.type === 2001 && !dynamic) return (life >= c.value) === c.positive;
        return true;
      }));
    },
    match(ctx, random) {
      if (!groups.length) return [];
      // Check deterministic predicates first, even if a probability row is
      // authored first. A failed band/life/event gate never consumes a draw.
      return groups.find(group => group.every(c => matches(c, ctx)) &&
        (!random || group.every(c => c.type !== 4011 || matches(c, ctx, random)))) ?? null;
    },
    stillMatches: (branch, ctx) => branch.every(c => matches(c, ctx)),
    timestamp(branch, ctx) {
      if (branch.some(c => c.type === 7010) || (ctx.entering && branch.some(c => c.type === 7020))) return ctx.section.startMs;
      if (branch.some(c => c.type === 7005)) return ctx.section.history.at(-1)?.timeMs ?? ctx.timeMs;
      return ctx.timeMs;
    },
    consume(branch, counters) {
      for (const c of branch) if (c.type === 1030) counters[c.id] %= c.value;
    },
  };
}
