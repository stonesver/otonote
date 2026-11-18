import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {extname} from 'node:path';
import {transform} from '@astrojs/compiler-rs';
import {experimental_AstroContainer} from 'astro/container';

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const runtime = dataUrl(`export * from ${JSON.stringify(import.meta.resolve('astro/compiler-runtime'))};
 export const createMetadata=()=>({});export const renderScript=()=>'';`);
async function compile(name) {
 const path=new URL(`../src/components/${name}`,import.meta.url);
 const {code}=await transform(await readFile(path,'utf8'),{filename:path.pathname,internalURL:'astro/compiler-runtime'});
 const specs=[...code.matchAll(/from\s*(["'])([^"']+)\1/g)].map(m=>m[2]);
 let output=code;
 for(const spec of new Set(specs)) {
  const target=spec==='astro/compiler-runtime'?runtime:spec.endsWith('.astro')?await compile(spec.split('/').at(-1)):new URL(extname(spec) ? spec : spec + '.ts',path).href;
  output=output.replaceAll(JSON.stringify(spec),JSON.stringify(target));
 }
 return dataUrl(output);
}
const {default:Component}=await import(await compile('EventCountdown.astro'));
const container=await experimental_AstroContainer.create();
const props={start:'2026/10/18 10:00:00',end:'2026/10/25 10:00:00',edition:'global'};

test('event time has useful initial HTML even without external interaction scripts',async()=>{
 for(const locale of ['zh-CN','en']) {
  const html=await container.renderToString(Component,{props:{...props,locale}});
  assert.doesNotMatch(html,/计算时间中|Calculating/);
  assert.match(html,/data-state="(upcoming|active|ended)"/);
 }
});
test('inline initialization corrects stale prerendered countdowns before any modules load',async()=>{
 const html=await container.renderToString(Component,{props});
 const inline=html.match(/<script[^>]*data-event-countdown-init[^>]*>([\s\S]*?)<\/script>/);
 assert.ok(inline,'initialize from inline code without waiting for module downloads');
 const label={textContent:'stale snapshot'};
 const node={dataset:{start:String(Date.parse('2026-10-18T02:00:00Z')),end:String(Date.parse('2026-10-25T02:00:00Z')),en:'false'},querySelector:()=>label};
 const NativeDate=Date;
 class BrowserDate extends NativeDate {static now(){return NativeDate.parse('2026-10-18T03:00:00Z');}}
 vm.runInNewContext(inline[1],{document:{currentScript:{previousElementSibling:node}},Date:BrowserDate});
 assert.equal(node.dataset.state,'active');assert.match(label.textContent,/剩余/);
 node.dataset.start='';node.dataset.end='';vm.runInNewContext(inline[1],{document:{currentScript:{previousElementSibling:node}},Date:BrowserDate});
 assert.equal(label.textContent,'时间待确认');
});

test('returning from the browser page cache refreshes time and restarts exactly one timer',async()=>{
 const {transform:transpile}=await import('esbuild');
 const {eventCountdown}=await import('../src/lib/event-time.mjs');
 const {refreshEventCountdown}=await import('../src/lib/event-countdown-client.mjs');
 const source=await readFile(new URL('../src/components/EventCountdown.astro',import.meta.url),'utf8');
 const result=await transform(source,{filename:'EventCountdown.astro'});
 const script=result.scripts.find(s=>s.code.includes('setInterval'));
 const {code}=await transpile(script.code,{loader:'ts'});
 const label={textContent:''},node={dataset:{start:'1000',end:'2000',en:'false'},querySelector:()=>label};
 const listeners={},timers=new Set();let now=1500,sequence=0;
 const clearInterval=id=>timers.delete(id);
 vm.runInNewContext(code.replace(/^import .*;\n/gm,''),{
  eventCountdown,refreshEventCountdown:(node,calc)=>refreshEventCountdown(node,calc,now),clearInterval,
  document:{querySelectorAll:()=>[node],addEventListener(){},removeEventListener(){}},
  window:{setInterval(){const id=++sequence;timers.add(id);return id;},addEventListener:(name,fn)=>{listeners[name]=fn;}}
 });
 assert.equal(node.dataset.state,'active');assert.equal(timers.size,1);
 listeners.pagehide();assert.equal(timers.size,0);
 now=3000;listeners.pageshow();assert.equal(node.dataset.state,'ended');assert.equal(label.textContent,'已结束');assert.equal(timers.size,1);
 listeners.pageshow();assert.equal(timers.size,1);
});

test('Global event heading displays Beijing time and countdown reaches the same instant',async()=>{
 const {default:Hero}=await import(await compile('EventHero.astro'));
 const schedule={startAt:'2026/11/18 15:00:00',endAt:'2026/11/27 14:59:59',timeZone:null};
 const html=await container.renderToString(Hero,{props:{event:{id:6,name:'Event',edition:'global',mode:'challenge_live',schedule}}});
 assert.match(html,/2026\/11\/18 14:00/);
 assert.match(html,/2026\/11\/27 13:59/);
 assert.match(html,/北京时间（UTC\+8）/);
 const countdown=await container.renderToString(Component,{props:{start:schedule.startAt,end:schedule.endAt,edition:'global'}});
 assert.match(countdown,new RegExp('data-start="'+Date.parse('2026-11-18T06:00:00Z')+'"'));
});
