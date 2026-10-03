import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPersonalGrowthStore,applyPersonalGrowth,PERSONAL_GROWTH_FORMAT} from '../src/lib/personal-growth-store.mjs';
import {createInventoryManager} from '../src/lib/inventory-manager.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
const rules=JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json',import.meta.url)));
const vipRanks=[{rank:1,requiredPoints:0},{rank:2,requiredPoints:2000}];
const context={region:'global',serverId:'global-hmt'};
function memory(){const entries=new Map();return {get length(){return entries.size;},key:i=>[...entries.keys()][i],getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};}
function setup(storage=memory(),extra={}){return {storage,store:createPersonalGrowthStore({rules,vipRanks,context,storage,...extra})};}
const inventory=()=>createInventoryManager(rules).batch(createInventoryManager(rules).empty(),['member-card-1','support-card-1'],{patch:{level:2}});
const snapshot=()=>({format:'ournotes-growth-snapshot',schemaVersion:1,source:{region:'TW/HK/MO'},coverage:{memberCards:'observed',supportCards:'observed',bandItems:'observed',characterRanks:'observed',tgw:'observed'},growth:{memberCards:[{masterId:1,exp:70,cardRank:1,awakeCount:1,liveSkillLevel:2,gekisouSkillLevel:3}],supportCards:[{masterId:1,exp:0,cardRank:1,duplicateCount:0}],bandItems:[],characterRanks:[{characterId:1,exp:1}],tgw:{point:2000}}});

test('full backup preserves manual card changes and account bonuses across fresh tool instances',()=>{
 const {store,storage}=setup();store.save(store.fromImport(snapshot()));
 const edited=store.read().inventory;edited.growth['member-card-1'].skillLevel=4;store.saveInventory(edited);
 const json=JSON.parse(JSON.stringify(store.read()));assert.equal(json.format,PERSONAL_GROWTH_FORMAT);
 const second=setup().store;second.save(second.fromImport(json));
 assert.equal(second.read().inventory.growth['member-card-1'].skillLevel,4);
 assert.equal(second.read().account.tgwCardRank,2);
 assert.equal(setup(storage).store.read().account.characterRanks[1],2);
});
test('legacy release migration revalidates cards and leaves originals intact',()=>{
 const {store,storage}=setup();const old={...inventory(),sourceReleaseId:'old-release'};
 const key='ournotes:inventory:global:global-hmt:old-release';storage.setItem(key,JSON.stringify(old));
 const migrated=store.read();assert.equal(migrated.inventory.sourceReleaseId,rules.sourceReleaseId);
 store.save(migrated);assert.deepEqual(JSON.parse(storage.getItem(key)),old);
 const updated=setup(storage,{rules:{...rules,sourceReleaseId:'next-release'}}).store;
 assert.equal(updated.key,store.key);assert.equal(updated.read().inventory.sourceReleaseId,'next-release');
});
test('ambiguous old versions require explicit selection; a valid full backup can recover',()=>{
 const {store,storage}=setup();for(const version of ['one','two'])storage.setItem(`ournotes:inventory:global:global-hmt:${version}`,JSON.stringify(inventory()));
 assert.throws(()=>store.read(),/多个旧版本/);
 store.save({...store.empty(),inventory:inventory()});assert.equal(store.read().inventory.memberCardIds.length,1);
});
test('server identities isolate profiles and reject mismatched imports',()=>{
 const {store,storage}=setup();store.save({...store.empty(),inventory:inventory()});
 const other=setup(storage,{context:{region:'jp',serverId:'jp'}}).store;
 assert.equal(other.read(),null);assert.throws(()=>other.fromImport(store.read()),/区服/);
 assert.throws(()=>other.fromImport(snapshot()),/区服/);
 assert.throws(()=>setup(storage,{context:{region:'global',serverId:null}}).store.read(),/选择/);
});
test('invalid import and storage quota failures preserve the last complete profile',()=>{
 const {store,storage}=setup();store.save({...store.empty(),inventory:inventory()});const before=storage.getItem(store.key);
 const bad=store.read();bad.inventory.growth['member-card-1'].level=99999;
 assert.throws(()=>store.save(bad));assert.equal(storage.getItem(store.key),before);
 storage.setItem=()=>{throw Error('quota');};assert.throws(()=>store.saveAccount({tgwCardRank:2}),/quota/);
 assert.equal(storage.getItem(store.key),before);
});
test('whitelists backup fields and rejects malformed account levels',()=>{
 const {store}=setup();const value={...store.empty(),password:'SECRET',account:{tgwCardRank:2,token:'SECRET'},inventory:{...inventory(),token:'SECRET'}};
 const result=store.validate(value);assert.equal(JSON.stringify(result).includes('SECRET'),false);
 for(const account of [{tgwCardRank:99},{bandItems:{1:-1}},{characterRanks:{1:999999}},{characterRanks:JSON.parse('{"__proto__":2}')}]){
  assert.throws(()=>store.validate({...value,account}));
 }
});
test('personal defaults fill selected cards while explicit shared parameters win',()=>{
 const {store}=setup();const profile=store.fromImport(snapshot());
 const draft=createTeamDraft({slots:[{memberCardId:'member-card-1'}],modifiers:{tgwCardRank:1,growth:{'member-card-1':{level:1}},memoryBonuses:{1:30}}});
 applyPersonalGrowth(draft,profile);assert.equal(draft.modifiers.tgwCardRank,1);assert.equal(draft.modifiers.growth['member-card-1'].level,1);
 assert.equal(draft.modifiers.growth['member-card-1'].skillLevel,2);assert.equal(draft.modifiers.memoryBonuses[1],30);
 assert.equal(draft.modifiers.growth['support-card-1'],undefined);
 assert.equal(profile.inventory.growth['member-card-1'].level,2);
});

test('full import can replace unreadable storage and undo restores the exact prior record',()=>{
 const {store,storage}=setup();storage.setItem(store.key,'broken');const before=store.checkpoint();
 assert.throws(()=>store.read());store.save({...store.empty(),inventory:inventory()});
 assert.equal(store.read().inventory.memberCardIds.length,1);store.restore(before);assert.equal(storage.getItem(store.key),'broken');
 store.restore(null);assert.equal(store.read(),null);
});


test('observed instrument imports replace aggregate overrides; missing observations preserve them',()=>{
 const {store}=setup();store.saveAccount({bandItemTotals:{1:50},bandItems:{101:7}});
 const observed=snapshot();observed.growth.bandItems=[{masterId:101,level:3}];
 const imported=store.fromImport(observed);
 assert.equal(imported.account.bandItemTotals,undefined);
 assert.deepEqual(imported.account.bandItems,{101:3});
 const partial=snapshot();partial.coverage.bandItems='not_observed';partial.growth.bandItems=null;
 const retained=store.fromImport(partial);
 assert.deepEqual(retained.account.bandItemTotals,{1:50});
 assert.deepEqual(retained.account.bandItems,{101:7});
});
