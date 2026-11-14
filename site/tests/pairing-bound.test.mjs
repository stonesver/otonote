import test from 'node:test';
import assert from 'node:assert/strict';
import {maximumPairing,createMaximumPairing} from '../src/lib/scoring-rules/maximum-pairing.mjs';
import {pairingProfileBound} from '../src/lib/scoring-rules/pairing-bound.mjs';

test('relaxed character bound covers exact matching with negative weights and required leader',()=>{
  for(let seed=1;seed<=50;seed++) {
    const edges=Array.from({length:8},(_,m)=>Array.from({length:4},(_,s)=>({key:`${m}|${s}`,member:m,support:s,character:m>>1,weight:(m*31+s*19+seed*m*s*11)%71-40}))).flat();
    for(let leader=0;leader<8;leader++) {
      const best=maximumPairing({edges,count:3,requiredMembers:[leader]});
      assert.ok(pairingProfileBound(edges,leader,3)>=best.weight);
    }
    assert.equal(pairingProfileBound(edges,100,3),-Infinity);
    assert.equal(pairingProfileBound(edges,0,5),-Infinity);
  }
});

test('reused weight vectors preserve exact matching, ties and mandatory constraints',()=>{
 const edges=Array.from({length:8},(_,m)=>Array.from({length:4},(_,s)=>({key:`${m}|${s}`,member:m,support:s,character:m>>1}))).flat();
 for(const constraints of [{},{required:['0|1'],forbidden:['4|2'],requiredMembers:[3],requiredSupports:[3]},
  {requiredMembers:[0,1]},{requiredSupports:[0,1,2,3]}]){
  const options={edges,count:3,...constraints},solve=createMaximumPairing(options),weights=new Float64Array(edges.length);
  for(let seed=0;seed<40;seed++){
   edges.forEach((e,i)=>{weights[i]=seed%3===0?0:(e.member*31+e.support*19+seed*e.member*e.support*11)%71-40;});
   const expected=maximumPairing({...options,weight:e=>weights[edges.indexOf(e)]});
   assert.deepEqual(solve(weights),expected,JSON.stringify({constraints,seed}));
   assert.deepEqual(solve(e=>weights[edges.indexOf(e)]),expected,'function after vector resets residual state');
  }
 }
 assert.throws(()=>createMaximumPairing({edges,count:3})(new Float64Array(1)),/wrong size/);
});

test('both matching graphs equal independent exhaustive subsets with forced and forbidden cards',()=>{
 const enumerate=(edges,options)=>{
  let best=-Infinity;
  const visit=(start,chosen,characters,supports,sum)=>{
   if(chosen.length===options.count){
    if((options.required??[]).every(key=>chosen.some(e=>e.key===key))
      &&(options.requiredMembers??[]).every(id=>chosen.some(e=>e.member===id))
      &&(options.requiredSupports??[]).every(id=>chosen.some(e=>e.support===id)))best=Math.max(best,sum);
    return;
   }
   for(let i=start;i<edges.length;i++){
    const e=edges[i];
    if(options.forbidden?.includes(e.key)||characters.has(e.character)||supports.has(e.support))continue;
    visit(i+1,[...chosen,e],new Set([...characters,e.character]),new Set([...supports,e.support]),sum+e.weight);
   }
  };
  visit(0,[],new Set(),new Set(),0);return best;
 };
 const cases=[{},{required:['0|1'],forbidden:['4|2'],requiredMembers:[3],requiredSupports:[3]},
  {requiredMembers:[0,1]},{requiredSupports:[0,1,2,3]},
  {required:['0|0','2|1'],forbidden:['0|0']},{required:['0|0','1|1']}];
 for(let seed=0;seed<20;seed++){
  const edges=Array.from({length:8},(_,m)=>Array.from({length:4},(_,s)=>({key:`${m}|${s}`,member:m,support:s,
   character:m>>1,weight:seed===0?0:(m*31+s*19+seed*m*s*11)%71-40}))).flat();
  for(const constraints of cases){
   const options={edges,count:3,...constraints},expected=enumerate(edges,options);
   for(const compact of [false,true]){
    const result=maximumPairing({...options,compact});
    assert.equal(result?.weight??-Infinity,expected,JSON.stringify({seed,constraints,compact}));
    if(result){
     assert.equal(result.edges.length,3);
     assert.equal(new Set(result.edges.map(e=>e.character)).size,3);
     assert.equal(new Set(result.edges.map(e=>e.support)).size,3);
     for(const id of constraints.requiredMembers??[])assert.ok(result.edges.some(e=>e.member===id));
     for(const id of constraints.requiredSupports??[])assert.ok(result.edges.some(e=>e.support===id));
     for(const key of constraints.required??[])assert.ok(result.edges.some(e=>e.key===key));
     for(const key of constraints.forbidden??[])assert.ok(result.edges.every(e=>e.key!==key));
    }
   }
  }
 }
});

test('interleaved solver sizes preserve ties and mandatory rewards after memory growth',()=>{
 const small=Array.from({length:6},(_,m)=>Array.from({length:4},(_,s)=>({key:`${m}|${s}`,member:m,support:s,character:m>>1,weight:0}))).flat();
 const solve=createMaximumPairing({edges:small,count:3}),expected=solve();
 assert.deepEqual(expected.edges.map(e=>e.key),['0|0','2|1','4|2']);
 const large=Array.from({length:40},(_,m)=>Array.from({length:48},(_,s)=>({key:`${m}|${s}`,member:m,support:s,character:m,weight:m===s?10000:0}))).flat();
 const other=createMaximumPairing({edges:large,requiredMembers:[30],requiredSupports:[39]}),compact=createMaximumPairing({edges:small,count:3,compact:true,requiredMembers:[5]});
 for(let i=0;i<4;i++){
  const row=other();assert.equal(row.weight,50000);
  assert.ok(row.edges.some(e=>e.member===30));assert.ok(row.edges.some(e=>e.support===39));
  assert.deepEqual(solve(),expected);
  assert.ok(compact().edges.some(e=>e.member===5));
  assert.deepEqual(solve(new Float64Array(small.length)),expected);
 }
});
