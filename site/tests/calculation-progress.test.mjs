import test from 'node:test';
import assert from 'node:assert/strict';
import {progressSnapshot,createCalculationProgress} from '../src/lib/calculation-progress.mjs';

test('unknown search totals are indeterminate; reported stage counts are bounded',()=>{
 assert.equal(progressSnapshot({completed:52}).fraction,null);
 assert.equal(progressSnapshot({completed:0,total:0}).fraction,null);
 assert.equal(progressSnapshot({completed:NaN,total:100}).fraction,null);
 assert.equal(progressSnapshot({completed:3,total:10}).fraction,.3);
 assert.equal(progressSnapshot({completed:12,total:10}).fraction,1);
 assert.equal(progressSnapshot({completed:-1,total:10}).fraction,0);
});

test('stage transitions remove stale percentages; cancellation and reset remove busy feedback',()=>{
 class Node {
  constructor(){this.dataset={};this.attrs={};this.children=[];}
  append(...nodes){this.children.push(...nodes);}
  before(node){this.inserted=node;}
  setAttribute(k,v){this.attrs[k]=v;}
  removeAttribute(k){delete this.attrs[k];if(k==='value')delete this.value;}
 }
 const previous=globalThis.document;globalThis.document={createElement:()=>new Node()};
 try{
  const anchor=new Node(),feedback=createCalculationProgress(anchor,'test'),root=anchor.inserted,bar=root.children[1];
  assert.equal(root.hidden,true);
  feedback.update({label:'精算',completed:3,total:10});assert.equal(bar.value,.3);
  feedback.update({label:'准备下一阶段'});assert.equal(bar.value,undefined);
  feedback.finish('已停止','保留已完成方案','stopped');assert.equal(bar.hidden,true);assert.equal(root.dataset.state,'stopped');
  feedback.finish('失败','谱面不可用','error');assert.equal(root.dataset.state,'error');
  assert.equal(root.children[2].textContent,'谱面不可用');
  feedback.finish('请选择有效谱面','','error');assert.equal(root.children[2].textContent,'请选择有效谱面');
  feedback.finish('本轮完成');assert.equal(bar.value,1);assert.equal(bar.hidden,false);
  feedback.reset();assert.equal(root.hidden,true);
 }finally{globalThis.document=previous;}
});

// Repeated worker updates must not replace the heading text node or restart the bar.
test('progress changes only the text and value that actually changed',()=>{
 class Node {
  constructor(){this.dataset={};this.children=[];this.writes=0;this.attributes=0;}
  append(...n){this.children.push(...n);}
  before(n){this.inserted=n;}
  set textContent(v){this.text=v;this.writes++;}
  setAttribute(){this.attributes++;}
  removeAttribute(){this.attributes++;}
 }
 const previous=globalThis.document;globalThis.document={createElement:()=>new Node()};
 try {
  const anchor=new Node(),feedback=createCalculationProgress(anchor,'test');
  const [heading,bar,detail]=anchor.inserted.children,label=heading.children[0];
  feedback.update({label:'正在比较',completed:3,total:360,detail:'分支 10'});
  const attributes=bar.attributes;
  feedback.update({label:'正在比较',completed:3,total:360,detail:'分支 11'});
  feedback.update({label:'正在比较',completed:3,total:360,detail:'分支 11'});
  assert.equal(label.writes,1);assert.equal(detail.writes,2);assert.equal(bar.attributes,attributes);
 } finally {globalThis.document=previous;}
});

test('elapsed time ticks without worker messages, freezes on stop, and resets between runs',()=>{
 class Node {
  constructor(){this.dataset={};this.children=[];}
  append(...nodes){this.children.push(...nodes);}
  before(node){this.inserted=node;}
  setAttribute(){}
  removeAttribute(){}
 }
 const original=globalThis.document;globalThis.document={createElement:()=>new Node()};
 let time=0,tick,active=false;
 try {
  const anchor=new Node(),feedback=createCalculationProgress(anchor,'test',{now:()=>time,schedule:fn=>{tick=fn;active=true;return 1;},unschedule:()=>{active=false;}});
  const counter=anchor.inserted.children[0].children[1];
  feedback.update({label:'正在比较',completed:2,total:8});time=65000;tick();assert.equal(counter.textContent,'2 / 8 · 已用时 1 分 5 秒');
  feedback.finish('已停止','','stopped');assert.equal(active,false);time=80000;feedback.finish('已停止','','stopped');assert.equal(counter.textContent,'用时 1 分 5 秒');
  feedback.update({label:'重新开始'});assert.equal(counter.textContent,'已用时 不足 1 秒');assert.equal(active,true);
  feedback.reset();assert.equal(active,false);feedback.update({label:'重新开始'});time+=2000;tick();assert.equal(counter.textContent,'已用时 2 秒');
  feedback.destroy();assert.equal(active,false);
 }finally {globalThis.document=original;}
});
