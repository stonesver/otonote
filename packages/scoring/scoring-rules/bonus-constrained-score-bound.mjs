import {createMaximumPairing} from './maximum-pairing.mjs';

/** Score upper bound inside a minimum-additive-bonus subspace. Nothing here
 * supplies a score or excludes a card. For lambda>0, mu>=0 and B>=T:
 *   S <= P*H <= (lambda*P+H)^2/(4*lambda)
 *   lambda*P+H <= base + maxMatching(lambda*p+gain+mu*bonus) - mu*T.
 * Matching retains character/support capacities, locked pairs and the leader.
 * Integer ceilings and an absolute outward allowance cover proxy arithmetic.
 */
export function createBonusConstrainedScoreBound({coefficients,spans,profileFor,metric}) {
  if(!coefficients?.length||coefficients.length>100000||!coefficients.every(v=>Number.isFinite(v)&&v>=0))return null;
  const prefix=[0];for(const value of coefficients)prefix.push(prefix.at(-1)+value);
  const total=prefix.at(-1),n=coefficients.length+1,u=2**-53;
  const epsilon=total*2*n*u/(1-n*u),baseCoefficient=total+epsilon;
  const positionGains=new Map();
  const gains=new Map([...spans].map(([signature,positions])=>{
    const values=positions.map(effects=>effects.reduce((sum,e)=>sum+Math.max(0,prefix[e.last]-prefix[e.first]+epsilon)*e.value,0));
    positionGains.set(signature,values);
    // A max over positions relaxes their uniqueness. For expected/minimum
    // score each member occurs in each position 24 times among 120 orders.
    return [signature,metric==='maximumScore'?Math.max(...values):values.reduce((a,b)=>a+b,0)/5];
  }));
  const bound=createBonusConstrainedScoreEnvelopeBound({baseCoefficient,gainFor:edge=>gains.get(profileFor(edge).signature)});
  bound.envelope.positionGainsFor=edge=>positionGains.get(profileFor(edge).signature);
  return bound;
}

/** The same matching relaxation for an already conservative P-linear
 * envelope. A group may take per-edge and base maxima across normalized
 * charts. integerScore=false retains fractional score/threshold bounds. */
export function createBonusConstrainedScoreEnvelopeBound({baseCoefficient,gainFor:uncachedGainFor,integerScore=true,cutoff=-Infinity}) {
  if(!Number.isFinite(baseCoefficient)||baseCoefficient<0||typeof uncachedGainFor!=='function')return null;
  const gainCache=new WeakMap();
  const gainFor=edge=>{
    if(!gainCache.has(edge))gainCache.set(edge,uncachedGainFor(edge));
    return gainCache.get(edge);
  };
  const stats={matchingCalls:0};
  // matchingCache belongs to one immutable edge/bonus/mandatory-vertex
  // domain. Chart gains, thresholds and probe weights may change freely.
  const bound=function(available,forced,leader,solution,error,bonusFor,minBonus,constraints={},scoreCutoff=cutoff,matchingCache){
    const witnesses=new Map();bound.witnesses=[];
    if(!Number.isSafeInteger(minBonus)||minBonus<0||!Number.isFinite(error)||error<0||solution.weight<=0)return Infinity;
    const powers=new Float64Array(available.length),gains=new Float64Array(available.length),
      bonusValues=new Float64Array(available.length),probeWeights=new Float64Array(available.length);
    let largestPower=0,largestGain=0,largestBonus=0,index=0;
    for(const edge of available){
      const bonus=bonusFor(edge),gain=gainFor(edge);
      if(!Number.isSafeInteger(bonus)||bonus<0||!Number.isFinite(gain)||gain<0)return Infinity;
      powers[index]=edge.weight;gains[index]=gain;bonusValues[index++]=bonus;
      largestBonus=Math.max(largestBonus,bonus);
      largestPower=Math.max(largestPower,Math.abs(edge.weight));largestGain=Math.max(largestGain,gain);
    }
    const options={edges:available,required:forced.map(e=>e.key),requiredMembers:[...new Set([leader,...(constraints.memberRequired??[])])],requiredSupports:constraints.supportRequired??[]};
    const remember=result=>{
      if(!result)return;
      const row={edges:result.edges,weight:result.edges.reduce((s,e)=>s+e.weight,0),bonus:result.edges.reduce((s,e)=>s+bonusFor(e),0)};
      const key=row.edges.map(e=>e.key).join(';');
      if(!witnesses.has(key)){
        if(witnesses.size>=16)witnesses.delete(witnesses.keys().next().value);
        witnesses.set(key,row);
      }
      bound.witnesses=[...witnesses.values()];return row;
    };
    const solve=matchingCache?.solve??createMaximumPairing(options);
    if(matchingCache)matchingCache.solve=solve;
    const match=weight=>{
      stats.matchingCalls++;
      // A future unsupported magnitude must loosen the bound, never silently
      // overflow an exact matching weight. Existing scoring errors still use
      // the normal search/fallback path.
      try{return solve(weight);}catch{return null;}
    };
    const bonusMaximum=matchingCache?.bonusMaximum!==undefined?matchingCache.bonusMaximum:match(bonusValues);
    if(matchingCache)matchingCache.bonusMaximum=bonusMaximum;
    if(!bonusMaximum)return Infinity;
    remember(bonusMaximum);
    if(bonusMaximum.weight<minBonus)return 0; // Exact infeasibility certificate.
    const base=baseCoefficient*(1+error);
    let lambda=base/solution.weight,upper=Infinity,feasibleAtCutoff=false;
    if(!Number.isFinite(lambda)||lambda<=0)return Infinity;
    const probe=(lambda,mu)=>{
      const magnitude=lambda*largestPower+largestGain+mu*largestBonus;
      if(!Number.isFinite(magnitude)||!Number.isFinite(mu*minBonus))return null;
      // Keep every arc below 2^30: maximumPairing's mandatory-vertex rewards
      // and all five augmentations remain safely inside binary64 integers.
      const scale=2**30/Math.max(1,magnitude),allowance=magnitude*1e-10;
      if(!Number.isFinite(scale)||scale<=0)return null;
      for(let i=0;i<available.length;i++)probeWeights[i]=Math.ceil((lambda*powers[i]+gains[i]+mu*bonusValues[i]+allowance)*scale);
      const result=match(probeWeights);
      if(!result)return null;
      const row=remember(result);
      const sum=base+result.weight/scale-mu*minBonus;
      // Subtraction may cancel large terms; inflate their absolute scale,
      // rather than multiplying the small residual by a relative epsilon.
      const outward=Math.max(0,sum)+(base+5*(magnitude+allowance)+mu*minBonus)*1e-10;
      const rawUpper=outward*outward/(4*lambda)*(1+1e-10);
      const scoreUpper=integerScore?Math.ceil(rawUpper):rawUpper;
      if(Number.isFinite(scoreUpper))upper=Math.min(upper,scoreUpper);
      const gain=result.edges.reduce((s,e)=>s+gainFor(e),0);
      // A bonus-feasible matching reaching the cutoff in this relaxed
      // envelope means no tighter dual bound can exclude that grade here.
      // Keep the conservative upper already computed and let the caller
      // refine its actual card/chart domain. This is not a score or a proof
      // that the formation reaches the grade in the native calculator.
      if(Number.isFinite(scoreCutoff)&&scoreCutoff>0&&row.bonus>=minBonus
        &&row.weight*(base+gain)>=scoreCutoff)feasibleAtCutoff=true;
      return {...row,gain};
    };
    for(let iteration=0;iteration<3;iteration++){
      const initial=probe(lambda,0);if(upper<scoreCutoff||feasibleAtCutoff)return upper;if(!initial)break;
      let chosen=initial;
      if(initial.bonus<minBonus){
        let lo=0,hi=(base+lambda*solution.weight)/Math.max(1,minBonus),high;
        for(let i=0;i<12;i++){
          high=probe(lambda,hi);if(upper<scoreCutoff||feasibleAtCutoff)return upper;if(!high)break;
          chosen=high;if(high.bonus>=minBonus)break;
          lo=hi;hi*=2;
        }
        if(high?.bonus>=minBonus)for(let i=0;i<12;i++){
          const mid=(lo+hi)/2,row=probe(lambda,mid);if(upper<scoreCutoff||feasibleAtCutoff)return upper;if(!row)break;
          chosen=row;if(row.bonus<minBonus)lo=mid;else hi=mid;
        }
      }
      const next=(base+chosen.gain)/chosen.weight;
      if(!Number.isFinite(next)||next<=0||Math.abs(next-lambda)<=lambda*1e-6)break;
      lambda=next;
    }
    return upper;
  };
  bound.stats=stats;bound.witnesses=[];bound.envelope={baseCoefficient,gainFor};
  return bound;
}
