import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {loadTeamWorkspaceData,preloadTeamWorkspaceData} from '../src/lib/shared-team-loader.mjs';

test('collection inputs start concurrently and exclude unrelated archives',async()=>{
 const requests=[];let release;
 const pending=new Promise(resolve=>{release=resolve;});
 const read=name=>{requests.push(name);return pending;};
 const loading=preloadTeamWorkspaceData({readArtifact:read,readGroup:read});
 assert.equal(requests.length,8,'all required files and groups start before any response');
 assert.equal(requests.filter(name=>name.includes('/*.json')).length,3);
 assert.ok(requests.every(name=>!/database-shards\/(items|growth|conditions|targets)/.test(name)));
 release({});await loading;
});

test('workspace reuses calculator data without opening the collection dependency tree',async()=>{
 const rules={sourceReleaseId:'current'},data={memberCards:[{id:'member-card-1'}],supportCards:[],rules};
 let collections=0,presentations=0;
 const loaders={loadPresentation:async()=>{presentations++;return {sharedTeamPresentation:()=>({growthIcons:{}})};},loadCollection:async()=>{collections++;return {sharedTeamData:()=>({formalRules:rules})};}};
 const actual=await loadTeamWorkspaceData({data},loaders);
 assert.equal(collections,0);assert.equal(presentations,1);
 assert.equal(actual.memberCards,data.memberCards);assert.equal(actual.formalRules,rules);
 await loadTeamWorkspaceData(null,loaders);assert.equal(collections,1);
});

test('calculator data profiles exclude unrelated database archives',()=>{
 const temp=mkdtempSync(join(process.cwd(),'output/tools-loading-test-'));
 try {
  execFileSync(process.execPath,['tools/build_web_client.mjs',join(temp,'build')],{stdio:'pipe'});
  const manifest=JSON.parse(readFileSync(join(temp,'build/compiled/manifest.json')));
  for(const pattern of ['tools/deck-builder','tools/song-calculator','tools/event-efficiency']){
   const route=manifest.routes.find(row=>row.pattern===pattern),profile=manifest.dataProfiles[route.dataProfile];
   const unused=[...profile.files,...profile.groups].filter(name=>/database-shards\/(?:items|growth|conditions|targets|summary|skill-level-resources|skills-index)/.test(name));
   assert.deepEqual(unused,[],`${pattern} should load card and skill data only`);
   assert.ok(profile.groups.includes('@projection-data/database-shards/skills/*.json'));
   assert.ok(profile.groups.includes('@projection-data/database-shards/member-cards/*.json'));
  }
 } finally {rmSync(temp,{recursive:true,force:true});}
});
