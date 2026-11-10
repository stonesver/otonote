import { createFormationCalculator } from './scoring-rules/formation-power.mjs';
import { resolveSearchInput } from './scoring-rules/formation-input.mjs';
import { maximumPairing } from './scoring-rules/maximum-pairing.mjs';
import { compilePairingModels, draftFromPairing } from './inventory-optimizer.mjs';
import { createTeamDraft } from './team-draft.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';

const roles = new Map([[11001, '涨槽'], [11002, 'RUSH 点数'], [11003, '槽量补充'], [11005, '抽奖保底'], [2000, 'RUSH 得分'], [3004, '生命保护']]);

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
  limit = 32, cardScope = 'owned', onProgress, yieldControl = async () => {}, shouldStop = () => false
} = {}) {
  if (!['owned', 'reference'].includes(cardScope)) throw Error('未知的卡库范围');
  const base = createTeamDraft({ selectedSongId: songs[0].trackId, selectedDifficulty: songs[0].difficulty,
    modifiers: { ...structuredClone(profile?.account ?? {}), growth: structuredClone(profile?.inventory?.growth ?? {}) } });
  const input = resolveSearchInput(rules, base, { scope: cardScope, inventory: profile?.inventory, constraints: { bandId: context.bandId } });
  const power = createFormationCalculator(rules), t = rules.tables;
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
  const candidates = selectLuckSeeds(generated, limit), seen = new Set(candidates.map(c => c.id));
  return {
    candidates, generated: new Set(generated.map(c => c.id)).size,
    complete: completed === seedSongs.length * tasks.length * 2,
    async neighbours(leaders, remaining = 16) {
      if (!remaining) return [];
      const proposals = [];
      const propose = (candidate, slots, family) => {
        const id = stableSnapshotHash(slots); if (seen.has(id)) return;
        const draft = { ...candidate.draft, slots };
        proposals.push({ id, draft, family, name: family, power: power.calculate(draft).total.total });
      };
      for (const candidate of leaders) {
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
      }
      if (shouldStop()) return null;
      const result = selectLuckSeeds(proposals, remaining);
      for (const row of result) seen.add(row.id);
      return result;
    }
  };
}
