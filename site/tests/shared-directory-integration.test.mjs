/** Exercise actual directory entry modules, not just the identity helpers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const data = {
 skills:{records:[{id:'live-skill-1',masterId:1,kind:'live',effects:[{type:1000}],targetIds:[],contentIdentity:'a'}]},
 immersive:{scenes:[{id:10001,bandId:1,background:'Spot/cafe/Background/cafe',contentIdentity:'a'}]},
 live2d:{models:[{id:'1001',characterId:1,costumeId:1,modelPath:'001_adv/tomori/model/tomori',category:'member',usage:'story',variant:'model',sourceSha256:'a'}]},
 bgm:{tracks:[{id:'bgm-sound_bgm_title-1',cueName:'sound_bgm_title',audio:{sha256:'a'}}]},
 bandItems:{bands:[],items:[{id:'band-item-102',masterId:102,bandId:'band-1',resourceGroupId:1001,containerPath:'Assets/AddressableResources/Band/1/BandItem/102/band_item.png',contentIdentity:'a'}]},
 gallery:{comics:[],stamps:[],backgrounds:[],stickers:[{id:30,mediaType:'stickers',characterIds:[1],bandIds:[1],image:'/content/releases/primary/public/gallery/stickers-30.png',sourceSha256:'a',status:'available'}]},
};
const cases=[['skills','shared-database.ts','skillIndex','records','./game-database'],['immersive','shared-immersive.ts','default','scenes','../data/immersive-scenes.json'],['live2d','shared-live2d.ts','default','models','../data/live2d-catalog.json'],['bgm','shared-bgm.ts','bgmCatalog','tracks','./bgm-catalog'],['bandItems','shared-band-items.ts','bandItemDatabase','items','./band-items'],['gallery','shared-gallery.ts','gallery','stickers','./gallery']];
for(const region of ['global','jp'])for(const [kind,entry,exportName,field,nativeImport] of cases){
 test(`${region}: ${entry} uses stable identity at its real import boundary`,async()=>{
  const primary=structuredClone(data[kind]),secondary=structuredClone(primary);
  Object.assign(secondary[field][0],{name:'翻訳',contentIdentity:'b',sourceSha256:'b',audio:{sha256:'b'}});
  if(kind==='live2d')Object.assign(secondary[field][0],{id:'asset-discovered',costumeId:null});
  if(kind==='gallery')secondary.stickers[0].image='/content/releases/secondary/public/gallery/stickers-30.png';
  const primaryManifest={schemaVersion:2,assets:[{kind:'stickers',id:30,asset:'Image/Degree/one',image:'stickers-30.png',sha256:'a',status:'available'}]};
  const secondaryManifest=structuredClone(primaryManifest);secondaryManifest.assets[0].sha256='b';
  const other=region==='global'?'jp':'global';
  const modules={
   './shared-catalog':`export const catalog={assets:[]};`,
   [nativeImport]:kind==='skills'?`export const itemIndex=[];export const skillIndex=${JSON.stringify(primary.records)};`:`const value=${JSON.stringify(primary)};export default value;export const ${exportName==='default'?'unused':exportName}=value;`,
   './release-context':`export const activeReleaseContext={region:${JSON.stringify(region)},locale:'en'};`,
   '../runtime/content.mjs':`export async function otherEditionArtifact(){return ${JSON.stringify(secondary)}};
export async function editionSnapshot(region){return {root:region===${JSON.stringify(region)}?'/content/releases/primary/':'/content/releases/secondary/'}};
export async function checkedJson(url){if(url==='/content/releases/primary/public/gallery/manifest.json')return ${JSON.stringify(primaryManifest)};if(url==='/content/releases/secondary/public/gallery/manifest.json')return ${JSON.stringify(secondaryManifest)};throw Error('Unpinned request: '+url);}`,
  };
  const result=await build({entryPoints:[new URL('../src/lib/'+entry,import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'snapshot-fixtures',setup(build){
   build.onResolve({filter:/.*/},args=>modules[args.path]?{path:args.path,namespace:'fixture'}:null);
   build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path]}));
  }}]});
  const module=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
  const rows=kind==='skills'?module[exportName]:module[exportName][field];assert.equal(rows.length,1);
  assert.deepEqual(rows[0].editionPresence.editions,['global','jp']);assert.equal(rows[0].editionPresence.different,true);
  assert.equal(rows[0].sourceEdition,region);
  if(kind==='immersive')assert.equal(rows[0].editionPresence.counterparts[0].href,`/${other}/en/immersive/10001/`);
 });
}
