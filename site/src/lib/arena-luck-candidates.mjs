import { createFormationCalculator } from './scoring-rules/formation-power.mjs';
import { resolveSearchInput } from './scoring-rules/formation-input.mjs';
import { maximumPairing } from './scoring-rules/maximum-pairing.mjs';
import { compilePairingModels, draftFromPairing } from './inventory-optimizer.mjs';
import { createTeamDraft } from './team-draft.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { compileGekisouEffects } from '../../../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';
import { checkTeamCompatibility } from './team-workspace-compatibility.mjs';

const roles = new Map([[11001, '涨槽'], [11002, 'RUSH 点数'], [11003, '槽量补充'], [11005, '抽奖保底'], [2000, 'RUSH 得分'], [3004, '生命保护']]);

/** Additional exploration witnesses, never a substitute for replay ranking.
 * Keep power/active-skill tradeoffs instead of letting power alone discard a
 * weaker-stat card with a stronger applicable band branch. */
export function luckSkillTradeoffs(candidates, values) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.family)) groups.set(candidate.family, []);
    groups.get(candidate.family).push({ candidate, values: [candidate.power, ...values(candidate)] });
  }
  return [...groups.values()].flatMap(group => group.filter(row => !group.some(other =>
    other.values.every((value, i) => value >= row.values[i]) && other.values.some((value, i) => value > row.values[i])
  )).map(row => row.candidate));
}

/** Retain different mechanisms before spending frame replays. Power chooses
 * seeds WITHIN a constraint; it never supplies the final recommendation. */
export function selectLuckSeeds(candidates, limit) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.family)) groups.set(candidate.family, []);
    groups.get(candidate.family).push(candidate);
  }
  for (const group of groups.values()) group.sort((a, b) => b.power - a.power || a.id.localeCompare(b.id));
  const selected = new Map();
  for (let round = 0; selected.size < limit; round++) {
    let found = false;
    for (const group of groups.values()) if (round < group.length) {
      found = true; const candidate = group[round];
      if (!selected.has(candidate.id)) selected.set(candidate.id, candidate);
      if (selected.size === limit) break;
    }
    if (!found) break;
  }
  return [...selected.values()];
}

export async function createLuckCandidateSource(rules, profile, context, songs, {
  limit = 32, replacementLimit = 32, cardScope = 'owned', preserveSkillTradeoffs = false, comparisonTeam = null, onProgress, yieldControl = async () => {}, shouldStop = () => false
} = {}) {
  if (!['owned', 'reference'].includes(cardScope)) throw Error('未知的卡库范围');
  const base = createTeamDraft({ selectedSongId: songs[0].trackId, selectedDifficulty: songs[0].difficulty,
    modifiers: { ...structuredClone(profile?.account ?? {}), growth: structuredClone(profile?.inventory?.growth ?? {}) } });
  const input = resolveSearchInput(rules, base, { scope: cardScope, inventory: profile?.inventory, constraints: { bandId: context.bandId } });
  const power = createFormationCalculator(rules), t = rules.tables;
  let comparison;
  if (comparisonTeam) {
    // Only the formation transfers. Every candidate shares this search's
    // inventory growth, account bonuses, stage, song and performance inputs.
    const draft = { ...input.draft, slots: structuredClone(comparisonTeam.draft.slots) };
    const compatibility = checkTeamCompatibility(draft, { rules,
      allowedMemberIds: input.inventory.memberCardIds, allowedSupportIds: input.inventory.supportCardIds });
    if (!compatibility.compatible) throw Error(`自配队无法参与当前比较：${compatibility.issues[0].message}`);
    comparison = { id: stableSnapshotHash(draft.slots), name: '自配队对照', family: '自配队对照', draft,
      power: power.calculate(draft).total.total, comparison: { id: comparisonTeam.id, name: comparisonTeam.name } };
  }
  const pairStrengths = new Map(), types = [...roles.keys()];
  const skillStrengths = candidate => {
    // Growth and missions are fixed for this source. Applicability depends on
    // the member/support pair, so reusing a pair needs no effect compilation.
    const keys = candidate.draft.slots.map(slot => `${slot.memberCardId}:${slot.supportCardId}`);
    if (keys.some(key => !pairStrengths.has(key))) {
      const effects = compileGekisouEffects(rules, candidate.draft, false, [2, 2, 2]).filter(effect => effect.active);
      keys.forEach((key, slot) => pairStrengths.set(key, types.map(type => effects
        .filter(effect => effect.slotIndex === slot && effect.definition._skillEffectType === type)
        .reduce((sum, effect) => sum + effect.definition._effectValue, 0))));
    }
    return types.map((_, i) => keys.reduce((sum, key) => sum + pairStrengths.get(key)[i], 0));
  };
  const cardRoles = new Map();
  for (const kind of ['member', 'support']) for (const id of input.inventory[`${kind}CardIds`]) {
    const card = power.card(id, kind), member = kind === 'member';
    const parent = member ? t.GekisouSkill : t.GekisouSupportSkill;
    const skillIds = (member ? [card._gekisouSkillID] : [card._gekisouSupportSkillId01, card._gekisouSupportSkillId02])
      .filter(id => parent.some(p => p._id === id && p._gekisouMissionType === 2));
    const rank = member ? null : power.resolveGrowth(card, 'Support', input.draft.modifiers.growth[id]).rankRow;
    const actualLevel = skillId => member ? input.draft.modifiers.growth[id]?.gekisouSkillLevel ?? 1
      : rank[card._gekisouSupportSkillId01 === skillId ? '_gekisouSupportSkill01Level' : '_gekisouSupportSkill02Level'];
    const table = member ? t.GekisouSkillEffect : t.GekisouSupportSkillEffect;
    const field = member ? '_gekisouSkillID' : '_gekisouSupportSkillID';
    cardRoles.set(id, [...new Set(table.filter(e => skillIds.includes(e[field]) && e._level === actualLevel(e[field]))
      .map(e => roles.get(e._skillEffectType) ?? '其他 LUCK'))]);
  }
  const members = input.inventory.memberCardIds, supports = input.inventory.supportCardIds;
  const luckMembers = members.filter(id => cardRoles.get(id).length);
  const luckSupports = supports.filter(id => cardRoles.get(id).length);
  const tasks = [{ family: '综合力与队长', members: [], supports: [] },
    ...members.map(id => ({ family: cardRoles.get(id).join('＋') || '普通成员技能', members: [id], supports: [] })),
    ...supports.map(id => ({ family: cardRoles.get(id).join('＋') || '普通留影技能', members: [], supports: [id] }))];
  // Two-source constraints retain synergies that single-card seeds lose.
  for (const member of luckMembers) for (const support of luckSupports) tasks.push({
    family: '成员与留影组合', members: [member], supports: [support]
  });
  for (let a = 0; a < luckSupports.length; a++) for (let b = a + 1; b < luckSupports.length; b++) {
    if (cardRoles.get(luckSupports[a]).join() === cardRoles.get(luckSupports[b]).join()) continue;
    tasks.push({ family: '留影机制组合', members: [], supports: [luckSupports[a], luckSupports[b]] });
  }
  const focusedCharacters = new Set(luckMembers.map(id => power.card(id, 'member')._characterID));
  const focused = new Set(members.filter(id => luckMembers.includes(id) || !focusedCharacters.has(power.card(id, 'member')._characterID)));
  const seedSongs = [...new Map(songs.map(song => {
    const music = t.LiveMusic.find(m => `music-${m._id}` === song.trackId);
    return [JSON.stringify([music._musicType, music._bestMusicTagIDs]), song];
  })).values()];
  const generated = [];
  let completed = 0;
  outer: for (const song of seedSongs) {
    const current = { ...input, draft: { ...input.draft, selectedSongId: song.trackId, selectedDifficulty: song.difficulty } };
    const models = await compilePairingModels(rules, current, { yieldControl });
    for (const focus of [false, true]) for (const task of tasks) {
      if (shouldStop()) break outer;
      let best;
      for (const model of models) {
        const match = maximumPairing({ edges: focus ? model.edges.filter(e => focused.has(e.member)) : model.edges,
          requiredMembers: [...new Set([model.leader, ...task.members])], requiredSupports: task.supports });
        if (!match) continue;
        const draft = draftFromPairing(current, model.leader, match.edges), value = power.calculate(draft).total.total;
        const candidate = { id: stableSnapshotHash(draft.slots), name: task.family, family: focus ? `LUCK 成员 · ${task.family}` : task.family, draft, power: value };
        if (!best || value > best.power) best = candidate;
        if (!task.members.length && !task.supports.length) generated.push(candidate);
      }
      if (best) generated.push(best);
      completed++;
      onProgress?.({ phase: 'generate', completed, total: seedSongs.length * tasks.length * 2, candidates: generated.length });
      await yieldControl();
    }
  }
  const seeds = selectLuckSeeds(generated, limit);
  const candidates = seeds.map(row => row.id === comparison?.id ? { ...row, comparison: comparison.comparison } : row);
  if (comparison && !candidates.some(row => row.id === comparison.id)) candidates.push(comparison);
  const seen = new Set(candidates.map(c => c.id));
  const pending = new Map(), expanded = new Set();
  return {
    candidates, seeds, comparisonId: comparison?.id ?? null,
    generated: new Set([...generated.map(c => c.id), ...(comparison ? [comparison.id] : [])]).size,
    complete: completed === seedSongs.length * tasks.length * 2,
    get pending() { return pending.size; },
    get expanded() { return expanded.size; },
    async neighbours(leaders, remaining = 16) {
      if (!remaining) return [];
      const proposals = [];
      let replacements = [];
      const propose = (candidate, slots, family) => {
        const id = stableSnapshotHash(slots); if (seen.has(id) || pending.has(id)) return;
        const draft = { ...candidate.draft, slots };
        const row = { id, draft, family, name: family, power: power.calculate(draft).total.total };
        (['队长调整', '留影重配'].includes(family) ? proposals : replacements).push(row);
      };
      for (const candidate of leaders) {
        if (expanded.has(candidate.id)) continue;
        replacements = [];
        for (let i = 0; i < 5; i++) {
          // Commit a neighbourhood only after every requested leader has been
          // visited. Interrupted proposals must not enter `seen` or disappear
          // from the next attempt when the session resumes.
          if (shouldStop()) return null;
          if (i !== 2) { const slots = structuredClone(candidate.draft.slots); [slots[i], slots[2]] = [slots[2], slots[i]]; propose(candidate, slots, '队长调整'); }
          for (let j = i + 1; j < 5; j++) {
            const slots = structuredClone(candidate.draft.slots);
            [slots[i].supportCardId, slots[j].supportCardId] = [slots[j].supportCardId, slots[i].supportCardId]; propose(candidate, slots, '留影重配');
          }
          const character = power.card(candidate.draft.slots[i].memberCardId, 'member')._characterID;
          for (const id of members.filter(id => power.card(id, 'member')._characterID === character)) {
            const slots = structuredClone(candidate.draft.slots); slots[i].memberCardId = id; propose(candidate, slots, cardRoles.get(id).join('＋') || '普通成员替换');
          }
          for (const id of supports.filter(id => !candidate.draft.slots.some(s => s.supportCardId === id))) {
            const slots = structuredClone(candidate.draft.slots); slots[i].supportCardId = id; propose(candidate, slots, cardRoles.get(id).join('＋') || '普通留影替换');
          }
          await yieldControl();
        }
        // This is the declared finite neighbourhood, not the dequeue batch
        // size. Keep every captain/pairing variant and balance card changes
        // across mechanisms before power. Every selected proposal is queued.
        proposals.push(...selectLuckSeeds(replacements, replacementLimit));
        if (preserveSkillTradeoffs) proposals.push(...luckSkillTradeoffs(replacements, skillStrengths));
      }
      if (shouldStop()) return null;
      for (const row of proposals) pending.set(row.id, row);
      leaders.forEach(row => expanded.add(row.id));
      const result = selectLuckSeeds([...pending.values()], remaining);
      for (const row of result) { pending.delete(row.id); seen.add(row.id); }
      return result;
    }
  };
}
