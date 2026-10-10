function totals(items) {
  const sum = new Map();
  for (const { itemId, amount } of items) sum.set(itemId, (sum.get(itemId) ?? 0) + amount);
  return [...sum].map(([itemId, amount]) => ({ itemId, amount }));
}

function section(key, title, requirements, stageLabel) {
  const stages = [...new Set(requirements.map((row) => row.stage))].sort((a, b) => a - b);
  return {
    key, title,
    total: totals(requirements),
    steps: stages.map((stage) => ({
      label: stageLabel(stage),
      items: totals(requirements.filter((row) => row.stage === stage))
    }))
  };
}

/** Keep each upgrade axis independent; stages refer to the destination state. */
export function createCardMaterialLedger({ profile, projection, locale = "zh-CN" }) {
  if (!profile) return [];
  const en = locale === "en";
  const result = [];
  const curve = [...profile.levelCurve].sort((a, b) => a.level - b.level);
  const maxLevel = projection.growthSummary?.maxLevel ?? curve.at(-1)?.level ?? 1;
  const expAt = (level) => curve.find((point) => point.level === level)?.rawExp ?? 0;
  const caps = profile.cardKind === "support"
    ? profile.ranks.map((row) => row.limitLevel)
    : profile.levelLimits.map((row) => row.limitLevel);
  const milestones = [...new Set([...caps, maxLevel])]
    .filter((level) => level > 1 && level <= maxLevel).sort((a, b) => a - b);
  let previousLevel = 1;
  const steps = milestones.map((level) => {
    const step = {
      label: `Lv.${previousLevel} → ${level}`,
      items: [{ itemId: profile.cardKind === "support" ? "item-6" : "item-5", amount: expAt(level) - expAt(previousLevel) }]
    };
    previousLevel = level;
    return step;
  });
  if (steps.length) result.push({ key: "level", title: en ? "Level experience" : "等级经验", steps, total: totals(steps.flatMap((step) => step.items)) });
  const rankKind = profile.cardKind === "support" ? "support_rank" : "member_rank";
  const rank = profile.materialRequirements.filter((row) => row.usageKind === rankKind);
  if (rank.length) result.push(section("rank", en ? (profile.cardKind === "support" ? "Breakthrough" : "Awakening") : (profile.cardKind === "support" ? "突破" : "觉醒"), rank, (stage) => `${en ? (profile.cardKind === "support" ? "Breakthrough" : "Awakening") : (profile.cardKind === "support" ? "突破" : "觉醒")} ${stage - 1} → ${stage}`));
  const awake = profile.materialRequirements.filter((row) => row.usageKind === "member_awake");
  if (awake.length) result.push(section("awake", en ? "Breakthrough (training)" : "突破（特训）", awake, (stage) => `${en ? "Breakthrough (training)" : "突破（特训）"} ${stage - 2} → ${stage - 1}`));
  for (const ref of projection.skillRefs ?? []) {
    const materials = ref.materialRequirements ?? [];
    if (!materials.length) continue;
    const summary = projection.skillSummaries.find((entry) => entry.slot === ref.slot);
    const kind = ref.slot === "live" ? (en ? "Live skill" : "演出技能") : (en ? "Gekisou skill" : "激奏技能");
    result.push(section(`skill:${ref.slot}`, `${kind} · ${summary?.name ?? ref.skillId}`, materials, (stage) => `Lv.${stage - 1} → ${stage}`));
  }
  return result;
}
