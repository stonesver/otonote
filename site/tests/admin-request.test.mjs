import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from '../../backend/admin/static/request.mjs';

test('admin requests finish within their existing deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',(_path,{signal})=>new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  setTimeout(()=>resolve({ok:true,json:async()=>({status:'ready'})}),1000);
 }));
 const pending=request('/api/config');
 t.mock.timers.tick(1001);
 assert.deepEqual(await pending,{status:'ready'});
});

test('admin request timeouts give a readable failure',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',(_path,{signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 }));
 const pending=request('/api/config').catch(error=>error);
 t.mock.timers.tick(12001);
 assert.match((await pending).message,/请求超时/);
});
