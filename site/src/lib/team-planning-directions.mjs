/** Compare whole formations under one scenario. Task units are normalized
 * within each section; COMBO, LUCK and JUST are never added as raw counts. */
const finite = value => Number.isFinite(value) ? value : null;
const signature = row => JSON.stringify([row.draft.slots, row.draft.modifiers?.growth]);
const expected = row => finite(row.expectedScore) ?? finite(row.value) ?? 0;
const lower = row => finite(row.scoreDistribution?.p10) ?? finite(row.minimumScore) ?? expected(row);
const count = section => section.missionType === 1 ? section.combo : section.missionType === 2 ? section.luckPoints : section.just;

export function selectPlanningDirections(candidates, { goal = 'score', limit = 3, objective = 'expected_song_score' } = {}) {
  if (!['score', 'stable', 'missions'].includes(goal)) throw new Error('请选择冲分、稳定或段落竞争方向');
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('方案数量应为 1–3');
  const unique = new Map();
  for (const row of candidates) {
    if (!row.draft?.slots || !Number.isFinite(row.value)) throw new Error('配队比较结果不完整');
    const key = signature(row), previous = unique.get(key);
    if (!previous || row.value > previous.value) unique.set(key, row);
  }
  const rows = [...unique.values()];
  if (!rows.length) return [];
  const sections = new Map();
  for (const row of rows) for (const section of row.sections ?? []) {
    const key = `${section.index}:${section.missionType}`;
    sections.set(key, Math.max(sections.get(key) ?? 0, finite(count(section)) ?? 0));
  }
  const taskValue = row => {
    const own = row.sections ?? [];
    if (!own.length) return null;
    // Chart event counts are independent of a team's score or activation result.
    // This relative comparison index is not a score formula or a win rate.
    const weight = s => finite(s.taskEventCount) ?? (Number.isFinite(s.endMs-s.startMs) ? Math.max(0,s.endMs-s.startMs) : 1);
    const weightSum=own.reduce((sum,s)=>sum+weight(s),0)||1;
    return own.reduce((sum, s) => {
      const max = sections.get(`${s.index}:${s.missionType}`);
      return sum + weight(s)*(max > 0 ? (finite(count(s)) ?? 0) / max : 0);
    }, 0) / weightSum;
  };
  const hasOpponents = rows.every(row => row.scenario?.opponents?.length);
  const taskScore = row => hasOpponents
    ? -(row.sections ?? []).reduce((sum, s) => sum + s.rank, 0) / Math.max(1, row.sections?.length ?? 0)
    : taskValue(row);
  const objectives = objective === 'formation_power' ? [{ id: 'power', label: '综合力较高', metric: row => row.power }] : [
    { id: 'score', label: '冲高分', metric: row => objective === 'maximum_song_score' ? (finite(row.maximumScore) ?? expected(row)) : objective === 'minimum_song_score' ? (finite(row.minimumScore) ?? lower(row)) : expected(row) },
    { id: 'stable', label: '求稳定', metric: lower },
    ...(sections.size ? [{ id: 'missions', label: '争段落名次', metric: taskScore }] : [])
  ];
  // Omit teams that are no better on any displayed direction. Compare whole
  // teams; a tied mean cannot keep a strictly worse low-score/task alternative.
  const undominated = rows.filter(row => !rows.some(other => other !== row
    && objectives.every(({metric}) => (metric(other) ?? -Infinity) >= (metric(row) ?? -Infinity))
    && objectives.some(({metric}) => (metric(other) ?? -Infinity) > (metric(row) ?? -Infinity))));
  objectives.sort((a, b) => Number(b.id === goal) - Number(a.id === goal));
  const chosen = new Map();
  for (const direction of objectives) {
    const ranked = undominated.filter(row => finite(direction.metric(row)) !== null)
      .sort((a, b) => direction.metric(b) - direction.metric(a) || expected(b) - expected(a) || signature(a).localeCompare(signature(b)));
    const winner = ranked[0];
    if (!winner) continue;
    const key = signature(winner), existing = chosen.get(key);
    if (existing) { existing.direction.alsoSuitable.push(direction.label); continue; }
    const bestScore = Math.max(...rows.map(expected));
    const gap = Math.max(0, bestScore - expected(winner));
    const reason = direction.id === 'power' ? '在已比较的队伍中，这队综合力较高。'
      : direction.id === 'stable' ? '在相同发挥样本中，这队的较低分数较高。'
      : direction.id === 'missions' ? hasOpponents ? '在填写的对手条件下，这队的平均段落名次较好。' : '按各段计分事件数量衡量，这队的任务计数表现较好；可展开查看每段差别。'
      : objective === 'maximum_song_score' ? '在相同发挥样本中，这队出现过的最高分较高。'
      : objective === 'minimum_song_score' ? '在相同发挥样本中，这队出现过的最低分较高。'
      : '在当前计算条件下，这队的平均分较高。';
    const tradeoff = direction.id === 'missions' && !hasOpponents ? '没有填写对手，任务计数优势不等于一定拿第一。'
      : gap > 0 ? `平均分比本次最高方案少 ${Math.round(gap).toLocaleString()} 分。`
      : direction.id === 'stable' ? '这是参考样本的比较，不是实战保底。' : '换一首歌或改变发挥条件后，结果可能不同。';
    chosen.set(key, { ...winner, direction: { id: direction.id, label: direction.label, reason, tradeoff, alsoSuitable: [] },
      directionMetrics: { expectedScore: expected(winner), lowerScore: lower(winner), taskComparison: taskValue(winner), hasOpponents } });
  }
  return [...chosen.values()].slice(0, limit);
}
