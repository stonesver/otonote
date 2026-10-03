import { createFormationCalculator, requireInteger } from './formation-power.mjs';

const KINDS = ['member', 'support'];
const fields = kind => kind === 'member' ? ['level', 'rank', 'awake', 'skillLevel', 'gekisouSkillLevel'] : ['level', 'rank'];
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value;
};
const canonical = (value, kind) => {
  const match = new RegExp(`^(?:${kind}-(?:card-)?)?([0-9]+)$`).exec(String(value));
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Invalid ${kind} card: ${value}`);
  return `${kind}-card-${Number(match[1])}`;
};
const cardKind = id => {
  if (/^member-card-\d+$/.test(id)) return 'member';
  if (/^support-card-\d+$/.test(id)) return 'support';
  throw new Error(`Use a canonical member/support card id: ${id}`);
};
const bindVersion = (input, rules, name) => {
  object(input, name);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error(`Unsupported ${name} schema`);
  if (input.sourceReleaseId !== undefined && input.sourceReleaseId !== rules.sourceReleaseId) throw new Error(`${name} release_mismatch`);
};

/** Pure scenario normalization. Inventory is evidence of ownership, never mutated.
 * A complete actual record includes both member skill levels. Missing fields
 * can only enter calculations through an explicitly labelled reference policy. */
export function resolveGrowthScenario(rules, draft, options = {}) {
  const calculator = createFormationCalculator(rules);
  if (!Array.isArray(draft?.slots) || draft.slots.length !== 5) throw new Error('Exactly five slots required');
  bindVersion(options, rules, 'planning scenario');
  const scope = options.scope ?? 'selected';
  if (!['selected', 'owned', 'reference', 'trial'].includes(scope)) throw new Error('Unknown planning scope');
  const unknownGrowth = options.unknownGrowth ?? 'exclude';
  if (!['exclude', 'reference'].includes(unknownGrowth)) throw new Error('Unknown growth policy');
  const inventoryInput = options.inventory;
  if (inventoryInput) bindVersion(inventoryInput, rules, 'inventory');
  const normalizePool = (input = {}) => Object.fromEntries(KINDS.map(kind => {
    const ids = input[`${kind}CardIds`] ?? [];
    if (!Array.isArray(ids)) throw new Error(`Invalid ${kind} pool`);
    const normalized = [...new Set(ids.map(id => canonical(id, kind)))];
    normalized.forEach(id => calculator.card(id, kind));
    return [`${kind}CardIds`, normalized];
  }));
  const ownedPool = normalizePool(inventoryInput);
  const selectedPool = normalizePool(options.selectedCardIds ?? Object.fromEntries(KINDS.map(kind =>
    [`${kind}CardIds`, draft.slots.map(slot => slot[`${kind}CardId`]).filter(Boolean)])));
  const trialPool = normalizePool(options.trialCardIds);
  let pool;
  if (scope === 'owned') {
    if (!inventoryInput) throw new Error('请先填写已拥有的卡，或选择参考队伍');
    pool = ownedPool;
  } else if (scope === 'reference') {
    pool = normalizePool({ memberCardIds: rules.tables.MemberCard.map(r => r._id), supportCardIds: rules.tables.SupportCard.map(r => r._id) });
  } else if (scope === 'trial') {
    pool = normalizePool(Object.fromEntries(KINDS.map(kind => [`${kind}CardIds`, [
      ...ownedPool[`${kind}CardIds`], ...selectedPool[`${kind}CardIds`], ...trialPool[`${kind}CardIds`]]])));
  } else pool = selectedPool;

  const validateGrowth = (id, value, { complete = false } = {}) => {
    const kind = cardKind(id), validFields = fields(kind);
    object(value, `growth ${id}`);
    for (const [key, number] of Object.entries(value)) {
      if (!validFields.includes(key)) throw new Error(`Unsupported growth field ${id}: ${key}`);
      requireInteger(number, `${id} ${key}`, 1, key === 'level' ? 999 : 5);
    }
    if (complete && validFields.some(key => value[key] === undefined)) throw new Error(`Incomplete growth: ${id}`);
    const resolved = calculator.resolveGrowth(calculator.card(id, kind), kind === 'member' ? 'Member' : 'Support', value);
    return { level: resolved.level, rank: resolved.rank, ...(kind === 'member' ? {
      awake: resolved.awake, skillLevel: value.skillLevel ?? 1, gekisouSkillLevel: value.gekisouSkillLevel ?? 1 } : {}) };
  };
  const maximum = id => {
    const kind = cardKind(id), row = calculator.card(id, kind);
    const rank = Math.max(...rules.tables[kind === 'member' ? 'MemberCardRank' : 'SupportCardRank']
      .filter(r => r._group === row[`_${kind}CardRankGroup`]).map(r => r._rank));
    return validateGrowth(id, { rank, ...(kind === 'member' ? {
      awake: Math.max(...rules.tables.MemberCardLevelLimit.filter(r => r._rarity === row._rarity).map(r => r._awakeCount)),
      skillLevel: 5, gekisouSkillLevel: 5 } : {}) });
  };
  const referenceGrowth = options.referenceGrowth ?? (scope === 'reference' ? 'maximum' : {});
  if (referenceGrowth !== 'maximum') {
    object(referenceGrowth, 'reference growth');
    for (const key of Object.keys(referenceGrowth)) if (!KINDS.includes(key)) throw new Error(`Unknown reference kind: ${key}`);
    for (const kind of KINDS) if (referenceGrowth[kind]) object(referenceGrowth[kind], `reference ${kind}`);
  }
  const inputPlan = options.plan ?? { enabled: false };
  bindVersion(inputPlan, rules, 'growth plan');
  if (inputPlan.enabled !== undefined && typeof inputPlan.enabled !== 'boolean') throw new Error('Invalid plan enabled');
  const enabled = inputPlan.enabled ?? Boolean(options.plan);
  const mode = inputPlan.mode ?? 'current-cap';
  if (!['current-cap', 'target', 'maximum'].includes(mode)) throw new Error('Unknown growth plan mode');
  const maxTrainedCards = inputPlan.maxTrainedCards === undefined ? 10 : requireInteger(inputPlan.maxTrainedCards, 'maxTrainedCards', 0, 10);
  for (const key of ['skillLevel', 'gekisouSkillLevel']) if (inputPlan[key] !== undefined) requireInteger(inputPlan[key], key, 1, 5);
  const allIds = KINDS.flatMap(kind => pool[`${kind}CardIds`]);
  const allowedCardIds = inputPlan.allowedCardIds ?? allIds;
  if (!Array.isArray(allowedCardIds)) throw new Error('Invalid allowedCardIds');
  for (const id of allowedCardIds) calculator.card(id, cardKind(id));
  const allowed = new Set(allowedCardIds);
  const targets = inputPlan.targets ?? {};
  object(targets, 'growth targets');
  for (const [id, target] of Object.entries(targets)) {
    calculator.card(id, cardKind(id));
    object(target, `target ${id}`);
    for (const [key, number] of Object.entries(target)) {
      if (!fields(cardKind(id)).includes(key)) throw new Error(`Unsupported target field ${id}: ${key}`);
      requireInteger(number, `${id} ${key}`, 1, key === 'level' ? 999 : 5);
    }
  }
  const previousResult = draft.modifiers?.planningResult;
  if (previousResult) {
    bindVersion(previousResult, rules, 'saved planning result');
    object(previousResult.actualGrowth, 'saved actual growth');
  }
  // Reject invalid targets even when disabled, disallowed, or outside this
  // search pool; saved plans must not carry latent invalid game states.
  for (const [id, target] of Object.entries(targets)) {
    const raw = inventoryInput?.growth?.[id] ?? (previousResult
      ? previousResult.actualGrowth[id] : draft.modifiers?.growth?.[id]);
    const baseline = raw == null ? {} : raw;
    const proposed = { ...baseline };
    for (const [field, value] of Object.entries(target)) proposed[field] = Math.max(baseline[field] ?? 1, value);
    validateGrowth(id, proposed);
  }
  const currentDraft = structuredClone(draft), targetDraft = structuredClone(draft);
  for (const result of [currentDraft, targetDraft]) {
    result.modifiers ??= {};
    result.modifiers.growth = { ...result.modifiers.growth };
  }
  const cards = {}, excludedCardIds = [], normalizedTargets = { ...structuredClone(targets) };
  for (const id of allIds) {
    const kind = cardKind(id), owned = ownedPool[`${kind}CardIds`].includes(id);
    // Newly imported actual records take precedence over a saved scenario.
    const raw = inventoryInput?.growth?.[id] ?? (previousResult
      ? previousResult.actualGrowth?.[id] : draft.modifiers?.growth?.[id]);
    if (raw != null) validateGrowth(id, raw);
    const actualKnown = Boolean(raw && fields(kind).every(key => Number.isInteger(raw[key])));
    const actualGrowth = actualKnown ? validateGrowth(id, raw, { complete: true }) : null;
    const missingFields = fields(kind).filter(key => !Number.isInteger(raw?.[key]));
    const isTrial = scope === 'trial' && trialPool[`${kind}CardIds`].includes(id);
    const reference = scope === 'reference' || !actualKnown;
    if (!actualKnown && scope !== 'reference' && !isTrial && unknownGrowth === 'exclude') {
      excludedCardIds.push(id);
      continue;
    }
    if (enabled && maxTrainedCards < 10 && !actualKnown) {
      throw new Error(`限制培养张数前，请填写这些卡的实际养成：${id}`);
    }
    const currentGrowth = scope === 'reference' || !actualKnown
      ? referenceGrowth === 'maximum' ? maximum(id) : validateGrowth(id, { ...raw, ...referenceGrowth[kind] })
      : actualGrowth;
    let targetGrowth = { ...currentGrowth };
    if (enabled && allowed.has(id)) {
      if (mode === 'maximum') targetGrowth = maximum(id);
      else if (mode === 'current-cap') {
        const { level, ...atCurrentLimit } = currentGrowth;
        targetGrowth = validateGrowth(id, atCurrentLimit);
      }
      if (kind === 'member') for (const key of ['skillLevel', 'gekisouSkillLevel']) {
        if (inputPlan[key] !== undefined) targetGrowth[key] = Math.max(targetGrowth[key], inputPlan[key]);
      }
      // Targets already fulfilled after an import never downgrade actual growth.
      for (const [key, number] of Object.entries(targets[id] ?? {})) targetGrowth[key] = Math.max(currentGrowth[key], number);
      targetGrowth = validateGrowth(id, targetGrowth, { complete: true });
      normalizedTargets[id] = { ...targetGrowth };
    }
    const changes = actualKnown ? fields(kind).filter(key => targetGrowth[key] > actualGrowth[key])
      .map(field => ({ field, from: actualGrowth[field], to: targetGrowth[field] })) : [];
    const referenceChanges = fields(kind).filter(key => targetGrowth[key] > currentGrowth[key])
      .map(field => ({ field, from: currentGrowth[field], to: targetGrowth[field] }));
    cards[id] = { id, kind, ownership: owned ? 'owned' : 'unknown', actualKnown, actualGrowth,
      currentGrowth, targetGrowth, reference, missingFields, changes, referenceChanges,
      needsTraining: actualKnown && changes.length > 0, trainingUnknown: !actualKnown };
    currentDraft.modifiers.growth[id] = { ...currentGrowth };
    targetDraft.modifiers.growth[id] = { ...targetGrowth };
  }
  const inventory = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId,
    ...Object.fromEntries(KINDS.map(kind => [`${kind}CardIds`, pool[`${kind}CardIds`].filter(id => cards[id])])) };
  const plan = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId, enabled, mode,
    allowedCardIds: [...allowed], maxTrainedCards, targets: normalizedTargets,
    ...(inputPlan.skillLevel === undefined ? {} : { skillLevel: inputPlan.skillLevel }),
    ...(inputPlan.gekisouSkillLevel === undefined ? {} : { gekisouSkillLevel: inputPlan.gekisouSkillLevel }) };
  const planningScenario = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId, scope,
    unknownGrowth, selectedCardIds: selectedPool, trialCardIds: trialPool, referenceGrowth: structuredClone(referenceGrowth), plan };
  const actualGrowth = Object.fromEntries(Object.values(cards).map(card => [card.id, card.actualGrowth]));
  for (const result of [currentDraft, targetDraft]) {
    result.modifiers.planningScenario = structuredClone(planningScenario);
    result.modifiers.planningResult = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId, actualGrowth: structuredClone(actualGrowth) };
  }
  const assumptions = [
    ...(scope === 'reference' ? ['参考队伍不代表已经持有；养成与账号条件以本次填写值为准。'] : []),
    ...(Object.values(cards).some(c => c.reference) ? ['部分卡片使用参考养成，不能据此计算相对实际卡库的提升。'] : []),
    ...(excludedCardIds.length ? [`已排除 ${excludedCardIds.length} 张养成资料不完整的卡。`] : []),
    ...(enabled ? ['培养张数同时计算成员与留影；不代表材料消耗或材料足够。'] : []),
    ...(enabled && mode === 'maximum' ? ['全满养成包含突破与觉醒，只作为明确选择的目标参考。'] : [])
  ];
  return { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId, scope, currentDraft, targetDraft,
    inventory, cards, plan, planningScenario, assumptions, excludedCardIds };
}

/** Candidate preparation never treats a reference baseline as actual. */
export function prepareGrowthCandidate(rules, scenario, candidateDraft, { trainedCardIds } = {}) {
  bindVersion(scenario, rules, 'resolved growth scenario');
  if (!Array.isArray(candidateDraft?.slots) || candidateDraft.slots.length !== 5) throw new Error('Exactly five slots required');
  const calculator = createFormationCalculator(rules);
  const memberCharacters = candidateDraft.slots.map(slot => calculator.card(slot.memberCardId, 'member')._characterID);
  const supports = candidateDraft.slots.map(slot => canonical(slot.supportCardId, 'support'));
  if (new Set(memberCharacters).size !== 5 || new Set(supports).size !== 5) throw new Error('候选需要五位不同角色及五张不同留影');
  const ids = [...new Set(candidateDraft.slots.flatMap(slot => KINDS.map(kind => canonical(slot[`${kind}CardId`], kind))))];
  const selected = trainedCardIds === undefined ? null : new Set(trainedCardIds);
  if (selected) for (const id of selected) if (!scenario.cards[id]) throw new Error(`Unknown trained card ${id}`);
  const targetDraft = structuredClone(candidateDraft), baselineDraft = structuredClone(candidateDraft);
  for (const result of [targetDraft, baselineDraft]) result.modifiers = { ...result.modifiers, growth: { ...result.modifiers?.growth } };
  const changedCards = [], referenceCardIds = [], unknownOwnershipIds = [], pendingTrainingUnknownIds = [];
  for (const id of ids) {
    const card = scenario.cards[id];
    if (!card) throw new Error(`Candidate card outside scenario: ${id}`);
    const train = selected === null || selected.has(id);
    const target = train ? card.targetGrowth : card.currentGrowth;
    targetDraft.modifiers.growth[id] = { ...target };
    baselineDraft.modifiers.growth[id] = { ...(card.actualGrowth ?? card.currentGrowth) };
    const changes = card.actualKnown ? fields(card.kind).filter(field => target[field] > card.actualGrowth[field])
      .map(field => ({ field, from: card.actualGrowth[field], to: target[field] })) : [];
    if (changes.length) changedCards.push({ id, kind: card.kind, changes });
    if (card.reference) referenceCardIds.push(id);
    if (!card.actualKnown) pendingTrainingUnknownIds.push(id);
    if (card.ownership !== 'owned') unknownOwnershipIds.push(id);
  }
  if (scenario.plan.enabled && changedCards.length > scenario.plan.maxTrainedCards) throw new Error('培养卡数超过限制');
  const actualAvailable = ids.every(id => scenario.cards[id].actualKnown) && scenario.scope !== 'reference';
  const comparison = { actualAvailable, actualTeamAvailable: actualAvailable && unknownOwnershipIds.length === 0,
    trainedCardCount: changedCards.length, changedCards, referenceCardIds, unknownOwnershipIds,
    pendingTrainingUnknownIds, trainingCountComplete: pendingTrainingUnknownIds.length === 0,
    materialEstimateAvailable: false };
  targetDraft.modifiers.planningScenario = structuredClone(scenario.planningScenario);
  targetDraft.modifiers.planningResult = { schemaVersion: 1, sourceReleaseId: rules.sourceReleaseId,
    actualGrowth: Object.fromEntries(ids.map(id => [id, structuredClone(scenario.cards[id].actualGrowth)])), ...comparison };
  return { actualDraft: actualAvailable ? baselineDraft : null, baselineDraft, targetDraft, comparison,
    assumptions: [...scenario.assumptions] };
}

const choose = (n, k) => {
  let result = 1n;
  for (let i = 1; i <= k; i++) result = result * BigInt(n - i + 1) / BigInt(i);
  return result;
};
function* subsets(ids, size, start = 0, prefix = []) {
  if (!size) { yield prefix; return; }
  for (let index = start; index <= ids.length - size; index++) yield* subsets(ids, size - 1, index + 1, [...prefix, ids[index]]);
}

/** Enumerate feasible growth assignments BEFORE an optimizer's power prefilter.
 * Every card stays in the pool in every variant; only a permitted subset is
 * raised. Callers must report incomplete coverage when using offset/limit. */
export function createGrowthSearchVariants(scenario, { offset = 0, limit = Number.MAX_SAFE_INTEGER } = {}) {
  requireInteger(offset, 'variant offset', 0, Number.MAX_SAFE_INTEGER);
  requireInteger(limit, 'variant limit', 0, Number.MAX_SAFE_INTEGER);
  const trainable = scenario.plan.enabled ? Object.values(scenario.cards)
    .filter(card => card.needsTraining || card.referenceChanges.length > 0).map(card => card.id) : [];
  const count = Math.min(scenario.plan.maxTrainedCards, trainable.length);
  // A ten-card team cannot exceed this budget. Keep both current and target
  // searches because skill value is not guaranteed monotone with its level.
  const unbounded = scenario.plan.enabled && scenario.plan.maxTrainedCards === 10;
  const total = unbounded ? (trainable.length ? 2n : 1n) : Array.from({ length: count + 1 }, (_, k) => choose(trainable.length, k)).reduce((a, b) => a + b, 0n);
  const totalCount = total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
  return { totalCount, totalCountExact: String(total), offset, limit,
    truncated: BigInt(offset) > 0n || BigInt(offset) + BigInt(limit) < total,
    *[Symbol.iterator]() {
      let index = 0, emitted = 0;
      const selections = unbounded ? (trainable.length ? [[], trainable] : [[]]) : (function* () {
        for (let size = 0; size <= count; size++) yield* subsets(trainable, size);
      })();
      for (const trainedCardIds of selections) {
        if (index++ < offset) continue;
        if (emitted++ >= limit) break;
        const draft = structuredClone(scenario.currentDraft);
        for (const id of trainedCardIds) draft.modifiers.growth[id] = { ...scenario.cards[id].targetGrowth };
        yield { index: index - 1, draft, inventory: structuredClone(scenario.inventory), trainedCardIds };
      }
    }
  };
}
