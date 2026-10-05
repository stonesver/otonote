import { requireInteger } from './formation-power.mjs';

const f32 = Math.fround;

// A reproducible sampling source, NOT the game's unknown random seed/stream.
export function createScoringRandom(seed) {
  requireInteger(seed, 'random seed', 0, 0xffffffff);
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, state | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function weightedScoringDraw(rows, random, valueKey) {
  const total = rows.reduce((s, r) => s + r._weight, 0);
  if (!(total > 0)) throw new Error('Empty lottery distribution');
  const u = random();
  if (!Number.isFinite(u) || u < 0 || u >= 1) throw new Error('Random draw must be in [0, 1)');
  let value = u * total;
  for (const row of rows) {
    if (row._weight < 0) throw new Error('Negative lottery weight');
    value -= row._weight;
    if (value < 0) return row[valueKey];
  }
  throw new Error('Invalid lottery distribution');
}

export function luckNoteCategory(type) {
  // LuckGekisouLotteryMachine.GetBasePoint / IsSubNote, 0x55d2b8c.
  if ([0, 80, 82, 100, 101, 102, 103, 104, 105, 121, 122, 123].includes(type)) return null;
  return type === 21 || type === 120 || (type >= 60 && type <= 63) ? 1 : 0;
}

/** Source-closed LuckScore arithmetic and lottery distribution. Callers own
 * the judgement/skill phase order. A queued result is drawn immediately after
 * consuming the previous one, rather than redrawn when the gauge next fills. */
export function createGekisouLuckMachine(rules, { random = createScoringRandom(1) } = {}) {
  const setting = key => Number(rules.tables.LiveSettings.find(r => r._key === key)?._value);
  const normalMax = setting('gekisou_luck_gauge_max'), rushMax = setting('gekisou_luck_gauge_max_rush');
  if (!(normalMax > 0 && rushMax > 0) || !rules.native.luckPointsByResult) throw new Error('Missing audited LUCK constants');
  const state = { gauge: 0, gaugeMax: normalMax, pendingLots: 0, rushCombo: 0, bonusPoints: 0,
    next: null, counts: [0, 0, 0, 0], draws: 0 };
  const minimums = [];
  function addGauge(points) {
    requireInteger(points, 'gauge points', 0, 0x7fffffff);
    state.gauge += points;
    state.pendingLots += Math.floor(state.gauge / state.gaugeMax);
    state.gauge %= state.gaugeMax;
  }
  function setGaugeMax(max) {
    if (max === state.gaugeMax) return;
    state.gaugeMax = max;
    // Native SetGaugeMaxValue uses >, while AddGauge uses >=.
    if (state.gauge > max) addGauge(0);
  }
  function draw() {
    const chanceType = rules.native.luckChanceTypesByRushCombo[state.rushCombo] ?? rules.native.luckChanceTypeAfterThreeRushes;
    const minimum = Math.max(0, ...minimums.filter(e => e.remaining > 0).map(e => e.result));
    const result = weightedScoringDraw(rules.tables.LiveGekisouLuckBonusLot.filter(r =>
      r._chanceLotType === chanceType && r._lotResult >= minimum), random, '_lotResult');
    // ConsumeMinimumResultEntries consumes every active guarantee <= the
    // selected maximum guarantee, even if the natural result would be better.
    if (minimum) for (const entry of minimums) if (entry.remaining > 0 && entry.result <= minimum) entry.remaining--;
    state.draws++;
    return result;
  }
  return {
    state,
    addGauge,
    addGaugePercent(bp) { addGauge(Math.floor(f32(f32(state.gaugeMax * bp) / rules.native.skillValueDivisor))); },
    addBonusPoints(points) { requireInteger(points, 'luck bonus points', 0, 0x7fffffff); state.bonusPoints += points; },
    addMinimum(result, count) {
      requireInteger(result, 'minimum result', 1, 3); requireInteger(count, 'minimum uses', 1, 100000);
      const entry = { result, remaining: count };
      minimums.push(entry); return entry;
    },
    removeMinimum(entry) { if (entry) entry.remaining = 0; },
    addNote(type, judgement = 5, gaugeUpFactor = 0) {
      const category = luckNoteCategory(type);
      if (category == null || ![3, 4, 5, 6].includes(judgement)) return 0;
      const rows = rules.tables.LiveGekisouLuckBasePoint.filter(r => r._noteCategory === category &&
        r._noteSimulateJudgement === (category === 1 || judgement === 6 ? 5 : judgement));
      const base = weightedScoringDraw(rows, random, '_basePoint');
      const points = Math.floor(f32(f32(1 + f32(gaugeUpFactor)) * base));
      addGauge(points); return points;
    },
    consume() {
      if (!state.pendingLots) return null;
      state.pendingLots--;
      if (state.next === null) state.next = draw();
      const result = state.next;
      state.bonusPoints += rules.native.luckPointsByResult[result];
      state.counts[result]++;
      state.rushCombo = result === 3 ? state.rushCombo + 1 : 0;
      setGaugeMax(state.rushCombo ? rushMax : normalMax);
      state.next = draw();
      return result;
    },
    // ConsumeLotAndProcessLottery adds ONE LuckBonus handle on entering RUSH
    // and removes it on leaving RUSH. Ranking points never enter CalcNoteScore.
    scoreFactorPercent() { return Math.min(200, 100 + (state.rushCombo ? setting('gekisou_luck_rush_score_bonus_percent') : 0)); },
  };
}
