import test from 'node:test';
import assert from 'node:assert/strict';
import {createBonusConstrainedScoreBound,createBonusConstrainedScoreEnvelopeBound} from '../../packages/scoring/scoring-rules/bonus-constrained-score-bound.mjs';
import {maximumPairing,partitionPairing} from '../../packages/scoring/scoring-rules/maximum-pairing.mjs';
import {constrainBonusCards} from '../src/lib/event-yield-optimizer.mjs';

function* orders(values,n=values.length){
 if(!n){yield [];return;}
 for(let i=0;i<values.length;i++)for(const tail of orders(values.filter((_,j)=>i!==j),n-1))yield [values[i],...tail];
}
const coefficient=[1,2,4,8,16],base=coefficient.reduce((a,b)=>a+b,0);
function fixture(){
 const members=Array.from({length:6},(_,i)=>({id:`m${i}`,character:i===5?0:i})),supports=Array.from({length:6},(_,i)=>`s${i}`);
 const profiles=new Map(),spans=new Map();
 for(let i=0;i<7;i++){
  const profile={signature:String(i)};profiles.set(i,profile);
  spans.set(String(i),coefficient.map((_,p)=>[{first:p,last:p+1,value:i/10}]));
 }
 return {members,supports,profiles,spans};
}
test('minimum-bonus score bounds dominate independent exhaustive member variants, pairings and orders',()=>{
 const f=fixture();
 for(const leader of ['m0','m1']){
  const edges=f.members.flatMap((m,i)=>f.supports.map((support,j)=>({key:`${m.id}|${support}`,member:m.id,support,character:m.character,
   weight:100+(i*13+j*7+(leader==='m1'?i*3:0))%91,bonus:(i*11+j*3)%31,profile:f.profiles.get((i*3+j)%7)})));
  const root={leader,required:[],forbidden:[]},solution=maximumPairing({edges,requiredMembers:[leader]});
  const all=[];
  for(const members of [f.members.slice(0,5),[...f.members.slice(1,5),f.members[5]]]){
   if(!members.some(m=>m.id===leader))continue;
   for(const supports of orders(f.supports,5)){
    const chosen=members.map((m,i)=>edges.find(e=>e.member===m.id&&e.support===supports[i]));
    const power=chosen.reduce((s,e)=>s+e.weight,0),rates=chosen.map(e=>Number(e.profile.signature)/10);
    let maximum=-Infinity;
    for(const order of orders(rates))maximum=Math.max(maximum,base+order.reduce((s,g,p)=>s+g*coefficient[p],0));
    all.push({keys:new Set(chosen.map(e=>e.key)),members:new Set(chosen.map(e=>e.member)),supports:new Set(chosen.map(e=>e.support)),bonus:chosen.reduce((s,e)=>s+e.bonus,0),
     expected:power*(base+rates.reduce((s,g)=>s+g,0)*base/5),maximum:power*maximum});
   }
  }
  for(const metric of ['expectedScore','minimumScore','maximumScore']){
   const bound=createBonusConstrainedScoreBound({coefficients:coefficient,spans:f.spans,profileFor:e=>e.profile,metric});
   for(const state of [root,{...root,memberRequired:['m2'],supportRequired:['s5']},...partitionPairing(root,solution)]){
    const available=edges.filter(e=>!state.forbidden.includes(e.key));
    const solved=maximumPairing({edges:available,required:state.required,requiredMembers:[leader,...(state.memberRequired??[])],requiredSupports:state.supportRequired??[]});
    if(!solved)continue;
    const rows=all.filter(row=>state.required.every(k=>row.keys.has(k))&&state.forbidden.every(k=>!row.keys.has(k))&&(state.memberRequired??[]).every(k=>row.members.has(k))&&(state.supportRequired??[]).every(k=>row.supports.has(k)));
    const maxBonus=Math.max(...rows.map(r=>r.bonus));
    for(const threshold of [0,Math.floor(maxBonus*.8),maxBonus,maxBonus+1]){
     const exact=Math.max(0,...rows.filter(r=>r.bonus>=threshold).map(r=>metric==='maximumScore'?r.maximum:r.expected));
     const upper=bound(available,solved.edges.filter(e=>state.required.includes(e.key)),leader,solved,0,e=>e.bonus,threshold,state);
     assert.ok(upper>=exact,`${leader} ${metric} ${threshold}: ${upper} < ${exact}`);
     for(const witness of bound.witnesses){
      assert.equal(witness.edges.length,5);assert.equal(new Set(witness.edges.map(e=>e.character)).size,5);
      assert.equal(new Set(witness.edges.map(e=>e.support)).size,5);assert.ok(witness.edges.some(e=>e.member===leader));
      for(const id of state.memberRequired??[])assert.ok(witness.edges.some(e=>e.member===id));
      for(const id of state.supportRequired??[])assert.ok(witness.edges.some(e=>e.support===id));
      for(const key of state.required)assert.ok(witness.edges.some(e=>e.key===key));
      for(const key of state.forbidden)assert.ok(witness.edges.every(e=>e.key!==key));
     }
    }
   }
  }
 }
});
test('a grade requiring high power excludes a conflicting high-bonus team without dropping it',()=>{
 const profile={signature:'zero'},spans=new Map([['zero',Array.from({length:5},()=>[])]]);
 const edges=Array.from({length:5},(_,i)=>({key:`m${i}|s${i}`,member:`m${i}`,support:`s${i}`,character:i,weight:100,bonus:0}));
 edges.push({key:'weak|s4',member:'weak',support:'s4',character:4,weight:1,bonus:1000});
 const solution=maximumPairing({edges,requiredMembers:['m0']});
 const bound=createBonusConstrainedScoreBound({coefficients:[1],spans,profileFor:()=>profile,metric:'expectedScore'});
 const upper=bound(edges,[],'m0',solution,0,e=>e.bonus,1000);
 assert.ok(upper>=401);assert.ok(upper<450);
 assert.equal(bound(edges,[],'m0',solution,0,e=>e.bonus,1001),0);
 assert.equal(bound(edges,[],'m0',solution,0,()=>NaN,1),Infinity);
 assert.equal(createBonusConstrainedScoreBound({coefficients:[NaN],spans,profileFor:()=>profile,metric:'expectedScore'}),null);
});

test('merged normalized chart envelopes bound each chart and retain fractional proof gaps',()=>{
 const profile={signature:'zero'},spans=new Map([['zero',Array.from({length:5},()=>[])]]);
 const edges=Array.from({length:5},(_,i)=>({key:`m${i}|s${i}`,member:`m${i}`,support:`s${i}`,character:i,weight:100,bonus:0}));
 edges.push({key:'weak|s4',member:'weak',support:'s4',character:4,weight:1,bonus:1000});
 const solution=maximumPairing({edges,requiredMembers:['m0']});
 const charts=[{coefficient:1,threshold:450},{coefficient:1.1,threshold:480}];
 const envelopes=charts.map(c=>{
  const single=createBonusConstrainedScoreBound({coefficients:[c.coefficient],spans,profileFor:()=>profile,metric:'expectedScore'}).envelope;
  return {baseCoefficient:single.baseCoefficient/c.threshold*(1+1e-10),gainFor:e=>single.gainFor(e)/c.threshold*(1+1e-10)};
 });
 const bound=createBonusConstrainedScoreEnvelopeBound({baseCoefficient:Math.max(...envelopes.map(e=>e.baseCoefficient)),
  gainFor:edge=>Math.max(...envelopes.map(e=>e.gainFor(edge))),integerScore:false});
 const upper=bound(edges,[],'m0',solution,0,e=>e.bonus,1000);
 for(const chart of charts)assert.ok(upper>=401*chart.coefficient/chart.threshold);
 assert.ok(upper>0&&upper<1,'a valid fractional upper bound excludes both grade thresholds');
 const unconstrained=bound(edges,[],'m0',solution,0,e=>e.bonus,0);
 for(const chart of charts)assert.ok(unconstrained>=500*chart.coefficient/chart.threshold);
 assert.equal(createBonusConstrainedScoreEnvelopeBound({baseCoefficient:Infinity,gainFor:()=>0}),null);
});

test('normalized proof stops refining once a conservative bound already excludes the grade',()=>{
 const edges=Array.from({length:5},(_,i)=>({key:`m${i}|s${i}`,member:`m${i}`,support:`s${i}`,character:i,weight:100,bonus:0}));
 edges.push({key:'weak|s4',member:'weak',support:'s4',character:4,weight:1,bonus:1000});
 const solution=maximumPairing({edges,requiredMembers:['m0']});
 const make=cutoff=>createBonusConstrainedScoreEnvelopeBound({baseCoefficient:1/450,gainFor:()=>0,integerScore:false,cutoff});
 const full=make(-Infinity),early=make(1);
 const exact=401/450;
 const args=[edges,[],'m0',solution,0,e=>e.bonus,1000];
 for(const upper of [full(...args),early(...args)])assert.ok(upper>=exact&&upper<1);
 assert.ok(early.stats.matchingCalls<full.stats.matchingCalls,`${early.stats.matchingCalls} >= ${full.stats.matchingCalls}`);
});

test('a per-call grade cutoff stops matching once its safe envelope already excludes that grade',()=>{
 const edges=Array.from({length:5},(_,i)=>({key:`m${i}|s${i}`,member:`m${i}`,support:`s${i}`,character:i,weight:100,bonus:0}));
 edges.push({key:'weak|s4',member:'weak',support:'s4',character:4,weight:1,bonus:1000});
 const solution=maximumPairing({edges,requiredMembers:['m0']});
 const make=()=>createBonusConstrainedScoreEnvelopeBound({baseCoefficient:1,gainFor:()=>0});
 const full=make(),early=make(),args=[edges,[],'m0',solution,0,e=>e.bonus,1000,{}];
 const expected=full(...args),actual=early(...args,450);
 assert.ok(expected>=401&&expected<450);assert.ok(actual>=401&&actual<450);
 assert.ok(early.stats.matchingCalls<full.stats.matchingCalls);
 // The next stricter grade must still be refined independently.
 assert.equal(early(...args,400),expected);
});

test('conditional card envelopes equal independent card-subset enumeration under mandatory characters',()=>{
 const choose=(rows,n)=>n===0?[[]]:rows.flatMap((row,i)=>choose(rows.slice(i+1),n-1).map(tail=>[row,...tail]));
 for(let seed=1;seed<=12;seed++){
  const members=Array.from({length:7},(_,i)=>({id:`m${i}`,group:i===6?0:i,value:(i*17+seed*13)%59}));
  const supports=Array.from({length:7},(_,i)=>({id:`s${i}`,value:(i*23+seed*7)%71}));
  const edges=members.flatMap(m=>supports.map(s=>({key:m.id+'|'+s.id,member:m.id,support:s.id,character:m.group})));
  const value=(kind,id)=>(kind==='member'?members:supports).find(r=>r.id===id).value;
  for(const state of [{memberRequired:[],supportRequired:[]},{memberRequired:['m0','m3'],supportRequired:['s2']},
    {memberRequired:['m0','m6'],supportRequired:[]},{memberRequired:['absent'],supportRequired:[]},
    {memberRequired:['m0','m1','m2','m3','m4'],supportRequired:['s0','s1','s2','s3','s4']}]){
   const allowed=(rows,required)=>choose(rows,5).filter(team=>required.every(id=>team.some(r=>r.id===id))&&new Set(team.map(r=>r.group??r.id)).size===5);
   const ms=allowed(members,state.memberRequired),ss=allowed(supports,state.supportRequired),sum=team=>team.reduce((n,r)=>n+r.value,0);
   const maximum=(sets,id)=>Math.max(-Infinity,...sets.filter(team=>!id||team.some(r=>r.id===id)).map(sum));
   for(const threshold of [0,150,300,500]){
    const expected=edges.filter(e=>maximum(ms,e.member)+maximum(ss)>=threshold&&maximum(ss,e.support)+maximum(ms)>=threshold);
    assert.deepEqual(constrainBonusCards(edges,state,value,threshold).map(e=>e.key),expected.map(e=>e.key));
   }
  }
 }
});
