import {createTeamWorkspaceStore} from './team-workspace-store.mjs';
import {checkTeamCompatibility, mergeTeamForTool} from './team-workspace-compatibility.mjs';
import {createPersonalGrowthStore} from './personal-growth-store.mjs';
import {refreshPlanningPreset} from './preset-portfolio.mjs';
import {validateTeamDraft} from './team-draft.mjs';

/** A selected, non-training team is an explicit calculation input, not an actual-profile view. */
export function hasSelectedGrowthOverrides(draft) {
  const scenario=draft.modifiers?.planningScenario;
  return scenario?.scope==='selected'&&(!scenario.plan||scenario.plan.enabled===false);
}
export function toolTeamInputState(draft,known) {
  const scope=draft.modifiers?.planningScenario?.scope;
  const missingGrowth=draft.slots.some(slot=>['member','support'].some(kind=>{
    const id=slot[`${kind}CardId`];if(!id)return false;
    const growth=draft.modifiers?.growth?.[id]??{};
    return (kind==='member'?['level','rank','awake','skillLevel','gekisouSkillLevel']:['level','rank']).some(field=>growth[field]==null);
  }));
  const scenario=draft.modifiers?.planningScenario,actual=draft.modifiers?.planningResult?.actualGrowth;
  const missingBaseline=actual&&(scope==='owned'||scenario?.plan&&scenario.plan.enabled!==false)&&draft.slots.some(slot=>[slot.memberCardId,slot.supportCardId].filter(Boolean).some(id=>!actual[id]));
  return {inputIssues:validateTeamDraft(draft,known),growthIsReference:Boolean(['reference','trial'].includes(scope)||missingGrowth||missingBaseline)};
}
export function refreshToolTeamGrowth(rules,draft,inventory) {
  if(hasSelectedGrowthOverrides(draft))return {draft:structuredClone(draft),planning:{missingActual:toolTeamInputState(draft).growthIsReference}};
  return refreshPlanningPreset(rules,draft,inventory);
}

export const toolTeamLabel=(kind,locale)=>({deck:locale==='en'?'Deck builder':'配队工具',song:locale==='en'?'Song calculator':'歌曲计算'})[kind];
let activeContext = null;
const teamFingerprint=draft=>JSON.stringify({slots:draft.slots,growth:draft.modifiers?.growth,planningScenario:draft.modifiers?.planningScenario,planningResult:draft.modifiers?.planningResult,performanceScenario:draft.modifiers?.performanceScenario});
const emit = (name, detail) => document.dispatchEvent(new CustomEvent(`team-workspace:${name}`, {detail}));
export const getActiveToolTeamContext = () => activeContext;
export const openTeamWorkspace = (tab = 'teams') => emit('open', {tab});
export function requestTeamSave(draft, name, onSaved, onError) {
  emit('save', {draft:structuredClone(draft), name, onSaved, onError});
}
export function notifyToolTeamChanged(context) {
  if (!context) return;
  context.persistRecent?.();
  context.renderSummary?.();
  emit('draft', {context});
}
export function assertToolTeamCompatible(context, draft = context?.getDraft()) {
  if (!context) return;
  if(context.inventoryError)throw new Error(context.inventoryError);
  const result = checkTeamCompatibility(draft, context.getRestrictions?.() ?? {});
  if (!result.compatible) throw new Error(result.issues.map(issue => issue.message ?? issue.reason ?? String(issue)).join('；'));
}
export function hasExplicitTeam(search) {
  const params = new URLSearchParams(search);
  return ['members','supports','member','support'].some(key => params.has(key));
}

/** One adapter owns a page's working copy. Store notifications never replace another tab's team. */
export function registerToolTeamContext(host, spec) {
  const abort = new AbortController();
  const store = createTeamWorkspaceStore({rules:spec.rules});
  const profileStore = createPersonalGrowthStore({rules:spec.rules, vipRanks:spec.data.vipRanks});
  let applying = false, lastDraft = '', inventoryRaw;
  let savedDraft = teamFingerprint(spec.getDraft());
  const context = {...spec, host, store, getRestrictions:()=>({rules:spec.rules, requireComplete:false, ...(spec.getRestrictions?.()??{})})};
  context.isDirty = () => teamFingerprint(context.getDraft()) !== savedDraft;
  context.markSaved = () => {savedDraft = teamFingerprint(context.getDraft()); emit('draft', {context});};
  context.renderSummary = () => {
    const container=host.querySelector('[data-team-workspace-summary]');
    if(!container)return;
    container.replaceChildren();const english=spec.data.locale==='en'||document.documentElement.lang==='en';
    for(const [index,slot] of context.getDraft().slots.entries()){
      const pair=document.createElement('div');
      for(const kind of ['member','support']){
        const card=spec.data[`${kind}Cards`].find(card=>card.id===slot[`${kind}CardId`]);
        if(card?.imageUrl){const image=document.createElement('img');image.src=card.imageUrl;image.alt=card.displayName;image.loading='lazy';pair.append(image);}
        else {const empty=document.createElement('small');empty.textContent=card?.displayName??(english?'Not selected':'未选择');pair.append(empty);}
      }
      const caption=document.createElement('small');caption.textContent=index===2?(english?'Leader':'队长'):`${index+1}`;pair.append(caption);container.append(pair);
    }
  };
  const feedback = error => {
    context.error = error.message;
    const status = host.querySelector('[data-team-workspace-status]');
    if (status) status.textContent = error.message;
    emit('draft', {context});
  };
  context.persistRecent = () => {
    if (applying) return;
    const draft = context.getDraft(), fingerprint = teamFingerprint(draft);
    if (fingerprint === lastDraft) return;
    try {
      const state = store.read();
      store.setRecentDraft(draft, {expectedRevision:state.revision});
      lastDraft = fingerprint;
      context.error = null;
    } catch (error) { feedback(error); }
  };
  context.applyDraft = (draft, options = {}) => {
    let next = mergeTeamForTool(context.getDraft(), draft, options);
    const scenario=next.modifiers?.planningScenario;
    let profile;
    try{profile=profileStore.read();}catch(error){if(scenario?.scope==='owned')throw error;}
    if(scenario?.scope==='owned'&&next.slots.some(slot=>['member','support'].some(kind=>slot[`${kind}CardId`]&&!profile?.inventory[`${kind}CardIds`]?.includes(slot[`${kind}CardId`]))))throw new Error('这套实际队伍含有未记录为持有的卡，请补全卡库，或改用参考队伍。');
    if(scenario&&next.slots.every(slot=>slot.memberCardId&&slot.supportCardId)){
      next=refreshToolTeamGrowth(spec.rules,next,profile?.inventory).draft;
    }else if(profile&&!scenario){
      next.modifiers.growth??={};
      for(const slot of next.slots)for(const id of [slot.memberCardId,slot.supportCardId])if(id&&profile.inventory.growth[id])next.modifiers.growth[id]=structuredClone(profile.inventory.growth[id]);
    }
    const compatibility=checkTeamCompatibility(next,context.getRestrictions());
    if(!compatibility.compatible)throw new Error(compatibility.issues.map(issue=>issue.message).join('；'));
    context.inventoryError=null;
    context.invalidate?.();
    applying = true;
    try { spec.applyDraft(next); context.error = null; }
    finally { applying = false; }
    notifyToolTeamChanged(context);
  };
  context.refreshInventory = () => {
    context.invalidate?.();
    try {
      const profile = profileStore.read();
      let draft = structuredClone(context.getDraft());
      const scenario = draft.modifiers?.planningScenario;
      // Reference and trial values are intentional assumptions; actual records refresh separately.
      context.inventoryError=null;
      if (!['reference','trial'].includes(scenario?.scope)) {
        draft.modifiers ??= {};
        for (const field of ['bandItems','bandItemTotals','characterRanks','tgwCardRank']) delete draft.modifiers[field];
        Object.assign(draft.modifiers, structuredClone(profile?.account??{}));
        if (!scenario?.plan&&!hasSelectedGrowthOverrides(draft)) {
          draft.modifiers.growth ??= {};
          for (const slot of draft.slots) for (const id of [slot.memberCardId,slot.supportCardId]) {
            if (!id)continue;
            if (profile?.inventory.growth[id]) draft.modifiers.growth[id] = structuredClone(profile.inventory.growth[id]);
            else if(scenario?.scope==='owned'){delete draft.modifiers.growth[id];if(draft.modifiers.planningResult?.actualGrowth)draft.modifiers.planningResult.actualGrowth[id]=null;}
          }
        }
        if (scenario && draft.slots.every(slot => slot.memberCardId && slot.supportCardId)) {
          try{draft = refreshToolTeamGrowth(spec.rules, draft, profile?.inventory).draft;}
          catch(error){delete draft.modifiers.planningResult;context.inventoryError=error.message;}
        }
      }
      if(scenario?.scope==='owned'&&draft.slots.some(slot=>['member','support'].some(kind=>slot[`${kind}CardId`]&&!profile?.inventory[`${kind}CardIds`]?.includes(slot[`${kind}CardId`]))))context.inventoryError='这套实际队伍含有未记录为持有的卡，请补全卡库，或改用参考队伍。';
      spec.onInventoryChange?.(profile);
      applying = true;
      try { spec.applyDraft(draft); } finally { applying = false; }
      notifyToolTeamChanged(context);
      if(context.inventoryError)feedback(new Error(context.inventoryError));
    } catch (error) { feedback(error); }
  };
  host.teamWorkspaceContext = context;
  activeContext = context;
  const listen = (target, type, fn) => target.addEventListener(type, fn, {signal:abort.signal});
  listen(host, 'click', event => {
    const open = event.target.closest('[data-open-team-workspace]');
    if (open) { event.preventDefault(); openTeamWorkspace(open.dataset.openTeamWorkspace || 'teams'); }
    if (event.target.closest('[data-save-current-team]')) requestTeamSave(context.getDraft(), spec.label);
  });
  const onInventoryChange = event => {
    if (event.detail?.key && event.detail.key !== profileStore.key) return;
    // The revision event and storage event can both represent the same import.
    let raw;
    try { raw = localStorage.getItem(profileStore.key); } catch { return context.refreshInventory(); }
    if (raw === inventoryRaw) return;
    inventoryRaw = raw;
    context.refreshInventory();
  };
  try { inventoryRaw = localStorage.getItem(profileStore.key); } catch {}
  listen(window, 'personal-growth:changed', onInventoryChange);
  listen(window, 'storage', event => {
    if (event.key === profileStore.key) onInventoryChange(event);
    if (event.key === store.key) emit('context', {context});
  });
  listen(window, 'team-workspace:changed', () => emit('context', {context}));
  try {
    const state = store.read();
    if (!hasExplicitTeam(location.search) && state.recentDraft) context.applyDraft(state.recentDraft);
    else lastDraft = teamFingerprint(context.getDraft());
    savedDraft = teamFingerprint(context.getDraft());
  } catch (error) { feedback(error); }
  context.renderSummary();
  emit('context', {context});
  return () => {
    abort.abort();
    if (activeContext === context) {activeContext = null; emit('context', {context:null});}
    delete host.teamWorkspaceContext;
  };
}
