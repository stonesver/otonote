/** Website-facing contract for the unchanged JavaScript growth engine. */
import type {TeamDraft} from '../team-draft.mjs';
import type {ScoringRules} from '../calculation/optimizer-types.ts';
import type {Inventory, PlanningScenario, GrowthPlan, GrowthRecords, TrainingChange} from '../calculation/growth-types.ts';
export interface GrowthComparison {
  actualAvailable: boolean; actualTeamAvailable: boolean; trainedCardCount: number;
  changedCards: {id: string; kind: TrainingChange['type']; changes: TrainingChange['fields']}[];
  referenceCardIds: string[]; unknownOwnershipIds: string[]; pendingTrainingUnknownIds: string[];
  trainingCountComplete: boolean; materialEstimateAvailable: false;
}
export interface SavedPlanningResult extends Partial<GrowthComparison> {
  schemaVersion: number; sourceReleaseId: string; actualGrowth: Record<string, GrowthRecords[string] | null>;
  selectedTrainingCardIds?: string[];
}
export interface ResolvedGrowthScenario {
  schemaVersion: number; sourceReleaseId: string; scope: NonNullable<PlanningScenario['scope']>;
  currentDraft: TeamDraft; targetDraft: TeamDraft; inventory: Inventory;
  plan: GrowthPlan & {enabled: boolean; maxTrainedCards: number};
  planningScenario: PlanningScenario; assumptions: string[]; excludedCardIds: string[];
}
export function resolveGrowthScenario(rules: ScoringRules, draft: TeamDraft, options?: PlanningScenario & {inventory?: Inventory}): ResolvedGrowthScenario;
export function prepareGrowthCandidate(rules: ScoringRules, scenario: ResolvedGrowthScenario, candidateDraft: TeamDraft, options?: {trainedCardIds?: string[]}): {
  actualDraft: TeamDraft | null; baselineDraft: TeamDraft;
  targetDraft: TeamDraft & {modifiers: {planningResult: SavedPlanningResult}};
  comparison: GrowthComparison; assumptions: string[];
};
export function createGrowthSearchVariants(scenario: ResolvedGrowthScenario, options?: {offset?: number; limit?: number}): {
  totalCount: number | null; totalCountExact: string; offset: number; limit: number; truncated: boolean;
  [Symbol.iterator](): Iterator<{index: number; draft: TeamDraft; inventory: Inventory; trainedCardIds: string[]}>;
};
