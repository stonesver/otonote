import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTool, stageClientTools} from '../src/runtime/tool-startup.mjs';

test('cold-rendered tools are hidden before attachment and revealed together after initialization', () => {
  const styles = [], gates = [];
  const regions = [0, 1].map(() => ({ attributes:new Set(), inert:false, hidden:false,
    setAttribute(name){this.attributes.add(name);}, removeAttribute(name){this.attributes.delete(name);},
    before(node){gates.push(node);}
  }));
  const document = {
    head:{append:node=>styles.push(node)},
    querySelectorAll:selector=>{assert.ok(selector.includes('ap-grade-tool'));return regions;},
    createElement:()=>({setAttribute(){},remove(){this.removed=true;}})
  };
  const reveal = stageClientTools(document, 'zh-CN');
  assert.equal(gates.length, 2);
  assert.match(styles[0].textContent, /display: none !important/);
  assert.ok(regions.every(r=>r.hidden && r.inert && r.attributes.has('data-tool-pending')));
  assert.ok(gates.every(g=>/正在准备工具/.test(g.textContent) && !g.removed));
  reveal();
  assert.ok(regions.every(r=>!r.hidden && !r.inert && !r.attributes.size));
  assert.ok(gates.every(g=>g.removed));
});

function fixture() {
  const nodes = ['cards', 'songs'].map(name => ({dataset:{deferredJson:name, sha256:name}, textContent:''}));
  const modules = ['picker', 'workbench'].map(deferredModule => ({dataset:{deferredModule}}));
  const region = {inert:true, hidden:true, attributes:new Set(['aria-busy','data-tool-pending']),
    removeAttribute(name){this.attributes.delete(name);}, querySelectorAll:()=>nodes};
  const status = {textContent:''}, retry = {hidden:true};
  const gate = {removed:false, remove(){this.removed=true;}, querySelector:()=>({setAttribute(){}})};
  const lookup = {'[data-tool-pending]':region,'[data-tool-status]':status,'[data-tool-gate]':gate,'[data-tool-retry]':retry};
  let ready = 0;
  return {nodes, region, gate, status, retry,
    options:{document:{querySelector:key=>lookup[key],querySelectorAll:()=>modules},locale:'zh-CN',onReady:()=>ready++,onError:()=>{}},
    ready:()=>ready};
}

test('entering a tool starts all data reads and enables it only after ordered module initialization', async () => {
  const f = fixture(), pending = new Map(), imported = [];
  const task = prepareTool({...f.options,
    readJson:(url, hash)=>{assert.equal(url,hash); return new Promise(resolve=>pending.set(url,resolve));},
    importModule:async url=>{
      assert.deepEqual(f.nodes.map(n=>JSON.parse(n.textContent)),[{cards:1},{songs:1}]);
      assert.equal(f.region.inert,true);
      assert.equal(f.region.hidden,true, 'the old controls stay out of the first paint');
      imported.push(url);
    }
  });
  assert.deepEqual([...pending.keys()],['cards','songs']);
  pending.get('cards')({cards:1});
  await Promise.resolve();
  assert.deepEqual(imported,[]);
  pending.get('songs')({songs:1});
  await task;
  assert.deepEqual(imported,['picker','workbench']);
  assert.equal(f.region.inert,false);
  assert.equal(f.region.hidden,false);
  assert.equal(f.region.attributes.size,0);
  assert.equal(f.gate.removed,true);
  assert.equal(f.ready(),1);
});

for (const stage of ['data','module']) test(`${stage} failure leaves controls locked and exposes a real reload`, async () => {
  const f=fixture();
  await prepareTool({...f.options,
    readJson:async()=>{if(stage==='data')throw Error('offline');return {};},
    importModule:async()=>{throw Error('module failed');}
  });
  assert.equal(f.region.inert,true);
  assert.equal(f.region.hidden,true);
  assert.equal(f.gate.removed,false);
  assert.equal(f.retry.hidden,false);
  assert.match(f.status.textContent,/准备失败/);
  assert.equal(f.ready(),0);
});

test('unavailable tools do not load dormant modules or data', async () => {
  await prepareTool({document:{querySelector:()=>null},readJson:()=>assert.fail(),importModule:()=>assert.fail()});
});
