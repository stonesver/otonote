import type {AccountGrowth, GrowthRecords, PlanningScenario} from './calculation/growth-types.ts';
import type {PerformanceScenario} from './calculation/optimizer-types.ts';

export interface TeamDraftSlot {
  memberCardId: string | null;
  supportCardId: string | null;
}

export interface TeamDraft {
  schemaVersion: number;
  ruleSetVersion: string;
  slots: TeamDraftSlot[];
  selectedSongId: string | null;
  selectedDifficulty: string | null;
  modifiers: Record<string, unknown> & AccountGrowth & {
    recommendationGoal?: 'score' | 'stable' | 'missions';
    growth?: GrowthRecords; planningScenario?: PlanningScenario; performanceScenario?: PerformanceScenario;
  };
}

export interface TeamDraftIssue {
  code: string;
  severity: "error";
  message: string;
  slotIndex?: number;
  field?: string;
  value?: string;
}

export const TEAM_DRAFT_SCHEMA_VERSION: number;
export const TEAM_RULE_SET: {
  id: string;
  label: string;
  verificationStatus: "experimental";
  officialSlotCount: null;
  slotModel: "member_with_optional_support";
  evidence: readonly string[];
  unresolvedRules: readonly string[];
};
export const TEAM_DIFFICULTIES: readonly string[];

export function createTeamDraft(initial?: Partial<TeamDraft>): TeamDraft;
export function validateTeamDraft(
  draft: unknown,
  known?: {
    memberCardIds?: Set<string>;
    supportCardIds?: Set<string>;
    musicTrackIds?: Set<string>;
  }
): TeamDraftIssue[];
export function parseTeamDraftSearch(
  search: string,
  known?: {
    memberCardIds?: Set<string>;
    supportCardIds?: Set<string>;
    musicTrackIds?: Set<string>;
  }
): { draft: TeamDraft; issues: TeamDraftIssue[] };
export function serializeTeamDraftSearch(draft: TeamDraft): string;
export function deriveTeamDraftSummary(
  draft: TeamDraft,
  data?: {
    memberCards?: Array<Record<string, unknown>>;
    supportCards?: Array<Record<string, unknown>>;
    projections?: Array<Record<string, unknown>>;
  }
): Record<string, unknown>;
