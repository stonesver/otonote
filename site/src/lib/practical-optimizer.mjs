import { resolveSearchInput } from './scoring-rules/formation-input.mjs';
import { createFormationCalculator } from './scoring-rules/formation-power.mjs';
import { createFormalSkillResolver } from './scoring-rules/formal-skills.mjs';
import { pairingProfileBound } from './scoring-rules/pairing-bound.mjs';
import { maximumPairing } from './scoring-rules/maximum-pairing.mjs';
import { compilePairingModels, draftFromPairing, compareScoredFormations } from './inventory-optimizer.mjs';
import { createEventPipeline } from './scoring-rules/event-rules.mjs';
import { createCandidateEvaluator } from './formation-candidate-evaluator.mjs';
import { compileGekisouEffects } from '../../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';
import { skillMechanismIssue } from '../../../packages/scoring/scoring-rules/skill-mechanism-error.mjs';

const signature = draft => draft.slots.map(s => `${s.memberCardId}|${s.supportCardId}`).join(';');
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
export const PRACTICAL_PLAN = Object.freeze({ version: 1, localRounds: 1, screenOrders: 10, finalists: 6, finalOrders: 120 });
export const PRACTICAL_SEARCH_WARNINGS = Object.freeze([
  '实用推荐采用多方向起点和一轮局部粗筛，不穷举卡库，不保证全局或局部最优。',
  '粗筛中的技能特征不是分数；只有最终复算的队伍会作为推荐结果。',
  '快速模拟使用 10 种均衡技能顺序；最终使用全部 120 种。仅检查有限站位，不枚举全部 24 种站位。'
]);

// Overlapping two-standard-error intervals are a caution, not a probability
// that either team is best. Pairing correlations and model errors are unknown.
export function scoreCloseness(first, second, objective = 'expected_song_score') {
  if (!first || !second || objective !== 'expected_song_score') return null;
  const gap = Math.abs(first.value - second.value);
  if (!Number.isFinite(first.standardError) || !Number.isFinite(second.standardError)) return { kind: 'unknown', gap };
  const margin = 2 * (first.standardError + second.standardError);
  return { kind: gap <= margin ? 'close' : 'separated', gap, margin };
}

export function legalPracticalDraft(draft, input, characterFor, windowFor = () => false, maxWindowCards = 1) {
  const slots = draft.slots;
  if (slots.length !== 5 || slots.some(s => !input.inventory.memberCardIds.includes(s.memberCardId) || !input.inventory.supportCardIds.includes(s.supportCardId))) return false;
  if (new Set(slots.map(s => characterFor(s.memberCardId))).size !== 5 || new Set(slots.map(s => s.supportCardId)).size !== 5) return false;
  const c = input.constraints;
  return (!c.leaderId || slots[2].memberCardId === c.leaderId)
    && c.requiredMemberIds.every(id => slots.some(s => s.memberCardId === id))
    && c.requiredSupportIds.every(id => slots.some(s => s.supportCardId === id))
    && c.lockedPairs.every(pair => slots.some(s => s.memberCardId === pair.memberCardId && s.supportCardId === pair.supportCardId))
    && slots.filter(s => windowFor(s.supportCardId)).length <= maxWindowCards;
}

/** One fixed pass around each seed. Neighbours are feature-screened, not all
 * fully simulated, and the winner is not fed back into an unbounded loop. */
export function* practicalNeighbours(draft, inventory) {
  const change = (kind, edit) => { const next = { ...draft, slots: draft.slots.map(s => ({ ...s })) }; edit(next.slots); return { kind, draft: next }; };
  for (let slot = 0; slot < 5; slot++) {
    for (const id of inventory.memberCardIds) if (id !== draft.slots[slot].memberCardId)
      yield change('member', slots => { slots[slot].memberCardId = id; });
    for (const id of inventory.supportCardIds) if (id !== draft.slots[slot].supportCardId)
      yield change('support', slots => { slots[slot].supportCardId = id; });
  }
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++)
    yield change('pairing', slots => { [slots[a].supportCardId, slots[b].supportCardId] = [slots[b].supportCardId, slots[a].supportCardId]; });
  for (const slot of [0, 1, 3, 4]) yield change('leader', slots => { [slots[2], slots[slot]] = [slots[slot], slots[2]]; });
}

export async function optimizePractical({ rules, draft, scope = 'selected', inventory, constraints = {}, theoreticalGrowth, chart,
  mode = 'ordinary', objective = 'expected_song_score', gekisouScenario = {}, performanceScenario, maxWindowCards = 1, resultLimit = 3, eventAdapters = [], extraProfiles = [], transformScore = value => value, compareCandidates = (a,b) => b.value-a.value, finalistLimit = PRACTICAL_PLAN.finalists, retainedOrigins = [], candidateCache, candidateCacheKey, pairCache, pairCacheKey, modelCache, scoreCache, signal, onProgress = () => {}, yieldControl = pause }) {
  if(!Number.isInteger(finalistLimit)||finalistLimit<2||finalistLimit>24)throw Error('Invalid finalist limit');
  if(!Number.isInteger(maxWindowCards)||maxWindowCards<0||maxWindowCards>5)throw Error('扩窗卡上限应为 0–5');
  if(!Number.isInteger(resultLimit)||resultLimit<1||resultLimit>24)throw Error('Invalid result limit');
  const input = resolveSearchInput(rules, draft, { scope, inventory, constraints, theoreticalGrowth });
  if (!['ordinary', 'gekisou'].includes(mode)) throw new Error('演出模式无效');
  const stages = [{ id: 'prepare', label: '准备卡片与技能', completed: 0, total: null },
    { id: 'seeds', label: '生成不同配队起点', completed: 0, total: null },
    { id: 'neighbours', label: '检查一轮换卡与配对', completed: 0, total: null },
    { id: 'screen', label: '快速模拟候选', completed: 0, total: null },
    { id: 'final', label: '完整复算领先队伍', completed: 0, total: null }];
  const report = { plan: {...PRACTICAL_PLAN, finalists: finalistLimit}, stages, directions: [], neighbourChecks: 0, neighbourGenerated: 0, screened: 0, finalists: 0, scoreCacheHits: 0, scoreCalculations: 0, unsupportedPairs: [], unsupportedCandidates: [] };
  const results = [], warnings = [...input.assumptions, ...PRACTICAL_SEARCH_WARNINGS];
  let baselineResult = null;
  const result = status => ({ status, searchMethod: 'practical', objective, searchScope: scope, mode,
    sourceReleaseId: rules.sourceReleaseId, ruleSetVersion: rules.ruleSetVersion,
    optimality: status === 'completed' && !report.unsupportedPairs.length && !report.unsupportedCandidates.length ? 'practical_checked' : 'incomplete', evaluated: report.finalists,
    results: [...results].sort(compareCandidates).slice(0, resultLimit), baseline: baselineResult?.value ?? null,
    baselineResult, warnings: [...warnings, ...(report.unsupportedPairs.length || report.unsupportedCandidates.length
      ? [`部分卡片配对含尚未实现的计分机制，已跳过 ${report.unsupportedPairs.length} 个配对、${report.unsupportedCandidates.length} 个候选；推荐仅覆盖可完整计算的队伍。`] : [])],
    scoringCoverage: { complete: !report.unsupportedPairs.length && !report.unsupportedCandidates.length,
      unsupportedPairs: report.unsupportedPairs, unsupportedCandidates: report.unsupportedCandidates },
    practical: structuredClone(report), checkpoint: null,
    closeness: mode === 'gekisou' ? scoreCloseness([...results].sort(compareCandidates)[0], [...results].sort(compareCandidates)[1], objective) : null });
  const update = (index, completed, total) => {
    Object.assign(stages[index], { completed, total });
    onProgress({ phase: 'practical', stage: stages[index].label, completed, total, stages: structuredClone(stages) });
  };
  // Explicit job-scoped key: the caller must include every preparation input.
  // Only candidate slots are reused; each chart is screened and fully rescored.
  let prepared = candidateCacheKey == null ? null : candidateCache?.get(candidateCacheKey);
  if (prepared) {
    Object.assign(report,structuredClone(prepared.report),{candidateCacheHit:true});
  } else {
    const candidates=await prepareCandidates({rules,input,mode,maxWindowCards,eventAdapters,extraProfiles,pairCache,pairCacheKey,modelCache,signal,yieldControl,update,report,objective,performanceScenario});
    if(!candidates||signal?.aborted)return result('cancelled');
    prepared={...candidates,report:{directions:report.directions,neighbourChecks:report.neighbourChecks,neighbourGenerated:report.neighbourGenerated,unsupportedPairs:report.unsupportedPairs}};
    if(candidateCacheKey!=null)candidateCache?.set(candidateCacheKey,structuredClone(prepared));
    report.candidateCacheHit=false;
  }
  const missions=prepared.missions;
  const screenDrafts = new Map(prepared.rows.map((c,i)=>[i,{...c,draft:{...input.draft,slots:structuredClone(c.slots)},origins:new Set(c.origins)}]));
  // Caller owns a cache bound to the exact rules, chart and personal inputs.
  // Cache only raw simulation values: reward transforms always run afresh.
  const evaluators = new Map();
  const rawScore = (draft, precision) => {
    const key=precision+':'+signature(draft);
    if(scoreCache?.has(key)){report.scoreCacheHits++;return scoreCache.get(key);}
    if(!evaluators.has(precision))evaluators.set(precision,createCandidateEvaluator({rules,chart,mode,objective,eventAdapters,performanceScenario,scorePrecision:precision,
      gekisouScenario:{...gekisouScenario,batches:precision==='screen'?1:Math.max(2,gekisouScenario.batches??1)}}));
    let value;
    try { value=evaluators.get(precision).score(draft); }
    catch (error) {
      const issue = skillMechanismIssue(error);
      report.unsupportedCandidates.push({ ...issue, slots: draft.slots });
      return null;
    }
    report.scoreCalculations++;scoreCache?.set(key,value);return value;
  };
  const screened = [];
  for (const candidate of screenDrafts.values()) {
    if (signal?.aborted) return result('cancelled');
    const value = rawScore(candidate.draft,'screen');
    if (value) screened.push({ ...candidate, ...transformScore(value,candidate.draft) }); report.screened++;
    update(3, report.screened, screenDrafts.size); await yieldControl();
  }
  screened.sort(compareCandidates);
  // Reserve representation for each relevant mission and the single-window
  // alternative, then fill by screening score. Final order is ALWAYS rescored.
  const finalists = [], seen = new Set();
  const choose = c => { if (c && !seen.has(signature(c.draft)) && finalists.length < finalistLimit) { seen.add(signature(c.draft)); finalists.push(c); } };
  choose(screened[0]);
  if(performanceScenario)choose([...screened].sort((a,b)=>(b.scoreDistribution?.p10??b.minimumScore??b.value)-(a.scoreDistribution?.p10??a.minimumScore??a.value))[0]);
  // Always retain the current legal team so screening cannot recommend a
  // strictly worse replacement under the final scoring model.
  choose(screened.find(c => c.origins.has('current')));
  for (const id of [...retainedOrigins, ...missions.map(t => `mission-${t}`), ...(missions.includes(3) ? ['window'] : [])]) choose(screened.find(c => c.origins.has(id)));
  for (const c of screened) choose(c);
  if (screened.some(c=>c.origins.has('current'))) {
    const value = rawScore(input.draft,'full');
    if (value) baselineResult = { ...transformScore(value,input.draft), draft: input.draft };
    await yieldControl();
  }
  for (const candidate of finalists) {
    if (signal?.aborted) return result('cancelled');
    const raw = baselineResult && signature(candidate.draft) === signature(input.draft) ? baselineResult : rawScore(candidate.draft,'full');
    if (!raw) continue;
    const value = raw === baselineResult ? baselineResult : { ...transformScore(raw,candidate.draft), draft: candidate.draft };
    results.push({ ...value, id: signature(candidate.draft), origins: [...candidate.origins],
      delta: baselineResult ? value.value - baselineResult.value : null, comparison: compareScoredFormations(value, baselineResult) });
    report.finalists++; update(4, report.finalists, finalists.length);
    onProgress({ phase: 'practical-result', bestCandidate: [...results].sort(compareCandidates)[0] }); await yieldControl();
  }
  if (signal?.aborted) return result('cancelled');
  return result('completed');
}

async function prepareCandidates({rules,input,mode,maxWindowCards,eventAdapters,extraProfiles,pairCache,pairCacheKey,modelCache,signal,yieldControl,update,report,objective,performanceScenario}) {
  const calculator = createFormationCalculator(rules, { eventAdapters }), members = new Map(rules.tables.MemberCard.map(r => [`member-card-${r._id}`, r]));
  const supports = new Map(rules.tables.SupportCard.map(r => [`support-card-${r._id}`, r]));
  const characterFor = id => members.get(id)._characterID;
  const memberSkills = new Map(rules.tables.GekisouSkill.map(r => [r._id, r._gekisouMissionType]));
  const supportSkills = new Map(rules.tables.GekisouSupportSkill.map(r => [r._id, r._gekisouMissionType]));
  const maxima = new Map();
  for (const e of [...rules.tables.GekisouSkillEffect, ...rules.tables.GekisouSupportSkillEffect])
    maxima.set(e._skillEffectType, Math.max(maxima.get(e._skillEffectType) ?? 1, Math.abs(e._effectValue)));
  const memberFeatures = new Map(), supportFeatures = new Map();
  const effectFeatures = effects => {
    const result = { window: false, missions: [0, 0, 0, 0] };
    for (const { mission, effect } of effects) {
      if (effect._skillEffectType === 4004) result.window = true;
      // Counts/percentages are normalized separately by effect type. This is
      // a diversity feature, not a conversion from task quantities to points.
      if ([1, 2, 3].includes(mission) && ![12004, 12006, 4004].includes(effect._skillEffectType))
        result.missions[mission] += 0.5 + Math.abs(effect._effectValue) / maxima.get(effect._skillEffectType);
    }
    return result;
  };
  for (const id of input.inventory.memberCardIds) {
    const card = members.get(id), level = input.draft.modifiers.growth?.[id]?.gekisouSkillLevel ?? 1;
    memberFeatures.set(id, effectFeatures(rules.tables.GekisouSkillEffect.filter(e => e._gekisouSkillID === card._gekisouSkillID && e._level === level)
      .map(effect => ({ mission: memberSkills.get(card._gekisouSkillID), effect }))));
  }
  for (const id of input.inventory.supportCardIds) {
    const card = supports.get(id), rank = calculator.resolveGrowth(card, 'Support', input.draft.modifiers.growth?.[id]).rankRow;
    supportFeatures.set(id, effectFeatures([1, 2].flatMap(i => rules.tables.GekisouSupportSkillEffect
      .filter(e => e._gekisouSupportSkillID === card[`_gekisouSupportSkillId0${i}`] && e._level === rank[`_gekisouSupportSkill0${i}Level`])
      .map(effect => ({ mission: supportSkills.get(card[`_gekisouSupportSkillId0${i}`]), effect })))));
  }
  const isWindow = id => mode === 'gekisou' && supportFeatures.get(id)?.window;
  const legal = d => legalPracticalDraft(d,input,characterFor,isWindow,maxWindowCards) && d.slots.every(s => features.has(`${s.memberCardId}|${s.supportCardId}`));
  const memberCount = input.inventory.memberCardIds.length;
  let leaderCount = input.constraints.leaderId ? 1 : memberCount;
  let models = await compilePairingModels(rules, input, { signal, yieldControl, eventAdapters, pairCache, pairCacheKey, modelCache,
    onProgress: p => {
      if (p.phase === 'leader_weights') leaderCount = p.total;
      update(0, p.completed + (p.phase === 'leader_weights' ? memberCount : 0), 2 * memberCount + leaderCount);
    } });
  if (!models || signal?.aborted) return null;
  const resolver = createFormalSkillResolver(rules), features = new Map();
  const dynamicResolver = performanceScenario ? createFormalSkillResolver(rules, { dynamic: true }) : null;
  const music = createEventPipeline(rules, input.draft.modifiers.event, eventAdapters).apply('song_context',
    rules.tables.LiveMusic.find(m => `music-${m._id}` === input.draft.selectedSongId), { draft: input.draft });
  const missions = mode === 'gekisou' ? [...new Set([1, 2, 3].map(i => music?.[`_gekisouMission${i}`]))].filter(m => [1, 2, 3].includes(m)) : [];
  // Include all pairs, even those excluded by the first leader's character.
  for (const [index, m] of input.inventory.memberCardIds.entries()) {
    if (signal?.aborted) return null;
    for (const s of input.inventory.supportCardIds) {
      const pair = { slots: [{ memberCardId: m, supportCardId: s }], modifiers: input.draft.modifiers };
      let skill;
      try {
        // Power-only work does not depend on any skill execution capability.
        if (objective === 'formation_power') skill = { liveEffects: [], extensionMs: 0 };
        else {
          skill = resolver(pair)[0]; dynamicResolver?.(pair);
          if (mode === 'gekisou') compileGekisouEffects(rules, pair, Boolean(performanceScenario), missions);
        }
      } catch (error) {
        report.unsupportedPairs.push({ memberCardId: m, supportCardId: s, ...skillMechanismIssue(error) });
        continue;
      }
      features.set(`${m}|${s}`, { live: skill.liveEffects.filter(e => e.active).reduce((n, e) => n + e.rate * e.durationMs / 1000, 0),
        extension: skill.extensionMs / 1000, attribute: members.get(m)._cardType === music?._musicType ? 1 : 0,
        missions: [0, 1, 2, 3].map(t => memberFeatures.get(m).missions[t] + supportFeatures.get(s).missions[t]) });
    }
    update(0, memberCount + leaderCount + index + 1, 2 * memberCount + leaderCount);
    await yieldControl();
  }
  // Exclude before seed generation so an unsupported high-power card cannot
  // occupy every seed and hide otherwise valid alternatives. Keep constraints.
  models = models.map(model => ({ ...model, edges: model.edges.filter(e => features.has(e.key)) }));
  const scale = Math.max(1, ...models[0].edges.map(e => e.weight));
  const featureMax = field => Math.max(1, ...[...features.values()].map(f => f[field]));
  const liveMax = featureMax('live'), extensionMax = featureMax('extension');
  const missionMax = [0, 1, 2, 3].map(t => Math.max(1, ...[...features.values()].map(f => f.missions[t])));
  const requiredWindows = [...new Set([...input.constraints.requiredSupportIds, ...input.constraints.lockedPairs.map(p => p.supportCardId)])].filter(isWindow);
  const profiles = [{ id: 'power', label: '综合力', feature: () => 0 },
    { id: 'live', label: '普通加分技能', feature: f => f.live / liveMax },
    ...(mode === 'ordinary' ? [{ id: 'extension', label: '留影延时', feature: f => f.extension / extensionMax }] : []),
    { id: 'attribute', label: '歌曲同属性', feature: f => f.attribute },
    ...missions.map(t => ({ id: `mission-${t}`, label: `${['', 'COMBO', 'LUCK', 'JUST'][t]} 技能${t === 3 ? (requiredWindows.length ? ' · 保留必选判卡' : ' · 无判卡') : ''}`, feature: f => f.missions[t] / missionMax[t] })),
    ...(missions.includes(3) && maxWindowCards ? [{ id: 'window', label: 'JUST · 判定改善', window: true, feature: f => f.missions[3] / missionMax[3] }] : []),
    ...(missions.includes(3) && maxWindowCards>1 ? [{id:'window-combination',label:'JUST · 多张扩窗搭配',allWindows:true,feature:f=>f.missions[3]/missionMax[3]}] : []), ...extraProfiles];
  if (requiredWindows.length > maxWindowCards) throw new Error('必选扩窗卡超过本次设置的上限，请调整配队条件。');
  const seedRows = [], screenDrafts = new Map();
  const add = (d, profile, kind) => { if (legal(d)) { const key = signature(d); const existing = screenDrafts.get(key);
    if (existing) existing.origins.add(profile.id); else screenDrafts.set(key, { draft: d, origins: new Set([profile.id]), kind }); } };
  const modelMaps = new Map(), modelsByLeader = new Map(models.map(m => [m.leader, m]));
  const weightsFor = leader => {
    if (!modelMaps.has(leader)) modelMaps.set(leader, new Map(modelsByLeader.get(leader)?.edges.map(e => [e.key, e]) ?? []));
    return modelMaps.get(leader);
  };
  const proxy = (d, profile) => d.slots.reduce((sum, slot) => { const key = `${slot.memberCardId}|${slot.supportCardId}`;
    return sum + (profile.powerWeight??1)*(weightsFor(d.slots[2].memberCardId).get(key)?.weight ?? -1e12) + scale * (profile.featureWeight??0.4) * profile.feature(features.get(key),slot); }, 0);
  for (const [index, profile] of profiles.entries()) {
    if (signal?.aborted) return null;
    const featureWeights = new Map([...features].map(([key, feature]) => {
      const [memberCardId,supportCardId] = key.split('|');
      return [key, scale * (profile.featureWeight??0.4) * profile.feature(feature,{memberCardId,supportCardId})];
    }));
    const weights = new WeakMap();
    const weight = edge => {
      let value=weights.get(edge);
      if(value===undefined)weights.set(edge,value=Math.round((profile.powerWeight??1)*edge.weight+featureWeights.get(edge.key)));
      return value;
    };
    let best;
    const windows = profile.window ? (requiredWindows.length ? requiredWindows : input.inventory.supportCardIds.filter(isWindow)) : [requiredWindows[0] ?? null];
    for (const windowId of windows) for (const model of models) {
      if (signal?.aborted) return null;
      // A bounded multi-window seed chooses its best distinct windows before pairing.
      // This is a heuristic seed; the legality limit still applies to every neighbour.
      const allowedWindows = new Set(requiredWindows);
      if (windowId) allowedWindows.add(windowId);
      if (profile.allWindows) {
        const ranked = [...model.edges].filter(e => isWindow(e.support)).sort((a,b) =>
          (b.weight + scale * 0.4 * profile.feature(features.get(b.key))) - (a.weight + scale * 0.4 * profile.feature(features.get(a.key))));
        for (const edge of ranked) { if (allowedWindows.size >= maxWindowCards) break; allowedWindows.add(edge.support); }
      }
      const edges = model.edges.filter(e => !isWindow(e.support) || allowedWindows.has(e.support));
      if (best && pairingProfileBound(edges,model.leader,5,weight) <= best.weight) {
        report.prunedLeaders=(report.prunedLeaders??0)+1; await yieldControl(); continue;
      }
      const solution = maximumPairing({ edges, weight, required: input.constraints.lockedPairs.map(p => `${p.memberCardId}|${p.supportCardId}`),
        requiredMembers: [...input.constraints.requiredMemberIds, model.leader], requiredSupports: [...input.constraints.requiredSupportIds, ...(windowId ? [windowId] : [])] });
      if (solution && (!best || solution.weight > best.weight)) best = { draft: draftFromPairing(input, model.leader, solution.edges), weight: solution.weight };
      await yieldControl();
    }
    report.directions.push({ id: profile.id, label: profile.label, status: best ? 'generated' : 'unavailable' });
    if (best) { seedRows.push({ draft: best.draft, profile }); add(best.draft, profile, 'seed'); }
    update(1, index + 1, profiles.length);
  }
  if (!seedRows.length && !report.unsupportedPairs.length) throw new Error('当前筛选与必选条件下无法生成实用候选');
  if (legal(input.draft)) add(input.draft, { id: 'current' }, 'current');
  const neighboursPerSeed = 5 * (input.inventory.memberCardIds.length - 1 + input.inventory.supportCardIds.length - 1) + 14;
  const totalNeighbours = seedRows.length * neighboursPerSeed;
  for (const seed of seedRows) {
    const winners = new Map();
    for (const candidate of practicalNeighbours(seed.draft, input.inventory)) {
      if (signal?.aborted) return null;
      report.neighbourGenerated++;
      if (legal(candidate.draft)) {
        report.neighbourChecks++;
        const score = proxy(candidate.draft, seed.profile), previous = winners.get(candidate.kind);
        if (!previous || score > previous.score) winners.set(candidate.kind, { ...candidate, score });
      }
      if (report.neighbourGenerated % 50 === 0) { update(2, report.neighbourGenerated, totalNeighbours); await yieldControl(); }
    }
    for (const candidate of winners.values()) add(candidate.draft, seed.profile, candidate.kind);
    if (mode === 'gekisou') for (const [a, b] of [[0, 1], [1, 3], [3, 4]]) {
      const d = { ...seed.draft, slots: [...seed.draft.slots] }; [d.slots[a], d.slots[b]] = [d.slots[b], d.slots[a]]; add(d, seed.profile, 'position');
    }
  }
  update(2, report.neighbourGenerated, totalNeighbours);
  return {missions,rows:[...screenDrafts.values()].map(c=>({slots:c.draft.slots,origins:[...c.origins],kind:c.kind}))};
}
