import { createFormationCalculator } from "./scoring-rules/formation-power.mjs";
import { createFormalSongCalculator } from "./scoring-rules/formal-song-score.mjs";
import { createFormalSkillResolver } from "./scoring-rules/formal-skills.mjs";
import { createGekisouSongCalculator } from "./scoring-rules/gekisou-song-score.mjs";
import { maximumPairing, partitionPairing } from "./scoring-rules/maximum-pairing.mjs";
import { resolveSearchInput } from "./scoring-rules/formation-input.mjs";
import { stableSnapshotHash } from "./scoring-engine.mjs";

const emptySlots = () => Array.from({ length: 5 }, () => ({ memberCardId: null, supportCardId: null }));
const metric = { expected_song_score: "expectedScore", minimum_song_score: "minimumScore", maximum_song_score: "maximumScore" };
const keyOf = (m, s) => `${m}|${s}`;
const jobModels = new WeakMap();
export { gekisouPlacements } from "./scoring-rules/formation-placements.mjs";
import { createCandidateEvaluator } from "./formation-candidate-evaluator.mjs";
import { SearchQueue } from "./scoring-rules/search-queue.mjs";
import { createOrdinaryScoreBound } from '../../../packages/scoring/scoring-rules/ordinary-score-bound.mjs';

export function compareScoredFormations(candidate, baseline) {
  if (!baseline) return null;
  const delta = candidate.value - baseline.value;
  return { scoreDelta: delta, powerDelta: candidate.power - baseline.power,
    scoreChangePercent: baseline.value ? delta / baseline.value * 100 : null,
    powerChangePercent: baseline.power ? (candidate.power - baseline.power) / baseline.power * 100 : null,
    // These are differences between two WHOLE formations, not an attribution
    // of non-additive skill interactions to an individual card.
    powerSourceDeltas: Object.fromEntries(Object.entries(candidate.breakdown).map(([key, v]) => [key, v.total - (baseline.breakdown[key]?.total ?? 0)])),
    skillScoreGainDelta: candidate.skillScoreGain == null ? null : candidate.skillScoreGain - baseline.skillScoreGain,
    sectionDeltas: candidate.sections?.map((s, i) => ({ index: s.index,
      noteScore: s.noteScore - baseline.sections[i].noteScore,
      rankingBonus: s.rankingBonus - baseline.sections[i].rankingBonus,
      totalScore: s.totalScore - baseline.sections[i].totalScore })) ?? null };
}

/** Fixed leader makes the current ordinary power model additive over pairs.
 * Use the SAME native arithmetic as the calculator to obtain edge weights. */
function reweightModels(models, weight) {
  const changed = new WeakMap();
  return models.map(model => ({ leader: model.leader, edges: model.edges.map(edge => {
    if (!changed.has(edge)) changed.set(edge, { ...edge, weight: weight(edge) });
    return changed.get(edge);
  }) }));
}

export async function compilePairingModels(rules, input, { signal, yieldControl, onProgress, eventAdapters = [], pairCache, pairCacheKey, modelCache } = {}) {
  // A fresh token belongs to one optimizer call. Practical seeds and exact
  // refinement share immutable models without copying another full edge matrix.
  const modelKey = modelCache ? JSON.stringify(input) : null, saved = modelCache && jobModels.get(modelCache);
  if (saved?.rules === rules && saved.key === modelKey && saved.adapters.length === eventAdapters.length
    && saved.adapters.every((adapter,i) => adapter === eventAdapters[i])) {
    await yieldControl?.();
    return signal?.aborted ? null : saved.models;
  }
  const remember = models => {
    if (modelCache) jobModels.set(modelCache, { rules, key: modelKey, adapters: [...eventAdapters], models });
    return models;
  };
  const calculator = createFormationCalculator(rules, { eventAdapters }), members = input.inventory.memberCardIds, supports = input.inventory.supportCardIds;
  const memberRows = new Map(members.map((id) => [id, calculator.card(id, "member")]));
  const pairs = [];
  const evaluateSlot = (member, support, leader) => {
    const slots = emptySlots(), index = member === leader ? 2 : 0;
    if (leader) slots[2].memberCardId = leader;
    slots[index] = { memberCardId: member, supportCardId: support };
    return calculator.calculateSlot({ ...input.draft, slots }, index);
  };
  const cached=pairCacheKey==null?null:pairCache?.get(pairCacheKey);
  if(cached){
    const musicBonuses=new Map();
    for(const [i,member] of members.entries()){
      if(signal?.aborted)return null;
      const slot=evaluateSlot(member,null,null);
      musicBonuses.set(member,slot.breakdown.musicType.total+slot.breakdown.musicTag.total);
      onProgress?.({phase:'pair_weights',completed:i+1,total:members.length});await yieldControl?.();
    }
    return remember(reweightModels(cached.models, edge=>edge.weight+musicBonuses.get(edge.member)));
  }
  const musicBonuses=new Map();
  for (const [i, member] of members.entries()) {
    if (signal?.aborted) return null;
    for (const support of supports) {
      const slot=evaluateSlot(member,support,null);
      musicBonuses.set(member,slot.breakdown.musicType.total+slot.breakdown.musicTag.total);
      pairs.push({key:keyOf(member,support),member,support,character:memberRows.get(member)._characterID,weight:slot.total.total});
    }
    onProgress?.({ phase: "pair_weights", completed: i + 1, total: members.length });
    await yieldControl?.();
  }
  const leaders = input.constraints.leaderId ? [input.constraints.leaderId] : members;
  const models = [];
  // Most leaders give the same bonus to a given pair. Intern immutable edges
  // by their final integer weight instead of storing one object per leader.
  const variants = Array(pairs.length);
  for (const [i, leader] of leaders.entries()) {
    if (signal?.aborted) return null;
    const bonuses = new Map(members.filter((m) => m === leader || memberRows.get(m)._characterID !== memberRows.get(leader)._characterID)
      .map((member) => [member, evaluateSlot(member, null, leader).breakdown.leader.total]));
    const edges=[];
    for(let j=0;j<pairs.length;j++) {
      const edge=pairs[j], bonus=bonuses.get(edge.member);
      if(bonus===undefined)continue;
      if(bonus===0){edges.push(edge);continue;}
      const weight=edge.weight+bonus, byWeight=variants[j]??=new Map();
      let variant=byWeight.get(weight);
      if(!variant)byWeight.set(weight,variant={...edge,weight});
      edges.push(variant);
    }
    models.push({leader,edges});
    onProgress?.({ phase: "leader_weights", completed: i + 1, total: leaders.length });
    await yieldControl?.();
  }
  // Song/type bonuses use only the member base, independently of support and
  // leader. This optional job cache is only used with the audited event adapter.
  if(pairCacheKey!=null)pairCache?.set(pairCacheKey,{models:reweightModels(models,edge=>edge.weight-musicBonuses.get(edge.member))});
  return remember(models);
}

export function draftFromPairing(input, leader, edges) {
  const slots = emptySlots();
  const others = edges.filter((e) => e.member !== leader);
  const captain = edges.find((e) => e.member === leader);
  if (!captain) throw new Error("Matching omitted required leader");
  slots[2] = { memberCardId: captain.member, supportCardId: captain.support };
  for (const i of [0, 1, 3, 4]) {
    const e = others.shift(); slots[i] = { memberCardId: e.member, supportCardId: e.support };
  }
  return { ...structuredClone(input.draft), slots };
}

/** Search full candidate inventory. A budgeted result is explicitly incomplete.
 * Lawler subspaces partition the whole legal space; no top-K power prefilter. */
export async function optimizeInventory({ rules, draft, scope = "selected", inventory, constraints, theoreticalGrowth,
  chart, objective = "formation_power", mode = "ordinary", gekisouScenario, topN = 10, maxEvaluations = 500, checkpoint,
  signal, onProgress, evaluateBatch, batchSize = 1, yieldControl = () => new Promise((r) => setTimeout(r, 0)) }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 4) throw new Error("Invalid batch size");
  if (!Number.isInteger(topN) || topN < 1 || topN > 100) throw new Error("Invalid topN");
  if (!Number.isInteger(maxEvaluations) || maxEvaluations < 0) throw new Error("Invalid search budget");
  if (objective !== "formation_power" && !metric[objective]) throw new Error("Unknown optimizer objective");
  if (!["ordinary", "gekisou"].includes(mode)) throw new Error("Unknown performance mode");
  const input = resolveSearchInput(rules, draft, { scope, inventory, constraints, theoreticalGrowth });
  const calculator = createFormationCalculator(rules);
  const song = metric[objective] ? (mode === "gekisou" ? createGekisouSongCalculator(rules, chart, { scenario: gekisouScenario }) : createFormalSongCalculator(rules, chart)) : null;
  const inputHash = stableSnapshotHash({ input, objective, mode, scenario: song?.scenario, topN, chartHash: song?.timeline.chartHash,
    placementSearchVersion: 1, boundVersion: 4, ruleSetVersion: rules.ruleSetVersion, rulesHash: stableSnapshotHash(rules) });
  if (checkpoint && (checkpoint.inputHash !== inputHash || checkpoint.schemaVersion !== 1)) throw new Error("checkpoint input_mismatch");
  const models = await compilePairingModels(rules, input, { signal, yieldControl, onProgress });
  if (!models) return { status: "cancelled", results: [], evaluated: 0, warnings: [], optimality: "incomplete", upperBound: null, optimalityGap: null, topNComplete: false };
  const modelById = new Map(models.map((m) => [m.leader, m]));
  let factorBound = 1;
  const pairSkills = new Map();
  if (song) {
    const resolve = createFormalSkillResolver(rules), resolveJust = createFormalSkillResolver(rules, { judgement: 6 }), maxima = [];
    // Every start AND removal is bounded by adding the absolute command value.
    // This intentionally loose float32 bound covers rounding history after end.
    for (const member of input.inventory.memberCardIds) {
      let max = 0;
      for (const support of input.inventory.supportCardIds) {
        const skill = resolve({ slots: [{ memberCardId: member, supportCardId: support }], modifiers: input.draft.modifiers })[0];
        pairSkills.set(keyOf(member, support), skill);
        const effects = skill.liveEffects;
        const justEffects = mode === "gekisou" ? resolveJust({ slots: [{ memberCardId: member, supportCardId: support }], modifiers: input.draft.modifiers })[0].liveEffects : [];
        const sum = effects.filter((e, i) => e.active || justEffects[i]?.active).reduce((s, e) => s + Math.abs(Math.fround(Math.floor(Math.fround(e.rate * 100000)) / 100000)), 0);
        max = Math.max(max, sum);
      }
      maxima.push(max);
      await yieldControl();
    }
    // Ten starts/ends at most per currently supported member (two effects each).
    // Factor > any reachable sum, including a generous float32 rounding margin.
    factorBound = Math.fround((1 + 2 * maxima.sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0)) * 1.0001);
  }
  const boundCache = new Map();
  const ordinaryBound = song && mode === 'ordinary' ? createOrdinaryScoreBound({ song, pairSkills,
    legacyFactor: factorBound, input, metric: metric[objective] }) : null;
  const bound = (power) => {
    if (!song) return power;
    if (!boundCache.has(power)) {
      if (boundCache.size >= 8192) boundCache.delete(boundCache.keys().next().value);
      boundCache.set(power, song.upperBound(power, factorBound));
    }
    return boundCache.get(power);
  };
  const solve = (state) => {
    const model = modelById.get(state.leader);
    if (!model) throw new Error("Invalid checkpoint leader");
    const solution = maximumPairing({ edges: model.edges, required: state.required, forbidden: state.forbidden,
      requiredMembers: [...input.constraints.requiredMemberIds, state.leader], requiredSupports: input.constraints.requiredSupportIds });
    return solution ? { ...state, solution, upperBound: ordinaryBound
      ? ordinaryBound(state, model, solution, () => draftFromPairing(input, state.leader, solution.edges))
      : bound(solution.weight) } : null;
  };
  const required = input.constraints.lockedPairs.map((p) => keyOf(p.memberCardId, p.supportCardId));
  const tie = (a,b) => a.leader.localeCompare(b.leader)
    || JSON.stringify([a.required,a.forbidden]).localeCompare(JSON.stringify([b.required,b.forbidden]));
  // Preserve the previous power-first expansion order for short budgets. A
  // second heap tracks the certificate, independently of candidate priority.
  const priority = (a,b) => b.solution.weight-a.solution.weight || tie(a,b);
  const frontier = new SearchQueue((checkpoint?.frontier ?? models.map(m => ({leader:m.leader,required,forbidden:[]}))).map(solve).filter(Boolean), priority);
  let boundFrontier = new SearchQueue(frontier.snapshot(), (a,b) => b.upperBound-a.upperBound || priority(a,b));
  const active = new Set(frontier.snapshot());
  const push = state => { frontier.push(state); boundFrontier.push(state); active.add(state); };
  const remainingBound = () => {
    while (boundFrontier.length && !active.has(boundFrontier.peek())) boundFrontier.pop();
    // Discard buried stale entries so memory remains proportional to the live frontier.
    if (boundFrontier.length > 2 * active.size + 128)
      boundFrontier = new SearchQueue([...active], (a,b) => b.upperBound-a.upperBound || priority(a,b));
    return boundFrontier.peek()?.upperBound ?? 0;
  };
  const evaluator = createCandidateEvaluator({rules,chart,mode,objective,gekisouScenario},{calculator,song});
  const scoreDraft = evaluator.score;
  let baselineResult = null;
  try { baselineResult = scoreDraft(draft); } catch { /* A new inventory needs no preexisting full formation. */ }
  const baseline = baselineResult?.value ?? null;
  const withComparison = (value) => ({ ...value, comparison: compareScoredFormations(value, baselineResult) });
  const results = (checkpoint?.results ?? []).map((r) => ({ ...r, ...withComparison(scoreDraft(r.draft)) }));
  const resultSort = () => results.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  resultSort(); results.splice(topN);
  let evaluated = checkpoint?.evaluated ?? 0, runEvaluated = 0;
  const prune = () => {
    if (results.length === topN && remainingBound() <= results.at(-1).value) {
      frontier.clear(); boundFrontier.clear(); active.clear();
    }
  };
  prune();
  while (frontier.length && !signal?.aborted && (!maxEvaluations || runEvaluated < maxEvaluations)) {
    const states = [];
    const width = Math.min(batchSize, maxEvaluations ? maxEvaluations-runEvaluated : batchSize);
    while (states.length < width && frontier.length) {
      const state=frontier.pop(); active.delete(state);
      if (results.length === topN && state.upperBound <= results.at(-1).value) continue;
      states.push(state);
    }
    if (!states.length) break;
    const drafts = states.map(state => draftFromPairing(input,state.leader,state.solution.edges));
    const values = evaluateBatch ? await evaluateBatch(drafts) : await Promise.all(drafts.map(candidate => evaluator.evaluate(candidate, {
      signal,yieldControl,onProgress:p=>onProgress?.({...p,evaluated})
    })));
    if (!Array.isArray(values) || values.length !== states.length) throw new Error("Invalid candidate batch response");
    for (const [i,state] of states.entries()) {
      const value = values[i];
      // Every uncompleted subspace survives cancellation and can be resumed.
      if (!value) { if (!signal?.aborted) throw new Error("Candidate batch did not complete"); push(state); continue; }
      if (value.power !== state.solution.weight) throw new Error("Pairing model disagrees with native power calculator");
      if (value.value > state.upperBound) throw new Error("Search bound below evaluated candidate");
      const id = `${state.leader}:${state.solution.edges.map(e=>e.key).join(",")}`;
      results.push({id,...withComparison(value),delta:baseline==null?null:value.value-baseline});
      resultSort(); results.splice(topN);
      for (const child of partitionPairing(state,state.solution)) {
        const solved=solve({leader:child.leader,required:child.required,forbidden:child.forbidden});
        if(solved) push(solved);
      }
      evaluated++; runEvaluated++;
    }
    prune();
    onProgress?.({phase:"search",completed:evaluated,frontier:frontier.length,concurrency:batchSize,
      best:results[0]?.value??null,upperBound:Math.max(results[0]?.value??0,remainingBound()),
      // A small live preview, never the entire growing search frontier.
      bestCandidate:results[0]??null});
    await yieldControl();
  }
  const complete = frontier.length === 0;
  const upperBound = Math.max(results[0]?.value ?? 0, remainingBound());
  return { status: complete ? (results.length ? "completed" : "no_feasible_formation") : signal?.aborted ? "cancelled" : "budget_exhausted", objective, mode,
    searchScope: scope, inputHash, sourceReleaseId: rules.sourceReleaseId, ruleSetVersion: rules.ruleSetVersion,
    optimality: complete ? (results.length ? (mode === "gekisou" && song ? "best_within_simulation" : "proven_within_model") : "infeasible") : "incomplete", topNComplete: complete, upperBound,
    optimalityGap: results.length ? upperBound - results[0].value : null,
    evaluated, baseline, baselineResult, results, warnings: [...input.assumptions, ...(song?.timeline.warnings ?? [])],
    ...(complete ? {} : { checkpoint: { schemaVersion: 1, inputHash, evaluated,
      results: results.map(({ id, draft, delta }) => ({ id, draft, delta })),
      frontier: frontier.snapshot().map(({ leader, required, forbidden }) => ({ leader, required, forbidden })) } }) };
}
