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
  feedback.finish('本轮完成');assert.equal(bar.value,1);assert.equal(bar.hidden,false);
  feedback.reset();assert.equal(root.hidden,true);
 }finally{globalThis.document=previous;}
});
