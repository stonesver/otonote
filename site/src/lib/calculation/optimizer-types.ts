import type {GrowthComparison} from '../scoring-rules/growth-scenarios.mjs';
import type {TeamDraft} from '../team-draft.mjs';
import type {Inventory, PlanningScenario, PlanningComparison} from './growth-types.ts';

export type CalculationMode = 'ordinary' | 'gekisou';
export type CalculationObjective = 'formation_power' | 'expected_song_score' | 'minimum_song_score' | 'maximum_song_score';
/** Rule tables and chart internals remain owned and validated by the scoring engine. */
export interface ScoringRules { sourceReleaseId: string; ruleSetVersion: string; tables: Record<string, Record<string, unknown>[]> }
export interface ChartData { sourceReleaseId?: string; [field: string]: unknown }
export interface ChartCandidate { id?: string; trackId: string; difficulty: string; title: string; analysisDataUrl: string }
export interface CalculationScope {
  title: string; candidates: ChartCandidate[]; songCount: number; chartCount: number;
  excluded: {trackId: string; difficulty: string | null; reason: string; message: string}[];
  fingerprint: string;
}
export interface PerformanceScenario {
  version?: string;
  profile?: 'ideal' | 'steady' | 'practice' | 'explicit' | 'ap_timing';
  seed?: number; samples?: number; frameRate?: number;
  timingBiasMs?: number; timingSpreadMs?: number; missRate?: number;
  difficultRanges?: {startMs: number; endMs: number; spreadMultiplier?: number}[];
  performance?: Record<string, unknown>;
  description?: string;
}
export interface GekisouScenario {
  frameRate?: number; timingOffsetMs?: number; batches?: number; seed?: number;
  ranks?: number[]; opponents?: unknown[];
}
export interface OptimizerConstraints {
  bandId?: number | number[] | null; attribute?: number | number[] | null; supportAttribute?: number | number[] | null;
  leaderId?: string | null; requiredMemberIds?: string[]; requiredSupportIds?: string[];
  excludedMemberIds?: string[]; excludedSupportIds?: string[];
  lockedPairs?: {memberCardId: string; supportCardId: string}[];
}
export interface OptimizerRequest {
  rules: ScoringRules; draft: TeamDraft; inventory?: Inventory;
  scope?: 'selected' | 'owned' | 'theoretical';
  objective?: CalculationObjective; mode?: CalculationMode;
  constraints?: OptimizerConstraints; chart?: ChartData;
  planningScenario?: PlanningScenario; performanceScenario?: PerformanceScenario;
  gekisouScenario?: GekisouScenario; recommendationGoal?: 'score' | 'stable' | 'missions';
  searchMethod?: 'practical'; topN?: number; concurrency?: number;
  maxEvaluations?: number; variantLimit?: number; maxWindowCards?: number;
  calculationScope?: CalculationScope | null; playlistCandidates?: ChartCandidate[];
}
export interface ScoreSection {
  index: number; missionType: number; combo: number; luckPoints: number; just: number;
  noteScore: number; rank: number; rankingBonus: number; totalScore: number; share: number;
}
export interface ScoreComparison {
  scoreDelta: number; powerDelta: number; scoreChangePercent: number | null; powerChangePercent: number | null;
  powerSourceDeltas: Record<string, number>; skillScoreGainDelta: number | null;
  sectionDeltas: {index: number; noteScore: number; rankingBonus: number; totalScore: number}[] | null;
}
export interface ApTimingPlan {
  version: string; context: string; chartId: string; chartHash: string;
  order: number[]; score: number; minimumScore: number; maximumScore: number;
  onTimeMinimumScore: number; apMarginMs: number; toleranceMs: number;
  adjustments: {scoreIndex: number; noteId: string; nodeIndex: number | null; timeMs: number;
    position: number; size: number; timingOffsetMs: number; apEarlyMs: number; apLateMs: number; apMarginMs: number}[];
  rates: {frameRate: number; referenceScore: number; baselineScore: number; minimumScore: number; maximumScore: number;
    minimumCondition: {phaseMs: number; biasMs: number}; maximumCondition: {phaseMs: number; biasMs: number};
    favorable: {phaseMs: number; score: number}}[];
  search: {screenedOrders: number; refinedOrders: number; policies: number[]; phaseClasses: number; optimality: 'candidate_search'};
}
export interface OptimizerCandidate {
  draft: TeamDraft; value: number; power: number;
  id?: string; delta?: number | null; expectedScore?: number; minimumScore?: number; maximumScore?: number;
  planning?: PlanningComparison; growthComparison?: GrowthComparison;
  direction?: {id: string; label: string; reason?: string; tradeoff?: string; alsoSuitable?: string[]};
  breakdown?: Record<string, {total: number}>;
  performanceSummary?: string | {label?: string};
  performanceScenario?: PerformanceScenario;
  apTimingPlan?: ApTimingPlan;
  scoreDistribution?: {p10: number; count: number};
  scenario?: GekisouScenario;
  inputHash?: string;
  comparison?: ScoreComparison | null; sections?: ScoreSection[];
  rankingBonusShare?: number; sampleCount?: number; standardError?: number;
  scorePrecision?: 'screen' | 'full' | 'ap_timing'; orderCount?: number; bestOrder?: number[]; worstOrder?: number[];
  warnings?: string[];
}
export interface ScoringIssue {sourceCardId?: string; memberCardId?: string; supportCardId?: string; message: string; slots?: TeamDraft["slots"]}
export interface OptimizerReport {
  kind?: undefined;
  status: 'completed' | 'cancelled' | 'budget_exhausted' | 'no_feasible_formation';
  searchMethod?: 'planning' | 'practical';
  optimality: 'incomplete' | 'practical_checked' | 'proven_within_model' | 'best_within_simulation' | 'infeasible';
  results: OptimizerCandidate[]; evaluated: number; warnings: string[];
  mode?: CalculationMode; objective?: CalculationObjective;
  sourceReleaseId?: string; ruleSetVersion?: string; inputHash?: string;
  practical?: {directions: {id: string; label: string; status?: string}[]; neighbourChecks: number; screened: number; finalists: number};
  closeness?: {kind: 'unknown' | 'close' | 'separated'; gap: number; margin?: number} | null;
  upperBound?: number | null; optimalityGap?: number | null; topNComplete?: boolean;
  checkpoint?: {schemaVersion: number; inputHash: string; evaluated: number; frontier: unknown[]; results: unknown[]} | null;
  planningScenario?: PlanningScenario; performanceScenario?: PerformanceScenario;
  baseline?: number | null; baselineResult?: OptimizerCandidate | null;
  planning?: {completedVariants: number; totalVariants: string; truncated: boolean; excludedCardIds: string[]};
  scoringCoverage?: {complete: boolean; unsupportedComparisons?: ScoringIssue[]; unsupportedLeaders?: ScoringIssue[]; unsupportedPairs?: ScoringIssue[]; unsupportedCandidates?: ScoringIssue[]};
  calculationScope?: CalculationScope | null;
}
export interface PlaylistReport {
  kind: 'playlist-team-batch'; status: 'running' | 'completed' | 'cancelled';
  rows: {candidate: ChartCandidate; result: OptimizerReport}[];
  failures: {id?: string; trackId: string; difficulty: string; title: string; message: string}[];
  total: number; done: number; results: OptimizerCandidate[]; coverageComplete: boolean;
  optimality: 'per_chart_results_only'; calculationScope?: CalculationScope | null;
}
interface ProgressFields {
  phase: 'planning' | 'practical' | 'planning-result' | 'practical-result' | 'fallback' | 'pair_weights' | 'leader_weights' | 'placements' | 'search';
  stage?: string; message?: string; completed?: number; total?: number;
  stages?: {id: string; label: string; completed: number; total: number | null}[];
  bestCandidate?: OptimizerCandidate | null;
  planningVariant?: number; chartTitle?: string; chartDone?: number; chartTotal?: number;
  best?: number | null; frontier?: number; upperBound?: number; concurrency?: number;
}
export type OptimizerProgress = ProgressFields & (
  {phase: 'planning'; completed: number; total: number} |
  {phase: 'practical'; stage: string; completed: number; total: number; stages: NonNullable<ProgressFields['stages']>} |
  {phase: 'planning-result' | 'practical-result'; bestCandidate: OptimizerCandidate} |
  {phase: 'fallback'; message: string} |
  {phase: 'pair_weights' | 'leader_weights' | 'placements'; completed: number; total: number} |
  {phase: 'search'; completed: number; frontier: number; concurrency: number; best: number | null; upperBound: number}
);
export type OptimizerCommand = {type: 'cancel'} | {type: 'optimize'; requestId: number; payload: OptimizerRequest};
export type OptimizerMessage = {requestId: number} & (
  {type: 'progress'; progress: OptimizerProgress} |
  {type: 'playlist-partial'; result: PlaylistReport} |
  {type: 'result'; result: OptimizerReport | PlaylistReport} |
  {type: 'error'; error: string}
);
export interface OptimizerOptions extends OptimizerRequest {
  signal?: AbortSignal; onProgress?: (progress: OptimizerProgress) => void; yieldControl?: () => Promise<void>;
  theoreticalGrowth?: 'maximum' | 'configured'; checkpoint?: OptimizerReport['checkpoint'];
  eventAdapters?: unknown[]; extraProfiles?: unknown[]; resultLimit?: number; finalistLimit?: number; retainedOrigins?: string[];
  candidateCache?: Map<string, unknown>; candidateCacheKey?: string;
  pairCache?: Map<string, unknown>; pairCacheKey?: string; modelCache?: Map<string, unknown>; scoreCache?: Map<string, unknown>;
  transformScore?: (score: Omit<OptimizerCandidate, 'draft'>, draft: TeamDraft) => Omit<OptimizerCandidate, 'draft'>;
  compareCandidates?: (a: OptimizerCandidate, b: OptimizerCandidate) => number;
  batchSize?: number; evaluateBatch?: (drafts: TeamDraft[]) => Promise<(OptimizerCandidate | null)[]>;
}
