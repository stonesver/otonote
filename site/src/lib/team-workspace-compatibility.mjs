/** Explicit tool restrictions only. Event bonuses are deliberately not restrictions. */
export function checkTeamCompatibility(draft, {rules, inventory, allowedMemberIds, allowedSupportIds,
  allowedBandIds, allowedAttributes, requireOwned = false, allowedTrackIds, supportedScopes, requireComplete = true} = {}) {
  const issues = [], slots = Array.from({length:5}, (_, slot) => ({slot, compatible:true, issues:[]}));
  const add = (code, message, slot, kind) => {
    const item = {code, message, ...(slot == null ? {} : {slot}), ...(kind ? {kind} : {})};
    issues.push(item); if (slot != null) { slots[slot].issues.push(item); slots[slot].compatible = false; }
  };
  const allows = (list, value) => list == null || [...list].some(id => String(id) === String(value));
  const known = kind => new Map((rules?.tables?.[kind === 'member' ? 'MemberCard' : 'SupportCard'] ?? []).map(row => [`${kind}-card-${row._id}`, row]));
  const cards = {member:known('member'), support:known('support')};
  const characters = new Map((rules?.tables?.Character ?? []).map(row => [row._id, row]));
  if (!Array.isArray(draft?.slots) || draft.slots.length !== 5) add('invalid_slots', '队伍需要五组配对');
  const seen = {member:new Set(),support:new Set(),character:new Set()};
  for (let slot = 0; slot < 5; slot++) for (const kind of ['member','support']) {
    const id = draft?.slots?.[slot]?.[`${kind}CardId`], label = kind === 'member' ? '成员卡' : '留影';
    if (!id) { if (requireComplete) add('missing_card', `第 ${slot + 1} 组尚未选择${label}`, slot, kind); continue; }
    const card = cards[kind].get(id);
    if (rules && !card) add('unknown_card', `这张${label}不在当前内容中，请更新内容后重试`, slot, kind);
    if (seen[kind].has(id)) add('duplicate_card', `同一张${label}不能重复使用`, slot, kind);
    seen[kind].add(id);
    if (!allows(kind === 'member' ? allowedMemberIds : allowedSupportIds, id)) add('card_restricted', `当前工具不允许使用这张${label}`, slot, kind);
    if (requireOwned && !inventory?.[`${kind}CardIds`]?.includes(id)) add('not_owned', `这张${label}尚未记录为持有`, slot, kind);
    if (kind === 'member' && card) {
      if (seen.character.has(card._characterID)) add('duplicate_character', '同名角色不能同时上阵', slot, kind);
      seen.character.add(card._characterID);
      if (!allows(allowedBandIds, characters.get(card._characterID)?._bandID)) add('band_restricted', '当前工具不允许使用这个乐队的成员', slot, kind);
      if (!allows(allowedAttributes, card._cardType)) add('attribute_restricted', '当前工具不允许使用这个属性的成员', slot, kind);
    }
  }
  const scope = draft?.modifiers?.planningScenario?.scope ?? 'selected';
  if (!allows(supportedScopes, scope)) add('scope_unsupported', '当前工具不支持这套队伍的养成场景');
  if (requireOwned && ['reference','trial'].includes(scope)) add('hypothetical_team', '参考或试用队伍不能作为实际持有队伍使用');
  if (draft?.selectedSongId && !allows(allowedTrackIds, draft.selectedSongId)) add('song_restricted', '这首歌不在当前活动的可选曲目中');
  return {compatible:issues.length === 0, issues, slots};
}

/** Transfer formation semantics, not the source page's event, song, or rank assumptions. */
export function mergeTeamForTool(current, incoming, {includePerformance = false} = {}) {
  const result = structuredClone(current ?? {});
  result.slots = structuredClone(incoming.slots);
  result.modifiers = {...result.modifiers};
  for (const field of ['growth','planningScenario','planningResult']) {
    delete result.modifiers[field];
    if (Object.hasOwn(incoming.modifiers ?? {}, field)) result.modifiers[field] = structuredClone(incoming.modifiers[field]);
  }
  if (includePerformance && Object.hasOwn(incoming.modifiers ?? {}, 'performanceScenario')) {
    result.modifiers.performanceScenario = structuredClone(incoming.modifiers.performanceScenario);
  }
  return result;
}
