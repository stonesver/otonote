import type {EditionRecord} from "./catalog";
import systemsData from "@projection-data/global-systems.json";
import { validateArtifact } from "./artifact-contracts";

export interface GachaPool extends EditionRecord {
  id: number;
  name: string;
  startAt: string | null;
  endAt: string | null;
  isLimited: boolean;
  bannerAssetName: string | null;
  lotGroupId: number;
  prizeGroupIds: number[];
  pickupMemberCardIds: number[];
  pickupSupportCardIds: number[];
  supportCardIds: number[];
  products: { id: number; drawCount: number; price: number; itemType: number; costName: string;
    ensuredCount: number; ensuredRarity: number; ensuredType: number; limitCount: number; resetType: number; firstTimePrice: number }[];
  relatedEventIds: number[];
  eventRelationStatus: string;
  description: string;
  categories: string[];
  isRerun?: boolean;
  prizes: (SystemReward & { isPickup: boolean; fixedRateBasisPoints: number; addedRateBasisPoints: number })[];
  probabilityGroups: { rarity: number; resourceType: number; prizeGroupId: number; percent: number | null }[];
}

export interface VipRank {
  rank: number;
  requiredPoints: number;
  bonuses: { type: number; label: string; rawValue: number }[];
  rankUpRewards: SystemReward[];
  dailyRewardRows: number;
  productsPrice: number;
  dailyRewards: (SystemReward & { day: number })[];
}

export interface StudioLevel {
  level: number;
  requiredExp: number;
  unlockBandRank: number;
  efficiencySeconds: number;
  limitSeconds: number;
  rawEarnCoin: number;
  rawEarnMemberExp: number;
  rawEarnSupportExp: number;
  rawEarnOfflineBonusExp: number;
  itemLotGroupId: number;
  itemDraws: number;
}

export interface SystemReward {
  itemType?: number | null;
  resourceType: number;
  resourceId: number;
  count: number;
  name: string;
  imagePath: string | null;
}
export interface MissionGroup {
  bannerAsset?: string | null; bandId?: number | null; previewRewards: SystemReward[]; rewardKindCount: number;
  id: string; category: string; categoryLabel: string; groupName: string; title: string; description: string; rewardNames: string[];
  startAt: string | null; endAt: string | null; releaseDay: number; isCharacterTemplate: boolean;
  related: { name: string; href: string }[];
  completeRewards: SystemReward[];
  sections: { id: string; title: string; taskCount: number; isCharacterTemplate: boolean; categoryLabel: string }[];
  stages: { id: number; sectionId: string; isCharacterTemplate: boolean; description: string; releaseDay: number; related: { name: string; href: string }[]; target: number; rewards: SystemReward[] }[];
}

export interface GlobalSystems {
  schemaVersion: 1;
  sourceReleaseId: string;
  status: string;
  gachaPools: GachaPool[];
  gachaHistoryPrizes?: {id: number; resourceType: number; resourceId: number;
    groupId: number; isPickup: boolean}[];
  missions: MissionGroup[];
  vipRanks: VipRank[];
  vipDailyPoints?: { consecutiveDays: number; points: number }[];
  studioUnits: {
    id: number;
    name: string;
    bandId: number;
    startAt: string | null;
    levels: StudioLevel[];
    itemRewards: Record<string, (SystemReward & { percent: number | null })[]>;
  }[];
  studioExpFactors: { bandRank: number; factor: number }[];
  evidence: { table: string; rowCount: number }[];
}

export const globalSystems = validateArtifact<GlobalSystems>(
  "global-systems.json",
  systemsData,
  {
    schemaVersion: 1,
    fields: {
      sourceReleaseId: "string",
      status: "string",
      gachaPools: "array",
      vipRanks: "array",
      studioUnits: "array",
      evidence: "array"
    }
  }
);
