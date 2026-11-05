import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../backend/admin/static/admin.mjs',import.meta.url),'utf8');
function harness(load){
 const declarations=source.slice(source.indexOf('let config,'),source.indexOf('\nfunction el('));
 const refresh=source.slice(source.indexOf('async function refresh('),source.indexOf('\nfunction navigate('));
 return new Function('noticeLoad',`${declarations}
 const button={disabled:false}, events=[], siteId=()=> 'site', $=()=>button;
 const status=(text)=>events.push(text), refreshLoads=async()=>{events.push('load');};
 const api=async()=>({}), renderSummary=()=>events.push('overview');
 const notices={load:noticeLoad};
 const settings=()=>events.push('settings');
 ${refresh}
 config={};currentView='notices';
 return {events,button,refresh, switchView(view){currentView=view;generation++;return refresh();}};
 `)(load);
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('switching away from pending notices starts other modules without waiting or stale status',async()=>{
 let finish;const gate=new Promise(resolve=>finish=resolve);
 const app=harness(()=>gate), notices=app.refresh();
 await flush();
 await app.switchView('load');
 assert.ok(app.events.includes('load'),'load request must start before notices finishes');
 assert.equal(app.button.disabled,false);
 const before=[...app.events];finish();await notices;await flush();
 assert.deepEqual(app.events,before,'old notices completion must not overwrite the current status');
});
test('same module refreshes are coalesced and old failures do not overwrite another module',async()=>{
 let fail,calls=0;const gate=new Promise((_resolve,reject)=>fail=reject);
 const app=harness(()=>{calls++;return gate;});
 const notices=app.refresh();await app.refresh();assert.equal(calls,1);
 await app.switchView('settings');const before=[...app.events];
 fail(new Error('old notices failure'));await notices;await flush();
 assert.deepEqual(app.events,before);assert.equal(app.button.disabled,false);
});
