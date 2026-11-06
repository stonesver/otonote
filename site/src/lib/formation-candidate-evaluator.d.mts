/** Contract at the unchanged JavaScript scoring kernel boundary. */
import type {TeamDraft} from './team-draft.mjs';
import type {OptimizerOptions, OptimizerCandidate} from './calculation/optimizer-types.ts';
export function createCandidateEvaluator(context: Pick<OptimizerOptions, 'rules' | 'chart' | 'mode' | 'objective' | 'gekisouScenario' | 'performanceScenario' | 'eventAdapters'> & {scorePrecision?: 'full' | 'screen'}, existing?: {calculator?: unknown; song?: unknown}): {
  score(draft: TeamDraft): Omit<OptimizerCandidate, 'draft'>;
  evaluate(draft: TeamDraft, options?: Pick<OptimizerOptions, 'signal' | 'yieldControl' | 'onProgress'>): Promise<OptimizerCandidate | null | undefined>;
};
