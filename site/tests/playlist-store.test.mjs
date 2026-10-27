import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaylistStore,normalizePlaylistEntries,entriesFromCharts} from '../src/lib/playlist-store.mjs';
const context={region:'global',serverId:'global-hmt'};
const entry={trackId:'music-1',difficulties:['expert']};
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};};
test('create, rename, copy and import preserve identities and never overwrite by name',async()=>{
 const store=createPlaylistStore({context,storage:memory()});store.read();
 const first=(await store.save({name:'常打',entries:[entry]})).playlists[0];
 await store.save({name:'常打',entries:[entry]});assert.equal(store.read().playlists.length,2);
 await store.save({...first,name:'新名字'});assert.equal(store.read().playlists[0].id,first.id);
 const original=store.exportWorkspace();await store.importWorkspace(JSON.stringify(original));
 assert.equal(store.read().playlists.length,4);assert.equal(new Set(store.read().playlists.map(p=>p.id)).size,4);
});
test('unknown content is retained, entries deduplicate, all difficulty is explicit',()=>{
 assert.deepEqual(normalizePlaylistEntries([entry,{trackId:'music-1',difficulties:['hard']},entry]),[{trackId:'music-1',difficulties:['expert','hard']}]);
 assert.deepEqual(normalizePlaylistEntries([entry,{trackId:'music-1',difficulties:'all'}]),[{trackId:'music-1',difficulties:'all'}]);
 assert.deepEqual(entriesFromCharts([{trackId:'music-999999',difficulty:'future'}]),[{trackId:'music-999999',difficulties:['future']}]);
});
test('stale editor cannot save, delete or undo over a later revision',async()=>{
 const storage=memory(),a=createPlaylistStore({context,storage}),b=createPlaylistStore({context,storage});a.read();b.read();
 const saved=await a.save({name:'A',entries:[entry]});
 await assert.rejects(b.save({name:'B',entries:[]}),{code:'revision_conflict'});b.read();await b.remove(saved.playlists[0].id);
 await assert.rejects(a.restore(saved),{code:'revision_conflict'});a.read();await a.restore(saved);assert.equal(a.read().playlists.length,1);
});
test('wrong server, malformed data and quota failures leave storage intact',async()=>{
 const storage=memory(),store=createPlaylistStore({context,storage});await store.save({name:'A',entries:[entry]});const raw=storage.getItem(store.key),backup=store.read();
 assert.throws(()=>store.validate({...backup,serverId:'global-en'}),/区服/);
 await assert.rejects(store.save({name:' ',entries:[]}),/名称/);
 await assert.rejects(store.save({name:'A',entries:[{trackId:'bad',difficulties:['expert']}]}),/ID/);
 assert.equal(storage.getItem(store.key),raw);storage.setItem=()=>{throw Error('quota');};await assert.rejects(store.save({name:'B',entries:[]}),/quota/);assert.equal(storage.getItem(store.key),raw);
});
test('empty playlists are storable; version changes do not erase records',async()=>{
 const storage=memory(),store=createPlaylistStore({context,storage});await store.save({name:'稍后编辑',entries:[]});assert.equal(createPlaylistStore({context,storage}).read().playlists.length,1);
 assert.equal(createPlaylistStore({context:{region:'jp',serverId:'jp'},storage}).read().playlists.length,0);
 const unselected=createPlaylistStore({context:{region:'global',serverId:null},storage});
 assert.deepEqual(unselected.read().playlists,[]); // Public all/recommended scopes need no account.
 await assert.rejects(unselected.save({name:'A',entries:[]}),/选择/);
});
