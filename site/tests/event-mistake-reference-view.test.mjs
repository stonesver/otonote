import test from 'node:test';
import assert from 'node:assert/strict';

class Node {
 constructor(){this.children=[];this.dataset={};this.attrs={};this.listeners={};this.isConnected=false;}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(k,v){this.attrs[k]=v;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(k,fn){this.listeners[k]=fn;}
}
const registry=new Map(),workers=[];
globalThis.HTMLElement=Node;
globalThis.customElements={get:name=>registry.get(name),define:(name,element)=>registry.set(name,element)};
globalThis.document={createElement:tag=>new (registry.get(tag)??Node)()};
globalThis.Worker=class {
 constructor(){workers.push(this);}
 postMessage(input){this.input=input;}
 terminate(){this.terminated=true;}
};
const {eventMistakeReference}=await import('../src/lib/event-mistake-reference-view.mjs');
const row={song:{id:'song-1',analysisDataUrl:'/chart'},draft:{slots:[]},worstOrder:[0,1,2,3,4],reward:{mode:'challenge',eventId:3,scoreRank:7}};
const reference={status:'estimated',patternCount:12,results:[{judgement:4,passingRange:[86,137],oneCanFail:false},{judgement:1,passingRange:[0,9],oneCanFail:true}]};
function mount(cache,input=row){const view=eventMistakeReference(input,{}, {details:new Node(),cache});view.isConnected=true;view.connectedCallback();return view;}
test('selected reference starts automatically, cancels obsolete work and reuses completed results',()=>{
 workers.length=0;const cache=new Map(),view=mount(cache);
 assert.equal(workers.length,0,'hidden candidates do not start');
 view.setActive(true);assert.equal(workers.length,1);
 const stale=workers[0];view.setActive(false);assert.equal(stale.terminated,true);
 stale.onmessage({data:{reference}});assert.equal(cache.size,0,'late results from a cancelled worker are ignored');
 view.setActive(true);assert.equal(workers.length,2);const active=workers[1];
 view.setActive(true);assert.equal(workers.length,2,'repeated visibility updates do not restart work');
 active.onmessage({data:{referenceProgress:{completed:1,total:24}}});
 assert.match(view.details.children[0].textContent,/1 \/ 24/);
 active.onmessage({data:{reference}});assert.equal(active.terminated,true);
 assert.deepEqual(view.labels.map(n=>n.textContent),['86–137','1 次可能掉档']);
 assert.equal(view.labels[1].parentElement.dataset.tone,'warn');
 view.disconnectedCallback();view.isConnected=false;
 const recreated=mount(cache);recreated.setActive(true);
 assert.equal(workers.length,2,'same plan can reuse results after pagination or rerender');
 assert.deepEqual(recreated.labels.map(n=>n.textContent),['86–137','1 次可能掉档']);
 const different=mount(cache,{...row,worstOrder:[4,3,2,1,0]});different.setActive(true);
 assert.equal(workers.length,3,'a different skill order must be recalculated');
 different.disconnectedCallback();assert.equal(workers[2].terminated,true);
});
test('failures stay explicit and retry without an automatic loop',()=>{
 workers.length=0;const view=mount(new Map());view.setActive(true);
 workers[0].onerror();assert.equal(view.retry.hidden,false);
 assert.deepEqual(view.labels.map(n=>n.textContent),['未算出','未算出']);
 view.setActive(true);assert.equal(workers.length,1);
 view.retry.listeners.click();assert.equal(workers.length,2);
 workers[0].onerror();assert.equal(view.worker,workers[1],'an old error cannot terminate the retry');
 workers[1].onmessage({data:{reference}});assert.equal(view.retry.hidden,true);
});
