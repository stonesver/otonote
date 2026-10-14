import test from 'node:test';
import assert from 'node:assert/strict';
import {featureStatus,snapshotFreshness} from '../src/lib/feature-status.mjs';
import {validateRecognitionIndex,RECOGNITION_ALGORITHM} from '../src/lib/card-recognition/index-contract.mjs';
const catalog={release:{id:'release',region:'jp',versionName:'1.0.5'},memberCards:[{id:'member-card-1',variantAssetIds:['a']}],supportCards:[{id:'support-card-2',variantAssetIds:['b']}]};
const index={schemaVersion:1,region:'jp',sourceReleaseId:'release',algorithm:RECOGNITION_ALGORITHM,featuresPath:'recognition/features.bin.gz',featuresSha256:'a'.repeat(64),compressedBytes:40,decodedBytes:160,cards:[{id:'member-card-1',kind:'member',assetId:'a',count:4,descriptorOffset:0,pointOffset:128}],missing:[{id:'support-card-2',assetId:'b'}]};
const context={region:'jp',sourceReleaseId:'release'};
test('missing index degrades separately; matching scoring is estimate and never gameplay verified',()=>{
 const data=featureStatus({catalog,modes:{sourceReleaseId:'release',events:{records:[]}},rules:{sourceReleaseId:'release',verificationStatus:'code_audited'},scoring:{sourceReleaseId:'release',status:'compatible'}});
 assert.equal(featureStatus({catalog,rules:{sourceReleaseId:'release',verificationStatus:'unavailable'},scoring:{sourceReleaseId:'release',status:'partial'}}).calculator.status,'unavailable');
 assert.equal(data.screenshot.status,'unavailable');assert.equal(data.calculator.status,'estimated');assert.equal(data.calculator.gameplayVerified,false);assert.equal(data.events.status,'available');
});
test('partial card coverage is visible; foreign release and unknown artwork cannot appear available',()=>{
 assert.deepEqual(featureStatus({catalog,recognition:index}).screenshot,{status:'partial',cards:1,totalCards:2,missingAssets:1});
 for(const modified of [{...index,sourceReleaseId:'old'},{...index,cards:[{...index.cards[0],assetId:'other'}]}])assert.equal(featureStatus({catalog,recognition:modified}).screenshot.status,'unavailable');
 assert.equal(featureStatus({catalog,rules:{sourceReleaseId:'old'},scoring:{status:'compatible'}}).calculator.status,'unavailable');
});
test('algorithm, bounds, sizes, duplicates and cross-region indexes fail before initialization',()=>{
 validateRecognitionIndex(index,context);
 for(const mutate of [i=>i.algorithm='future',i=>i.region='global',i=>i.decodedBytes=-1,i=>i.compressedBytes=0,i=>i.cards[0].pointOffset=156,i=>i.cards.push(i.cards[0]),i=>i.featuresSha256='invalid']){
  const copy=structuredClone(index);mutate(copy);assert.throws(()=>validateRecognitionIndex(copy,context));
 }
});
test('freshness compares immutable snapshot identity, not only same game release; network failure is unknown',()=>{
 const pinned={contentReleaseId:'release',root:'/content/releases/aaa/'};
 assert.equal(snapshotFreshness(pinned,{contentReleaseId:'release',manifest:'/content/releases/aaa/manifest.json'}),'current');
 assert.equal(snapshotFreshness(pinned,{contentReleaseId:'release',manifest:'/content/releases/bbb/manifest.json'}),'stale');
 assert.equal(snapshotFreshness(pinned,null),'unknown');
});
