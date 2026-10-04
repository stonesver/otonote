import { createFormationCalculator, requireInteger } from "./formation-power.mjs";
import { resolveGrowthScenario } from "./growth-scenarios.mjs";

export function canonicalCardId(value, kind) {
  const match = new RegExp(`^(?:${kind}-(?:card-)?)?([0-9]+)$`).exec(String(value));
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Invalid ${kind} card: ${value}`);
  return `${kind}-card-${Number(match[1])}`;
}

export function createInventory(rules, input = {}) {
  if (input.sourceReleaseId && input.sourceReleaseId !== rules.sourceReleaseId) throw new Error("inventory release_mismatch");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error("Unsupported inventory schema");
  const calculator = createFormationCalculator(rules);
  const ids = (kind) => {
    const values = input[`${kind}CardIds`] ?? [];
    if (!Array.isArray(values)) throw new Error(`Invalid ${kind} inventory`);
    const result = values.map((value) => canonicalCardId(value, kind));
    if (new Set(result).size !== result.length) throw new Error(`Duplicate ${kind} in inventory`);
    for (const value of result) calculator.card(value, kind);
    return result.sort((a, b) => Number(a.split("-").at(-1)) - Number(b.split("-").at(-1)));
  };
  return { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId,
    memberCardIds: ids("member"), supportCardIds: ids("support") };
}

/** New planning calls expose the resolved scenario; optimizers must enumerate
 * its feasible growth variants before pruning candidates. Legacy calls retain
 * their established defaults. */
export function resolveSearchInput(rules, draft, options = {}) {
  if (options.planningScenario || ['reference', 'trial'].includes(options.scope)
    || options.plan || options.unknownGrowth || options.selectedCardIds) {
    const scenario = resolveGrowthScenario(rules, draft, {
      ...options, ...options.planningScenario, inventory: options.inventory
    });
    const input = resolveLegacySearchInput(rules, scenario.currentDraft, {
      scope: 'owned', inventory: scenario.inventory, constraints: options.constraints ?? {}
    });
    return { ...input, scope: scenario.scope, growthScenario: scenario,
      assumptions: [...input.assumptions, ...scenario.assumptions] };
  }
  return resolveLegacySearchInput(rules, draft, options);
}

function resolveLegacySearchInput(rules, draft, { scope = "selected", inventory, constraints = {},
  theoreticalGrowth = "maximum" } = {}) {
  const calculator = createFormationCalculator(rules);
  if (!draft?.slots || draft.slots.length !== 5) throw new Error("Exactly five slots required");
  if (!["selected", "owned", "theoretical"].includes(scope)) throw new Error("Unknown search scope");
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) throw new Error("Invalid constraints");
  const validKeys = ["bandId", "attribute", "supportAttribute", "leaderId", "requiredMemberIds", "requiredSupportIds",
    "excludedMemberIds", "excludedSupportIds", "lockedPairs"];
  for (const key of Object.keys(constraints)) if (!validKeys.includes(key)) throw new Error(`Unknown constraint: ${key}`);
  const result = structuredClone(draft);
  result.modifiers ??= {};
  let pool;
  if (scope === "selected") {
    if (draft.slots.some((s) => !s.memberCardId || !s.supportCardId)) throw new Error("请先选择五张成员和五张留影");
    pool = createInventory(rules, { memberCardIds: draft.slots.map((s) => s.memberCardId),
      supportCardIds: draft.slots.map((s) => s.supportCardId) });
  } else if (scope === "owned") {
    if (!inventory) throw new Error("请先填写已拥有卡库");
    pool = createInventory(rules, inventory);
  } else {
    if (!["maximum", "configured"].includes(theoreticalGrowth)) throw new Error("Unknown theoretical growth");
    pool = createInventory(rules, { memberCardIds: rules.tables.MemberCard.map((r) => r._id),
      supportCardIds: rules.tables.SupportCard.map((r) => r._id) });
    if (theoreticalGrowth === "maximum") {
      result.modifiers.growth = { ...result.modifiers.growth };
      for (const kind of ["member", "support"]) for (const id of pool[`${kind}CardIds`]) {
        const row = calculator.card(id, kind);
        const ranks = rules.tables[kind === "member" ? "MemberCardRank" : "SupportCardRank"]
          .filter((r) => r._group === row[`_${kind}CardRankGroup`]);
        const rank = Math.max(...ranks.map((r) => r._rank));
        const awake = kind === "member" ? Math.max(...rules.tables.MemberCardLevelLimit
          .filter((r) => r._rarity === row._rarity).map((r) => r._awakeCount)) : 1;
        const { level } = calculator.resolveGrowth(row, kind === "member" ? "Member" : "Support", { rank, awake });
        result.modifiers.growth[id] = { level, rank, ...(kind === "member" ? { awake, skillLevel: 5, gekisouSkillLevel: 5 } : {}) };
      }
    }
  }
  const list = (key, kind) => {
    const values = constraints[key] ?? [];
    if (!Array.isArray(values)) throw new Error(`Invalid constraint: ${key}`);
    return [...new Set(values.map((id) => canonicalCardId(id, kind)))];
  };
  if (constraints.lockedPairs !== undefined && !Array.isArray(constraints.lockedPairs)) throw new Error("Invalid lockedPairs");
  const normalized = {
    requiredMemberIds: list("requiredMemberIds", "member"), requiredSupportIds: list("requiredSupportIds", "support"),
    excludedMemberIds: list("excludedMemberIds", "member"), excludedSupportIds: list("excludedSupportIds", "support"),
    leaderId: constraints.leaderId ? canonicalCardId(constraints.leaderId, "member") : null,
    lockedPairs: (constraints.lockedPairs ?? []).map((p) => ({ memberCardId: canonicalCardId(p.memberCardId, "member"),
      supportCardId: canonicalCardId(p.supportCardId, "support") }))
  };
  const chars = new Map(rules.tables.Character.map((c) => [c._id, c]));
  for (const key of ["bandId", "attribute", "supportAttribute"]) {
    if (constraints[key] !== undefined && constraints[key] !== null) normalized[key] = requireInteger(constraints[key], key, 1, 99);
  }
  for (const kind of ["member", "support"]) {
    pool[`${kind}CardIds`] = pool[`${kind}CardIds`].filter((id) => {
      const row = calculator.card(id, kind);
      return !normalized[kind === "member" ? "excludedMemberIds" : "excludedSupportIds"].includes(id)
        && (kind === "member" ? (!normalized.bandId || chars.get(row._characterID)._bandID === normalized.bandId)
          && (!normalized.attribute || row._cardType === normalized.attribute)
          : !normalized.supportAttribute || row._cardType === normalized.supportAttribute);
    });
    for (const id of pool[`${kind}CardIds`]) {
      const growth = result.modifiers.growth?.[id];
      if (scope === "owned" || (scope === "theoretical" && theoreticalGrowth === "configured")) {
        if (!growth || !Number.isInteger(growth.level) || !Number.isInteger(growth.rank)
          || (kind === "member" && !Number.isInteger(growth.awake))) throw new Error(`请填写实际等级与养成：${id}`);
      }
      calculator.resolveGrowth(calculator.card(id, kind), kind === "member" ? "Member" : "Support", growth);
    }
  }
  const requiredMembers = new Set([...normalized.requiredMemberIds, ...normalized.lockedPairs.map((p) => p.memberCardId),
    ...(normalized.leaderId ? [normalized.leaderId] : [])]);
  const requiredSupports = new Set([...normalized.requiredSupportIds, ...normalized.lockedPairs.map((p) => p.supportCardId)]);
  for (const id of requiredMembers) if (!pool.memberCardIds.includes(id)) throw new Error(`必选成员被筛选或不在卡库：${id}`);
  for (const id of requiredSupports) if (!pool.supportCardIds.includes(id)) throw new Error(`必选留影被筛选或不在卡库：${id}`);
  const characterIds = pool.memberCardIds.map((id) => calculator.card(id, "member")._characterID);
  if (new Set(characterIds).size < 5 || pool.supportCardIds.length < 5) throw new Error("筛选后需要至少五位不同角色及五张留影");
  if (requiredMembers.size > 5 || requiredSupports.size > 5) throw new Error("必选卡片不能超过五张");
  if (new Set([...requiredMembers].map((id) => calculator.card(id, "member")._characterID)).size !== requiredMembers.size) {
    throw new Error("必选成员包含同名角色");
  }
  return { draft: result, inventory: pool, constraints: normalized, scope, theoreticalGrowth,
    assumptions: ["未填写的账号角色评级为 1、TGW 为 1，乐器与回忆为 0。", ...(scope === "theoretical" && theoreticalGrowth === "maximum" ? ["卡片按满等级、满突破、满觉醒及满技能；账号评级、乐器、TGW使用填写值"] : scope === "selected" ? ["所选卡未填写等级时使用当前突破/觉醒的等级上限，未填写突破、觉醒和技能等级时为 1。"] : [])] };
}
