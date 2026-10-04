import {currentServerContext, assertAccountServer} from './game-servers.mjs';
import {createTeamDraft} from './team-draft.mjs';
import {createFormationCalculator} from './scoring-rules/formation-power.mjs';
import {resolveGrowthScenario} from '../../../packages/scoring/scoring-rules/growth-scenarios.mjs';
import {checkTeamCompatibility} from './team-workspace-compatibility.mjs';

export const TEAM_WORKSPACE_FORMAT = 'otonote-team-workspace';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const conflict = () => Object.assign(Error('队伍已在另一个窗口修改，请刷新后重试，或另存为新队伍。'), {code:'revision_conflict'});

/** Durable, per-account teams. Missing growth stays missing; validation never writes calculated defaults. */
export function createTeamWorkspaceStore({rules, context = currentServerContext(), storage} = {}) {
  storage ??= {getItem:k=>globalThis.localStorage.getItem(k), setItem:(k,v)=>globalThis.localStorage.setItem(k,v),
    key:i=>globalThis.localStorage.key(i), get length(){return globalThis.localStorage.length;}};
  const key = `ournotes:team-workspace:${context.region}:${context.serverId ?? 'unselected'}`;
  const calculator = createFormationCalculator(rules);
  let observedRevision;
  const checkServer = () => assertAccountServer(context.serverId, context);
  const empty = () => ({format:TEAM_WORKSPACE_FORMAT, schemaVersion:1, ...context, sourceReleaseId:rules.sourceReleaseId, revision:0, teams:[], recentDraft:null});
  function validateDraft(value, partial = false) {
    if (!object(value) || !Array.isArray(value.slots) || value.slots.length !== 5 || !object(value.modifiers ?? {})) throw Error('队伍草稿格式无效');
    for (const slot of value.slots) {
      if (!object(slot)) throw Error('队伍配对格式无效');
      for (const kind of ['member','support']) {
        const id = slot[`${kind}CardId`];
        if (id != null && (typeof id !== 'string' || !new RegExp(`^${kind}-card-[1-9]\\d*$`).test(id))) throw Error('卡牌 ID 无效');
      }
    }
    const draft = createTeamDraft(clone(value));
    const compatibility = checkTeamCompatibility(draft, {rules});
    const invalid = compatibility.issues.filter(issue => !(partial && issue.code === 'missing_card'));
    if (invalid.length) throw Error(invalid[0].message);
    if (!object(draft.modifiers.growth ?? {})) throw Error('卡牌养成格式无效');
    for (const [id, growth] of Object.entries(draft.modifiers.growth ?? {})) {
      const kind = id.startsWith('member-card-') ? 'member' : id.startsWith('support-card-') ? 'support' : null;
      if (!kind || !object(growth)) throw Error('卡牌养成格式无效');
      calculator.resolveGrowth(calculator.card(id, kind), kind === 'member' ? 'Member' : 'Support', growth);
      for (const field of ['skillLevel','gekisouSkillLevel']) if (growth[field] != null && (!Number.isInteger(growth[field]) || growth[field] < 1 || growth[field] > 5)) throw Error('技能等级应为 1–5');
    }
    const plan = draft.modifiers.planningScenario;
    if (plan != null && (!object(plan) || !['owned','selected','reference','trial'].includes(plan.scope))) throw Error('队伍养成场景无效');
    if (plan) {
      plan.sourceReleaseId = rules.sourceReleaseId;
      if (plan.plan) plan.plan.sourceReleaseId = rules.sourceReleaseId;
      const record = draft.modifiers.planningResult;
      if (record != null && !object(record)) throw Error('队伍培养记录无效');
      if (record) record.sourceReleaseId = rules.sourceReleaseId;
      // Revalidate pools and cultivation goals without converting any reference into owned data.
      resolveGrowthScenario(rules, draft, {...plan, scope:'selected'});
      for (const id of record?.selectedTrainingCardIds ?? []) calculator.card(id, id.startsWith('member-card-') ? 'member' : 'support');
    }
    // A saved team may outlive the event/song it was created on. Only validate its formation here.
    const formation = {...draft, selectedSongId:null, modifiers:{...draft.modifiers}};
    delete formation.modifiers.event;
    calculator.calculate(formation);
    return draft;
  }
  function validate(value) {
    checkServer();
    if (!object(value) || value.format !== TEAM_WORKSPACE_FORMAT || value.schemaVersion !== 1 || !Array.isArray(value.teams) || value.teams.length > 100) throw Error('请选择版本 1 的队伍备份（最多 100 队）');
    assertAccountServer(value.serverId, context);
    if (value.region !== context.region) throw Error('队伍备份与当前区服不匹配');
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('队伍修订号无效');
    const ids = new Set();
    const teams = value.teams.map(team => {
      if (!object(team) || typeof team.id !== 'string' || !team.id || team.id.length > 200 || ids.has(team.id)) throw Error('队伍 ID 无效或重复');
      ids.add(team.id);
      const name = typeof team.name === 'string' ? team.name.trim() : '';
      if (!name || name.length > 80) throw Error('队伍名称应为 1–80 字');
      return {id:team.id, name, sourceReleaseId:rules.sourceReleaseId, draft:validateDraft(team.draft),
        ...(typeof team.createdAt === 'string' ? {createdAt:team.createdAt} : {}),
        ...(typeof team.updatedAt === 'string' ? {updatedAt:team.updatedAt} : {})};
    });
    return {...empty(), revision:value.revision, teams, recentDraft:value.recentDraft == null ? null : validateDraft(value.recentDraft, true)};
  }
  function load() { checkServer(); const raw = storage.getItem(key); return raw === null ? empty() : validate(JSON.parse(raw)); }
  function read() { const state = load(); observedRevision = state.revision; return state; }
  function emit(revision) {
    if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') globalThis.dispatchEvent(new CustomEvent('team-workspace:changed', {detail:{key, revision}}));
  }
  function mutate(change, {expectedRevision = observedRevision} = {}, replacement = false) {
    checkServer();
    const before = storage.getItem(key);
    let previous;
    try { previous = before === null ? empty() : validate(JSON.parse(before)); }
    catch (error) { if (!replacement) throw error; previous = empty(); }

    if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw conflict();
    const next = validate({...change(clone(previous)), revision:previous.revision + 1});
    // Verify the raw record once more immediately before the atomic localStorage write.
    if (storage.getItem(key) !== before) throw conflict();
    storage.setItem(key, JSON.stringify(next));
    observedRevision = next.revision; emit(next.revision); return next;
  }
  function saveTeam({id, name, draft, expectedRevision} = {}) {
    return mutate(state => {
      const index = id == null ? -1 : state.teams.findIndex(team => team.id === id);
      if (id != null && index < 0) throw Error('这套队伍已不存在，请另存为新队伍');
      const now = new Date().toISOString();
      const team = {id:id ?? globalThis.crypto.randomUUID(), name, draft, sourceReleaseId:rules.sourceReleaseId,
        createdAt:index < 0 ? now : state.teams[index].createdAt, updatedAt:now};
      if (index < 0) state.teams.push(team); else state.teams[index] = team;
      return state;
    }, {expectedRevision});
  }
  function listLegacy() {
    checkServer(); const prefix = `ournotes:presets:${context.region}:${context.serverId}:`, result = [];
    for (let i = 0; i < storage.length; i++) {
      const legacyKey = storage.key(i); if (!legacyKey?.startsWith(prefix)) continue;
      try {
        const value = JSON.parse(storage.getItem(legacyKey));
        result.push({key:legacyKey, sourceReleaseId:value.sourceReleaseId ?? legacyKey.slice(prefix.length), count:value.candidates?.length ?? 0});
      } catch { result.push({key:legacyKey, sourceReleaseId:legacyKey.slice(prefix.length), count:0, error:'旧队伍备份无法读取'}); }
    }
    return result.sort((a,b) => a.key.localeCompare(b.key));
  }
  function migrateLegacy(legacyKey, options = {}) {
    if (!listLegacy().some(entry => entry.key === legacyKey)) throw Error('请选择当前区服的旧队伍备份');
    const value = JSON.parse(storage.getItem(legacyKey));
    assertAccountServer(value.serverId, context);
    if (value.schemaVersion !== 1 || !Array.isArray(value.candidates) || value.candidates.length > 100 || (value.region && value.region !== context.region)) throw Error('旧队伍备份格式无效');
    return mutate(state => {
      const now = new Date().toISOString();
      state.teams.push(...value.candidates.map(team => ({id:globalThis.crypto.randomUUID(), name:team.name, draft:team.draft, createdAt:now, updatedAt:now})));
      return state;
    }, options);
  }
  return {key, empty, read, validate, validateDraft, saveTeam, listLegacy, migrateLegacy,
    removeTeam(id, options) { return mutate(state => { if (!state.teams.some(team => team.id === id)) throw Error('这套队伍已不存在'); state.teams = state.teams.filter(team => team.id !== id); return state; }, options); },
    setRecentDraft(draft, options) { return mutate(state => ({...state, recentDraft:draft}), options); },
    checkpoint() { checkServer(); return storage.getItem(key); },
    restore(checkpoint, options) { const restored = checkpoint === null ? empty() : validate(JSON.parse(checkpoint)); return mutate(() => restored, options); },
    fromImport(value) { return validate(typeof value === 'string' ? JSON.parse(value) : value); },
    importWorkspace(value, {replace = false, expectedRevision} = {}) {
      const imported = validate(typeof value === 'string' ? JSON.parse(value) : value);
      return mutate(state => replace ? imported : {...state, teams:[...state.teams, ...imported.teams.map(team => ({
        ...team, id:globalThis.crypto.randomUUID()
      }))]}, {expectedRevision}, replace);
    },
    exportWorkspace() { return read(); }
  };
}
