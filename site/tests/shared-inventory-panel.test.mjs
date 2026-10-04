import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inventoryImportDelta} from '../src/lib/shared-inventory-panel.mjs';
import {createPersonalGrowthStore} from '../src/lib/personal-growth-store.mjs';
import {createInventoryManager} from '../src/lib/inventory-manager.mjs';

const rules=JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json',import.meta.url)));
const context={region:'global',serverId:'global-hmt'};
function setup(){
  const values=new Map(),storage={get length(){return values.size;},key:i=>[...values.keys()][i],getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const store=createPersonalGrowthStore({rules,context,storage,vipRanks:[{rank:1}]});
  return {store,storage};
}
test('replacement preview counts additions, removals and actual growth changes independently',()=>{
  const manager=createInventoryManager(rules),before={inventory:manager.batch(manager.empty(),['member-card-1','support-card-1'])};
  const after={inventory:manager.batch(manager.empty(),['member-card-1','member-card-2'],{patch:{level:2}})};
  const snapshot=structuredClone(before);
  assert.deepEqual(inventoryImportDelta(before,after),{member:{count:2,added:1,removed:0,changed:1},support:{count:0,added:0,removed:1,changed:0}});
  assert.deepEqual(before,snapshot);
  assert.deepEqual(inventoryImportDelta(null,after).member,{count:2,added:2,removed:0,changed:0});
});
test('successful saves and undo notify same-page tools; failed writes never send success',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window');const target=new EventTarget();Object.defineProperty(globalThis,'window',{value:target,configurable:true});
  try{
    const {store,storage}=setup(),events=[];target.addEventListener('personal-growth:changed',event=>events.push(event.detail));
    const saved=store.saveAccount({tgwCardRank:1});
    assert.equal(events.length,1);assert.equal(events[0].key,store.key);assert.deepEqual(events[0].profile,saved);assert.equal(events[0].revision,store.checkpoint());
    const checkpoint=store.checkpoint();store.saveInventory(createInventoryManager(rules).empty());store.restore(checkpoint);
    assert.equal(events.length,3);assert.equal(events[2].revision,checkpoint);
    storage.setItem=()=>{throw Error('quota');};assert.throws(()=>store.saveAccount({}),/quota/);assert.equal(events.length,3);
    store.restore(null);assert.equal(events.length,4);assert.equal(events[3].profile,null);assert.equal(events[3].revision,null);
  }finally{if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
});
test('import validation and notification do not create or alter a named-team store',()=>{
  const {store,storage}=setup(),teamKey='ournotes:teams:global:global-hmt';storage.setItem(teamKey,'named teams');
  const imported=store.fromImport({...store.empty(),inventory:createInventoryManager(rules).batch(createInventoryManager(rules).empty(),['member-card-1'])});
  assert.equal(store.read(),null);store.save(imported);assert.equal(storage.getItem(teamKey),'named teams');
  const corrupt=structuredClone(imported);corrupt.inventory.growth['member-card-1'].level=99999;
  assert.throws(()=>store.fromImport(corrupt));assert.deepEqual(store.read(),imported);assert.equal(storage.getItem(teamKey),'named teams');
});
