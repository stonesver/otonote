import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTeamDraft,parseTeamDraftSearch} from '../src/lib/team-draft.mjs';
import {createPersonalGrowthStore} from '../src/lib/personal-growth-store.mjs';
import {registerToolTeamContext,refreshToolTeamGrowth,toolTeamInputState} from '../src/lib/shared-team-context.mjs';
const rules=JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json',import.meta.url)));
const context={region:'global',serverId:'global-hmt'};
function environment(t){
 const entries=new Map(),doc=new EventTarget(),win=new EventTarget(),cleanups=[];
 const values={window:win,document:doc,location:{pathname:'/global/zh-CN/tools/song-calculator/',search:'?server=global-hmt'},localStorage:{getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key),get length(){return entries.size;},key:i=>[...entries.keys()][i]},dispatchEvent:event=>win.dispatchEvent(event)};
 const old=Object.fromEntries(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 t.after(()=>{for(const cleanup of cleanups)cleanup();for(const key of Object.keys(values)){if(old[key])Object.defineProperty(globalThis,key,old[key]);else delete globalThis[key];}});
 const personal=createPersonalGrowthStore({rules,context}),profile=personal.empty();
 for(const kind of ['member','support'])for(let id=1;id<=5;id++){const key=`${kind}-card-${id}`;profile.inventory[`${kind}CardIds`].push(key);profile.inventory.growth[key]={level:1,rank:1,...kind==='member'?{awake:1,skillLevel:1,gekisouSkillLevel:1}:{}};}
 personal.save(profile);
 function adapter(initial=createTeamDraft()){
  let draft=structuredClone(initial);const host=new EventTarget();host.querySelector=()=>null;
  const cleanup=registerToolTeamContext(host,{rules,data:{vipRanks:[]},getDraft:()=>draft,applyDraft:next=>{draft=next;},invalidate:()=>{}});cleanups.push(cleanup);
  return {context:host.teamWorkspaceContext,get draft(){return draft;},cleanup};
 }
 return {win,personal,profile,adapter};
}
function team(inventory,scope='selected'){
 const draft=createTeamDraft({slots:[1,2,3,4,5].map(id=>({memberCardId:`member-card-${id}`,supportCardId:`support-card-${id}`})),modifiers:{growth:structuredClone(inventory.growth),planningScenario:{schemaVersion:1,sourceReleaseId:rules.sourceReleaseId,scope,unknownGrowth:'exclude'}}});
 draft.modifiers.planningScenario.selectedCardIds={memberCardIds:inventory.memberCardIds,supportCardIds:inventory.supportCardIds};draft.modifiers.growth['member-card-1'].skillLevel=3;return draft;
}
test('selected non-training growth survives apply, actual inventory refresh, and cross-tool recent restore',t=>{
 const {win,personal,profile,adapter}=environment(t),selected=team(profile.inventory),first=adapter();
 first.context.applyDraft(selected);assert.equal(first.draft.modifiers.growth['member-card-1'].skillLevel,3);
 profile.inventory.growth['member-card-1'].skillLevel=2;personal.save(profile);win.dispatchEvent(new CustomEvent('personal-growth:changed',{detail:{key:personal.key}}));
 assert.equal(first.draft.modifiers.growth['member-card-1'].skillLevel,3);assert.equal(personal.read().inventory.growth['member-card-1'].skillLevel,2);
 first.cleanup();const next=adapter();assert.equal(next.draft.modifiers.growth['member-card-1'].skillLevel,3);
 const initialSongRefresh=refreshToolTeamGrowth(rules,next.draft,personal.read().inventory);assert.equal(initialSongRefresh.draft.modifiers.growth['member-card-1'].skillLevel,3);
});
test('disabled cultivation metadata still preserves selected values, while current teams refresh actual levels',t=>{
 const {personal,profile,adapter,win}=environment(t),selected=team(profile.inventory);selected.modifiers.planningScenario.plan={enabled:false};
 assert.equal(refreshToolTeamGrowth(rules,selected,profile.inventory).draft.modifiers.growth['member-card-1'].skillLevel,3);
 const page=adapter();page.context.applyDraft(team(profile.inventory,'owned'));assert.equal(page.draft.modifiers.growth['member-card-1'].skillLevel,1);
 profile.inventory.growth['member-card-1'].skillLevel=2;personal.save(profile);win.dispatchEvent(new CustomEvent('personal-growth:changed',{detail:{key:personal.key}}));assert.equal(page.draft.modifiers.growth['member-card-1'].skillLevel,2);
});
test('song input state clears obsolete shared-card errors and changes reference notes with the applied formation',t=>{
 const {profile}=environment(t),known={memberCardIds:new Set(profile.inventory.memberCardIds),supportCardIds:new Set(profile.inventory.supportCardIds),musicTrackIds:new Set(['music-1'])};
 const old=parseTeamDraftSearch('?members=member-card-999999&song=music-1',known);assert.ok(old.issues.some(issue=>issue.code==='unknown_member_card'));
 const actual=team(profile.inventory,'owned');actual.selectedSongId='music-1';const valid=toolTeamInputState(actual,known);assert.deepEqual(valid.inputIssues,[]);assert.equal(valid.growthIsReference,false);
 const reference=structuredClone(actual);reference.modifiers.planningScenario.scope='reference';assert.equal(toolTeamInputState(reference,known).growthIsReference,true);
 const missing=structuredClone(actual);delete missing.modifiers.growth['member-card-1'].level;assert.equal(toolTeamInputState(missing,known).growthIsReference,true);
 assert.equal(toolTeamInputState(actual,known).growthIsReference,false);
 const invalidSong=structuredClone(actual);invalidSong.selectedSongId='music-999999';assert.ok(toolTeamInputState(invalidSong,known).inputIssues.some(issue=>issue.code==='unknown_song'));
});
