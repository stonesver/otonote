import test from 'node:test';
import assert from 'node:assert/strict';
import {eventYieldBreakdown,eventChallengeBreakdown,eventSongHeading} from '../src/lib/event-result-presentation.mjs';
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}
 setAttribute(name,value){this[name]=value;}
}
function documentFor(t){const prior=globalThis.document;globalThis.document={createElement:tag=>new Node(tag)};t.after(()=>{globalThis.document=prior;});}
const all=node=>[node,...node.children.flatMap(all)];
const row=()=>({song:{seconds:100},reward:{mode:'ordinary',badges:900,eventPoints:442,challengePoints:40},bonuses:{rewardBP:10000,eventPointBP:1800},total:{badges:316000,eventPoints:174000},normalPlays:100,spentFire:100,remainingFire:0,earnedCP:4000,startingCP:0,minimumRank:6,maximumRank:7,power:1444620,estimatedScore:8818035.9,continuation:{plays:3,badges:226000,eventPoints:129800,remainingCP:0}});
test('breakdown preserves stage totals and separates carried challenge points from earned points',t=>{
 documentFor(t);const input=row();input.startingCP=200;const before=structuredClone(input),root=eventYieldBreakdown(input),nodes=all(root);
 const body=nodes.find(n=>n.tagName==='tbody');assert.deepEqual(body.children.map(tr=>tr.children.map(n=>n.textContent)),[
 ['单次',1,'900','442'],['普通',100,'90,000','44,200'],['挑战',3,'226,000','129,800'],['合计',103,'316,000','174,000']]);
 const facts=nodes.filter(n=>n.tagName==='dt').map(n=>n.textContent);assert.ok(facts.includes('已有挑战 pt'));assert.ok(facts.includes('新获挑战 pt'));assert.ok(facts.includes('预算比值 · 道具 / 火'));assert.deepEqual(input,before);
});
test('challenge readout uses the selected cost reward instead of the base candidate reward',t=>{
 documentFor(t);const input=row(),nodes=all(eventChallengeBreakdown({row:input,cost:1600,plays:2,reward:{badges:90400,eventPoints:51920}}));
 assert.deepEqual(nodes.filter(n=>n.tagName==='dd').slice(0,4).map(n=>n.textContent),['1,600 pt','90,400','51,920','2']);
});
test('song identity keeps a text difficulty alongside color and an optional catalog cover',t=>{
 documentFor(t);const root=eventSongHeading({tracks:[{id:'music-1',title:'歌曲',jacketUrl:'/cover.webp',bandVisuals:[{label:'乐队',icon:'/band.webp'}]}]},{trackId:'music-1',difficulty:'hard',level:20},{grade:'S'}),nodes=all(root);
 assert.equal(nodes.find(n=>n.className==='event-difficulty').textContent,'HARD · 20');assert.equal(nodes.find(n=>n.className==='event-difficulty').dataset.difficulty,'hard');assert.equal(nodes.find(n=>n.className==='event-song-cover').src,'/cover.webp');
 assert.equal(nodes.find(n=>n.className==='event-song-band').alt,'乐队');
});
