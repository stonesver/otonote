import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecommendationTeamView} from '../src/lib/recommendation-team-view.mjs';
import {createEventTeamView} from '../src/lib/event-team-view.mjs';
class Element extends EventTarget {
 constructor(tag){super();this.tagName=tag;this.children=[];this.dataset={};this.textContent='';this.attrs={};}
 append(...children){this.children.push(...children);}
 setAttribute(k,v){this.attrs[k]=v;}
 querySelectorAll(selector){return this.children.flatMap(n=>[...(n.className?.split(' ').includes(selector.slice(1))?[n]:[]),...n.querySelectorAll(selector)]);}
}
const all=node=>[node,...node.children.flatMap(all)];
function fixture(t){
 const prior=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};t.after(()=>{globalThis.document=prior;});
 const memberCards=Array.from({length:5},(_,i)=>({id:`member-card-${i}`,kind:'member',shortLabel:`成员 ${i}`})),supportCards=Array.from({length:5},(_,i)=>({id:`support-card-${i}`,kind:'support',shortLabel:`留影 ${i}`}));
 const draft={slots:memberCards.map((m,i)=>({memberCardId:m.id,supportCardId:supportCards[i].id})),modifiers:{growth:Object.fromEntries([...memberCards,...supportCards].map(c=>[c.id,{level:10,rank:1}]))}};
 return {tool:{data:{locale:'zh-CN',memberCards,supportCards}},draft};
}
test('complete roster preserves five ordered pairs and defers replay without a duplicate roster',t=>{
 const {tool,draft}=fixture(t),before=structuredClone(draft),root=createRecommendationTeamView(tool,draft),nodes=all(root),pairs=nodes.filter(n=>n.className==='score-pair');
 assert.equal(pairs.length,5);assert.equal(pairs[2].dataset.leader,'true');
 for(let i=0;i<5;i++)assert.deepEqual(all(pairs[i]).filter(n=>n.className==='tw-card-name').map(n=>n.textContent),[`成员 ${i}`,`留影 ${i}`]);
 assert.deepEqual(draft,before);assert.equal(nodes.filter(n=>n.className==='tw-card-view').length,10);assert.equal(nodes.some(n=>n.className==='recommendation-roster-details'),false);assert.ok(root.children.some(n=>n.tagName==='skill-activation'));
});
test('mixed reference and missing growth retain per-card evidence',t=>{
 const {tool,draft}=fixture(t);delete draft.modifiers.growth['member-card-0'];draft.modifiers.planningResult={referenceCardIds:['support-card-0']};
 const nodes=all(createRecommendationTeamView(tool,draft)),cards=nodes.filter(n=>n.className==='tw-card-view');
 assert.equal(cards[0].dataset.source,'unknown');assert.equal(cards[1].dataset.source,'reference');
 assert.equal(nodes.find(n=>n.className==='score-lineup task-pairing').dataset.uniformSource,undefined);
});
test('mobile facts keep distinct growth fields, skill types and accessible card names',t=>{
 const {tool,draft}=fixture(t);
 Object.assign(tool.data.memberCards[0],{displayName:'完整成员名称',attributeCode:2,rarity:5,rarityLabel:'SSR',skillFacets:{'live-type':['life'],'gekisou-type':['combo']}});
 Object.assign(tool.data.supportCards[0],{skillFacets:{'skill-role':['score'],'gekisou-type':['luck']}});
 draft.modifiers.growth['member-card-0']={level:90,rank:3,awake:4,skillLevel:2,gekisouSkillLevel:5};
 const cards=all(createRecommendationTeamView(tool,draft)).filter(n=>n.className==='tw-card-view');
 const stats=all(cards[0]).filter(n=>n.className==='tw-card-stat');
 assert.equal(cards[0].title,'完整成员名称');
 assert.deepEqual(stats.map(n=>[n.dataset.field,n.title]),[
  ['level','等级 90'],['rank','觉醒 3'],['awake','突破（特训） 4'],['skillLevel','演出技能 2'],['gekisouSkillLevel','激奏技能 5']
 ]);
 assert.equal(stats.find(n=>n.dataset.field==='awake').title,'突破（特训） 4');
 assert.ok(all(cards[0]).some(n=>n.className==='tw-card-stat-label'&&n.textContent==='COMBO'));
 assert.equal(all(cards[0]).filter(n=>n.className==='tw-card-art').length,1);
 assert.ok(all(cards[0]).some(n=>n.textContent==='SSR'));
 assert.deepEqual(all(cards[1]).filter(n=>n.className==='tw-card-stat').map(n=>n.title),['等级 10','突破 1']);
 assert.ok(all(cards[1]).some(n=>n.textContent==='LUCK'));
});
test('mobile facts never invent unrecorded growth and localize labels',t=>{
 const {tool,draft}=fixture(t);tool.data.locale='en';delete draft.modifiers.growth['member-card-0'];
 const member=all(createRecommendationTeamView(tool,draft)).find(n=>n.className==='tw-card-view');
 assert.deepEqual(all(member).filter(n=>n.className==='tw-card-stat').map(n=>n.title),['Level —','Awakening —','Breakthrough (training) —','Live skill —','Gekisou skill —']);
});
test('event result has exactly one complete roster, a manual replay entry and one uniform growth label',t=>{
 const {tool,draft}=fixture(t),before=structuredClone(draft),root=createEventTeamView(tool,draft,{mode:'challenge',eventId:3}),nodes=all(root);
 assert.equal(nodes.filter(n=>n.className==='score-pair').length,5);
 assert.equal(nodes.filter(n=>n.className==='tw-card-name').length,10);
 assert.equal(nodes.some(n=>n.className==='recommendation-pairs'||n.className==='recommendation-roster-details'),false);
 assert.equal(nodes.find(n=>n.className==='score-lineup task-pairing').dataset.uniformSource,'selected');
 assert.equal(nodes.filter(n=>n.className==='task-team-source').length,1);
 const replay=nodes.find(n=>n.tagName==='skill-activation');
 assert.ok(root.children.includes(replay),'replay is not nested in a second roster disclosure');
 assert.equal(replay.expandOnDesktop,undefined);assert.equal(replay.payload.mode,'challenge');assert.equal(replay.payload.eventId,3);
 assert.deepEqual(draft,before);
});
