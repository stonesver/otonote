import {recordsFromGlob} from "./database-records";
import {cardDetailProjections,publicSkills} from "./game-card-data";
const skillDetails=publicSkills;
import type {EditionRecord} from "./catalog";
import summaryData from "@projection-data/database-shards/summary.json";
import skillIndexData from "@projection-data/database-shards/skills-index.json";
import itemIndexData from "@projection-data/database-shards/items-index.json";
import growthIndexData from "@projection-data/database-shards/growth-index.json";
import targetData from "@projection-data/database-shards/targets.json";
import conditionData from "@projection-data/database-shards/conditions.json";
import skillResourceData from "@projection-data/database-shards/skill-level-resources.json";
import { validateArtifact } from "./artifact-contracts";
import { activeReleaseContext } from "./release-context";

export type SkillKind =
  | "leader"
  | "live"
  | "support"
  | "gekisou"
  | "gekisou_support";

export type InterpretationStatus = "identified" | "partial";

export interface MaterialRequirement {
  itemId: string;
  amount: number;
  usageKind:
    | "skill_level"
    | "member_rank"
    | "member_awake"
    | "support_rank";
  stage: number;
  sourceEntityId: string;
  sourceGroupId: number;
  cardIds: string[];
  interpretationStatus: InterpretationStatus;
}

export interface SkillEffect {
  sourceEffectId: number;
  sourceOrder: number;
  effectType: number;
  effectName: string;
  rawValue: number;
  rawMaxValue: number;
  durationSeconds: number;
  effectLimitCount: number;
  conditionGroupId: number;
  releaseConditionGroupId: number;
  triggerConditionGroupId: number;
  triggerTypeCode: number;
  targetIds: string[];
  cumulativeConditionId: number;
  executeLimitCount: number;
  executeLimitResetConditionGroupId: number;
  interpretationStatus: InterpretationStatus;
}

export interface SkillLevel {
  level: number;
  effects: SkillEffect[];
  renderedSummary: string;
  materialRequirements: MaterialRequirement[];
}

export interface SkillDefinition {
  id: string;
  masterId: number;
  kind: SkillKind;
  name: string;
  descriptionTemplate: string;
  iconId: number;
  iconAssetId: string | null;
  iconStatus: "identified" | "source_missing";
  iconEvidence: string;
  publicationStatus: "public" | "archive_only";
  publicationReason: string;
  categoryCodes: number[];
  missionTypeCode: number;
  executionTimingCode: number;
  levels: SkillLevel[];
  relatedCardIds: string[];
  sourceReleaseIds: string[];
  interpretationStatus: InterpretationStatus;
}

export interface SkillIndexRecord extends EditionRecord {
  contentIdentity?:string;
  id: string;
  masterId: number;
  kind: SkillKind;
  name: string;
  iconAssetId: string | null;
  iconStatus: "identified" | "source_missing";
  publicationStatus: "public";
  interpretationStatus: InterpretationStatus;
  highestLevel: number;
  highestSummary: string;
  effects: Array<{ type: number; name: string }>;
  targetIds: string[];
  conditional: boolean;
  relatedCardIds: string[];
}

export interface SkillTarget {
  id: string;
  masterId: number;
  targetType: number;
  characterId: string | null;
  bandId: string | null;
  cardTypeCode: number;
  tagId: number;
  judgementCode: number;
  liveMusicTypeCode: number;
  skillTypeCode: number;
  skillGroupId: number;
  missionTypeCode: number;
  liveSkillCategoryCodes: number[];
  gekisouSkillCategoryCodes: number[];
  interpretationStatus: InterpretationStatus;
}

export interface SkillCondition {
  id: string;
  masterId: number;
  conditionType: number;
  rawValues: unknown[];
  isPositive: boolean;
  targetIds: string[];
  interpretationStatus: InterpretationStatus;
}

export interface SkillConditionGroup {
  groupId: number;
  sets: Array<{
    sourceSetId: number;
    conditionIds: string[];
  }>;
  combinationStatus: "unverified";
}

export interface GrowthCurvePoint {
  level: number;
  rawExp: number;
  rates: {
    performance: number;
    technic: number;
    visual: number;
  };
}

export interface GrowthProfile {
  id: string;
  cardKind: "member" | "support";
  levelGroup: number;
  rankGroup: number;
  awakeGroup: number | null;
  awakeResourceGroup: number | null;
  rarity: number | null;
  rankItemId: string | null;
  levelCurve: GrowthCurvePoint[];
  levelLimits: Array<{
    awakeCount: number;
    limitLevel: number;
  }>;
  ranks: Array<Record<string, number | { performance: number; technic: number; visual: number }>>;
  awakes: Array<{
    awakeCount: number;
    rates: {
      performance: number;
      technic: number;
      visual: number;
    };
  }>;
  materialRequirements: MaterialRequirement[];
  sourceCardIds: string[];
}

export interface Item {
  liveDrops?: { mode: "solo" | "multi"; scoreRank: number; rewardGroup: number; count: number; probability: number; probabilityBase: number }[];
  acquisitionSources?: { kind: string; name: string; count: number; isBonus: boolean; windows: { startAt: string; endAt: string }[] }[];
  id: string;
  masterId: number;
  name: string;
  phoneticName: string;
  description: string;
  typeCode: number;
  inventoryDisplayGroup: number;
  value: number;
  maxOwned: number;
  displayOrder: number;
  displayTargetIds: number[];
  availableFrom: string;
  availableUntil: string;
  imagePath: string;
  iconAssetId: string | null;
  usages: MaterialRequirement[];
  sourceReleaseIds: string[];
  catalogStatus: "identified" | "missing_asset";
}

export interface ItemIndexRecord extends EditionRecord {
  contentIdentity?:string;
  id: string;
  masterId: number;
  name: string;
  phoneticName: string;
  description: string;
  typeCode: number;
  maxOwned: number;
  displayOrder: number;
  availableFrom: string;
  availableUntil: string;
  iconAssetId: string | null;
  catalogStatus: "identified" | "missing_asset";
  usageKinds: MaterialRequirement["usageKind"][];
  relatedCardIds: string[];
}

export interface SkillReference {
  slot: string;
  skillId: string;
  levelResourceGroup: number;
  materialRequirements?: MaterialRequirement[];
}

export interface SkillSummary {
  slot: string;
  skillId: string;
  name: string;
  level: number;
  summary: string;
  interpretationStatus: InterpretationStatus;
}

export interface CardDetailProjection {
  cardId: string;
  cardKind: "member" | "support";
  skillRefs: SkillReference[];
  growthProfileId: string | null;
  skillSummaries: SkillSummary[];
  growthSummary: {
    maxLevel?: number;
    maxRank?: number;
    maxAwake?: number;
  };
  materialSummary: MaterialRequirement[];
  projectionStatus: InterpretationStatus;
}

export interface SkillLevelResourceProfile {
  id: string;
  [key: string]: unknown;
}

export interface GameDatabase {
  schemaVersion: 1;
  sourceReleaseId: string;
  skills: SkillDefinition[];
  conditions: SkillCondition[];
  conditionGroups: SkillConditionGroup[];
  cumulativeConditions: Array<Record<string, unknown>>;
  targets: SkillTarget[];
  growthProfiles: GrowthProfile[];
  skillLevelResourceProfiles: SkillLevelResourceProfile[];
  items: Item[];
  quality: {
    skillCount: number;
    itemCount: number;
    growthProfileCount: number;
    partialSkillCount: number;
    publicSkillCount: number;
    archivedSkillCount: number;
    missingSkillIconCount: number;
    unexplainedMissingSkillIconCount: number;
  };
}

export interface CardDetailProjections {
  schemaVersion: 1;
  memberCards: CardDetailProjection[];
  supportCards: CardDetailProjection[];
}

interface DetailShard<T> {
  schemaVersion: 1;
  contentReleaseId: string;
  kind: string;
  recordCount: number;
  sha256: string;
  record: T;
}

interface RecordsShard<T> {
  schemaVersion: 1;
  contentReleaseId: string;
  records: T[];
}

interface RecordShard<T> {
  schemaVersion: 1;
  contentReleaseId: string;
  record: T;
}

interface DatabaseSummaryRecord {
  sourceReleaseId: string;
  quality: GameDatabase["quality"];
}

type GrowthIndexRecord = {
  id: string;
  cardKind: "member" | "support";
  sourceCardIds: string[];
  maxLevel: number;
};

interface ConditionsRecord {
  conditions: SkillCondition[];
  conditionGroups: SkillConditionGroup[];
  cumulativeConditions: Array<Record<string, unknown>>;
}


const summary = validateArtifact<RecordShard<DatabaseSummaryRecord>>(
  "database-shards/summary.json",
  summaryData,
  {
    schemaVersion: 1,
    fields: {
      contentReleaseId: "string",
      record: "object",
      "record.sourceReleaseId": "string",
      "record.quality": "object"
    }
  }
);
const skillIndexArtifact = validateArtifact<RecordsShard<SkillIndexRecord>>(
  "database-shards/skills-index.json",
  skillIndexData,
  {
    schemaVersion: 1,
    fields: {
      contentReleaseId: "string",
      records: "array",
      "records[]": "object",
      "records[].id": "string"
    }
  }
);
const itemIndexArtifact = validateArtifact<RecordsShard<ItemIndexRecord>>(
  "database-shards/items-index.json",
  itemIndexData,
  {
    schemaVersion: 1,
    fields: {
      contentReleaseId: "string",
      records: "array",
      "records[]": "object",
      "records[].id": "string"
    }
  }
);
const growthIndexArtifact = validateArtifact<RecordsShard<GrowthIndexRecord>>(
  "database-shards/growth-index.json",
  growthIndexData,
  {
    schemaVersion: 1,
    fields: {
      contentReleaseId: "string",
      records: "array",
      "records[]": "object",
      "records[].id": "string",
      "records[].sourceCardIds": "array",
      "records[].maxLevel": "number"
    }
  }
);
const targetArtifact = validateArtifact<RecordsShard<SkillTarget>>(
  "database-shards/targets.json",
  targetData,
  {
    schemaVersion: 1,
    fields: {
      contentReleaseId: "string",
      records: "array",
      "records[]": "object",
      "records[].id": "string"
    }
  }
);
const conditionArtifact = validateArtifact<RecordShard<ConditionsRecord>>(
  "database-shards/conditions.json",
  conditionData,
  {
    schemaVersion: 1,
    fields: {
      contentReleaseId: "string",
      record: "object",
      "record.conditions": "array",
      "record.conditionGroups": "array",
      "record.cumulativeConditions": "array"
    }
  }
);
const skillResourceArtifact = validateArtifact<
  RecordsShard<SkillLevelResourceProfile>
>(
  "database-shards/skill-level-resources.json",
  skillResourceData,
  {
    schemaVersion: 1,
    fields: {
      contentReleaseId: "string",
      records: "array",
      "records[]": "object",
      "records[].id": "string"
    }
  }
);

const itemDetails = recordsFromGlob<Item>(
  "database-shards/items",
  "id",
  import.meta.glob("@projection-data/database-shards/items/*.json", {
    eager: true
  })
);
const growthDetails = recordsFromGlob<GrowthProfile>(
  "database-shards/growth",
  "id",
  import.meta.glob("@projection-data/database-shards/growth/*.json", {
    eager: true
  })
);

export const skillIndex = skillIndexArtifact.records;
export const itemIndex = itemIndexArtifact.records;
export const growthIndex = growthIndexArtifact.records;
export const gameDatabase = {
  schemaVersion: summary.schemaVersion,
  sourceReleaseId: summary.contentReleaseId,
  skills: skillDetails,
  conditions: conditionArtifact.record.conditions,
  conditionGroups: conditionArtifact.record.conditionGroups,
  cumulativeConditions: conditionArtifact.record.cumulativeConditions,
  targets: targetArtifact.records,
  growthProfiles: growthDetails,
  skillLevelResourceProfiles: skillResourceArtifact.records,
  items: itemDetails,
  quality: summary.record.quality
} satisfies GameDatabase;
export {cardDetailProjections,publicSkills};

const skillsById = new Map(
  publicSkills.map((skill) => [skill.id, skill])
);
const itemsById = new Map(
  gameDatabase.items.map((item) => [item.id, item])
);
const growthProfilesById = new Map(
  gameDatabase.growthProfiles.map((profile) => [profile.id, profile])
);
const targetsById = new Map(
  gameDatabase.targets.map((target) => [target.id, target])
);
const conditionGroupsById = new Map(
  gameDatabase.conditionGroups.map((group) => [group.groupId, group])
);
const memberCardProjectionsById = new Map(
  cardDetailProjections.memberCards.map((projection) => [
    projection.cardId,
    projection
  ])
);
const supportCardProjectionsById = new Map(
  cardDetailProjections.supportCards.map((projection) => [
    projection.cardId,
    projection
  ])
);

export function getSkill(id: string | null | undefined): SkillDefinition | undefined {
  return id ? skillsById.get(id) : undefined;
}

export function getItem(id: string | null | undefined): Item | undefined {
  return id ? itemsById.get(id) : undefined;
}

export function getGrowthProfile(
  id: string | null | undefined
): GrowthProfile | undefined {
  return id ? growthProfilesById.get(id) : undefined;
}

export function getSkillTarget(
  id: string | null | undefined
): SkillTarget | undefined {
  return id ? targetsById.get(id) : undefined;
}

export function getConditionGroup(
  id: number | null | undefined
): SkillConditionGroup | undefined {
  return id ? conditionGroupsById.get(id) : undefined;
}

export function getMemberCardProjection(
  id: string
): CardDetailProjection | undefined {
  return memberCardProjectionsById.get(id);
}

export function getSupportCardProjection(
  id: string
): CardDetailProjection | undefined {
  return supportCardProjectionsById.get(id);
}

export function getItemUsages(id: string): MaterialRequirement[] {
  return getItem(id)?.usages ?? [];
}

export function skillKindLabel(
  kind: SkillKind,
  locale: string = activeReleaseContext.locale
): string {
  const labels = locale === "en"
    ? {
        leader: "Leader Skill",
        live: "Live Skill",
        support: "Support Skill",
        gekisou: "Gekisou Skill",
        gekisou_support: "Gekisou Support Skill"
      }
    : {
        leader: "队长技能",
        live: "Live 技能",
        support: "支援技能",
        gekisou: "激奏技能",
        gekisou_support: "激奏支援技能"
      };
  return labels[kind];
}

export function usageKindLabel(
  kind: MaterialRequirement["usageKind"],
  locale: string = activeReleaseContext.locale
): string {
  const labels = locale === "en"
    ? {
        skill_level: "Skill Level",
        member_rank: "Member Card Rank",
        member_awake: "Member Card Awakening",
        support_rank: "Snap Rank"
      }
    : {
        skill_level: "技能升级",
        member_rank: "成员卡 Rank",
        member_awake: "成员卡觉醒",
        support_rank: "留影 Rank"
      };
  return labels[kind];
}

export function formatRate(value: number): string {
  return `${(value / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
