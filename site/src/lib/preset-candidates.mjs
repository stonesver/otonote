import { optimizeTeamPlanning } from './team-planning-optimizer.mjs';
import { createInventoryManager } from './inventory-manager.mjs';
import { optimizeInventory } from './inventory-optimizer.mjs';
import { preparePresetDraft, presetWindowCardCount } from './preset-portfolio.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';

/** Bounded seed generation, not a substitute for score-space search. Each seed
 * maximizes power in a type-focused pool; the portfolio later scores real charts. */
export async function generatePresetCandidates({ rules, draft, inventory, songs, mode = 'gekisou', maxWindowCards = 1, planningScenario, performanceScenario, constraints = {}, variantLimit = 24 }, { onProgress, yieldControl } = {}) {
  if (planningScenario) {
    const candidates = [], skipped = [], seen = new Set();
    for (const [index,song] of songs.entries()) {
      onProgress?.({completed:index,total:songs.length});
      const report = await optimizeTeamPlanning({rules,draft:{...draft,selectedSongId:song.trackId,selectedDifficulty:song.difficulty},inventory,
        planningScenario,performanceScenario,mode,objective:'formation_power',maxWindowCards,constraints,variantLimit,yieldControl});
      for (const result of report.results) {
        if (seen.has(result.id)) continue;seen.add(result.id);
        candidates.push({id:`seed-${result.id}`,sourceReleaseId:rules.sourceReleaseId,draft:result.draft,
          name:`${song.title??song.trackId} · ${result.planning.label}`,origin:'planning_power_seed'});
      }
      if(report.status!=='completed')skipped.push(`${song.title??song.trackId}：只比较了部分培养组合`);
    }
    onProgress?.({completed:songs.length,total:songs.length});
    if(!candidates.length)throw Error('当前场景没有生成可用队伍，请检查卡片范围。');
    return {candidates,skipped,warning:'这些是按保存的卡片与养成条件生成的综合力起点；请继续比较歌曲分数。'};
  }
  if (!['ordinary', 'gekisou'].includes(mode) || ![0, 1].includes(maxWindowCards)) throw new Error('候选生成设置无效');
  const manager = createInventoryManager(rules), owned = manager.validate(inventory);
  if (owned.memberCardIds.length < 5 || owned.supportCardIds.length < 5) throw new Error('请先在个人卡库录入至少五个不同角色的成员及五张留影');
  const base = structuredClone(draft); base.modifiers ??= {};
  base.modifiers.growth = { ...base.modifiers.growth };
  for (const kind of ['member', 'support']) for (const id of owned[`${kind}CardIds`]) {
    base.modifiers.growth[id] = { ...manager.preset(id, kind, 'level', owned.growth[id]),
      ...(kind === 'member' ? { skillLevel: 5, gekisouSkillLevel: 5 } : {}) };
  }
  const members = new Map(rules.tables.MemberCard.map(c => [`member-card-${c._id}`, c]));
  const supports = new Map(rules.tables.SupportCard.map(c => [`support-card-${c._id}`, c]));
  const memberSkills = new Map(rules.tables.GekisouSkill.map(s => [s._id, s._gekisouMissionType]));
  const supportSkills = new Map(rules.tables.GekisouSupportSkill.map(s => [s._id, s._gekisouMissionType]));
  const windowSkills = new Set(rules.tables.GekisouSupportSkillEffect.filter(e => e._skillEffectType === 4004).map(e => e._gekisouSupportSkillID));
  const isWindow = id => [1, 2].some(i => windowSkills.has(supports.get(id)[`_gekisouSupportSkillId0${i}`]));
  const windows = owned.supportCardIds.filter(isWindow);
  const groups = new Map();
  for (const song of songs) {
    const master = rules.tables.LiveMusic.find(m => `music-${m._id}` === song.trackId);
    if (!master) throw new Error('候选曲池包含未知歌曲');
    const missions = mode === 'ordinary' ? [0] : [...new Set([1, 2, 3].map(i => master[`_gekisouMission${i}`]))].filter(m => [1, 2, 3].includes(m));
    for (const mission of missions) {
      const key = `${master._musicType}:${mission}`;
      if (!groups.has(key)) groups.set(key, { song, mission, attribute: master._musicType });
    }
  }
  if (!groups.size) throw new Error('没有可生成候选的歌曲');
  const tasks = [...groups.values()].flatMap(group => [null, ...(group.mission === 3 && maxWindowCards ? windows : [])].map(windowId => ({ ...group, windowId })));
  const candidates = [], seen = new Set(), skipped = [];
  for (const [index, task] of tasks.entries()) {
    onProgress?.({ completed: index, total: tasks.length });
    let memberIds = owned.memberCardIds.filter(id => memberSkills.get(members.get(id)._gekisouSkillID) === task.mission);
    if (!task.mission || new Set(memberIds.map(id => members.get(id)._characterID)).size < 5) memberIds = owned.memberCardIds;
    const allowed = owned.supportCardIds.filter(id => mode === 'ordinary' || !isWindow(id) || id === task.windowId);
    let supportIds = allowed.filter(id => [1, 2].some(i => supportSkills.get(supports.get(id)[`_gekisouSupportSkillId0${i}`]) === task.mission));
    if (!task.mission || supportIds.length < 5) supportIds = allowed;
    if (task.windowId && !supportIds.includes(task.windowId)) supportIds.push(task.windowId);
    if (supportIds.length < 5) { skipped.push(`属性 ${task.attribute} / 类型 ${task.mission}：符合判卡上限的留影不足`); continue; }
    const input = { ...base, selectedSongId: task.song.trackId, selectedDifficulty: task.song.difficulty ?? draft.selectedDifficulty };
    const search = await optimizeInventory({ rules, draft: input, scope: 'owned',
      inventory: { ...owned, memberCardIds: memberIds, supportCardIds: supportIds },
      constraints: { requiredSupportIds: task.windowId ? [task.windowId] : [] }, objective: 'formation_power', topN: 1, maxEvaluations: 1 });
    const result = search.results[0];
    if (!result) { skipped.push(`属性 ${task.attribute} / 类型 ${task.mission}：无法组成合法队伍`); continue; }
    const prepared = preparePresetDraft(rules, result.draft);
    if (mode === 'gekisou' && presetWindowCardCount(rules, prepared) > maxWindowCards) continue;
    const id = stableSnapshotHash({ slots: prepared.slots, modifiers: prepared.modifiers });
    if (seen.has(id)) continue; seen.add(id);
    candidates.push({ id: `seed-${id}`, sourceReleaseId: rules.sourceReleaseId, draft: prepared,
      name: `${['综合力', 'COMBO', 'LUCK', 'JUST'][task.mission]} · 属性 ${task.attribute}${task.windowId ? ' · 单判卡' : mode === 'gekisou' ? ' · 无判卡' : ''}`,
      origin: 'power_seed_by_mission_and_attribute' });
  }
  onProgress?.({ completed: tasks.length, total: tasks.length });
  if (!candidates.length) throw new Error('卡库无法生成合法预设；请检查角色数量及判卡上限');
  return { candidates, skipped, warning: '这是按类型和属性生成的综合力起点；并未穷举所有技能组合。可加入单曲自动配队结果扩大候选。' };
}
