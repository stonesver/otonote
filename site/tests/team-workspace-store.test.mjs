import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTeamWorkspaceStore} from '../src/lib/team-workspace-store.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
const rules = JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json', import.meta.url)));
const context = {region:'global', serverId:'global-hmt'};
const draft = () => createTeamDraft({slots:[1,2,3,4,5].map(id => ({memberCardId:`member-card-${id}`,supportCardId:`support-card-${id}`}))});
function memory(){const entries=new Map();return {get length(){return entries.size;},key:i=>[...entries.keys()][i],getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)};}
function setup(storage=memory(),options={}) {return {storage,store:createTeamWorkspaceStore({rules,context,storage,...options})};}

test('named teams have stable identity; identical names/cards create independent records', () => {
 const {store}=setup();assert.equal(store.read().revision,0);
 const first=store.saveTeam({name:'同名',draft:draft()}).teams[0];
 const next=store.saveTeam({name:'同名',draft:draft()});assert.equal(next.teams.length,2);assert.notEqual(next.teams[0].id,next.teams[1].id);
 const renamed=store.saveTeam({...first,name:'改名'});assert.equal(renamed.teams[0].id,first.id);assert.equal(renamed.teams[0].name,'改名');
 assert.deepEqual(renamed.teams[0].draft.modifiers,{}); // Never fill unknown growth with calculator defaults.
});
test('durable keys revalidate against a new content version without losing pairing and reference flags', () => {
 const {store,storage}=setup();const d=draft();d.modifiers.planningScenario={scope:'reference',sourceReleaseId:rules.sourceReleaseId};d.modifiers.growth={'member-card-1':{level:2}};
 store.saveTeam({name:'参考',draft:d});
 const updated=setup(storage,{rules:{...rules,sourceReleaseId:'new-content'}}).store;
 assert.equal(updated.key,store.key);assert.equal(updated.read().teams[0].sourceReleaseId,'new-content');const migrated=updated.read().teams[0].draft;assert.equal(migrated.modifiers.planningScenario.sourceReleaseId,'new-content');assert.deepEqual(migrated.slots,d.slots);assert.deepEqual(migrated.modifiers.growth,d.modifiers.growth);
 const stale=store.checkpoint(); const unknown=draft();unknown.slots[0].memberCardId='member-card-999999';
 assert.throws(()=>store.saveTeam({name:'新卡',draft:unknown}),/内容/);assert.equal(store.checkpoint(),stale);
});
test('recent draft can be incomplete while saved teams require all five pairs', () => {
 const {store}=setup();const incomplete=createTeamDraft();store.setRecentDraft(incomplete);
 assert.deepEqual(store.read().recentDraft,incomplete);assert.throws(()=>store.saveTeam({name:'未完成',draft:incomplete}),/尚未选择/);
});
test('stale tabs cannot overwrite or delete; refresh enables an explicit retry', () => {
 const {store,storage}=setup();const second=setup(storage).store;store.read();second.read();
 const first=store.saveTeam({name:'一队',draft:draft()});
 assert.throws(()=>second.saveTeam({name:'二队',draft:draft()}),{code:'revision_conflict'});
 second.read();second.saveTeam({name:'二队',draft:draft()});
 assert.throws(()=>store.removeTeam(first.teams[0].id),{code:'revision_conflict'});
 const current=store.read();assert.throws(()=>store.setRecentDraft(draft(),{expectedRevision:0}),{code:'revision_conflict'});
 assert.equal(store.read().teams.length,2);assert.equal(store.read().revision,current.revision);
});
test('explicit legacy selection appends teams atomically and keeps every original backup', () => {
 const {store,storage}=setup(); const keys=['one','two'].map(version=>`ournotes:presets:global:global-hmt:${version}`);
 for(const key of keys)storage.setItem(key,JSON.stringify({schemaVersion:1,...context,sourceReleaseId:key,candidates:[{id:'old-id',name:key,draft:draft()}]}));
 assert.equal(store.read().teams.length,0);assert.equal(store.listLegacy().length,2);
 const before=keys.map(key=>storage.getItem(key));const migrated=store.migrateLegacy(keys[1]);
 assert.equal(migrated.teams.length,1);assert.equal(migrated.teams[0].name,keys[1]);assert.notEqual(migrated.teams[0].id,'old-id');
 assert.deepEqual(keys.map(key=>storage.getItem(key)),before);
 assert.throws(()=>store.migrateLegacy('ournotes:presets:global:global-en:one'),/当前区服/);
});
test('backup import, deletion undo, and recent draft preserve complete state with increasing revisions', () => {
 const {store}=setup();store.saveTeam({name:'一队',draft:draft()});store.setRecentDraft(draft());const backup=store.exportWorkspace();
 const second=setup().store;second.importWorkspace(JSON.stringify(backup));assert.deepEqual(second.read().teams,backup.teams);assert.deepEqual(second.read().recentDraft,backup.recentDraft);
 const before=second.checkpoint();const after=second.removeTeam(backup.teams[0].id);const restored=second.restore(before);
 assert.equal(restored.revision,after.revision+1);assert.deepEqual(restored.teams,backup.teams);
 second.restore(null);assert.equal(second.read().teams.length,0);assert.equal(second.read().recentDraft,null);
});
test('invalid data, quota failures, wrong servers, and duplicates never partially write', () => {
 const {store,storage}=setup();store.saveTeam({name:'完整',draft:draft()});const before=store.checkpoint();
 for(const mutate of [v=>v.teams[0].draft.modifiers.growth={'member-card-1':{level:99999}},v=>v.teams.push(v.teams[0]),v=>v.teams[0].name='',v=>v.serverId='global-en']){
  const value=store.read();mutate(value);assert.throws(()=>store.importWorkspace(value));assert.equal(store.checkpoint(),before);
 }
 const other=setup(storage,{context:{region:'jp',serverId:'jp'}}).store;assert.equal(other.read().teams.length,0);assert.throws(()=>other.fromImport(store.read()),/区服/);
 assert.throws(()=>setup(storage,{context:{region:'global',serverId:null}}).store.read(),/选择/);
 storage.setItem=()=>{throw Error('quota');};assert.throws(()=>store.saveTeam({name:'不能保存',draft:draft()}),/quota/);assert.equal(store.checkpoint(),before);
});
test('storage notifications include key and committed revision, with no notification on failure', () => {
 const oldDispatch=globalThis.dispatchEvent; const events=[];globalThis.dispatchEvent=event=>events.push(event);
 try {const {store}=setup();store.saveTeam({name:'一队',draft:draft()});assert.equal(events.length,1);assert.equal(events[0].type,'team-workspace:changed');assert.deepEqual(events[0].detail,{key:store.key,revision:1});assert.throws(()=>store.saveTeam({name:'',draft:draft()}));assert.equal(events.length,1);}
 finally {if(oldDispatch)globalThis.dispatchEvent=oldDispatch;else delete globalThis.dispatchEvent;}
});

test('a validated replacement backup recovers corrupted storage without partial imports', () => {
 const {store,storage}=setup();storage.setItem(store.key,'invalid-json');
 assert.throws(()=>store.read());const value=store.empty();value.teams=[{id:'recovered',name:'恢复',draft:draft()}];
 const valid=store.fromImport(value);assert.equal(storage.getItem(store.key),'invalid-json');
 store.importWorkspace(valid);assert.equal(store.read().teams[0].name,'恢复');
});
