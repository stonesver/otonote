import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createInventoryManager} from '../src/lib/inventory-manager.mjs';
import {recognitionDraft,previewRecognitionImport,assertRecognitionContext} from '../src/lib/card-recognition/inventory.mjs';
const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
const cards=[{id:'member-card-1',kind:'member',name:'角色一'},{id:'member-card-2',kind:'member',name:'角色二'},{id:'support-card-1',kind:'support',name:'留影一'}];
const manager=createInventoryManager(rules,cards),context={region:'global',serverId:'global-hmt'};
const manifest={schemaVersion:1,region:'global',sourceReleaseId:rules.sourceReleaseId,cards};
const row=(key,observations,extra={})=>({key,kind:'member',cardId:'member-card-1',selected:true,observations,...extra});
const run=(rows,inventory=manager.empty())=>previewRecognitionImport({manager,inventory,rows,manifest,context,sourceReleaseId:rules.sourceReleaseId});
test('two screenshots merge one card; training maps to awake, stars to rank; new skills default one',()=>{
  const draft=recognitionDraft([row('training',{training:2,awakeningStars:3}),row('level',{level:10,awakeningStars:3})],manifest);
  assert.equal(draft.length,1);assert.deepEqual(draft[0].patch,{awake:2,rank:3,level:10});
  const result=run(draft);assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.inventory.growth['member-card-1'],{level:10,awake:2,rank:3,skillLevel:1,gekisouSkillLevel:1});
});
test('unobserved existing fields, skills and other cards survive; explicit skill maximum only changes selected card',()=>{
  const inventory=manager.batch(manager.empty(),['member-card-1','member-card-2'],{patch:{level:5,skillLevel:3,gekisouSkillLevel:2}}),before=structuredClone(inventory);
  const draft=recognitionDraft([row('level',{level:10})],manifest);
  const first=run(draft,inventory);
  assert.deepEqual(first.inventory.growth['member-card-1'],{...before.growth['member-card-1'],level:10});
  Object.assign(draft[0].patch,{skillLevel:5,gekisouSkillLevel:5});
  const max=run(draft,inventory);
  assert.equal(max.inventory.growth['member-card-1'].skillLevel,5);
  assert.equal(max.inventory.growth['member-card-1'].gekisouSkillLevel,5);
  assert.deepEqual(max.inventory.growth['member-card-2'],before.growth['member-card-2']);assert.deepEqual(inventory,before);
});
test('new cards require observed or confirmed growth, skills alone may default',()=>{
  const draft=recognitionDraft([row('level',{level:10,awakeningStars:1})],manifest);
  assert.match(run(draft).errors[0],/特训/);assert.equal(run(draft).inventory,null);
  draft[0].patch.awake=1;assert.deepEqual(run(draft).errors,[]);
});
test('conflicts are not silently overwritten by later observations or existing inventory',()=>{
  const draft=recognitionDraft([row('a',{level:10}),row('b',{level:20}),row('c',{level:30})],manifest);
  const inventory=manager.batch(manager.empty(),['member-card-1']);
  assert.equal(draft[0].patch.level,undefined);assert.match(run(draft,inventory).errors[0],/冲突/);
  draft[0].patch.level=20;assert.deepEqual(run(draft,inventory).errors,[]);
});
test('support petals map to rank; invalid or deselected imports never write partial growth',()=>{
  const draft=recognitionDraft([row('support',{level:1,supportPetals:2},{kind:'support',cardId:'support-card-1'})],manifest);
  assert.deepEqual(run(draft).inventory.growth['support-card-1'],{level:1,rank:2});
  draft[0].patch.level=100;assert.equal(run(draft).inventory,null);
  draft[0].selected=false;assert.equal(run(draft).inventory,null);
});
test('wrong region, release, unknown ID, fractional skill and level beyond training cap fail closed',()=>{
  assert.throws(()=>assertRecognitionContext({...manifest,region:'jp'},context,rules.sourceReleaseId));
  assert.throws(()=>assertRecognitionContext(manifest,context,'other'));
  assert.throws(()=>assertRecognitionContext(manifest,{region:'global'},rules.sourceReleaseId));
  const draft=recognitionDraft([row('a',{level:1,training:1,awakeningStars:1})],manifest);
  draft[0].patch.skillLevel=1.5;assert.equal(run(draft).inventory,null);
  draft[0].patch.skillLevel=1;draft[0].patch.level=100;assert.equal(run(draft).inventory,null);
  draft[0].id='member-card-99999';assert.equal(run(draft).inventory,null);
});
