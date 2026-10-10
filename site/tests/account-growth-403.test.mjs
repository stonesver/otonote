import test from 'node:test';
import assert from 'node:assert/strict';
import {setupAccountGrowthImport} from '../src/lib/account-growth-ui.mjs';

const node = () => ({hidden:false,disabled:false,value:'',textContent:'',listeners:{},
  addEventListener(type,callback){this.listeners[type]=callback;}});
const settled = () => new Promise(resolve => setImmediate(resolve));

test('403 stops retries with the old nonce until the user reconnects', async () => {
  const previousLocation=globalThis.location,previousFetch=globalThis.fetch;
  const elements=new Map(),get=selector=>{
    if(!elements.has(selector))elements.set(selector,node());
    return elements.get(selector);
  };
  const root={querySelector:get,addEventListener(){}};
  const workbench={querySelector:()=>root,addEventListener(){},personalGrowthStore:{}};
  const sent=[];
  globalThis.location={pathname:'/global/tools/song-calculator/',search:'?server=global-hmt'};
  globalThis.fetch=async (url,options={})=>{
    if(url.endsWith('/capabilities/'))return {ok:true,json:async()=>({enabled:true,nonce:sent.length?'new-nonce':'old-nonce'})};
    sent.push(options.headers['X-Growth-Nonce']);
    return {ok:false,status:403,headers:new Headers(),text:async()=>'<html>Forbidden</html>'};
  };
  try {
    setupAccountGrowthImport(workbench,{getInventory:()=>({}),replaceInventory(){}});
    await settled();
    get('[data-growth-account]').value='fixture@example.invalid';
    get('[data-growth-password]').value='fixture-password';
    await get('[data-growth-login]').listeners.submit({preventDefault(){}});
    assert.deepEqual(sent,['old-nonce']);
    assert.match(get('[data-growth-status]').textContent,/重新检查登录服务/);
    assert.equal(get('[data-growth-retry]').hidden,false);
    assert.equal(get('[data-growth-login-fields]').disabled,true);
    get('[data-growth-retry]').listeners.click();
    await settled();
    assert.equal(get('[data-growth-login-fields]').disabled,false);
    get('[data-growth-password]').value='fixture-password';
    await get('[data-growth-login]').listeners.submit({preventDefault(){}});
    assert.deepEqual(sent,['old-nonce','new-nonce']);
  } finally {
    globalThis.location=previousLocation;
    globalThis.fetch=previousFetch;
  }
});
