import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
import {createTeamWorkspaceStore} from '../src/lib/team-workspace-store.mjs';
import {createPersonalGrowthStore} from '../src/lib/personal-growth-store.mjs';
import {registerToolTeamContext,getActiveToolTeamContext,notifyToolTeamChanged,requestTeamSave,hasExplicitTeam} from '../src/lib/shared-team-context.mjs';
const rules=JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json',import.meta.url)));
const context={region:'global',serverId:'global-hmt'};
const team=()=>createTeamDraft({slots:[1,2,3,4,5].map(id=>({memberCardId:`member-card-${id}`,supportCardId:`support-card-${id}`}))});
function environment(t,search='?server=global-hmt'){
 const entries=new Map(),doc=new EventTarget(),win=new EventTarget();
 const values={window:win,document:doc,location:{pathname:'/global/zh-CN/tools/song-calculator/',search},localStorage:{getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key),get length(){return entries.size;},key:i=>[...entries.keys()][i]},dispatchEvent:event=>win.dispatchEvent(event)};
 const old=Object.fromEntries(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 t.after(()=>{for(const key of Object.keys(values)){if(old[key])Object.defineProperty(globalThis,key,old[key]);else delete globalThis[key];}});
 return {entries,doc,win};
}
function adapter(initial=team(),extra={}){
 let draft=structuredClone(initial),invalidations=0;const host=new EventTarget();host.querySelector=()=>null;
 const cleanup=registerToolTeamContext(host,{rules,data:{vipRanks:[]},getDraft:()=>draft,applyDraft:next=>{draft=next;},invalidate:()=>invalidations++,...extra});
 return {cleanup,context:host.teamWorkspaceContext,get draft(){return draft;},set draft(value){draft=value;},get invalidations(){return invalidations;}};
}
test('recent formation restores without importing source song, event, or performance; explicit team URL wins',t=>{
 environment(t);const incoming=team();incoming.slots.reverse();incoming.selectedSongId='music-1';incoming.modifiers={event:{id:1},performanceScenario:{profile:'ideal'}};
 const store=createTeamWorkspaceStore({rules,context});store.setRecentDraft(incoming);
 const current=createTeamDraft({selectedSongId:'music-2',selectedDifficulty:'hard',modifiers:{event:{id:22},performanceScenario:{profile:'practice'}}});
 let page=adapter(current);assert.deepEqual(page.draft.slots,incoming.slots);assert.equal(page.draft.selectedSongId,'music-2');assert.deepEqual(page.draft.modifiers,current.modifiers);assert.equal(page.context.isDirty(),false);page.cleanup();
 globalThis.location.search='?server=global-hmt&members=member-card-1';page=adapter(current);assert.deepEqual(page.draft.slots,current.slots);page.cleanup();
 assert.equal(hasExplicitTeam('?song=music-1'),false);
});
test('applying a team invalidates in-flight work, enforces restrictions, and tracks edits without saving a named team',t=>{
 environment(t);const page=adapter(team(),{getRestrictions:()=>({allowedMemberIds:['member-card-1','member-card-2','member-card-3','member-card-4','member-card-5']})});
 const incoming=team();incoming.slots.reverse();page.context.applyDraft(incoming);assert.equal(page.invalidations,1);assert.equal(page.context.isDirty(),true);
 assert.equal(page.context.store.read().teams.length,0);assert.deepEqual(page.context.store.read().recentDraft.slots,incoming.slots);
 page.context.markSaved();assert.equal(page.context.isDirty(),false);
 const bad=team();bad.slots[0].memberCardId='member-card-6';assert.throws(()=>page.context.applyDraft(bad),/不允许/);assert.equal(page.invalidations,1);assert.deepEqual(page.draft.slots,incoming.slots);page.cleanup();
});
test('inventory changes refresh actual values and invalidate while retaining independent team working copies',t=>{
 const {win}=environment(t);const personal=createPersonalGrowthStore({rules,context});const profile=personal.empty();profile.inventory.memberCardIds=['member-card-1'];profile.inventory.growth={'member-card-1':{level:1,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1}};personal.save(profile);
 const current=team();current.modifiers.growth={'member-card-1':{level:20,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1}};const page=adapter(current);
 profile.inventory.growth['member-card-1'].level=2;personal.save(profile);win.dispatchEvent(new CustomEvent('personal-growth:changed',{detail:{key:personal.key}}));
 assert.equal(page.draft.modifiers.growth['member-card-1'].level,2);assert.equal(page.invalidations,1);
 const other=team();other.slots.reverse();page.context.store.setRecentDraft(other);const event=new Event('storage');event.key=page.context.store.key;win.dispatchEvent(event);
 assert.deepEqual(page.draft.slots,current.slots);assert.equal(page.invalidations,1);page.cleanup();
});
test('quota failure preserves working input and saving a result requests naming without changing inventory',t=>{
 const {doc}=environment(t);const page=adapter();let requested;doc.addEventListener('team-workspace:save',event=>requested=event.detail);
 requestTeamSave(page.draft,'活动队');assert.equal(requested.name,'活动队');assert.notEqual(requested.draft,page.draft);assert.equal(page.context.store.read().teams.length,0);
 globalThis.localStorage.setItem=()=>{throw Error('storage full');};page.draft.slots.reverse();notifyToolTeamChanged(page.context);assert.equal(page.context.error,'storage full');assert.equal(page.draft.slots[0].memberCardId,'member-card-5');
 page.cleanup();assert.equal(getActiveToolTeamContext(),null);
});
