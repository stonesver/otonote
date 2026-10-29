import test from 'node:test';
import assert from 'node:assert/strict';
import {createArenaPersonalClient,validateArenaPersonal,arenaPersonalTier} from '../src/lib/arena-personal.mjs';
const scope={serverId:'global-hmt',seasonId:'1',bandId:'1'};
const value=overrides=>({format:'otonote-arena-personal',schemaVersion:1,source:{serverId:'global-hmt',edition:'global',clientVersion:'1.1.0',masterVersion:'a'.repeat(32)},seasonId:'1',bandId:'1',queriedAt:'2026-10-29T06:00:00Z',status:'ranked',rank:10001,point:100,...overrides});
const response=result=>({ok:true,status:200,text:async()=>JSON.stringify(result)});
const capabilities={enabled:true,serverId:'global-hmt',arenaPersonal:true,nonce:'synthetic-nonce'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('own response rejects cross-server, cross-season, false unranked and master mismatches',()=>{
 assert.equal(validateArenaPersonal(value(),scope).rank,10001);
 for(const bad of [value({bandId:'2'}),value({source:{serverId:'global-en'}}),value({status:'unranked'}),value({status:'unavailable'}),value({point:-1}),value({rank:0}),value({queriedAt:'2026-10-29'})])assert.throws(()=>validateArenaPersonal(bad,scope));
 const context={...scope,season:{id:'1',validFrom:'2026-10-01T00:00:00Z',validUntil:'2026-11-01T00:00:00Z'},league:{bandId:'1'}};
 const rankData={sourceMasterVersion:'a'.repeat(32),sourceReleaseId:'release',serverScopes:['global-hmt'],capabilities:{ranks:true},ranks:[{id:'1',bandId:'1',name:'新手 1',tier:1,division:1,threshold:0,openingSourceText:''}]};
 assert.equal(arenaPersonalTier(value(),rankData,context).name,'新手 1');assert.equal(arenaPersonalTier(value({source:{...value().source,masterVersion:'b'.repeat(32)}}),rankData,context),null);
 assert.equal(arenaPersonalTier(value(),{...rankData,sourceMasterVersion:undefined},context),null);
});
test('opening checks the common service; explicit query authenticates once and credentials never enter state',async()=>{
 const calls=[];const client=createArenaPersonalClient({fetcher:async(url,options)=>{calls.push([url,options]);return response(calls.length===1?capabilities:{snapshot:value()});}});
 client.select(scope);assert.equal(calls.length,0);await client.check();assert.equal(client.getState().status,'ready');
 await client.query('synthetic@example.invalid','synthetic-secret');assert.equal(client.getState().status,'complete');
 assert.equal(calls.length,2);assert.match(calls[1][0],/growth-export\/arena-rank/);
 const body=JSON.parse(calls[1][1].body);assert.deepEqual(body,{...scope,account:'synthetic@example.invalid',password:'synthetic-secret'});
 assert.equal(calls[1][1].cache,'no-store');assert.equal(calls[1][1].credentials,'same-origin');
 assert.ok(!JSON.stringify(client.getState()).includes('secret'));assert.equal(client.getState().nonce,null);
 client.select({...scope,bandId:'2'});assert.equal(client.getState().data,null);assert.equal(calls.length,2);
});
test('clear or scope change aborts pending reads and late responses cannot expose another account',async()=>{
 let release,calls=0;const client=createArenaPersonalClient({fetcher:async()=>++calls===1?response(capabilities):new Promise(resolve=>release=resolve)});
 client.select(scope);await client.check();const pending=client.query('a','b');client.clear();
 release(response({snapshot:value()}));await pending;assert.equal(client.getState().data,null);assert.equal(client.getState().status,'idle');
 await client.query('a','b');assert.equal(calls,2); // A fresh capability check is required.
});
test('errors clear credentials and results without retry or collector fallback',async()=>{
 let calls=0;const client=createArenaPersonalClient({fetcher:async()=>++calls===1?response(capabilities):{ok:false,status:429,text:async()=>JSON.stringify({error:'busy'})}});
 client.select(scope);await client.check();await client.query('a','b');assert.equal(calls,2);assert.equal(client.getState().status,'error');assert.equal(client.getState().data,null);assert.equal(client.getState().nonce,null);
 client.select({...scope,serverId:'jp'});await client.check();assert.equal(client.getState().status,'unsupported');assert.equal(calls,2);
});
