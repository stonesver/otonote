import {eventScopeControls} from './helpers/calculation-scopes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupEventYieldOptimizer} from '../src/lib/event-yield-ui.mjs';

function harness(t){
 class Node {
  constructor(){this.dataset={};this.children=[];this.listeners={};this.attrs={};this.value='';this.textContent='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  removeChild(node){this.children.splice(this.children.indexOf(node),1);}
  insertBefore(node,anchor){if(this.children.includes(node))this.removeChild(node);this.children.splice(anchor?this.children.indexOf(anchor):this.children.length,0,node);}
  scrollIntoView(){}
  focus(){globalThis.document.activeElement=this;}
  querySelector(selector){
   const all=this.children.flatMap(n=>[n,...n.descendants()]);
   if(selector==='[data-yield-phase][aria-selected="true"]')return all.find(n=>n.dataset.yieldPhase&&n.attrs['aria-selected']==='true');
   if(selector==='[data-yield-stage-cost][aria-pressed="true"]')return all.find(n=>n.dataset.yieldStageCost&&n.attrs['aria-pressed']==='true');
   return null;
  }
  descendants(){return this.children.flatMap(n=>[n,...n.descendants()]);}
  before(node){this.beforeNode=node;}
  setAttribute(k,v){this.attrs[k]=v;}
  removeAttribute(k){delete this.attrs[k];}
  addEventListener(k,fn){this.listeners[k]=fn;}
  querySelectorAll(selector){return this.children.flatMap(n=>[...(n.className?.split(' ').includes(selector.slice(1))?[n]:[]),...n.querySelectorAll(selector)]);}
 }
 const prior={document:globalThis.document,Worker:globalThis.Worker},nodes=new Map(),workers=[];
 globalThis.document={documentElement:{lang:'zh-CN'},createElement:()=>new Node()};
 globalThis.Worker=class extends Node {constructor(){super();workers.push(this);}postMessage(input){this.input=input;}terminate(){this.terminated=true;}};
 t.after(()=>{for(const [k,v] of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const node=k=>{if(!nodes.has(k))nodes.set(k,new Node());return nodes.get(k);},q=k=>node(`[data-yield-${k}]`);
 for(const [k,v] of Object.entries({event:'3',mode:'ordinary',pool:'selected',boost:'3',cost:'200'}))node(k).value=v;
 for(const [k,v] of Object.entries({budget:'100',starting:'0',depth:'full',goal:'badges',basis:'expectedScore',stages:'direct',songs:'all',difficulty:'all',level:'40','challenge-difficulty':'all','challenge-level':'40'}))q(k).value=v;
 q('goal').querySelector=node;
 const tool={q:node,querySelector:node,draft:{slots:[],modifiers:{}},data:{rules:{tables:{ChallengeMusic:[],LiveMusic:[]}},tracks:[{id:'music-1'}],charts:[{id:'chart-1',trackId:'music-1',difficulty:'hard',level:10,analysisDataUrl:'/chart'}]}};
 const optimizer=setupEventYieldOptimizer(tool,{createScopeControls:eventScopeControls,validateCardPool:()=>{}});optimizer.sync();optimizer.run();t.after(()=>optimizer.destroy());
 assert.equal(workers.length,1);
 const send=data=>workers.at(-1).listeners.message({data});
 const partial=(value,type='partial')=>({type,done:1,total:360,available:360,rows:['one','two'].map((id,i)=>({id,song:{id,title:id,difficulty:'hard',seconds:100},total:{badges:value-i,eventPoints:100},reward:{mode:'ordinary',scoreRank:5,badges:1,eventPoints:1,challengePoints:1},draft:{slots:[]},bonuses:{rewardBP:0,eventPointBP:0},normalPlays:33,spentFire:99,remainingFire:1,earnedCP:1,expectedScore:1000,estimatedScore:1000,minimumRank:5,maximumRank:5,power:1})),failures:[],coverageComplete:true});
 return {q,optimizer,send,partial,workers,tool};
}

test('cycle results explain whether challenge bands are unrestricted or inherited',t=>{
 const {q,optimizer,send,partial,tool}=harness(t);
 tool.data.rules.tables.ChallengeMusic=[{_eventId:3,_liveMusicId:1}];
 const member=q('member-band');member.multiple=true;member.options=[{value:'1',textContent:'MyGO!!!!!'}];member.selectedOptions=member.options;
 q('stages').value='cycle';optimizer.sync();optimizer.run();send(partial(1000,'result'));
 assert.ok(q('results').children.some(node=>/后续挑战：不限乐队/.test(node.textContent)));
 assert.match(q('card-band-hint').textContent,/不受普通阶段/);
 q('challenge-band-scope').checked=true;q('challenge-band-scope').listeners.change();assert.equal(q('results').children.length,0);
 optimizer.run();send(partial(1000,'result'));
 assert.ok(q('results').children.some(node=>/后续挑战：沿用普通阶段.*MyGO/.test(node.textContent)));
 assert.match(q('challenge-band-note').textContent,/沿用普通阶段.*MyGO/);
});

test('new candidates publish automatically, reuse unchanged teams and preserve the selected plan',async t=>{
 const {q,send,partial}=harness(t);
 send({type:'progress',stage:'event-group-proof',title:'全曲谱',done:1,total:360,detail:'已验证 100 个分支'});
 const heading=q('status').beforeNode.children[0].children[0],initialHeading=heading.textContent;
 send(partial(1000));const visible=q('results').children.slice();
 send(partial(1100));send(partial(1200));
 assert.deepEqual(q('results').children,visible,'coalesce a burst instead of rebuilding for every message');
 assert.equal(heading.textContent,initialHeading);
 await new Promise(resolve=>setTimeout(resolve,780));
 assert.notEqual(q('results').children[0],visible[0],'latest improvement appears automatically');
 const articles=q('results').querySelectorAll('.task-event-plan-result');
 const tabs=q('results').querySelectorAll('.task-event-result-tabs').find(n=>n.attrs['aria-label']==='收益方案');tabs.children[1].listeners.click();
 const updated=partial(1200);updated.rows[0].search={bestProven:true};send(updated);
 await new Promise(resolve=>setTimeout(resolve,780));
 assert.deepEqual(q('results').querySelectorAll('.task-event-plan-result'),articles,'proof-only changes preserve cards and playback DOM');
 assert.equal(articles[1].hidden,false);
 send(partial(1300,'result'));
 assert.equal(q('results').querySelectorAll('.task-event-plan-result')[1].hidden,false,'completion preserves the selected plan');
 assert.equal(q('status').beforeNode.dataset.state,'complete');
});

test('stopping publishes the latest candidates; old workers cannot replace them',t=>{
 const {q,send,partial,optimizer}=harness(t);
 send(partial(1000));const old=q('results').children[0];send(partial(1500));q('cancel').listeners.click();
 assert.notEqual(q('results').children[0],old);
 const stopped=q('results').children.slice();send(partial(2000));assert.deepEqual(q('results').children,stopped);
 optimizer.run();assert.equal(q('results').children.length,0);
 optimizer.destroy();
});

test('rapid progress is coalesced and queued updates cannot overwrite completion',async t=>{
 const {q,send,partial}=harness(t),root=q('status').beforeNode;
 send({type:'progress',stage:'search',detail:'分支 1',done:1,total:360});
 for(let i=2;i<100;i++)send({type:'progress',stage:'search',detail:`分支 ${i}`,done:1,total:360});
 assert.match(root.children[2].textContent,/分支 1$/);
 await new Promise(resolve=>setTimeout(resolve,275));
 assert.match(root.children[2].textContent,/分支 99$/);
 send({type:'progress',stage:'search',detail:'不可覆盖完成状态',done:1,total:360});
 send(partial(2000,'result'));
 await new Promise(resolve=>setTimeout(resolve,275));
 assert.equal(root.dataset.state,'complete');assert.doesNotMatch(root.children[2].textContent,/不可覆盖/);
});

test('default selection follows a new leader and invalidation discards queued results',async t=>{
 const {q,send,partial,optimizer}=harness(t);
 send(partial(1000));const better=partial(1200);better.rows[0].id='new';better.rows[0].song={...better.rows[0].song,id:'new',title:'新领先方案'};
 send(better);await new Promise(resolve=>setTimeout(resolve,780));
 const articles=q('results').querySelectorAll('.task-event-plan-result');assert.equal(articles[0].hidden,false);
 assert.ok(articles[0].querySelectorAll('.event-song-copy')[0].children.some(n=>n.textContent.includes('新领先方案')));
 send(partial(1400));optimizer.invalidate();await new Promise(resolve=>setTimeout(resolve,780));
 assert.equal(q('results').children.length,0);assert.equal(q('status').beforeNode.hidden,true);
});

test('ten recommendations expose an accurate eight-item page and keep the last two reachable',t=>{
 const {q,send,partial}=harness(t),data=partial(1000,'result'),sample=data.rows[0];
 data.rows=Array.from({length:10},(_,i)=>({...sample,id:`team-${i}`,song:{...sample.song,id:`song-${i}`,title:`Song ${i}`},total:{badges:1000-i,eventPoints:100}}));
 send(data);
 const nodes=n=>[n,...n.children.flatMap(nodes)];
 assert.equal(q('results').querySelectorAll('.task-event-plan-choice').length,8);
 const comparison=q('results').querySelectorAll('.event-alternatives')[0],firstTeam=q('results').querySelectorAll('.task-event-plan-result')[0];
 assert.ok(q('results').children.indexOf(comparison)<q('results').children.indexOf(firstTeam),'switching plans is available before the full roster');
 assert.equal(comparison.open,true,'multiple candidates are visible without opening a disclosure');
 assert.ok(nodes(q('results')).some(n=>n.textContent==='1–8 / 10 套'));
 nodes(q('results')).find(n=>n.textContent==='下一页方案').listeners.click();
 assert.equal(q('results').querySelectorAll('.task-event-plan-choice').length,2);
 assert.ok(nodes(q('results')).some(n=>n.textContent==='9–10 / 10 套'));
 const articles=q('results').querySelectorAll('.task-event-plan-result');assert.equal(articles.filter(n=>!n.hidden).length,1);
});


test('combined objectives stay inside comparison controls and phase tabs preserve separate teams and costs',t=>{
 const {q,send,partial}=harness(t);q('goal').value='both';
 const data=partial(1000,'result'),normal=data.rows[0];
 normal.continuation={plays:4,badges:400,eventPoints:200,remainingCP:0,stages:[{cost:1600,plays:3,reward:{badges:100,eventPoints:50},row:{...normal,reward:{...normal.reward,mode:'challenge'},song:{...normal.song,title:'Challenge song'}}},{cost:200,plays:1,reward:{badges:10,eventPoints:5},row:{...normal,reward:{...normal.reward,mode:'challenge'},song:{...normal.song,title:'Remainder song'}}}]};
 send(data);
 const comparison=q('results').querySelectorAll('.event-alternatives')[0];
 assert.equal(comparison.querySelectorAll('.task-event-goal-tabs').length,1);
 assert.equal(q('results').children.some(n=>n.className?.includes('task-event-goal-tabs')),false);
 let article=q('results').querySelectorAll('.task-event-plan-result')[0];
 const tabs=article.querySelectorAll('.event-phase-tabs')[0],panels=article.children.filter(n=>n.attrs.role==='tabpanel');
 assert.deepEqual(panels.map(n=>n.hidden),[false,true]);
 tabs.children[1].listeners.click();assert.deepEqual(panels.map(n=>n.hidden),[true,false]);
 assert.equal(tabs.children[1].attrs['aria-selected'],'true');
 const costs=panels[1].querySelectorAll('.task-event-result-tabs')[0];costs.children[1].listeners.click();
 assert.equal(costs.children[1].attrs['aria-pressed'],'true');
 const changed={...data,rows:data.rows.map((row,i)=>i?row:{...row,total:{...row.total,badges:1100}})};send(changed);
 article=q('results').querySelectorAll('.task-event-plan-result')[0];
 assert.equal(article.querySelector('[data-yield-phase][aria-selected="true"]').dataset.yieldPhase,'challenge');
 assert.equal(article.querySelector('[data-yield-stage-cost][aria-pressed="true"]').dataset.yieldStageCost,'200');
 const updatedTabs=article.querySelectorAll('.event-phase-tabs')[0];
 updatedTabs.children[1].listeners.keydown({key:'ArrowLeft',preventDefault(){}});
 assert.equal(updatedTabs.children[0].attrs['aria-selected'],'true');
 assert.equal(globalThis.document.activeElement,updatedTabs.children[0]);
});
