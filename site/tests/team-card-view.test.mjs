import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeamCardView,resolveTeamCardGrowth} from '../src/lib/team-card-view.mjs';
import {createInventoryManager} from '../src/lib/inventory-manager.mjs';
import {createFormationCalculator} from '../../packages/scoring/scoring-rules/formation-power.mjs';
import {createSharedTeamRules} from './fixtures/shared-team-rules.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
const rules=createSharedTeamRules();
const card={id:'member-card-1',kind:'member',displayName:'Synthetic member',shortLabel:'Synthetic',attributeCode:1,rarity:4,bandIds:['band-1'],characterId:'character-1',imageUrl:'/synthetic.png'};
const actual={level:1,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1};
const inventory=()=>({memberCardIds:[card.id],supportCardIds:[],growth:{[card.id]:structuredClone(actual)}});
const draft=()=>createTeamDraft({slots:[{memberCardId:card.id}],modifiers:{growth:{[card.id]:structuredClone(actual)}}});
class Element extends EventTarget {
 constructor(tag){super();this.tagName=tag;this.children=[];this.dataset={};this.textContent='';}
 append(...children){for(const child of children)child.parent=this;this.children.push(...children);}
 replaceWith(node){const index=this.parent.children.indexOf(this);this.parent.children.splice(index,1,node);node.parent=this.parent;}
}
const document={createElement:tag=>new Element(tag)};
const all=node=>[node,...node.children.flatMap(child=>typeof child==='string'?[]:all(child))];

test('new explicit CSV headers preserve the established field mapping and old templates remain readable',()=>{
 const manager=createInventoryManager(rules);
 const headers=['id,阶数（成员觉醒／留影突破）,突破（特训）阶数','id,rank,awake','id,突破阶数,觉醒阶数'];
 for(const header of headers){
   const rows=manager.preview(`${header}\nmember-card-1,3,2`);
   const value=manager.merge(manager.empty(),rows).inventory.growth[card.id];
   assert.equal(value.rank,3);assert.equal(value.awake,2);
 }
});

test('member breakthrough changes the level cap; awakening does not, while memory rank does',()=>{
 const calculator=createFormationCalculator(rules),member=calculator.card(card.id,'member'),support=calculator.card('support-card-1','support');
 const memberLevel=g=>calculator.resolveGrowth(member,'Member',g).level;
 assert.equal(memberLevel({rank:1,awake:1}),30);
 assert.equal(memberLevel({rank:5,awake:1}),30);
 assert.equal(memberLevel({rank:1,awake:2}),40);
 assert.equal(calculator.resolveGrowth(support,'Support',{rank:2}).level,40);
});

test('member awakening and breakthrough labels match the fields that control the level cap',()=>{
 const view=createTeamCardView(card,{growth:{rank:3,awake:2},data:{document}});
 const stats=all(view).filter(node=>node.className==='tw-card-stat');
 assert.equal(stats.find(node=>node.dataset.field==='rank').title,'觉醒 3');
 assert.equal(stats.find(node=>node.dataset.field==='awake').title,'突破（特训） 2');
 const support=createTeamCardView({...card,kind:'support'},{growth:{rank:3},data:{document}});
 assert.equal(all(support).find(node=>node.dataset.field==='rank').title,'突破 3');
});

test('awakening uses the star while breakthrough stays a concise label with its own value',()=>{
 const icons={rank:'/awakening-star.png',awake:'/awakened-text.png',awakeBase:'/awakening-marker.png'};
 const view=createTeamCardView(card,{growth:{rank:3,awake:2},data:{document,growthIcons:icons}});
 const stats=all(view).filter(node=>node.className==='tw-card-stat');
 const awake=stats.find(node=>node.dataset.field==='awake'),rank=stats.find(node=>node.dataset.field==='rank');
 assert.equal(all(rank).find(node=>node.tagName==='img').src,icons.rank);
 assert.equal(awake.children[0].textContent,'突');
 assert.equal(awake.children.at(-1).textContent,'2');
 assert.equal(all(awake).some(node=>node.tagName==='img'),false);
});

test('unknown fields stay visibly unknown and game icon URLs are reused without interactive descendants',()=>{
 const view=createTeamCardView(card,{growth:{level:2},data:{document,growthIcons:{memberLevel:'/level.png',rank:'/rank.png',awake:'/awakened-text.png',awakeBase:'/awake.png'},filterVisualOptions:{attribute:[{value:'1',label:'Red',icon:'/attribute.png'}],band:[{value:'1',label:'Test band',icon:'/band.png'}]}},source:'actual'});
 assert.equal(view.tagName,'span');assert.equal(view.className,'tw-card-view');
 const nodes=all(view),stats=nodes.filter(node=>node.className==='tw-card-stat');assert.equal(stats.length,5);
 assert.equal(stats[0].children.at(-1).textContent,'Lv.2');assert.equal(stats[1].children.at(-1).textContent,'—');
 assert.ok(stats.some(node=>node.title==='觉醒 —'));assert.ok(nodes.some(node=>node.src==='/attribute.png'));assert.ok(nodes.some(node=>node.src==='/band.png'));
 assert.equal(nodes.some(node=>['button','input','select','a'].includes(node.tagName)),false);
 const support=createTeamCardView({...card,kind:'support'},{data:{document},compact:true});assert.equal(all(support).filter(node=>node.className==='tw-card-stat').length,2);
 assert.ok(all(support).some(node=>node.textContent==='养成未记录'));
});
test('actual and explicitly selected growth remain distinct and are never mutated',()=>{
 const owned=inventory(),d=draft(),before=structuredClone(owned);
 assert.deepEqual(resolveTeamCardGrowth({card,draft:d,inventory:owned,rules}),{growth:actual,source:'actual'});
 d.modifiers.planningScenario={scope:'selected'};d.modifiers.growth[card.id].skillLevel=4;
 assert.equal(resolveTeamCardGrowth({card,draft:d,inventory:owned,rules}).source,'selected');assert.equal(resolveTeamCardGrowth({card,draft:d,inventory:owned,rules}).growth.skillLevel,4);
 assert.deepEqual(owned,before);d.modifiers.planningScenario={scope:'owned'};assert.deepEqual(resolveTeamCardGrowth({card,draft:d,inventory:{memberCardIds:[],growth:{}},rules}),{growth:{},source:'unknown'});assert.deepEqual(resolveTeamCardGrowth({card,draft:createTeamDraft(),rules}),{growth:{},source:'unknown'});
});
test('reference and unowned trial cards materialize only explicit reference assumptions',()=>{
 const d=draft();d.modifiers.planningScenario={scope:'reference',referenceGrowth:'maximum'};
 const resolved=resolveTeamCardGrowth({card,draft:d,inventory:inventory(),rules});assert.equal(resolved.source,'reference');assert.equal(resolved.growth.rank,5);assert.equal(resolved.growth.level,70);
 d.modifiers.planningScenario={scope:'trial',trialCardIds:{memberCardIds:[card.id]},referenceGrowth:'maximum'};
 assert.equal(resolveTeamCardGrowth({card,draft:d,inventory:{memberCardIds:[],growth:{}},rules}).source,'reference');
 assert.equal(d.modifiers.growth[card.id].level,1);
});
test('explicit missing-growth reference is displayed as an assumption without granting actual ownership',()=>{
 const d=createTeamDraft({slots:[{memberCardId:card.id}],modifiers:{planningScenario:{scope:'selected',unknownGrowth:'reference',referenceGrowth:'maximum'}}}),before=structuredClone(d);
 const resolved=resolveTeamCardGrowth({card,draft:d,inventory:{memberCardIds:[],growth:{}},rules});
 assert.equal(resolved.source,'reference');assert.equal(resolved.growth.level,70);assert.equal(resolved.growth.rank,5);assert.deepEqual(d,before);
 assert.equal(resolveTeamCardGrowth({card,draft:d,inventory:inventory(),rules}).source,'actual');
 d.modifiers.growth={[card.id]:resolved.growth};d.modifiers.planningResult={referenceCardIds:[card.id],actualGrowth:{[card.id]:null}};
 assert.equal(resolveTeamCardGrowth({card,draft:d,rules}).source,'reference');
});
test('only selected training is shown; dormant targets remain actual even when a target exists',()=>{
 const owned=inventory(),d=draft();d.modifiers.planningScenario={scope:'selected',plan:{enabled:true,mode:'target',targets:{[card.id]:{skillLevel:5}}}};
 d.modifiers.planningResult={actualGrowth:structuredClone(owned.growth),selectedTrainingCardIds:[]};
 assert.deepEqual(resolveTeamCardGrowth({card,draft:d,inventory:owned,rules}),{growth:actual,source:'actual'});
 d.modifiers.planningResult.selectedTrainingCardIds=[card.id];
 let result=resolveTeamCardGrowth({card,draft:d,inventory:owned,rules});assert.equal(result.source,'training');assert.equal(result.growth.skillLevel,5);
 delete d.modifiers.planningResult.selectedTrainingCardIds;result=resolveTeamCardGrowth({card,draft:d,inventory:owned,rules});assert.equal(result.source,'training');
 d.modifiers.planningScenario.plan.allowedCardIds=[];assert.equal(resolveTeamCardGrowth({card,draft:d,inventory:owned,rules}).source,'actual');assert.deepEqual(owned.growth[card.id],actual);
});

test('failed art keeps a placeholder and failed game icons retain labels and numeric values',()=>{
 const view=createTeamCardView(card,{growth:{level:2,rank:3},data:{document,growthIcons:{memberLevel:'/missing-level.png'},filterVisualOptions:{attribute:[{value:'1',label:'Red',icon:'/missing-attribute.png'}]}}});
 const images=all(view).filter(node=>node.tagName==='img');assert.equal(images.length,3);
 for(const image of images)image.dispatchEvent(new Event('error'));
 const nodes=all(view);assert.equal(nodes.some(node=>node.tagName==='img'),false);
 assert.ok(nodes.some(node=>node.className==='tw-card-no-art'&&node.textContent==='—'));
 assert.ok(nodes.some(node=>node.className==='tw-card-stat-label'&&node.textContent==='等级'));
 assert.ok(nodes.some(node=>node.textContent==='Lv.2'));assert.ok(nodes.some(node=>node.textContent==='属性 Red'));
});
test('unscoped editor input displays supplied growth without rewriting actual records; owned remains actual',()=>{
 const d=draft(),owned=inventory();d.modifiers.growth[card.id].level=2;
 let result=resolveTeamCardGrowth({card,draft:d,inventory:owned,rules});assert.equal(result.growth.level,2);assert.equal(result.source,'selected');assert.equal(owned.growth[card.id].level,1);
 d.modifiers.growth[card.id]={};result=resolveTeamCardGrowth({card,draft:d,inventory:owned,rules});assert.deepEqual(result,{growth:{},source:'unknown'});
 d.modifiers.planningScenario={scope:'owned'};result=resolveTeamCardGrowth({card,draft:d,inventory:owned,rules});assert.equal(result.growth.level,1);assert.equal(result.source,'actual');
});
