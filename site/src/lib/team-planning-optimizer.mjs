import { resolveGrowthScenario, createGrowthSearchVariants, prepareGrowthCandidate } from '../../../packages/scoring/scoring-rules/growth-scenarios.mjs';
import { normalizePerformanceScenario } from '../../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { optimizePractical } from './practical-optimizer.mjs';
import { createCandidateEvaluator } from './formation-candidate-evaluator.mjs';
import { compareScoredFormations } from './inventory-optimizer.mjs';
import { selectPlanningDirections } from './team-planning-directions.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const labels = { reference: '参考队伍', selected: '手选卡', owned: '当前养成', trial: '试用卡队伍' };

/** Feasible growth assignments are searched before candidate generation.
 * Nothing in this operation updates actual inventory or account modifiers. */
export async function optimizeTeamPlanning({ rules, draft, inventory, scope = 'selected', planningScenario,
  performanceScenario, recommendationGoal = 'score', objective = 'expected_song_score', mode = 'ordinary', chart,
  constraints = {}, gekisouScenario = {}, eventAdapters = [], maxWindowCards = 5, variantLimit = 24,
  signal, onProgress = () => {}, yieldControl = pause }) {
  if (!Number.isInteger(variantLimit) || variantLimit < 1 || variantLimit > 1000) throw new Error('培养组合比较上限应为 1–1000');
  const settings = planningScenario ?? draft.modifiers?.planningScenario ?? { scope: scope === 'theoretical' ? 'reference' : scope };
  const performance = objective === 'formation_power' ? undefined : normalizePerformanceScenario(performanceScenario ?? draft.modifiers?.performanceScenario ?? { profile: 'steady' });
  const resolved = resolveGrowthScenario(rules, draft, { ...settings, inventory });
  const variants = createGrowthSearchVariants(resolved, { limit: variantLimit });
  const context = { rules, chart, mode, objective, gekisouScenario, performanceScenario: performance, eventAdapters };
  const evaluator = createCandidateEvaluator(context);
  const warnings = new Set(resolved.assumptions), results = [], progressReports = [];
  let evaluated = 0, completedVariants = 0, baselineResult = null, interrupted = false;
  const actualScores = new Map();
  const actualScore = draft => {
    const key = stableSnapshotHash(draft);
    if (!actualScores.has(key)) actualScores.set(key, evaluator.score(draft));
    return actualScores.get(key);
  };
  for (const variant of variants) {
    if (signal?.aborted) break;
    onProgress({ phase: 'planning', completed: completedVariants, total: Math.min(variants.totalCount ?? variantLimit, variantLimit),
      message: resolved.plan.enabled ? `比较培养方案 ${completedVariants + 1}` : '比较不同配队' });
    const report = await optimizePractical({ ...context, draft: variant.draft, scope: 'owned', inventory: variant.inventory,
      constraints, maxWindowCards, resultLimit: 24, signal, yieldControl,
      onProgress: progress => onProgress({ ...progress, planningVariant: completedVariants + 1 }) });
    progressReports.push(report.practical);
    report.warnings.forEach(w => warnings.add(w));
    evaluated += report.evaluated;
    for (const candidate of report.results) {
      const prepared = prepareGrowthCandidate(rules, resolved, candidate.draft, { trainedCardIds: variant.trainedCardIds });
      const { comparison, targetDraft, actualDraft } = prepared;
      const current = comparison.actualAvailable && actualDraft ? actualScore(actualDraft) : null;
      if (resolved.scope !== 'reference' && comparison.actualTeamAvailable && current && (!baselineResult || current.value > baselineResult.value)) baselineResult = { ...current, draft: actualDraft };
      if (performance) targetDraft.modifiers.performanceScenario = performance;
      targetDraft.modifiers.recommendationGoal = recommendationGoal;
      targetDraft.modifiers.planningResult.selectedTrainingCardIds = variant.trainedCardIds.filter(id => targetDraft.slots.some(s => s.memberCardId===id || s.supportCardId===id));
      const trainingChanges = comparison.changedCards.map(card => ({ type: card.kind, id: card.id, fields: card.changes }));
      const hypothetical = ['reference', 'trial'].includes(resolved.scope);
      const isTraining = !hypothetical && resolved.plan.enabled && comparison.trainedCardCount > 0;
      const planning = { kind: isTraining ? 'training' : resolved.scope === 'owned' ? 'current' : resolved.scope,
        label: isTraining ? `需要培养 ${comparison.trainedCardCount} 张卡` : labels[resolved.scope], trainingChanges: hypothetical ? [] : trainingChanges,
        currentValue: baselineResult?.value ?? null, plannedTeamCurrentValue: current?.value ?? null,
        targetValue: candidate.value, missingActual: !comparison.actualTeamAvailable,
        ownershipUnknown: comparison.unknownOwnershipIds, materialEstimateAvailable: false,
        trainingCountComplete: !hypothetical && comparison.trainingCountComplete };
      const value = { ...candidate, draft: targetDraft, planning, performanceScenario: performance, performanceSummary: performance?.description,
        id: stableSnapshotHash({ slots: targetDraft.slots, growth: targetDraft.modifiers.growth }),
        delta: baselineResult ? candidate.value - baselineResult.value : null,
        comparison: compareScoredFormations(candidate, baselineResult), growthComparison: comparison };
      results.push(value);
      (candidate.warnings ?? []).forEach(w => warnings.add(w));
    }
    if (report.status !== 'completed') { interrupted = true; break; }
    completedVariants++;
    await yieldControl();
  }
  const cancelled = Boolean(signal?.aborted) || interrupted, bounded = variants.truncated;
  for (const result of results) {
    result.planning.currentValue = baselineResult?.value ?? null;
    result.delta = baselineResult ? result.value - baselineResult.value : null;
    result.comparison = compareScoredFormations(result, baselineResult);
  }
  if (bounded) warnings.add(`本次比较了前 ${completedVariants} 个培养组合，共有 ${variants.totalCountExact} 个；可缩小允许培养的卡片范围，或提高比较上限。`);
  const directions = selectPlanningDirections(results, { goal: recommendationGoal, objective });
  const sum = key => progressReports.reduce((value, report) => value + (report?.[key] ?? 0), 0);
  return { status: cancelled ? 'cancelled' : bounded ? 'budget_exhausted' : 'completed', searchMethod: 'planning',
    optimality: cancelled || bounded ? 'incomplete' : 'practical_checked', sourceReleaseId: rules.sourceReleaseId,
    ruleSetVersion: rules.ruleSetVersion, mode, objective, results: directions, evaluated,
    baseline: baselineResult?.value ?? null, baselineResult, checkpoint: null, warnings: [...warnings],
    planningScenario: resolved.planningScenario, performanceScenario: performance,
    inputHash: stableSnapshotHash({ draft, inventory, planningScenario: resolved.planningScenario, performance,
      constraints, gekisouScenario, objective, mode, recommendationGoal, variantLimit, maxWindowCards,
      rulesHash: stableSnapshotHash(rules), chart }),
    planning: { completedVariants, totalVariants: variants.totalCountExact, truncated: bounded, excludedCardIds: resolved.excludedCardIds },
    practical: { directions: [...new Map(progressReports.flatMap(r => r?.directions ?? []).map(d => [d.id, d])).values()],
      neighbourChecks: sum('neighbourChecks'), screened: sum('screened'), finalists: sum('finalists') } };
}
