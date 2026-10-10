import test from 'node:test';
import assert from 'node:assert/strict';
import {setupChallengeOptimizer} from '../src/lib/challenge-optimizer-ui.mjs';
import {installProgressDom} from './helpers/progress-dom.mjs';

test('challenge controls remain functional after moving outside the result panel',t=>{
 const nodes=new Map(),node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',listeners:{},hidden:false,textContent:'',children:[],addEventListener(type,fn){this.listeners[type]=fn;},setAttribute(){},replaceChildren(...children){this.children=children;}});return nodes.get(key);};
 const tool={q:node,querySelector:node,classList:{contains:()=>true},dataset:{task:'challenge'},draft:{slots:[{memberCardId:'member-card-1',supportCardId:'support-card-1'}],selectedSongId:'music-1',selectedDifficulty:'expert',modifiers:{growth:{'member-card-1':{level:30}},tgwCardRank:20}},data:{tracks:[{id:'music-1',title:'挑战曲'}],charts:[{trackId:'music-1',difficulty:'expert',analysisDataUrl:'/chart.json'}]}};
 node('mode').value='challenge';node('event').value='7';node('[data-challenge-opt-scope]').value='selected';node('[data-challenge-opt-objective]').value='maximum_song_score';
 node('challenge-optimizer').querySelector=()=>{throw Error('Controls have moved into the conditions sidebar');};
 const workers=[];class WorkerStub{constructor(){workers.push(this);this.listeners={};}addEventListener(type,fn){this.listeners[type]=fn;}postMessage(payload){this.payload=payload;}terminate(){this.terminated=true;}}
 const original=Object.getOwnPropertyDescriptor(globalThis,'Worker');Object.defineProperty(globalThis,'Worker',{value:WorkerStub,configurable:true});t.after(()=>{if(original)Object.defineProperty(globalThis,'Worker',original);else delete globalThis.Worker;});
 installProgressDom(t,node('[data-challenge-opt-status]'));
 const ui=setupChallengeOptimizer(tool);ui.sync();assert.equal(node('[data-challenge-opt-run]').disabled,false);node('[data-challenge-opt-run]').listeners.click();
 const progress=node('[data-challenge-opt-status]').progressNode;
 workers[0].listeners.message({data:{type:'progress',stage:'完整复算',completed:2,total:12}});assert.equal(progress.children[1].value,2/12);
 const payload=workers[0].payload;assert.equal(payload.eventId,7);assert.equal(payload.scope,'selected');assert.equal(payload.analysisDataUrl,'/chart.json');assert.deepEqual(payload.draft,tool.draft);assert.notEqual(payload.draft,tool.draft);
 node('[data-challenge-opt-objective]').value='expected_song_score';ui.sync();assert.equal(workers[0].terminated,true);assert.deepEqual(node('[data-challenge-opt-results]').children,[]);
 assert.equal(progress.hidden,true);workers[0].listeners.message({data:{type:'progress',stage:'旧任务',completed:8,total:12}});assert.equal(progress.hidden,true,'late worker messages cannot restore stale progress');
 node('[data-challenge-opt-scope]').value='reference';ui.sync();node('[data-challenge-opt-run]').listeners.click();assert.equal(workers[1].payload.objective,'expected_song_score');assert.equal(workers[1].payload.scope,'reference');assert.equal(workers[1].payload.inventory,undefined);ui.destroy();
 tool.dataset.task='team';ui.sync();assert.equal(node('challenge-optimizer').hidden,true);assert.equal(node('[data-challenge-opt-run]').disabled,true);
 tool.dataset.task='challenge';ui.sync();assert.equal(node('challenge-optimizer').hidden,false);assert.equal(node('[data-challenge-opt-run]').disabled,false);
});
