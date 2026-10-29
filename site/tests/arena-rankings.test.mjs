import test from 'node:test';
import assert from 'node:assert/strict';
import {createArenaRankingClient,validateArenaRankings,arenaRankingsView,arenaRankingTier} from '../src/lib/arena-rankings.mjs';
const scope={serverId:'global-hmt',seasonId:'1',bandId:'1'};
const payload=(extra={})=>({schemaVersion:1,...scope,status:'available',snapshotId:'a'.repeat(64),
 observedAt:'2026-10-29T01:00:00Z',expiresAt:'2026-10-29T01:15:00Z',coverage:{startRank:1,endRank:100},
 maxRank:100,totalEntries:2,entries:[{playerId:'p1',name:'Name',rank:1,point:100}],nextCursor:'next',...extra});
const response=value=>({ok:true,status:200,json:async()=>value});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('score-to-rank conversion requires matching rules, band, observation time and opening constraints',()=>{
 const rankData={sourceReleaseId:'test',capabilities:{ranks:true},serverScopes:['global-hmt'],ranks:[
  {bandId:'1',name:'Gold 4',tier:4,division:4,threshold:3355,openingSourceText:''},
  {bandId:'1',name:'Platinum 1',tier:5,division:1,threshold:4155,openingSourceText:''},
  {bandId:'2',name:'Other band',tier:5,division:1,threshold:0,openingSourceText:''}]};
 const context={...scope,league:{bandId:'1'},season:{id:'1',validFrom:'2026-10-01T00:00:00Z',validUntil:'2026-11-01T00:00:00Z'}};
 const observation=payload({sourceReleaseId:'test'}),options={rankData,context,observation};
 assert.equal(arenaRankingTier(4154,options).name,'Gold 4');assert.equal(arenaRankingTier(4155,options).name,'Platinum 1');
 for(const changed of [{sourceReleaseId:'old'},{bandId:'2'},{serverId:'global-kr'},{observedAt:'2026-11-01T00:00:00Z'}])assert.equal(arenaRankingTier(5000,{...options,observation:{...observation,...changed}}),null);
 rankData.ranks[1].opensAt='2026-10-30T00:00:00Z';assert.equal(arenaRankingTier(5000,options).name,'Gold 4');
 rankData.ranks[1].opensAt='invalid';assert.equal(arenaRankingTier(5000,options),null);
 delete rankData.ranks[1].opensAt;rankData.ranks[1].openingSourceText=null;assert.equal(arenaRankingTier(5000,options),null);
});
test('rankings require exact server, season and band and preserve official ties',()=>{
 for(const field of ['serverId','seasonId','bandId'])assert.throws(()=>validateArenaRankings(payload({[field]:'other'}),scope));
 const value=payload({entries:[{playerId:'p1',name:'A',rank:1,point:100},{playerId:'p2',name:'B',rank:1,point:100}],nextCursor:null});
 assert.equal(validateArenaRankings(value,scope).entries[1].rank,1);
 assert.throws(()=>validateArenaRankings(payload({entries:[...value.entries,value.entries[0]]}),scope));
 assert.throws(()=>validateArenaRankings(payload({observedAt:'2026-10-29T01:00:00'}),scope));
 assert.throws(()=>validateArenaRankings(payload({status:'unavailable'}),scope));
});
test('switching scope immediately clears old rows and ignores a delayed response',async()=>{
 const pending=[],calls=[];
 const client=createArenaRankingClient({fetcher:(url,options)=>new Promise(resolve=>{pending.push(resolve);calls.push([url,options]);})});
 client.select(scope);assert.equal(client.getState().status,'loading');
 const second={...scope,bandId:'2'};client.select(second);
 pending[1](response(payload(second)));await tick();assert.equal(client.getState().data.bandId,'2');
 pending[0](response(payload()));await tick();assert.equal(client.getState().data.bandId,'2');
 client.select({...second,serverId:'global-kr'});assert.equal(client.getState().entries.length,0);assert.equal(client.getState().status,'loading');
 assert.ok(calls[0][1].signal.aborted);assert.equal(calls[0][1].credentials,'omit');
 assert.match(calls[1][0],/server=global-hmt&season=1&band=2/);
 client.destroy();
});
test('no game or ranking request is made until all three selectors resolve',()=>{
 let calls=0;const client=createArenaRankingClient({fetcher:()=>{calls++;}});
 client.select({...scope,serverId:null});assert.equal(client.getState().status,'select-server');
 client.select({...scope,seasonId:null});assert.equal(client.getState().status,'select-season');
 client.select({...scope,bandId:null});assert.equal(client.getState().status,'select-band');assert.equal(calls,0);
});
test('new snapshot during pagination clears rows and requires explicit reload',async()=>{
 let calls=0;const client=createArenaRankingClient({fetcher:async()=>calls++?{ok:false,status:409}:response(payload())});
 client.select(scope);await tick();assert.equal(client.getState().entries.length,1);
 await client.more();assert.equal(client.getState().status,'changed');assert.equal(client.getState().entries.length,0);
});
test('pagination failure keeps same-scope rows, retry appends without inventing ranks',async()=>{
 let calls=0;const client=createArenaRankingClient({fetcher:async()=>{calls++;if(calls===2)throw Error('offline');
  return response(calls===1?payload():payload({entries:[{playerId:'p2',name:'B',rank:1,point:100}],nextCursor:null}));}});
 client.select(scope);await tick();await client.more();assert.equal(client.getState().paginationError,true);assert.equal(client.getState().entries.length,1);
 await client.more();assert.equal(client.getState().entries.length,2);assert.deepEqual(client.getState().entries.map(r=>r.rank),[1,1]);
});
test('empty, unavailable, stale and broken responses are distinct; names are escaped',async()=>{
 let now=Date.parse('2026-10-29T01:01:00Z');
 const client=createArenaRankingClient({now:()=>now,fetcher:async()=>response(payload({entries:[],totalEntries:0,status:'empty',maxRank:0,nextCursor:null}))});
 client.select(scope);await tick();assert.equal(client.getState().status,'empty');now+=3600_000;assert.equal(client.getState().status,'stale');
 const view=arenaRankingsView({state:{...client.getState(),entries:[{playerId:'p',name:'<img onerror="bad">',rank:1,point:0}]},t:a=>a,time:s=>s});
 assert.match(view,/&lt;img/);assert.ok(!view.includes('<img onerror='));assert.match(view,/快照已过期/);
 const missing=createArenaRankingClient({fetcher:async()=>response(payload({status:'unavailable',entries:[],observedAt:null,expiresAt:null,nextCursor:null,snapshotId:null}))});
 missing.select(scope);await tick();assert.equal(missing.getState().status,'not-collected');
 const broken=createArenaRankingClient({fetcher:async()=>response(payload({bandId:'2'}))});broken.select(scope);await tick();assert.equal(broken.getState().status,'error');
});

test('public decks validate slots and render safe server-scoped card details',async()=>{
 const {arenaRankingDeck,arenaRankIcon}=await import('../src/lib/arena-ranking-decks.mjs');
 const deck={totalPower:123456,cards:[{slot:0,performanceOrder:0,member:{masterId:72,rank:5,awake:3},support:{masterId:51}}]};
 const value=payload();value.entries[0].deck=deck;assert.doesNotThrow(()=>validateArenaRankings(value,scope));
 const html=arenaRankingDeck(deck,{t:a=>a,serverId:'global-hmt',base:'/global/zh-CN/',visuals:{members:[{id:'72',href:'member-72',name:'<script>card</script>',image:'/72.webp'}]}});
 assert.match(html,/&lt;script&gt;card/);assert.match(html,/server=global-hmt/);assert.match(html,/不一定是获得当前积分时使用的队伍/);assert.equal((html.match(/<section>/g)??[]).length,5);
 assert.equal(arenaRankIcon({rankIcons:[{tier:5,image:'javascript:bad'}]},5),'');
 value.entries[0].deck.cards.push({...deck.cards[0]});assert.throws(()=>validateArenaRankings(value,scope));
});

test('an automatic page cannot keep returning the same cursor',async()=>{
 let calls=0;const client=createArenaRankingClient({fetcher:async()=>response(calls++?payload({entries:[{playerId:'p2',name:'B',rank:2,point:0}]}):payload())});
 client.select(scope);await tick();await client.more();assert.equal(client.getState().status,'changed');assert.equal(client.getState().entries.length,0);
});

test('live lookups fall back explicitly, scope rank jumps and quietly retain unchanged or failed updates',async()=>{
 let fail=false,calls=[];const client=createArenaRankingClient({live:true,fetcher:async url=>{
  calls.push(url);if(url.includes('rankings-live'))return {ok:false,status:404};if(fail)throw Error('offline');return response(payload());
 }});
 client.select({...scope,rank:1});await tick();assert.match(calls[0],/rankings-live/);assert.match(calls[1],/rank=1/);assert.equal(client.getState().entries.length,1);
 await client.check();assert.equal(client.getState().entries.length,1);fail=true;await client.check();assert.equal(client.getState().entries.length,1);assert.equal(client.getState().refreshError,true);
});
test('dynamic query accepts rank beyond 1000, rejects wrong windows and honours busy responses',async()=>{
 let busy=false;const next={...scope,rank:10001};const client=createArenaRankingClient({live:true,fetcher:async()=>busy?{status:429,headers:{get:()=> '45'}}:response(payload({mode:'dynamic',coverage:{startRank:10001,endRank:10100},maxRank:31279,entries:[{playerId:'p1',name:'Name',rank:10001,point:0}],nextCursor:null}))});
 client.select(next);await tick();assert.equal(client.getState().entries[0].rank,10001);busy=true;await client.check();assert.equal(client.getState().entries.length,1);assert.equal(client.getState().retryAfter,45);busy=false;client.select({...next,rank:15001});await tick();assert.equal(client.getState().status,'error');
});

test('explicit ranges use only the live service; unavailable lookups never show a different saved range',async()=>{
 const calls=[];const client=createArenaRankingClient({live:true,fetcher:async url=>{calls.push(url);return {status:501,ok:false};}});
 client.select({...scope,rank:10001,end:10100});await tick();assert.equal(calls.length,1);assert.match(calls[0],/end=10100/);
 assert.equal(client.getState().status,'lookup-unavailable');assert.equal(client.getState().entries.length,0);
 const view=arenaRankingsView({state:client.getState(),t:a=>a,time:s=>s});assert.match(view,/每次最多 100 名/);assert.match(view,/服务尚未接通/);assert.match(view,/返回前 1000/);
});
test('rank range controls stay available without the removed tier filters',()=>{
 const state={status:'available',data:payload(),entries:payload().entries,scope};
 const view=arenaRankingsView({state,t:a=>a,time:s=>s});assert.match(view,/name="rank"/);assert.match(view,/每次最多 100 名/);assert.ok(!view.includes('rank-min'));assert.ok(!view.includes('rank-max'));
});
