import {currentServerContext, assertAccountServer} from './game-servers.mjs';

export const PLAYLIST_FORMAT = 'otonote-playlist-workspace';
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function normalizePlaylistEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 10000) throw Error('歌单最多包含 10000 个歌曲条目');
  const songs = new Map();
  for (const entry of entries) {
    if (!object(entry) || !/^music-[1-9]\d*$/.test(entry.trackId)) throw Error('歌单歌曲 ID 无效');
    const ds = entry.difficulties;
    if (ds !== 'all' && (!Array.isArray(ds) || !ds.length || ds.length > 32 || ds.some(d => typeof d !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(d)))) throw Error('请选择歌曲难度');
    const previous = songs.get(entry.trackId);
    songs.set(entry.trackId, ds === 'all' || previous === 'all' ? 'all' : [...new Set([...(previous ?? []), ...ds])].sort());
  }
  return [...songs].map(([trackId,difficulties]) => ({trackId,difficulties}));
}
export function entriesFromCharts(charts) {
  return normalizePlaylistEntries(charts.map(c => ({trackId:c.trackId,difficulties:[c.difficulty]})));
}
export function createPlaylistStore({context = currentServerContext(), storage, locks = globalThis.window?.navigator?.locks} = {}) {
  storage ??= {getItem:k=>globalThis.localStorage.getItem(k),setItem:(k,v)=>globalThis.localStorage.setItem(k,v)};
  const key = `ournotes:playlists:${context.region}:${context.serverId ?? 'unselected'}`;
  let observed;
  const empty = () => ({format:PLAYLIST_FORMAT,schemaVersion:1,...context,revision:0,playlists:[]});
  function validate(value) {
    assertAccountServer(context.serverId,context);
    if (!object(value) || value.format !== PLAYLIST_FORMAT || value.schemaVersion !== 1 || !Array.isArray(value.playlists) || value.playlists.length > 100) throw Error('请选择版本 1 的歌单备份（最多 100 份歌单）');
    assertAccountServer(value.serverId,context);
    if (value.region !== context.region) throw Error('歌单备份与当前区服不匹配');
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('歌单修订号无效');
    const ids = new Set();
    const playlists = value.playlists.map(p => {
      if (!object(p) || typeof p.id !== 'string' || !p.id || p.id.length > 200 || ids.has(p.id)) throw Error('歌单 ID 无效或重复');
      ids.add(p.id);
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name || name.length > 80) throw Error('歌单名称应为 1–80 字');
      if (!Number.isSafeInteger(p.revision) || p.revision < 1) throw Error('歌单修订号无效');
      return {id:p.id,name,revision:p.revision,entries:normalizePlaylistEntries(p.entries),
        note:typeof p.note === 'string' ? p.note.slice(0,500) : '',
        createdAt:typeof p.createdAt === 'string' ? p.createdAt : '',updatedAt:typeof p.updatedAt === 'string' ? p.updatedAt : ''};
    });
    return {...empty(),revision:value.revision,playlists};
  }
  function load() { const raw = storage.getItem(key); return raw === null ? empty() : validate(JSON.parse(raw)); }
  function read() { const state = load(); observed = state.revision; return state; }
  const conflict = () => Object.assign(Error('歌单已在其他页面更新，请重新载入或另存为新歌单'),{code:'revision_conflict'});
  async function mutate(change,{expectedRevision=observed}={}) {
    const write = () => {
      const previous = load(), raw = storage.getItem(key);
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw conflict();
      const next = validate({...change(clone(previous)),revision:previous.revision+1});
      if (storage.getItem(key) !== raw) throw conflict();
      storage.setItem(key,JSON.stringify(next));observed=next.revision;
      try { globalThis.dispatchEvent?.(new CustomEvent('playlists:changed',{detail:{key,revision:next.revision}})); } catch { /* Saving succeeded. */ }
      return next;
    };
    return locks?.request ? locks.request(key,write) : write();
  }
  return {key,context,read,validate,
    save({id,name,entries,note='',expectedRevision}) {
      return mutate(state => {
        const i = id == null ? -1 : state.playlists.findIndex(p=>p.id===id);
        if (id != null && i < 0) throw Error('歌单已删除，请另存为新歌单');
        const previous=state.playlists[i],now=new Date().toISOString();
        const p={id:id??globalThis.crypto.randomUUID(),name,note,entries,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??now,updatedAt:now};
        if(i<0)state.playlists.push(p);else state.playlists[i]=p;return state;
      },{expectedRevision});
    },
    remove(id,options) {return mutate(state=>{if(!state.playlists.some(p=>p.id===id))throw Error('歌单已删除');state.playlists=state.playlists.filter(p=>p.id!==id);return state;},options);},
    restore(value,options) {const restored=validate(value);return mutate(()=>restored,options);},
    importWorkspace(value,options={}) {const imported=validate(typeof value==='string'?JSON.parse(value):value);return mutate(state=>({...state,playlists:[...state.playlists,...imported.playlists.map(p=>({...p,id:crypto.randomUUID()}))]}),options);},
    exportWorkspace:read
  };
}
