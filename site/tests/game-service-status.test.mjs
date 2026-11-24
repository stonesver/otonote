import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceNotice,retainMaintenance,maintenanceStatusRows,installGameServiceNotice} from '../src/lib/game-service-status.mjs';
import {setupAccountGrowthImport} from '../src/lib/account-growth-ui.mjs';
import {GachaHistoryTool} from '../src/lib/gacha-history-ui.mjs';

const observation={status:'maintenance',maintenance:{expectedEndAt:'2026-10-18T06:00:00Z'}};
const node=()=>({hidden:false,disabled:false,value:'',textContent:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}});

test('expected maintenance end is UTC+8 and never an automatic recovery claim',()=>{
  assert.match(maintenanceNotice(observation,'zh',Date.parse('2026-10-18T05:00:00Z')),/14:00/);
  assert.match(maintenanceNotice(observation,'en',Date.parse('2026-10-18T07:00:00Z')),/not confirmed/);
  assert.match(maintenanceNotice(observation,'zh',Date.parse('2026-10-18T07:00:00Z')),/等待官方恢复确认/);
  assert.equal(maintenanceNotice({status:'unknown'}),'');
});

test('growth blocks credentials during maintenance, keeps file import usable, and never retries login on recovery',async()=>{
  const previous={location:globalThis.location,fetch:globalThis.fetch,window:globalThis.window};
  const elements=new Map(),q=key=>{if(!elements.has(key))elements.set(key,node());return elements.get(key);};
  globalThis.location={pathname:'/global/tools/song-calculator/',search:'?server=global-hmt'};
  globalThis.window=new EventTarget();
  const sent=[];
  globalThis.fetch=async url=>{sent.push(url);return {ok:true,json:async()=>({enabled:true,nonce:'fixture',gameStatus:observation})};};
  try {
    setupAccountGrowthImport({querySelector:()=>({querySelector:q}),addEventListener(){},personalGrowthStore:{}},{getInventory(){},replaceInventory(){}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(q('[data-growth-login-fields]').disabled,true);
    assert.equal(q('[data-growth-file]').disabled,false);
    await q('[data-growth-login]').listeners.submit({preventDefault(){}});
    assert.deepEqual(sent,['/api/growth-export/capabilities/']);
    const event=new Event('game-service-status-change');
    event.detail={servers:{'global-hmt':{status:'no_maintenance_signal'}}};
    window.dispatchEvent(event);
    assert.equal(q('[data-growth-login-fields]').disabled,false);
    assert.equal(sent.length,1);
  } finally {
    globalThis.window.dispatchEvent(new Event('pagehide'));
    Object.assign(globalThis,previous);
  }
});

test('gacha stops before reading inputs or issuing a request when maintenance is known',async()=>{
  const tool=new GachaHistoryTool(),elements=new Map();
  tool.q=key=>{if(!elements.has(key))elements.set(key,node());return elements.get(key);};
  tool.nonce='fixture';tool.applyGameStatus(observation);
  assert.equal(tool.q('fields').disabled,true);
  assert.match(tool.q('service').textContent,/维护/);
  await tool.queryHistory();
  assert.equal(elements.has('account'),false);
});


test('maintenance status rejects stale responses, retain uncertainty, and disappear on fresh recovery',async()=>{
  const names=['window','document','location','fetch','setTimeout','clearTimeout'];
  const previous=Object.fromEntries(names.map(key=>[key,globalThis[key]]));
  const timers=[],requests=[],updates=[];
  let rows=[], renders=0;
  const root={hidden:true,dataset:{locale:'zh-CN'},
    ownerDocument:{createElement:()=>({append(...children){this.children=children;}})},
    querySelector:()=>({replaceChildren(...items){renders++;rows=items.map(item=>({title:item.children[0].textContent,timing:item.children[1].textContent}));}})};
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  globalThis.location={pathname:'/global/zh-CN/tools/gacha-history/',search:'?server=global-en'};
  globalThis.setTimeout=(callback,delay)=>{const timer={callback,delay};timers.push(timer);return timer;};
  globalThis.clearTimeout=timer=>{if(timer)timer.cleared=true;};
  let response={schemaVersion:1,validUntil:new Date(Date.now()+60000).toISOString(),servers:{'global-en':observation}};
  globalThis.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>response};};
  window.addEventListener('game-service-status-change',event=>updates.push(event.detail));
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  let stop;
  try {
    stop=installGameServiceNotice(root);await flush();
    assert.equal(root.hidden,false);
    assert.equal(rows.length,1);assert.match(rows[0].title,/EN.*游戏服务器更新中/);
    assert.doesNotMatch(rows[0].timing,/本地文件导入|在线读取/);
    assert.equal(requests[0].options.credentials,'omit');
    assert.equal(requests[0].options.cache,'no-store');
    await timers.findLast(timer=>timer.delay===60000).callback();await flush();
    assert.equal(renders,1); // Same poll does not replace the live region or repeat its announcement.
    response={...response,validUntil:'2026-01-01T00:00:00Z',servers:{'global-en':{status:'no_maintenance_signal'}}};
    await timers.findLast(timer=>timer.delay===60000).callback();await flush();
    assert.equal(rows.length,1);assert.match(rows[0].timing,/恢复待确认/);
    assert.deepEqual(updates.at(-1).servers,{});
    response={...response,validUntil:new Date(Date.now()+60000).toISOString()};
    const restored=new Event('pageshow');restored.persisted=true;window.dispatchEvent(restored);await flush();
    assert.deepEqual(rows,[]);
    assert.equal(root.hidden,true);
    assert.equal(requests.length,4);
    document.dispatchEvent(new Event('ournotes:shell-dispose'));
    assert.equal(requests.at(-1).options.signal.aborted,true);
    assert.equal(timers.findLast(timer=>timer.delay===60000).cleared,true);
    window.dispatchEvent(restored);await flush();assert.equal(requests.length,4);
  } finally {stop?.();Object.assign(globalThis,previous);}
});


test('automatic notices follow selected server and locale, without extra service instructions',()=>{
  const observations=retainMaintenance({}, {'global-hmt':observation,'global-en':observation,'unknown-host':observation});
  assert.equal(maintenanceStatusRows(observations,{region:'jp'}).length,0);
  assert.equal(maintenanceStatusRows(observations,{region:'global'}).length,2);
  assert.equal(maintenanceStatusRows(observations,{region:'global',serverId:'global-kr'}).length,0);
  const [english]=maintenanceStatusRows(observations,{region:'global',serverId:'global-en',locale:'en'});
  assert.match(english.title,/EN.*Game server updating/);
  assert.match(english.timing,/Expected end:/);
  assert.doesNotMatch(JSON.stringify(english),/imports|reads|Browsing/);
  assert.equal(Object.hasOwn(english,'endsAt'),false);
  assert.equal(Object.keys(observations).length,2);
});

test('only confirmed servers recover; unknown status retains a bounded in-memory notice',()=>{
  const previous=retainMaintenance({}, {'global-hmt':observation,'global-en':observation});
  const next=retainMaintenance(previous,{'global-hmt':{status:'no_maintenance_signal'},'global-en':{status:'unknown'}});
  assert.deepEqual(Object.keys(next),['global-en']);
  assert.equal(next['global-en'].uncertain,true);
  assert.equal(previous['global-en'].uncertain,false);
  assert.deepEqual(retainMaintenance({}, {'global-en':{status:'unknown'}}),{});
});

test('each server gets its own estimate, and elapsed or missing estimates never imply recovery',()=>{
  const at=Date.parse('2026-10-18T05:00:00Z');
  const observations=retainMaintenance({}, {'global-hmt':observation,
    'global-en':{...observation,maintenance:{expectedEndAt:'2026-10-18T07:00:00Z'}},
    'global-kr':{status:'maintenance'}});
  const rows=maintenanceStatusRows(observations,{region:'global'},at);
  assert.match(rows.find(row=>row.serverId==='global-hmt').timing,/14:00/);
  assert.match(rows.find(row=>row.serverId==='global-en').timing,/15:00/);
  assert.equal(rows.find(row=>row.serverId==='global-kr').timing,'结束时间待定');
  const elapsed=maintenanceStatusRows(observations,{region:'global'},at+7200000);
  assert.equal(elapsed.length,3);
  assert.match(elapsed.find(row=>row.serverId==='global-hmt').timing,/14:00.*恢复待确认/);
});

test('polling pauses in hidden pages and BFCache, resumes after an aborted request, and stops on disposal',async()=>{
  const names=['window','document','location','fetch','setTimeout','clearTimeout'];
  const previous=Object.fromEntries(names.map(key=>[key,globalThis[key]]));
  const timers=[],requests=[];
  const root={hidden:true,dataset:{locale:'en'},querySelector:()=>({replaceChildren(){}})};
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  document.hidden=true;
  globalThis.location={pathname:'/global/en/',search:''};
  globalThis.setTimeout=(callback,delay)=>{const timer={callback,delay};timers.push(timer);return timer;};
  globalThis.clearTimeout=timer=>{if(timer)timer.cleared=true;};
  let pending=false;
  globalThis.fetch=(url,options)=>{
    requests.push({url,options});
    if(pending)return new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
    });
    return Promise.resolve({ok:true,json:async()=>({schemaVersion:1,
      validUntil:new Date(Date.now()+60000).toISOString(),servers:{}})});
  };
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const visible=value=>{document.hidden=!value;document.dispatchEvent(new Event('visibilitychange'));};
  const page=(type)=>{const event=new Event(type);event.persisted=true;window.dispatchEvent(event);};
  let stop;
  try {
    stop=installGameServiceNotice(root);await flush();
    assert.equal(requests.length,0,'initially hidden pages do not fetch');
    visible(true);await flush();assert.equal(requests.length,1);
    const scheduled=timers.findLast(timer=>timer.delay===60000);
    visible(false);assert.equal(scheduled.cleared,true);
    await scheduled.callback();assert.equal(requests.length,1);
    pending=true;visible(true);assert.equal(requests.length,2);
    visible(false);assert.equal(requests.at(-1).options.signal.aborted,true);
    pending=false;visible(true);await flush();
    const resume=timers.findLast(timer=>timer.delay===0);
    assert.ok(resume,'a rapid return waits for abort settlement, then retries immediately');
    await resume.callback();assert.equal(requests.length,3);
    const beforeCache=timers.findLast(timer=>timer.delay===60000);
    page('pagehide');assert.equal(beforeCache.cleared,true);
    await beforeCache.callback();assert.equal(requests.length,3);
    page('pageshow');await flush();assert.equal(requests.length,4);
    document.dispatchEvent(new Event('ournotes:shell-dispose'));
    visible(false);visible(true);page('pageshow');await flush();
    assert.equal(requests.length,4);
    assert.equal(timers.findLast(timer=>timer.delay===60000).cleared,true);
  } finally {stop?.();Object.assign(globalThis,previous);}
});
