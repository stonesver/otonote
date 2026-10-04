import {currentServerContext, assertAccountServer} from './game-servers.mjs';
import {createInventoryManager} from './inventory-manager.mjs';
import {convertGrowthSnapshot, growthModifiersForDraft} from './account-growth-import.mjs';

import {validateBandItemTotals} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';

export const PERSONAL_GROWTH_FORMAT = 'otonote-personal-growth';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const accountFields = ['bandItems', 'bandItemTotals', 'characterRanks', 'tgwCardRank'];

/** One durable profile per server. Content releases validate data, never identify its owner. */
export function createPersonalGrowthStore({rules, vipRanks = [], context = currentServerContext(), storage}) {
  storage ??= {
    getItem:k=>globalThis.localStorage.getItem(k), setItem:(k,v)=>globalThis.localStorage.setItem(k,v),
    removeItem:k=>globalThis.localStorage.removeItem(k), key:i=>globalThis.localStorage.key(i), get length(){return globalThis.localStorage.length;}
  };
  const manager = createInventoryManager(rules);
  const key = `ournotes:personal-growth:${context.region}:${context.serverId ?? 'unselected'}`;
  const notify = profile => {
    // Storage events only reach other documents. Tools in this document need the same invalidation signal.
    try {
      if (typeof globalThis.window?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
        globalThis.window.dispatchEvent(new CustomEvent('personal-growth:changed', {detail:{key, profile:structuredClone(profile), revision:storage.getItem(key)}}));
      }
    } catch { /* Notification errors must not turn a successful durable save into a reported failure. */ }
  };
  const checkServer = () => assertAccountServer(context.serverId, context);
  const inventory = value => {
    if (!object(value) || !Array.isArray(value.memberCardIds) || !Array.isArray(value.supportCardIds)) throw Error('卡库格式无效');
    // Revalidate every ID and level against the current content before migrating a release.
    return manager.validate({...value, sourceReleaseId:rules.sourceReleaseId});
  };
  function account(value = {}) {
    if (!object(value)) throw Error('账号养成格式无效');
    const result = {};
    for (const field of accountFields) {
      if (!Object.hasOwn(value, field)) continue;
      if (field === 'bandItemTotals') { result[field]=validateBandItemTotals(rules,value[field]);continue; }
      if (field === 'tgwCardRank') {
        const n = value[field];
        if (!Number.isSafeInteger(n) || n < 1 || n > 1000 || !vipRanks.some(r => r.rank === n)) throw Error('TGW 等级无效');
        result[field] = n; continue;
      }
      if (!object(value[field]) || Object.keys(value[field]).length > 10000) throw Error('账号养成记录无效');
      result[field] = {};
      for (const [id, level] of Object.entries(value[field])) {
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !Number.isSafeInteger(level)) throw Error('养成 ID 或等级无效');
        if (field === 'bandItems') {
          if (!rules.tables.BandItem.some(r => r._id === Number(id)) || level < 0 || (level > 0 && !rules.tables.BandItemSkillEffect.some(r => r._bandItemId === Number(id) && r._level === level))) throw Error(`乐器 ${id} 等级无效`);
        } else if (!rules.tables.Character.some(r => r._id === Number(id)) || !rules.tables.CharacterRank.some(r => r._rank === level)) throw Error(`角色 ${id} 评级无效`);
        result[field][id] = level;
      }
    }
    return result;
  }
  const empty = () => ({format:PERSONAL_GROWTH_FORMAT, schemaVersion:1, ...context, inventory:manager.empty(), account:{}});
  function validate(value) {
    checkServer();
    if (!object(value) || value.format !== PERSONAL_GROWTH_FORMAT || value.schemaVersion !== 1 || !object(value.account)) throw Error('请选择版本 1 的个人养成备份');
    assertAccountServer(value.serverId, context);
    if (value.region !== context.region) throw Error('养成文件版本与当前区服不匹配');
    return {...empty(), inventory:inventory(value.inventory), account:account(value.account)};
  }
  function legacy(kind) {
    const prefix = `ournotes:${kind}:${context.region}:${context.serverId}:`;
    const exact = storage.getItem(prefix + rules.sourceReleaseId);
    if (exact !== null) return JSON.parse(exact);
    const keys = [];
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k?.startsWith(prefix)) keys.push(k); }
    if (keys.length > 1) throw Error('发现多个旧版本的养成，请先从原卡库导出，再选择需要的备份导入；旧记录未修改。');
    return keys.length ? JSON.parse(storage.getItem(keys[0])) : null;
  }
  function read() {
    checkServer();
    const raw = storage.getItem(key);
    if (raw !== null) return validate(JSON.parse(raw));
    const oldInventory = legacy('inventory'), oldGrowth = legacy('account-growth');
    const converted = oldGrowth ? convertGrowthSnapshot(oldGrowth, rules, vipRanks) : null;
    if(converted)assertAccountServer(converted.safeSnapshot.source.serverId,context);
    if(oldInventory?.serverId)assertAccountServer(oldInventory.serverId,context);
    if (!oldInventory && !converted) return null;
    return {...empty(), inventory:oldInventory ? inventory(oldInventory) : converted.inventory, account:account(converted?.modifiers)};
  }
  function save(value) {
    const next = validate(value);
    storage.setItem(key, JSON.stringify(next)); // Single atomic write; legacy backups are never deleted.
    notify(next);
    return next;
  }
  function fromImport(value) {
    checkServer();
    if (value?.format === PERSONAL_GROWTH_FORMAT) return validate(value);
    if (value?.format === 'ournotes-growth-snapshot') {
      const converted = convertGrowthSnapshot(value, rules, vipRanks);
      assertAccountServer(converted.safeSnapshot.source.serverId, context);
      const previous={...(read()?.account??{})};
      if(Object.hasOwn(converted.modifiers,'bandItems'))delete previous.bandItemTotals;
      return {...empty(), inventory:converted.inventory, account:{...previous,...account(converted.modifiers)}};
    }
    assertAccountServer(value?.serverId, context);
    return {...empty(), inventory:inventory(value), account:read()?.account ?? {}};
  }
  return {key, empty, read, save, validate, fromImport,
    checkpoint() { return storage.getItem(key); },
    restore(checkpoint) {
      checkServer(); if(checkpoint===null)storage.removeItem(key);else storage.setItem(key,checkpoint);
      // Restoring a previously corrupt backup is supported; consumers must re-read and show the error.
      let profile=null;try {profile=read();}catch {}
      notify(profile);
    },
    saveInventory(value) { return save({...read() ?? empty(), inventory:value}); },
    saveAccount(value) { return save({...read() ?? empty(), account:account(value)}); }
  };
}

/** Saved values fill missing inputs; shared links and explicit scenario edits remain authoritative. */
export function applyPersonalGrowth(draft, profile) {
  if (!profile) return draft;
  const existing = draft.modifiers ?? {};
  const saved = growthModifiersForDraft({modifiers:{...profile.account, growth:profile.inventory.growth}}, draft);
  if(Object.hasOwn(existing,'bandItems'))delete saved.bandItemTotals;
  const growth = {...saved.growth};
  for (const [id, values] of Object.entries(existing.growth ?? {})) growth[id] = {...growth[id], ...values};
  draft.modifiers = {...saved, ...existing, growth};
  return draft;
}
