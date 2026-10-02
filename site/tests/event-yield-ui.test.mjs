import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectEventYieldRows,eventYieldGoals} from '../src/lib/event-yield-goals.mjs';
import {eventYieldStageInput} from '../src/lib/event-yield-stage.mjs';
import {setupEventYieldOptimizer} from '../src/lib/event-yield-ui.mjs';
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

test('ordinary song filters reach the worker, invalidate results and leave challenge and selected charts intact',t=>{
 const nodes=new Map();
 const node=key=>{
  if(!nodes.has(key))nodes.set(key,{value:'',hidden:false,disabled:false,checked:false,textContent:'',children:[],listeners:{},
   setAttribute(){},replaceChildren(...children){this.children=children;},addEventListener(type,fn){this.listeners[type]=fn;},querySelector:node});
  return nodes.get(key);
 };
 const q=key=>node(`[data-yield-${key}]`);
 const tool={q:node,pairs:[],draft:{slots:[],selectedSongId:'music-2',selectedDifficulty:'hard'},data:{
  rules:{tables:{ChallengeMusic:[{_eventId:1,_liveMusicId:2}]}},
  tracks:[{id:'music-1',bandIds:['band-1'],musicType:1},{id:'music-2',bandIds:['band-2'],musicType:2}],
  charts:[{id:'1-e',trackId:'music-1',difficulty:'expert',level:25,analysisDataUrl:'/1'},
   {id:'2-e',trackId:'music-2',difficulty:'expert',level:25,analysisDataUrl:'/2'},
   {id:'2-h',trackId:'music-2',difficulty:'hard',level:15,analysisDataUrl:'/2-h'}]}};
 for(const [key,value] of Object.entries({event:'1',mode:'ordinary',pool:'selected',boost:'1',cost:'200'}))node(key).value=value;
 for(const [key,value] of Object.entries({budget:'100',starting:'0',depth:'quick',goal:'both',basis:'expectedScore',stages:'cycle',songs:'all',band:'band-1',attribute:'1',difficulty:'expert',level:'40','challenge-scope':'selected','challenge-basis':'expectedScore','challenge-difficulty':'expert','challenge-level':'40'}))q(key).value=value;
 const workers=[];
 class WorkerStub {
  constructor(){workers.push(this);}
  addEventListener(){}
  postMessage(data){this.data=data;}
  terminate(){this.stopped=true;}
 }
 const original=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 Object.defineProperty(globalThis,'Worker',{value:WorkerStub,configurable:true,writable:true});
 t.after(()=>{if(original)Object.defineProperty(globalThis,'Worker',original);else delete globalThis.Worker;});
 const optimizer=setupEventYieldOptimizer(tool);
 optimizer.sync();optimizer.run();
 assert.deepEqual(workers.at(-1).data.candidates.map(c=>c.id),['1-e']);
 assert.deepEqual(workers.at(-1).data.challengeCandidates.map(c=>c.id),['2-e']);
 q('results').children=['old recommendation'];q('continue').hidden=false;
 q('band').value='band-2';node('yield-optimizer').listeners.change({stopPropagation(){}});
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
