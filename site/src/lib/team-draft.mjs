import {currentServerContext, assertAccountServer} from './game-servers.mjs';
export const TEAM_DRAFT_SCHEMA_VERSION = 1;

export const TEAM_RULE_SET = Object.freeze({
  id: "formation-research-v1",
  label: "编成研究规则 v1",
  verificationStatus: "experimental",
  officialSlotCount: 5,
  slotModel: "five_member_with_support",
  evidence: Object.freeze([
    "FormationEntity",
    "FormationSlotEntity",
    "UIFormationMemberCard",
    "UIFormationSupportCard",
    "DeckAutoBuilder",
    "PlayerFormationPowerCalculator"
  ]),
  unresolvedRules: Object.freeze([
    "duplicate_card_restrictions",
    "member_support_equipment_restrictions",
    "event_formation_power_modifiers"
  ])
});

export const TEAM_DIFFICULTIES = Object.freeze([
  "easy",
  "normal",
  "hard",
  "expert"
]);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nullableString = (value) =>
  typeof value === "string" && value.length > 0 ? value : null;

const normalizeSlot = (value = {}) => ({
  memberCardId: nullableString(value?.memberCardId),
  supportCardId: nullableString(value?.supportCardId)
});

const normalizeModifiers = (value) => {
  if (!isObject(value)) return {};
  const modifiers = { ...value };
  if (modifiers.tgwCardRank === "" || modifiers.tgwCardRank === null) {
    delete modifiers.tgwCardRank;
  }
  return modifiers;
};

export function createTeamDraft(initial = {}) {
  const sourceSlots = Array.isArray(initial.slots)
    ? initial.slots.slice(0, TEAM_RULE_SET.officialSlotCount).map(normalizeSlot)
    : [];
  const slots = Array.from(
    { length: TEAM_RULE_SET.officialSlotCount },
    (_, index) => sourceSlots[index] ?? normalizeSlot()
  );

  return {
    schemaVersion: TEAM_DRAFT_SCHEMA_VERSION,
    ruleSetVersion: TEAM_RULE_SET.id,
    slots,
    selectedSongId: nullableString(initial.selectedSongId),
    selectedDifficulty: nullableString(initial.selectedDifficulty),
    modifiers: normalizeModifiers(initial.modifiers)
  };
}

function issue(code, message, details = {}) {
  return { code, severity: "error", message, ...details };
}

export function validateTeamDraft(draft, known = {}) {
  const issues = [];
  if (!isObject(draft)) {
    return [issue("invalid_draft", "TeamDraft 必须是对象")];
  }
  if (draft.schemaVersion !== TEAM_DRAFT_SCHEMA_VERSION) {
    issues.push(issue("unsupported_schema", "草稿 schemaVersion 不受支持"));
  }
  if (draft.ruleSetVersion !== TEAM_RULE_SET.id) {
    issues.push(issue("unknown_rule_set", "草稿 ruleSetVersion 未知"));
  }
  if (
    !Array.isArray(draft.slots) ||
    draft.slots.length !== TEAM_RULE_SET.officialSlotCount
  ) {
    issues.push(issue("invalid_slots", "草稿必须包含五个编成槽位"));
    return issues;
  }

  const memberCardIds = known.memberCardIds ?? new Set();
  const supportCardIds = known.supportCardIds ?? new Set();
  const musicTrackIds = known.musicTrackIds ?? new Set();

  draft.slots.forEach((slot, slotIndex) => {
    if (!isObject(slot)) {
      issues.push(issue("invalid_slot", "槽位结构无效", { slotIndex }));
      return;
    }
    if (slot.memberCardId && !memberCardIds.has(slot.memberCardId)) {
      issues.push(
        issue("unknown_member_card", "成员卡不属于当前 Release", {
          slotIndex,
          field: "memberCardId",
          value: slot.memberCardId
        })
      );
    }
    if (slot.supportCardId && !supportCardIds.has(slot.supportCardId)) {
      issues.push(
        issue("unknown_support_card", "留影不属于当前 Release", {
          slotIndex,
          field: "supportCardId",
          value: slot.supportCardId
        })
      );
    }
  });

  if (draft.selectedSongId && !musicTrackIds.has(draft.selectedSongId)) {
    issues.push(
      issue("unknown_song", "歌曲不属于当前 Release", {
        field: "selectedSongId",
        value: draft.selectedSongId
      })
    );
  }
  if (draft.modifiers?.tgwCardRank !== undefined) {
    const rank = draft.modifiers.tgwCardRank;
    if (!Number.isInteger(rank) || rank < 1 ||
        (known.tgwCardRanks && !known.tgwCardRanks.has(rank))) {
      issues.push(issue("invalid_tgw_card_rank", "T.G.W CARD 等级不属于当前 Release", {
        field: "modifiers.tgwCardRank",
        value: rank
      }));
    }
  }
  if (
    draft.selectedDifficulty &&
    !TEAM_DIFFICULTIES.includes(draft.selectedDifficulty)
  ) {
    issues.push(
      issue("unsupported_difficulty", "难度不受当前工具支持", {
        field: "selectedDifficulty",
        value: draft.selectedDifficulty
      })
    );
  }
  return issues;
}

const parseList = (value) =>
  value === null ? [] : value.split(",").map(nullableString);

export function parseTeamDraftSearch(search, known = {}, hash = '') {
  const params = new URLSearchParams(
    typeof search === "string" && search.startsWith("?")
      ? search.slice(1)
      : search
  );
  const fragmentDraft = new URLSearchParams(hash.replace(/^#/, '')).get('team-draft');
  if (fragmentDraft) {
    for (const [key, value] of new URLSearchParams(fragmentDraft)) {
      if (!params.has(key)) params.set(key, value);
    }
  }
  const memberIds = parseList(params.get("members"));
  const supportIds = parseList(params.get("supports"));
  const slotCount = TEAM_RULE_SET.officialSlotCount;
  const slots = Array.from({ length: slotCount }, (_, index) => ({
    memberCardId: memberIds[index] ?? null,
    supportCardId: supportIds[index] ?? null
  }));

  if (params.has("member") && !params.has("members")) {
    slots[0].memberCardId = nullableString(params.get("member"));
  }
  if (params.has("support") && !params.has("supports")) {
    slots[0].supportCardId = nullableString(params.get("support"));
  }

  let modifiers = {};
  let modifierIssue = null;
  if (params.has("modifiers")) {
    try {
      if (params.get("modifiers").length > 30000) throw new Error("too large");
      modifiers = JSON.parse(params.get("modifiers"));
      if (!isObject(modifiers)) throw new Error("not an object");
    } catch {
      modifiers = {};
      modifierIssue = issue("invalid_modifiers", "成长与加成设置 JSON 无效");
    }
  }
  if (params.has("tgwRank")) modifiers.tgwCardRank = Number(params.get("tgwRank"));
  const draft = createTeamDraft({
    slots,
    selectedSongId: params.get("song"),
    selectedDifficulty: params.get("difficulty"),
    modifiers
  });
  return { draft, issues: [...validateTeamDraft(draft, known), ...(modifierIssue ? [modifierIssue] : [])] };
}

export function serializeTeamDraftSearch(draft) {
  const normalized = createTeamDraft(draft);
  const params = new URLSearchParams();
  const serverId = currentServerContext().serverId;
  if(serverId) params.set('server',serverId);
  params.set(
    "members",
    normalized.slots.map((slot) => slot.memberCardId ?? "").join(",")
  );
  params.set(
    "supports",
    normalized.slots.map((slot) => slot.supportCardId ?? "").join(",")
  );
  if (normalized.selectedSongId) {
    params.set("song", normalized.selectedSongId);
  }
  if (normalized.selectedDifficulty) {
    params.set("difficulty", normalized.selectedDifficulty);
  }
  if (normalized.modifiers.tgwCardRank !== undefined) {
    params.set("tgwRank", String(normalized.modifiers.tgwCardRank));
  }
  const { tgwCardRank: _rank, ...otherModifiers } = normalized.modifiers;
  if (otherModifiers.apTimingPlan) {
    const {version,context,order,search,adjustments}=otherModifiers.apTimingPlan;
    otherModifiers.apTimingPlan={version,context,order,search,adjustments:adjustments.map(({scoreIndex,timingOffsetMs})=>({scoreIndex,timingOffsetMs}))};
  }
  // Search candidates may carry growth for the whole owned inventory.
  // A share URL needs only the selected team, keeping unused cards private and URLs bounded.
  if (isObject(otherModifiers.growth)) {
    const selected = new Set(normalized.slots.flatMap(slot => [slot.memberCardId, slot.supportCardId]));
    otherModifiers.growth = Object.fromEntries(Object.entries(otherModifiers.growth).filter(([id]) => selected.has(id)));
  }
  if (Object.keys(otherModifiers).length) params.set("modifiers", JSON.stringify(otherModifiers));
  return `?${params.toString()}`;
}

export function serializeTeamDraftJson(draft, context = currentServerContext()) {
  return JSON.stringify({...createTeamDraft(draft), ...context}, null, 2);
}

export function parseScopedTeamDraftJson(raw, context = currentServerContext()) {
  const value = JSON.parse(raw);
  assertAccountServer(value?.serverId, context);
  return createTeamDraft(value);
}

const basePower = (card) => ({
  performance: Number(card?.performancePowerMax ?? 0),
  technic: Number(card?.technicPowerMax ?? 0),
  visual: Number(card?.visualPowerMax ?? 0)
});

export function deriveTeamDraftSummary(
  draft,
  { memberCards = [], supportCards = [], projections = [] } = {}
) {
  const memberById = new Map(memberCards.map((card) => [card.id, card]));
  const supportById = new Map(supportCards.map((card) => [card.id, card]));
  const projectionById = new Map(
    projections.map((projection) => [projection.cardId, projection])
  );
  const totals = { performance: 0, technic: 0, visual: 0 };
  const selectedCards = [];
  const skillSummaries = [];

  for (const [slotIndex, slot] of draft.slots.entries()) {
    const cards = [
      slot.memberCardId ? memberById.get(slot.memberCardId) : null,
      slot.supportCardId ? supportById.get(slot.supportCardId) : null
    ].filter(Boolean);
    for (const card of cards) {
      const power = basePower(card);
      // Support maxima are BP ratios, not points. Never mix these units.
      const isMember = memberById.has(card.id);
      if (isMember) {
        totals.performance += power.performance;
        totals.technic += power.technic;
        totals.visual += power.visual;
      }
      selectedCards.push({ slotIndex, cardId: card.id,
        ...(isMember ? { basePower: power } : { baseRatesBP: power }) });
      const projection = projectionById.get(card.id);
      for (const summary of projection?.skillSummaries ?? []) {
        skillSummaries.push({ slotIndex, cardId: card.id, ...summary });
      }
    }
  }

  const selectedMemberCount = draft.slots.filter(
    (slot) => slot.memberCardId
  ).length;
  const selectedSupportCount = draft.slots.filter(
    (slot) => slot.supportCardId
  ).length;
  return {
    basePower: {
      ...totals,
      total: totals.performance + totals.technic + totals.visual
    },
    selectedMemberCount,
    selectedSupportCount,
    requiredSlotCount: TEAM_RULE_SET.officialSlotCount,
    isComplete:
      selectedMemberCount === TEAM_RULE_SET.officialSlotCount &&
      selectedSupportCount === TEAM_RULE_SET.officialSlotCount,
    selectedCards,
    skillSummaries,
    score: null
  };
}
