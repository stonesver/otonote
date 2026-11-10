// Global production 1.0.1 (25), App.LiveLogic.Score.LiveScoreCalculator
// CalcNoteScoreCore at 0x55e4e38. This models only the arithmetic after the
// caller has resolved note, judgement, combo, skill and mode factors.
const f32 = Math.fround;
const mul = (left, right) => f32(f32(left) * f32(right));
const div = (left, right) => f32(f32(left) / f32(right));

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

export function calculateFormalNoteCore({
  totalPower,
  scoreAdjustmentFactor,
  musicScoreLevelFactor,
  noteFactorPercent,
  judgementFactorPercent,
  comboBonusFactor,
  scoreUpFactor,
  luckScoreFactorPercent,
  convertedNoteCount,
  eventBonusFactor,
  lifeOnusFactor,
  assistModeNoteScoreFactor,
  currentLife
}) {
  // This runs for every note, including rollback. Validate directly without
  // allocating an object and thirteen Object.entries pairs on each call.
  finiteNumber(totalPower, 'totalPower');
  finiteNumber(scoreAdjustmentFactor, 'scoreAdjustmentFactor');
  finiteNumber(musicScoreLevelFactor, 'musicScoreLevelFactor');
  finiteNumber(noteFactorPercent, 'noteFactorPercent');
  finiteNumber(judgementFactorPercent, 'judgementFactorPercent');
  finiteNumber(comboBonusFactor, 'comboBonusFactor');
  finiteNumber(scoreUpFactor, 'scoreUpFactor');
  finiteNumber(luckScoreFactorPercent, 'luckScoreFactorPercent');
  finiteNumber(convertedNoteCount, 'convertedNoteCount');
  finiteNumber(eventBonusFactor, 'eventBonusFactor');
  finiteNumber(lifeOnusFactor, 'lifeOnusFactor');
  finiteNumber(assistModeNoteScoreFactor, 'assistModeNoteScoreFactor');
  finiteNumber(currentLife, 'currentLife');
  if (!Number.isInteger(totalPower) || totalPower < 0 || totalPower > 0x7fffffff) {
    throw new RangeError("totalPower must be a non-negative int32");
  }
  if (!Number.isInteger(convertedNoteCount) || convertedNoteCount < 1) {
    throw new RangeError("convertedNoteCount must be a positive integer");
  }
  if (!Number.isInteger(noteFactorPercent)) throw new RangeError('noteFactorPercent must be an integer');
  if (!Number.isInteger(judgementFactorPercent)) throw new RangeError('judgementFactorPercent must be an integer');
  if (!Number.isInteger(luckScoreFactorPercent)) throw new RangeError('luckScoreFactorPercent must be an integer');

  // Match the native fmul/fdiv instruction sequence; each result rounds to f32.
  const noteFactor = div(noteFactorPercent, 100);
  const judgementFactor = div(judgementFactorPercent, 100);
  const luckFactor = div(luckScoreFactorPercent, 100);
  let base = mul(scoreAdjustmentFactor, totalPower);
  base = mul(base, musicScoreLevelFactor);
  base = mul(noteFactor, base);
  base = mul(judgementFactor, base);
  base = mul(base, comboBonusFactor);
  base = mul(base, scoreUpFactor);
  base = mul(luckFactor, base);
  base = div(base, convertedNoteCount);
  const firstFloor = Math.floor(base);
  if (!Number.isInteger(firstFloor) || firstFloor < -0x80000000 || firstFloor > 0x7fffffff) {
    throw new RangeError("first floor is outside int32");
  }

  let result = mul(firstFloor, eventBonusFactor);
  result = mul(currentLife > 0 ? 1 : lifeOnusFactor, result);
  result = mul(assistModeNoteScoreFactor, result);
  const score = Math.floor(result);
  if (!Number.isInteger(score) || score < -0x80000000 || score > 0x7fffffff) {
    throw new RangeError("note score is outside int32");
  }
  return { score, firstFloor, beforeFirstFloor: base, beforeSecondFloor: result };
}
