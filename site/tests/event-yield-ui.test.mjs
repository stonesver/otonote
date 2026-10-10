import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectEventYieldRows,eventYieldGoals,orderEventYieldRows,eventYieldGaps} from '../src/lib/event-yield-goals.mjs';
import {eventYieldStageInput} from '../src/lib/event-yield-stage.mjs';
import {setupEventYieldOptimizer} from '../src/lib/event-yield-ui.mjs';
import {installProgressDom} from './helpers/progress-dom.mjs';
test('cycle stages choose independent collection and AP basis without inheriting a normal grade',()=>{
 const input={mode:'ordinary',includeChallenge:true,scope:'selected',basis:'minimumScore',challengeScope:'owned',challengeBasis:'expectedScore',draft:{slots:[]}};
 assert.equal(eventYieldStageInput(input,'ordinary').scope,'selected');
 const challenge=eventYieldStageInput(input,'challenge');
 assert.equal(challenge.scope,'owned');assert.equal(challenge.basis,'expectedScore');assert.equal(challenge.mode,'challenge');
 assert.equal(input.scope,'selected');
 assert.equal(eventYieldStageInput({...input,challengeScope:'same'},'challenge').scope,'selected');
 assert.equal(eventYieldStageInput({...input,mode:'challenge'},'challenge').scope,'selected');
});
test('joint event recommendation exposes both item and event-point objectives',()=>{
 const page=readFileSync(new URL('../src/pages/tools/event-efficiency/index.astro',import.meta.url),'utf8');
 const goals=page.match(/<select data-yield-goal>([\s\S]*?)<\/select>/)?.[1];
 assert.match(goals,/value="badges"/);
 assert.match(goals,/value="eventPoints"/);
 assert.match(goals,/^<option value="both"/);
});
test('both objectives retain different teams for the same song instead of hiding its point leader',()=>{
 const base={song:{id:'song',seconds:100},reward:{scoreRank:5},expectedScore:1000};
 const items={...base,id:'items-team',total:{badges:11550,eventPoints:3100},recommendationGoals:['badges']};
 const points={...base,id:'r-team',total:{badges:5770,eventPoints:3470},recommendationGoals:['eventPoints']};
 const selected=selectEventYieldRows([items,points],'both');
 assert.deepEqual(selected.map(r=>r.id),['items-team','r-team']);
 assert.deepEqual(selected.map(r=>r.recommendationGoals),[['badges'],['eventPoints']]);
 assert.deepEqual(selectEventYieldRows(selected,'eventPoints').map(r=>r.id),['r-team']);
 assert.deepEqual(eventYieldGoals('both','challenge'),['badges','eventPoints']);
 assert.deepEqual(eventYieldGoals('grade','challenge'),['badges']);
});
test('identical reward plans share both labels without duplicate display or losing labels on repeated trimming',()=>{
 const row={id:'a',song:{id:'s',seconds:10},reward:{scoreRank:5},expectedScore:1000,total:{badges:200,eventPoints:150}};
 const result=selectEventYieldRows([{...row,recommendationGoals:['badges']},{...row,recommendationGoals:['eventPoints']}]);
 assert.equal(result.length,1);assert.deepEqual(result[0].recommendationGoals,['badges','eventPoints']);
 assert.deepEqual(selectEventYieldRows(result),result);
});

test('short-song ordering compares both currencies to one goal-specific leading plan',()=>{
 const make=(id,seconds,badges,eventPoints)=>({id,song:{id,seconds},reward:{scoreRank:5},expectedScore:1000,total:{badges,eventPoints}});
 const rows=[make('long',150,1000,800),make('short',80,800,1000),make('unknown',null,600,600),make('mid',100,900,900)];
 const before=structuredClone(rows),retained=selectEventYieldRows(rows,'both',rows.length*2);
 const sorted=orderEventYieldRows(retained,'short');
 assert.deepEqual(sorted.map(r=>r.id),['short','mid','long','unknown']);
 assert.deepEqual(orderEventYieldRows(retained,'yield','eventPoints').map(r=>r.id),['short','mid','long','unknown']);
 const {reference,gap}=eventYieldGaps(retained,'badges');
 assert.equal(reference.id,'long');
 assert.deepEqual(gap(rows[0]),{badges:0,eventPoints:0});
 assert.deepEqual(gap(rows[1]),{badges:200,eventPoints:-200});
 assert.deepEqual(gap(rows[3]),{badges:100,eventPoints:-100});
 const points=eventYieldGaps(retained,'eventPoints');
 assert.equal(points.reference.id,'short');
 assert.deepEqual(points.gap(rows[0]),{badges:-200,eventPoints:200});
 assert.deepEqual(rows,before);
});

test('short ordering only rearranges original high-yield candidates and excludes lower-yield short songs',()=>{
 let retained=[];
 for(let i=0;i<45;i++){
  const row={id:`team-${i}`,song:{id:`song-${i}`,seconds:200-i},reward:{scoreRank:5},expectedScore:1000,total:{badges:1000-i,eventPoints:900-i}};
  retained.push(row);
  retained=selectEventYieldRows(retained,'both',30);
 }
 const candidates=selectEventYieldRows(retained,'both');
 assert.equal(candidates.length,5);
 const short=orderEventYieldRows(candidates,'short');
 assert.equal(short[0].song.id,'song-4');
 assert.deepEqual(new Set(short.map(row=>row.id)),new Set(candidates.map(row=>row.id)));
 assert.ok(!short.some(row=>row.song.id==='song-44'));
 assert.deepEqual(eventYieldGaps(candidates).gap(short[0]),{badges:4,eventPoints:4});
 assert.equal(selectEventYieldRows(retained,'badges').length,10);
});

test('ordinary song filters reach the worker, invalidate results and leave challenge and selected charts intact',t=>{
 const nodes=new Map();
 const node=key=>{
  if(!nodes.has(key))nodes.set(key,{value:'',hidden:false,disabled:false,checked:false,textContent:'',children:[],listeners:{},
   setAttribute(){},replaceChildren(...children){this.children=children;},addEventListener(type,fn){this.listeners[type]=fn;},querySelector:node});
  return nodes.get(key);
 };
 const q=key=>node(`[data-yield-${key}]`);
 const tool={q:node,querySelector:node,pairs:[],draft:{slots:[],selectedSongId:'music-2',selectedDifficulty:'hard'},data:{
  rules:{tables:{ChallengeMusic:[{_eventId:1,_liveMusicId:2}]}},
  tracks:[{id:'music-1',bandIds:['band-1'],musicType:1},{id:'music-2',bandIds:['band-2'],musicType:2}],
  charts:[{id:'1-e',trackId:'music-1',difficulty:'expert',level:25,analysisDataUrl:'/1'},
   {id:'2-e',trackId:'music-2',difficulty:'expert',level:25,analysisDataUrl:'/2'},
   {id:'2-h',trackId:'music-2',difficulty:'hard',level:15,analysisDataUrl:'/2-h'}]}};
 for(const [key,value] of Object.entries({event:'1',mode:'ordinary',pool:'selected',boost:'1',cost:'200'}))node(key).value=value;
 for(const [key,value] of Object.entries({budget:'100',starting:'0',depth:'quick',goal:'both',basis:'expectedScore',stages:'cycle',songs:'all',band:'band-1',attribute:'1',difficulty:'expert',level:'40','challenge-scope':'selected','challenge-basis':'expectedScore','challenge-difficulty':'expert','challenge-level':'40'}))q(key).value=value;
 const workers=[];
 class WorkerStub {
  constructor(){workers.push(this);this.listeners={};}
  addEventListener(type,fn){this.listeners[type]=fn;}
  postMessage(data){this.data=data;}
  terminate(){this.stopped=true;}
 }
 const original=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 Object.defineProperty(globalThis,'Worker',{value:WorkerStub,configurable:true,writable:true});
 t.after(()=>{if(original)Object.defineProperty(globalThis,'Worker',original);else delete globalThis.Worker;});
 // The workbench moves conditions/results into sibling columns under the tool.
 node('yield-optimizer').querySelector=()=>{throw new Error('Do not assume filters remain in the legacy panel');};
 installProgressDom(t,q('status'));
 const optimizer=setupEventYieldOptimizer(tool);
 optimizer.sync();optimizer.run();
 assert.deepEqual(workers.at(-1).data.candidates.map(c=>c.id),['1-e']);
 const progress=q('status').progressNode;workers[0].listeners.message({data:{type:'progress',stage:'普通',title:'歌曲',done:1,total:9,detail:'完整复算 2 / 12'}});assert.equal(progress.children[1].value,1/9);
 assert.deepEqual(workers.at(-1).data.challengeCandidates.map(c=>c.id),['2-e']);
 q('results').children=['old recommendation'];q('continue').hidden=false;
 q('band').value='band-2';node('yield-optimizer').listeners.change({stopPropagation(){}});
 assert.equal(progress.hidden,true);workers[0].listeners.message({data:{type:'progress',stage:'旧任务',done:8,total:9}});assert.equal(progress.hidden,true);
 assert.equal(workers[0].stopped,true);assert.deepEqual(q('results').children,[]);assert.equal(q('continue').hidden,true);
 optimizer.run();
 assert.equal(workers.length,1);assert.match(q('status').textContent,/乐队、歌曲属性或难度/);
 q('attribute').value='2';optimizer.sync();optimizer.run('full');
 assert.deepEqual(workers.at(-1).data.candidates.map(c=>c.id),['2-e']);assert.equal(workers.at(-1).data.input.searchDepth,'full');
 q('band').value='band-1';q('attribute').value='1';q('songs').value='selected';optimizer.sync();optimizer.run();
 assert.equal(q('song-filters').hidden,true);assert.deepEqual(workers.at(-1).data.candidates.map(c=>c.id),['2-h']);
 node('mode').value='challenge';q('songs').value='all';optimizer.sync();optimizer.run();
 assert.equal(q('song-filters').hidden,true);assert.deepEqual(workers.at(-1).data.candidates.map(c=>c.id),['2-e']);
 optimizer.destroy();
});
