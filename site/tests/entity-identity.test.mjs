import test from 'node:test';
import assert from 'node:assert/strict';
import {entityIdentity,entityComparison,bindGalleryRows} from '../src/lib/entity-identity.mjs';
import {mergeEditionRows,mergeCatalogs} from '../src/lib/edition-library.mjs';

const samples={
 skills:{id:'live-skill-1',masterId:1,kind:'live',effects:[{type:1000}],targetIds:['skill-target-1'],highestLevel:5,contentIdentity:'stats-a'},
 immersive:{id:10001,bandId:1,background:'Spot/home_001/Background/home_001',contentIdentity:'export-a',assetRoot:'/content/releases/a/public/immersive/one/'},
 live2d:{id:'3100',characterId:3,costumeId:100,modelPath:'003_live/rana/model/rana',category:'member',usage:'live',variant:'model',sourceSha256:'bundle-a',physics:false},
 bgm:{id:'bgm-sound_bgm_title-1',cueName:'sound_bgm_title',audio:{sha256:'audio-a'},status:'available'},
 bandItems:{id:'band-item-102',masterId:102,bandId:'band-1',resourceGroupId:1001,containerPath:'Assets/AddressableResources/Band/1/BandItem/102/band_item.png',contentIdentity:'stats-a'},
 gallery:{id:30,mediaType:'stickers',characterIds:[1],bandIds:[1],sourceResource:'Image/Degree/character_001',sourceSha256:'png-a',status:'available'}
};
for(const [kind,fixture] of Object.entries(samples)) for(const region of ['global','jp']) {
 test(`${kind}: ${region} merges translated/repacked/revised entities and retains counterpart differences`,()=>{
  const primary={...structuredClone(fixture),name:'中文',sourceReleaseId:'one'};
  const secondary={...structuredClone(fixture),name:'日本語',sourceReleaseId:'two',contentIdentity:'stats-b',sourceSha256:'png-b',audio:{sha256:'audio-b'},physics:true,assetRoot:'/content/releases/b/public/immersive/renamed/'};
  const before=structuredClone([primary,secondary]);
  const merged=mergeEditionRows([primary],[secondary],{region,key:r=>entityIdentity(kind,r),difference:r=>entityComparison(kind,r),path:r=>`/catalog/${r.id}/`});
  assert.equal(merged.length,1);assert.equal(merged[0].editionPresence.different,true);
  assert.deepEqual(merged[0].editionPresence.editions,['global','jp']);
  assert.equal(merged[0].editionPresence.counterparts.length,1);
  assert.equal(merged[0].sourceReleaseId,'one');assert.deepEqual([primary,secondary],before);
 });
 test(`${kind}: conflicting bindings and ambiguous evidence are never collapsed`,()=>{
  const primary=structuredClone(fixture),other=structuredClone(fixture);
  if(kind==='immersive')other.background+='different';
  if(kind==='live2d')other.variant='still';
  if(kind==='bgm'){other.cueName='sound_bgm_other';other.id='bgm-sound_bgm_other-1';}
  if(kind==='bandItems')other.resourceGroupId=999;
  if(kind==='gallery')other.sourceResource+='different';
  if(kind==='skills')other.effects=[{type:2000}];
  const opts={region,key:r=>entityIdentity(kind,r)};
  assert.equal(mergeEditionRows([primary],[other],opts).length,2);
  const ambiguous=mergeEditionRows([primary],[primary,{...primary}],opts);
  assert.equal(ambiguous.length,3);
  assert.equal(entityIdentity(kind,{id:primary.id,name:'same title'}),null);
 });
}
test('BGM missing media is availability, not another track',()=>{
 const a=samples.bgm,b={...a,audio:null,status:'missing',sourceAsset:'',cueSheet:''};
 assert.equal(entityIdentity('bgm',a),entityIdentity('bgm',b));
 assert.notEqual(entityComparison('bgm',a),entityComparison('bgm',b));
});
test('gallery legacy bindings must agree with the published row bytes and be unique',()=>{
 const row={...samples.gallery,image:'/content/releases/a/public/gallery/stickers-30.png'};delete row.sourceResource;
 const binding={kind:'stickers',id:30,asset:'Image/Degree/character_001',image:'stickers-30.png',sha256:'png-a',status:'available'};
 const wrap=assets=>({schemaVersion:2,assets});
 assert.equal(bindGalleryRows([row],wrap([binding]))[0].sourceResource,binding.asset);
 for(const manifest of [null,wrap([{...binding,sha256:'wrong'}]),wrap([{...binding,image:'other.png'}]),wrap([binding,binding]),wrap([{...binding,asset:'../unsafe'}])])assert.equal(bindGalleryRows([row],manifest)[0].sourceResource,undefined);
 assert.equal(row.sourceResource,undefined,'no snapshot mutation');
});
test('character and band portraits can change; contradictory entity bindings cannot match by identical bytes',()=>{
 const make=region=>({release:{id:region,region},memberCards:[],supportCards:[],musicTracks:[],musicCharts:[],
  bands:[{id:'band-1',masterId:1,characterIds:['character-1'],logoAssetId:'logo'}],
  characters:[{id:'character-1',masterId:1,bandId:'band-1',birthday:{month:11,day:22},profileAssetId:'portrait'}],
  assets:[{id:'logo',sha256:region,containerPath:'Assets/AddressableResources/Band/1/band_logo.png'},{id:'portrait',sha256:region,containerPath:'Assets/AddressableResources/Character/Image/1/character_thumbnail.png'}]});
 const a=make('global'),b=make('jp');assert.equal(mergeCatalogs(a,b,'en').bands.length,1);
 b.assets[1].sha256=a.assets[1].sha256;b.characters[0].bandId='band-2';
 assert.equal(mergeCatalogs(a,b,'en').characters.length,2);
 b.assets[0].containerPath='Assets/AddressableResources/Band/2/band_logo.png';b.assets[0].sha256=a.assets[0].sha256;
 assert.equal(mergeCatalogs(a,b,'en').bands.length,2);
});

test('a Live2D resource discovered before its costume Master entry is still the same model',()=>{
 const a=samples.live2d,b={...a,id:'asset-discovered',costumeId:null,source:'resource-catalog'};
 assert.equal(entityIdentity('live2d',a),entityIdentity('live2d',b));
 assert.notEqual(entityIdentity('live2d',a),entityIdentity('live2d',{...b,modelPath:b.modelPath+'_low'}));
});

test('available counterpart media remains reachable and counterpart links point back to the primary edition',async()=>{
 const {preferAvailable}=await import('../src/lib/entity-identity.mjs');
 for(const region of ['global','jp']){
  const other=region==='global'?'jp':'global';
  const a={...samples.immersive,assetRoot:null,status:'missing'},b={...a,assetRoot:'/content/other/scene/',status:'available'};
  const rows=mergeEditionRows([a],[b],{region,key:r=>entityIdentity('immersive',r),preferSecondary:preferAvailable,path:r=>`/immersive/${r.id}/`});
  assert.equal(rows.length,1);assert.equal(rows[0].assetRoot,b.assetRoot);assert.equal(rows[0].sourceEdition,other);
  assert.equal(rows[0].sourceHref,`/${other}/zh-CN/immersive/10001/`);
  assert.equal(rows[0].editionPresence.counterparts[0].href,`/${region}/zh-CN/immersive/10001/`);
 }
});

test('all skill domains retain identity across level-value revisions',()=>{
 for(const kind of ['leader','live','support','gekisou','gekisou_support']){
  const row={id:`${kind.replace('_','-')}-skill-1`,masterId:1,kind,effects:[{type:13000}],targetIds:[],contentIdentity:'old-values'};
  assert.ok(entityIdentity('skills',row));assert.equal(entityIdentity('skills',row),entityIdentity('skills',{...row,highestLevel:10,contentIdentity:'new-values'}));
 }
});
