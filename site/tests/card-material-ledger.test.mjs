import assert from "node:assert/strict";
import test from "node:test";
import { createCardMaterialLedger } from "../src/lib/card-material-ledger.mjs";

const cost = (usageKind, itemId, amount, stage) => ({ usageKind, itemId, amount, stage });
const profile = {
  cardKind: "member", levelCurve: [{ level: 1, rawExp: 0 }, { level: 30, rawExp: 100 }, { level: 40, rawExp: 250 }],
  ranks: [{ rank: 1 }, { rank: 2 }], levelLimits: [{ limitLevel: 30 }, { limitLevel: 40 }],
  materialRequirements: [cost("member_rank", "item-10", 60, 2), cost("member_awake", "item-3", 10000, 2)]
};
const projection = {
  growthSummary: { maxLevel: 40 },
  skillSummaries: [{ slot: "live", name: "得分UP" }, { slot: "gekisou", name: "抽选条UP" }],
  skillRefs: [
    { slot: "live", skillId: "live-1", materialRequirements: [cost("skill_level", "item-3", 10000, 2), cost("skill_level", "item-24", 10, 2)] },
    { slot: "gekisou", skillId: "gekisou-1", materialRequirements: [cost("skill_level", "item-3", 10000, 2), cost("skill_level", "item-25", 10, 2)] }
  ]
};

test("separates two skills at the same level instead of merging their coins", () => {
  const ledger = createCardMaterialLedger({ profile, projection });
  assert.deepEqual(ledger.map((section) => section.key), ["level", "rank", "awake", "skill:live", "skill:gekisou"]);
  assert.deepEqual(ledger[3].total, [{ itemId: "item-3", amount: 10000 }, { itemId: "item-24", amount: 10 }]);
  assert.deepEqual(ledger[4].total, [{ itemId: "item-3", amount: 10000 }, { itemId: "item-25", amount: 10 }]);
  assert.equal(ledger[2].steps[0].label, "突破（特训） 0 → 1");
  assert.equal(ledger[1].steps[0].label, "觉醒 1 → 2");
});
test("level milestones are incremental costs and do not double count cumulative experience", () => {
  const [level] = createCardMaterialLedger({ profile, projection });
  assert.deepEqual(level.steps.map((step) => step.items[0].amount), [100, 150]);
  assert.deepEqual(level.total, [{ itemId: "item-5", amount: 250 }]);
});
test("support rank materials stay separate from level experience with no independent skill costs", () => {
  const support = { ...profile, cardKind: "support", ranks: [{ rank: 1, limitLevel: 30 }, { rank: 2, limitLevel: 40 }], materialRequirements: [cost("support_rank", "item-20000001", 1, 2)] };
  const ledger = createCardMaterialLedger({ profile: support, projection: { ...projection, skillRefs: [] } });
  assert.deepEqual(ledger.map((section) => section.key), ["level", "rank"]);
  assert.deepEqual(ledger[0].total, [{ itemId: "item-6", amount: 250 }]);
  assert.deepEqual(ledger[1].total, [{ itemId: "item-20000001", amount: 1 }]);
});
