import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMistakeReference} from '../src/lib/event-mistake-reference-view.mjs';
import {eventYieldBreakdown,eventChallengeBreakdown,eventSongHeading,eventGradeRisk,eventPlanHeading} from '../src/lib/event-result-presentation.mjs';
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.textContent='';}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 addEventListener(){}
 setAttribute(name,value){this[name]=value;}
}
function documentFor(t){const prior=globalThis.document;globalThis.document={createElement:tag=>new Node(tag)};t.after(()=>{globalThis.document=prior;});}
const all=node=>[node,...node.children.flatMap(all)];
const rules={tables:{LiveMusic:[{_id:1,_liveScoreRankGroup:1},{_id:2,_liveScoreRankGroup:2}],LiveScoreRank:[
 {_group:1,_liveScoreRank:2,_requiredScore:0},{_group:1,_liveScoreRank:6,_requiredScore:8000000},
 {_group:1,_liveScoreRank:7,_requiredScore:9000000},{_group:2,_liveScoreRank:7,_requiredScore:10000000}]}};
const riskText=r=>all(eventGradeRisk(r,rules)).map(n=>n.textContent).join(' ').replace(/\s+/g,' ').trim();
const row=()=>({song:{seconds:100},reward:{mode:'ordinary',badges:900,eventPoints:442,challengePoints:40},bonuses:{rewardBP:10000,eventPointBP:1800},total:{badges:316000,eventPoints:174000},normalPlays:100,spentFire:100,remainingFire:0,earnedCP:4000,startingCP:0,minimumRank:6,maximumRank:7,power:1444620,estimatedScore:8818035.9,continuation:{plays:3,badges:226000,eventPoints:129800,remainingCP:0}});
test('farming shows the selected reward grade and skill-order drop probability',t=>{
 documentFor(t);
 const input={...row(),song:{trackId:'music-1'},minimumScore:8800000,scoreBasis:'expectedScore',reward:{scoreRank:7},orderCount:120,gradeProbabilities:[{rank:7,probability:.6},{rank:6,probability:.4}]};
 const text=riskText;
 assert.match(text(input),/SS 60%.*S 40%/);assert.match(text(input),/掉档概率 40%/);assert.match(text(input),/120 种技能顺序等权/);
 assert.match(text({...input,scoreBasis:'minimumScore',reward:{scoreRank:6}}),/S 稳定刷取 · 最低分/);
 assert.match(text({...input,scoreBasis:'minimumScore',reward:{scoreRank:6}}),/掉档概率 0%/);
 assert.match(text({...input,gradeProbabilities:undefined}),/无法计算掉档概率/);
});
test('score headroom uses the selected song threshold and a conservative minimum-score budget',t=>{
 documentFor(t);
 const input={...row(),song:{trackId:'music-1'},scoreBasis:'minimumScore',estimatedScore:9400000,minimumScore:9400000,reward:{scoreRank:7}};
 assert.match(riskText(input),/SS 档门槛 9,000,000 分 AP 最低分 9,400,000 分 稳定分数余量 \+400,000 分/);
 assert.match(riskText(input),/分数余量占最低分约 4.3%/);
 assert.match(riskText({...input,song:{trackId:'music-2'},estimatedScore:10400000,minimumScore:10400000}),/SS 档门槛 10,000,000 分 AP 最低分 10,400,000 分 稳定分数余量 \+400,000 分/);
 assert.match(riskText({...input,estimatedScore:9000000,minimumScore:9000000}),/稳定分数余量为 0/);
 assert.match(riskText({...input,estimatedScore:9000001,minimumScore:9000001}),/分数余量占最低分不足 0.1%/);
});
test('average and best-order headroom never hides a minimum score below the reward threshold',t=>{
 documentFor(t);
 for(const [scoreBasis,label] of [['expectedScore','平均分'],['maximumScore','最高分']]){
  const text=riskText({...row(),song:{trackId:'music-1'},scoreBasis,estimatedScore:9100000.9,minimumScore:8900000,reward:{scoreRank:7}});
  assert.ok(text.includes(`${label} 9,100,000.9 分 · 高出 100,000 分`));
  assert.match(text,/最低分还差 100,000 分，暂无稳定分数余量/);
 }
});
test('the lowest reward grade does not present a 100-percent loss budget',t=>{
 documentFor(t);
 const text=riskText({...row(),song:{trackId:'music-1'},scoreBasis:'minimumScore',estimatedScore:100,minimumScore:100,reward:{scoreRank:2}});
 assert.match(text,/D 档门槛 0 分 AP 最低分 100 分/);
 assert.match(text,/当前已是最低奖励档位/);assert.doesNotMatch(text,/稳定分数余量|占最低分/);
});
test('song summary exposes headroom and drop risk while keeping exact metrics in details',t=>{
 documentFor(t);
 const input={...row(),song:{trackId:'music-1'},draft:{slots:[]},scoreBasis:'minimumScore',minimumScore:9400000,reward:{scoreRank:7},gradeProbabilities:[{rank:7,probability:1}]};
 const summary=r=>all(eventPlanHeading({rules},r)).find(n=>n.className==='event-plan-summary');
 const chips=r=>summary(r).children.filter(n=>n.className==='event-summary-chip').map(n=>n.children.map(c=>c.textContent).join(' '));
 assert.deepEqual(chips(input),['余量 +4.3%','AP 掉档 0%']);
 const root=summary(input),details=root.children.find(n=>n.tagName==='details');
 assert.ok(!details.open);assert.match(all(details).map(n=>n.textContent).join(' '),/SS 档门槛 9,000,000 分/);
 assert.ok(root.children.some(n=>n.tagName==='event-mistake-reference'));
 const risk={...input,scoreBasis:'expectedScore',minimumScore:8900000,gradeProbabilities:[{rank:6,probability:.4},{rank:7,probability:.6}]};
 assert.deepEqual(chips(risk),['缺口 −1.1%','AP 掉档 40%']);
 assert.ok(!summary(risk).children.some(n=>n.tagName==='event-mistake-reference'));
 assert.deepEqual(chips({...input,reward:{scoreRank:2}}),['最低档位 D 档','AP 掉档 0%']);
 assert.equal(chips({...input,gradeProbabilities:[]})[1],'AP 掉档 未知');
});
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

test('mistake reference emphasizes single-miss risk over favorable sampled counts',t=>{
 documentFor(t);const root=new Node('div');
 renderMistakeReference(root,{status:'estimated',patternCount:12,results:[{judgement:4,passingRange:[86,137],oneCanFail:false},{judgement:1,passingRange:[0,9],oneCanFail:true}]});
 const text=all(root).map(n=>n.textContent).join(' ');
 assert.match(text,/GREAT 86–137 个/);assert.match(text,/MISS 1 次也可能掉档/);
 assert.match(text,/不是保底次数或成功概率/);assert.match(text,/技能判定辅助处理后的结算数/);
});
