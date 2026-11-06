/** Persisted and hypothetical growth share units, never ownership or completeness. */
export interface SupportGrowth { level: number; rank: number }
export interface MemberGrowth extends SupportGrowth { awake: number; skillLevel: number; gekisouSkillLevel: number }
export type GrowthField = keyof MemberGrowth;
export type GrowthInput = Partial<MemberGrowth>;
export type GrowthRecords = Record<string, GrowthInput>;
export interface CardPool { memberCardIds: string[]; supportCardIds: string[] }
export interface Inventory extends CardPool {
  schemaVersion?: 1;
  sourceReleaseId?: string;
  growth?: GrowthRecords;
}
export interface AccountGrowth {
  bandItems?: Record<string, number>;
  bandItemTotals?: Record<string, number>;
  characterRanks?: Record<string, number>;
  tgwCardRank?: number;
}
export interface GrowthPlan {
  schemaVersion?: 1;
  sourceReleaseId?: string;
  enabled?: boolean;
  mode?: 'current-cap' | 'target' | 'maximum';
  maxTrainedCards?: number;
  allowedCardIds?: string[];
  targets?: GrowthRecords;
  skillLevel?: number;
  gekisouSkillLevel?: number;
}
export interface PlanningScenario {
  schemaVersion?: 1;
  sourceReleaseId?: string;
  scope?: 'selected' | 'owned' | 'reference' | 'trial';
  unknownGrowth?: 'exclude' | 'reference';
  selectedCardIds?: CardPool;
  trialCardIds?: CardPool;
  referenceGrowth?: 'maximum' | { member?: Partial<MemberGrowth>; support?: Partial<SupportGrowth> };
  plan?: GrowthPlan;
}
export interface TrainingChange {
  type: 'member' | 'support';
  id: string;
  fields: { field: GrowthField; from: number; to: number }[];
}
export interface PlanningComparison {
  kind: string;
  label: string;
  trainingChanges: TrainingChange[];
  currentValue: number | null;
  plannedTeamCurrentValue: number | null;
  targetValue: number;
  missingActual: boolean;
  actualScoreAvailable: boolean;
  ownershipUnknown: string[];
  materialEstimateAvailable: false;
  trainingCountComplete: boolean;
}
