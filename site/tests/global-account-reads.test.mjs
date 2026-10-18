import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedTeamRules} from './fixtures/shared-team-rules.mjs';
import {createPersonalGrowthStore} from '../src/lib/personal-growth-store.mjs';
import {convertGrowthSnapshot} from '../src/lib/account-growth-import.mjs';
import {createHistoryModel,historyTime,selectHistory,shareSummary,summarizeHistory} from '../src/lib/gacha-history.mjs';
import {setupAccountGrowthImport} from '../src/lib/account-growth-ui.mjs';
import {GachaHistoryTool} from '../src/lib/gacha-history-ui.mjs';

const servers=['global-hmt','global-en','global-kr'];
const rules=createSharedTeamRules(),vip=[{rank:1,requiredPoints:0},{rank:2,requiredPoints:2000}];
const growth=serverId=>({format:'ournotes-growth-snapshot',schemaVersion:1,source:{region:'global',edition:'global',serverId},coverage:{memberCards:'observed',supportCards:'observed'},growth:{memberCards:[{masterId:1,exp:70,cardRank:1,awakeCount:1,liveSkillLevel:2,gekisouSkillLevel:3}],supportCards:[]}});
const history=serverId=>({format:'otonote-gacha-history',schemaVersion:1,source:{region:'global',serverId},queriedAt:'2026-10-18T16:30:00Z',coverage:{scope:'server_returned',historyKind:'execution'},batches:[{poolId:1,productId:null,executedAt:Date.parse('2026-10-18T15:30:00Z')/1000,prizes:[{prizeId:1,converted:false}]}]});
function storage(){const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i],getItem:key=>values.get(key)??null,setItem:(key,v)=>values.set(key,v),removeItem:key=>values.delete(key)};}
const node=()=>({disabled:false,hidden:false,value:'',textContent:'',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}});

test('three profiles import into isolated storage and reject cross-region or contradictory sources atomically',()=>{
 const shared=storage();
 const stores=servers.map(serverId=>createPersonalGrowthStore({rules,vipRanks:vip,storage:shared,context:{region:'global',serverId}}));
 for(const [i,store] of stores.entries()) {
   const input=growth(servers[i]);store.save(store.fromImport(input));
   const before=store.checkpoint();
   for(const other of servers.filter(s=>s!==servers[i]))assert.throws(()=>store.fromImport(growth(other)),/区服/);
   const unavailable=growth(servers[i]);unavailable.growth.memberCards[0].masterId=99999999;
   assert.throws(()=>store.fromImport(unavailable),/网站资料中没有/);
   assert.equal(store.checkpoint(),before);
   assert.equal(store.read().serverId,servers[i]);
 }
 assert.equal(shared.length,3);
 const legacy=growth('global-hmt');legacy.source={region:'TW/HK/MO'};
 assert.equal(convertGrowthSnapshot(legacy,rules,vip).safeSnapshot.source.serverId,'global-hmt');
 for(const source of [{region:'global'}, {region:'TW/HK/MO',serverId:'global-en'}, {region:'global',serverId:'jp'}, {region:'global',edition:'jp',serverId:'global-kr'}]) {
   const value=growth('global-en');value.source=source;assert.throws(()=>convertGrowthSnapshot(value,rules,vip),/区服/);
 }
});

test('record dates, filter boundaries and share day use one explicit region zone',()=>{
 const expected={'global-hmt':{day:'2026-10-18',label:'UTC+8',time:'23:30:00',queryDay:'2026-10-19'},'global-en':{day:'2026-10-18',label:'UTC',time:'15:30:00',queryDay:'2026-10-18'},'global-kr':{day:'2026-10-19',label:'UTC+9',time:'00:30:00',queryDay:'2026-10-19'}};
 for(const id of servers) {
   const model=createHistoryModel(history(id),{},id),wanted=expected[id];
   assert.equal(model.records[0].day,wanted.day);assert.equal(model.timeZoneLabel,wanted.label);
   assert.ok(historyTime(model.records[0].executedAt,id).endsWith(wanted.time));
   assert.equal(selectHistory(model,{from:wanted.day,to:wanted.day}).length,1);
   const share=shareSummary(summarizeHistory(model.records),'test',model.queriedAt,id);
   assert.equal(share.timeZoneLabel,wanted.label);assert.equal(share.queriedDay,wanted.queryDay);
   assert.throws(()=>createHistoryModel(history(id),{},servers.find(s=>s!==id)),/区服/);
 }
});

test('EN and KR growth UI select matching capabilities and send serverId once without automatic authentication retry',async()=>{
 const previous={location:globalThis.location,fetch:globalThis.fetch,window:globalThis.window};
 try {
  for(const id of ['global-en','global-kr']) {
   globalThis.location={pathname:'/global/zh-CN/tools/song-calculator/',search:'?server='+id};globalThis.window=new EventTarget();
   const elements=new Map(),q=key=>{if(!elements.has(key))elements.set(key,node());return elements.get(key);};
   const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return calls.length===1?{ok:true,json:async()=>({enabled:true,nonce:'fixture',serverId:id})}:{ok:false,status:422,headers:new Headers(),text:async()=>JSON.stringify({error:'game_client_update_required'})};};
   setupAccountGrowthImport({querySelector:()=>({querySelector:q}),addEventListener(){},personalGrowthStore:{}},{});
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(calls[0].url,'/api/growth-export/capabilities/?serverId='+id);
   assert.equal(q('[data-growth-login-fields]').disabled,false);
   q('[data-growth-account]').value='fixture@example.invalid';q('[data-growth-password]').value='fixture';
   await q('[data-growth-login]').listeners.submit({preventDefault(){}});
   assert.equal(JSON.parse(calls[1].options.body).serverId,id);assert.equal(calls.length,2);
   assert.equal(q('[data-growth-password]').value,'');assert.match(q('[data-growth-status]').textContent,/版本/);
   window.dispatchEvent(new Event('pagehide'));
  }
 } finally {Object.assign(globalThis,previous);}
});

test('EN and KR gacha capability requests never reuse the default HMT identity',async()=>{
 const previous={location:globalThis.location,fetch:globalThis.fetch};
 try {
  for(const id of ['global-en','global-kr']) {
   globalThis.location={pathname:'/global/en/tools/gacha-history/',search:'?server='+id};
   const elements=new Map(),tool=new GachaHistoryTool();tool.isConnected=true;tool.q=key=>{if(!elements.has(key))elements.set(key,node());return elements.get(key);};
   let url;globalThis.fetch=async value=>{url=value;return {ok:true,json:async()=>({enabled:true,gachaHistory:true,serverId:id,nonce:'fixture'})};};
   await tool.checkService();assert.equal(url,'/api/growth-export/capabilities/?serverId='+id);assert.equal(tool.q('fields').disabled,false);
  }
 } finally {Object.assign(globalThis,previous);}
});
