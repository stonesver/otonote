import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedTeamRules} from './fixtures/shared-team-rules.mjs';
import {createInventoryManager} from '../src/lib/inventory-manager.mjs';
import {prepareInventoryBatch} from '../src/lib/shared-inventory-batch.mjs';
const manager=createInventoryManager(createSharedTeamRules());
test('batch defaults preserve existing growth, deduplicate selection and validate mixed card kinds',()=>{
 const before=manager.batch(manager.empty(),['member-card-1'],{patch:{level:2}}),copy=structuredClone(before);
 const result=prepareInventoryBatch(manager,before,['member-card-1','member-card-2','support-card-1','member-card-2'],{mode:'custom',patch:{level:3,skillLevel:4}});
 assert.deepEqual(result.inventory.growth['member-card-1'],copy.growth['member-card-1']);
 assert.equal(result.inventory.growth['member-card-2'].skillLevel,4);assert.equal(result.inventory.growth['support-card-1'].level,3);
 assert.equal('skillLevel' in result.inventory.growth['support-card-1'],false);
 assert.deepEqual([result.added,result.updated,result.kept],[2,0,1]);assert.deepEqual(before,copy);
});
test('updating recorded cards is explicit and presets use each card rules',()=>{
 const before=manager.batch(manager.empty(),['member-card-1']);
 const result=prepareInventoryBatch(manager,before,['member-card-1','support-card-1'],{mode:'maximum',updateExisting:true});
 assert.deepEqual(result.inventory.growth['member-card-1'],manager.preset('member-card-1','member','maximum'));
 assert.deepEqual(result.inventory.growth['support-card-1'],manager.preset('support-card-1','support','maximum'));
 assert.deepEqual([result.added,result.updated,result.kept],[1,1,0]);
});
test('invalid growth rejects the whole batch without mutating original inventory',()=>{
 const before=manager.empty(),copy=structuredClone(before);
 assert.throws(()=>prepareInventoryBatch(manager,before,['member-card-1','support-card-1'],{mode:'custom',patch:{level:99999}}));
 assert.throws(()=>prepareInventoryBatch(manager,before,['member-card-1'],{mode:''}),/请选择/);
 assert.deepEqual(before,copy);
});
