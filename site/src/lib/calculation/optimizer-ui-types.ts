import type {TeamDraft} from '../team-draft.mjs';
import type {Inventory} from './growth-types.ts';
import type {PlanningSettings} from './planning-settings.ts';
import type {CalculationScope, ChartCandidate, ScoringRules, OptimizerRequest, CalculationMode, CalculationObjective} from './optimizer-types.ts';

/** Existing page and legacy control boundaries; their DOM rendering stays in JS. */
export interface PlanningControls {
  readonly kind: string; read(): PlanningSettings; persist(): PlanningSettings;
  sync(): void; restore(): void;
}
export interface TeamScopeControls {
  task: {value: string};
  scope: {snapshot?: CalculationScope | null; refresh(): void; require(options: object): CalculationScope};
  destroy(): void;
}
export interface OptimizerWorkbench extends HTMLElement {
  data: {formalRules: ScoringRules; sourceReleaseId: string; locale: string; charts?: ChartCandidate[]; vipRanks?: {rank: number}[]};
  draft: TeamDraft;
  cardInventory?: Inventory;
  planningScenarios?: PlanningControls | null;
  optimizerState?: {running?: boolean; finished?: boolean; hasResults?: boolean; ready?: boolean; message?: string; space?: unknown};
  teamWorkspaceContext?: unknown;
}
/** Select values are constrained by the existing calculator template. */
export interface OptimizerSelects {
  '[data-search-scope]': HTMLSelectElement & {value: NonNullable<OptimizerRequest['scope']>};
  '[data-pairing-mode]': HTMLSelectElement & {value: CalculationMode};
  '[data-pairing-objective]': HTMLSelectElement & {value: CalculationObjective};
}

type NumberOrTextControl = 'gekisou-fps' | 'gekisou-offset' | 'gekisou-batches' | 'gekisou-seed'
  | 'planning-variant-limit' | 'planning-window-limit' | 'search-budget' | 'search-effort';
type ActionControl = 'optimize-pairing' | 'cancel-pairing' | 'resume-pairing' | 'export-pairing';
export type OptimizerNodes = OptimizerSelects
  & Record<`[data-${NumberOrTextControl}]`, HTMLInputElement>
  & Record<`[data-${ActionControl}]`, HTMLButtonElement>;
