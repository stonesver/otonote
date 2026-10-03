import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCostumes, costumeState, costumePreviewPath, matchesCostume, readCostumeFilters, costumeFilterSearch} from '../src/lib/costume-library.mjs';
import {artifactGlob} from '../src/runtime/content.mjs';
import {createHash} from 'node:crypto';

const context = {contentReleaseId:'fixture',region:'global',locale:'en'};
const row = {id:'costume-group-1',masterId:1,name:'Birthday',characterId:'character-1',characterMasterId:1,
  bandId:'band-1',isInitial:false,unlockMemberCardId:'member-card-9',startAt:'2030/10/04 0:00:00',icon:null,
  models:[{masterId:10,typeCode:2,modelPath:'model',modelId:'published-model',state:'available'}]};
test('costume contracts reject mixed editions and invalid records but accept an absent optional artifact', () => {
  assert.equal(validateCostumes(null, context).status,'unavailable');
  const value = {schemaVersion:1,...context,status:'available',costumes:[row]};
  assert.equal(validateCostumes(value,context),value);
  for (const patch of [{region:'jp'}, {locale:'zh-CN'}, {contentReleaseId:'other'}, {costumes:[row,row]}, {costumes:[{...row,models:[{}]}]}, {status:'unavailable'}])
    assert.throws(() => validateCostumes({...value,...patch},context));
});
test('filters combine and preserve server selection in shareable URLs', () => {
  const filters = readCostumeFilters('?server=global-hmt&character=character-1&q=Birthday');
  const candidate = {...row,searchText:'Member Birthday'};
  assert.ok(matchesCostume(candidate,filters));
  assert.ok(!matchesCostume(candidate,{...filters,band:'band-2'}));
  assert.ok(!matchesCostume(candidate,{...filters,q:'missing'}));
  assert.equal(costumeFilterSearch('?server=global-hmt&q=old',{q:'',band:'',character:''}),'server=global-hmt');
  const search = costumeFilterSearch('?server=global-hmt',{q:'日 生',band:'band-1',character:'character-1'});
  assert.deepEqual(readCostumeFilters(search),{q:'日 生',band:'band-1',character:'character-1'});
});
test('model links use published IDs and unavailable models have no link', () => {
  assert.equal(costumePreviewPath(row,row.models[0]),'/tools/live2d/?character=1&costume=published-model');
  assert.equal(costumePreviewPath(row,{state:'unavailable',modelId:null}),null);
});
test('release status uses explicit edition time and changes at the boundary', () => {
  const start = Date.parse('2030-10-03T16:00:00Z');
  assert.equal(costumeState(row.startAt,'global',start-1),'upcoming');
  assert.equal(costumeState(row.startAt,'global',start),'released');
  assert.equal(costumeState(row.startAt,'jp',start-1),'released');
  assert.equal(costumeState('not a date','global',start),'unknown');
  assert.equal(costumeState(null,'global',start),'unknown');
});
test('exact projection globs tolerate missing files but reject corrupt declared artifacts', async () => {
  const key=Symbol.for('ournotes.content.snapshot.v1'),rootKey=Symbol.for('ournotes.content-root.v1');
  const previous=globalThis[key],oldRoot=globalThis[rootKey],oldLocation=globalThis.location,oldFetch=globalThis.fetch;
  const root='/content/releases/'+'a'.repeat(24)+'/';
  globalThis.location={pathname:'/global/en/costumes/'};
  try {
    globalThis[key]={documents:new Map(),promise:Promise.resolve({root,locales:{en:{files:{}}}})};
    assert.deepEqual(await artifactGlob('@projection-data/costumes.json'),{});
    const data=JSON.stringify({schemaVersion:1,...context,status:'available',costumes:[row]});
    globalThis[key]={documents:new Map(),promise:Promise.resolve({root,locales:{en:{files:{
      'projection/costumes.json':{path:'en/costumes.json',sha256:createHash('sha256').update(data).digest('hex')}
    }}}})};
    globalThis.fetch=async()=>new Response('{}');
    await assert.rejects(artifactGlob('@projection-data/costumes.json'),/校验失败/);
    globalThis[key].documents=new Map();globalThis.fetch=async()=>new Response(data);
    assert.deepEqual((await artifactGlob('@projection-data/costumes.json',{import:'default'}))['@projection-data/costumes.json'].costumes,[row]);
  } finally { globalThis[key]=previous;globalThis[rootKey]=oldRoot;globalThis.location=oldLocation;globalThis.fetch=oldFetch; }
});
