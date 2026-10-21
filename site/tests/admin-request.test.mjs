import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from '../../backend/admin/static/request.mjs';

test('a 16 second archive preview survives while ordinary admin calls retain their deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',(_path,{signal})=>new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  setTimeout(()=>resolve({ok:true,json:async()=>({text:'bundle text'})}),16000);
 }));
 const archive=request('/api/archive/text/file/preview');
 const ordinary=request('/api/config').catch(error=>error);
 t.mock.timers.tick(12001);await Promise.resolve();
 const error=await ordinary;assert.ok(error instanceof Error);
 t.mock.timers.tick(4000);
 assert.deepEqual(await archive,{text:'bundle text'});
});

test('archive timeouts give a readable failure and retain original downloads',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',(_path,{signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 }));
 const pending=request('/api/archive/entries').catch(error=>error);
 t.mock.timers.tick(45001);
 assert.match((await pending).message,/超时.*原件/);
});
