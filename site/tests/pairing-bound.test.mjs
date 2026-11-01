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
