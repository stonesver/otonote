import test from 'node:test';import assert from 'node:assert/strict';
import {validatePopulation,createPopulationClient,populationView} from '../src/lib/arena-population.mjs';
const scope={serverId:'global-hmt',seasonId:'1',bandId:'1'},now=Date.parse('2026-10-29T06:01:00Z');
const observation={schemaVersion:1,...scope,method:'rank_boundary_probe',accuracy:'estimate',sourceReleaseId:'test',masterVersion:'a'.repeat(32),startedAt:'2026-10-29T06:00:00Z',observedAt:'2026-10-29T06:01:00Z',expiresAt:'2026-10-29T12:00:00Z',totalEstimate:100,sampleReads:10,tiers:[{tier:1,threshold:0,count:90},{tier:2,threshold:190,count:10}]};
const payload=()=>({schemaVersion:1,...scope,status:'available',observation:structuredClone(observation)});
const tick=()=>new Promise(r=>setTimeout(r,0));
test('native server Master binding prevents HMT counts from being relabelled as EN or Korea',()=>{
 const versions={'global-hmt':'a'.repeat(32),'global-en':'b'.repeat(32),'global-kr':'c'.repeat(32)};
 const data={sourceReleaseId:'test',sourceMasterVersion:versions['global-hmt'],sourceMasterVersions:versions,serverScopes:Object.keys(versions),completeRankBands:['1'],
  ranks:[{id:'1',bandId:'1',tier:1,name:'新手1',threshold:0,openingSourceText:''},{id:'2',bandId:'1',tier:2,name:'青铜1',threshold:190,openingSourceText:''}]};
 for(const serverId of ['global-en','global-kr']){
  const context={serverId,season:{id:'1',validFrom:'2026-10-01T00:00:00Z',validUntil:'2026-11-01T00:00:00Z'},league:{bandId:'1'}};
  const o={...observation,serverId,masterVersion:versions[serverId]};
  const render=value=>populationView({state:{status:'available',data:{observation:value}},rankData:data,context,t:a=>a,time:s=>s});
  assert.match(render(o),/≈ 100/);assert.match(render({...o,masterVersion:versions['global-hmt']}),/未匹配/);
 }
});
test('aggregate validation rejects mixed identities, wrong totals and fake precision',()=>{
 assert.equal(validatePopulation(payload(),scope).observation.totalEstimate,100);
 for(const change of [v=>v.serverId='global-en',v=>v.observation.totalEstimate=101,v=>v.observation.accuracy='exact',v=>v.observation.sampleReads=97,v=>v.observation.tiers[0].count=-1]){const v=payload();change(v);assert.throws(()=>validatePopulation(v,scope));}
});
test('switching scope clears counts and delayed requests cannot cross servers; requests read files only',async()=>{
 const pending=[],calls=[];const client=createPopulationClient({fetcher:(url,options)=>new Promise(resolve=>{calls.push([url,options]);pending.push(resolve);}),now:()=>now});
 client.select(scope);client.select({...scope,serverId:'global-en'});assert.equal(client.getState().data,null);
 pending[0]({ok:true,json:async()=>payload()});await tick();assert.equal(client.getState().data,null);
 pending[1]({ok:true,json:async()=>({schemaVersion:1,...scope,serverId:'global-en',status:'unavailable',observation:null})});await tick();assert.equal(client.getState().status,'unavailable');
 assert.match(calls[0][0],/^\/api\/v1\/arena-population/);assert.equal(calls[0][1].credentials,'omit');assert.equal(calls[0][1].cache,'no-store');client.destroy();
});
test('counts require matching full rank data; missing values stay unknown, maxRank is not a census',()=>{
 const rankData={serverScopes:['global-hmt'],sourceReleaseId:'test',sourceMasterVersion:'a'.repeat(32),completeRankBands:['1'],ranks:[{id:'1',bandId:'1',tier:1,name:'新手1',threshold:0,openingSourceText:''},{id:'2',bandId:'1',tier:2,name:'青铜1',threshold:190,openingSourceText:''}]};
 const context={serverId:'global-hmt',season:{id:'1',validFrom:'2026-10-01T00:00:00Z',validUntil:'2026-11-01T00:00:00Z'},league:{bandId:'1'}};
 const render=(state,data=rankData)=>populationView({state,rankData:data,context,t:a=>a,time:s=>s,ranking:{...scope,maxRank:1000,observedAt:observation.observedAt}});
 const view=render({status:'available',data:payload()});assert.match(view,/≈ 100/);assert.match(view,/90/);assert.match(view,/并非官方人数统计/);assert.ok(!view.includes('data-field="rank-min"'));
 assert.match(render({status:'unavailable',data:null}),/尚未完成服务器探测/);assert.match(render({status:'available',data:payload()},{...rankData,sourceMasterVersion:'b'.repeat(32)}),/未匹配/);
 assert.match(render({status:'stale',data:payload()}),/已过期/);
});
