import {solvePairing} from './maximum-pairing-kernel.mjs';
/** Exact cardinality matching with character capacities and mandatory vertices.
 * The topology is reusable when only integer weights change. Each solve resets
 * all residual capacities; no approximate matching or warm-start state leaks. */
export function createMaximumPairing({edges,count=5,required=[],forbidden=[],requiredMembers=[],requiredSupports=[],compact=false}) {
  const byKey=required.length?new Map(edges.map(e=>[e.key,e])):null;
  const banned=new Set(forbidden),forced=required.map(key=>byKey.get(key));
  const impossible=()=>null;
  if(forced.some(e=>!e||banned.has(e.key))||forced.length>count)return impossible;
  for(const field of ['member','support','character'])if(new Set(forced.map(e=>e[field])).size!==forced.length)return impossible;
  const usedValues=Object.fromEntries(['member','support','character'].map(field=>[field,new Set(forced.map(e=>e[field]))]));
  const used=(field,value)=>usedValues[field].has(value);
  let candidates=[],indices=[];
  edges.forEach((e,i)=>{if(!banned.has(e.key)&&!used('member',e.member)&&!used('support',e.support)&&!used('character',e.character)){candidates.push(e);indices.push(i);}});
  const needM=new Set(requiredMembers.filter(id=>!used('member',id))),needS=new Set(requiredSupports.filter(id=>!used('support',id)));
  const remaining=count-forced.length;
  if(needM.size>remaining||needS.size>remaining)return impossible;
  const requiredCharacters=new Map();
  if(compact){
    for(const id of needM){
      const edge=candidates.find(e=>e.member===id);if(!edge)return impossible;
      if(requiredCharacters.has(edge.character)&&requiredCharacters.get(edge.character)!==id)return impossible;
      requiredCharacters.set(edge.character,id);
    }
    const kept=[],keptIndices=[];
    for(let i=0;i<candidates.length;i++){
      const e=candidates[i];if(requiredCharacters.has(e.character)&&requiredCharacters.get(e.character)!==e.member)continue;
      kept.push(e);keptIndices.push(indices[i]);
    }
    candidates=kept;indices=keptIndices;
  }
  const graph=[[],[]],to=[],initial=[],rewardArcs=[],arcs=[],source=0,sink=1;
  const node=()=>{graph.push([]);return graph.length-1;};
  const add=(a,b)=>{const i=to.length;to.push(b,a);initial.push(1,0);graph[a].push(i);graph[b].push(i+1);return i;};
  const characterNodes=new Map(),memberNodes=new Map(),supportNodes=new Map(),pairArcs=new Map();
  // The default graph retains tie order. Bound-only compact graphs select
  // the best member per character/support; mandatory members filter variants.
  for(const e of candidates){
    let c=characterNodes.get(e.character),m=memberNodes.get(e.member),s=supportNodes.get(e.support);
    const newC=c===undefined,newM=m===undefined,newS=s===undefined;
    if(newC){c=node();characterNodes.set(e.character,c);}
    if(newM){m=compact?c:node();memberNodes.set(e.member,m);}
    if(newS){s=node();supportNodes.set(e.support,s);}
    if(newC){const arc=add(source,c);if(compact&&requiredCharacters.has(e.character))rewardArcs.push(arc);}
    if(newM&&!compact){const arc=add(c,m);if(needM.has(e.member))rewardArcs.push(arc);}
    if(newS){const arc=add(s,sink);if(needS.has(e.support))rewardArcs.push(arc);}
    if(compact){
      let bySupport=pairArcs.get(e.character);if(!bySupport)pairArcs.set(e.character,bySupport=new Map());
      let arc=bySupport.get(e.support);if(arc===undefined){arc=add(m,s);bySupport.set(e.support,arc);}
      arcs.push(arc);
    }else arcs.push(add(m,s));
  }
  const initialCapacity=Uint8Array.from(initial);
  // Contiguous adjacency keeps the same relaxation order while avoiding
  // nested array iteration in every augmenting path of every weight probe.
  const destinations=Int32Array.from(to),offsets=new Int32Array(graph.length+1),adjacency=new Int32Array(to.length);
  let offset=0;
  for(let u=0;u<graph.length;u++){offsets[u]=offset;adjacency.set(graph[u],offset);offset+=graph[u].length;}
  offsets[graph.length]=offset;
  const weights=new Float64Array(edges.length),topology={count,compact,offsets,adjacency,destinations,initial:initialCapacity,indices:Int32Array.from(indices),candidateArcs:Int32Array.from(arcs),rewardArcs:Int32Array.from(rewardArcs)};
  const forcedIndices=forced.map(e=>edges.indexOf(e));
  // Linear probes supply integer vectors in edge order. Their construction
  // already computes maximumWeight; other callers retain normal validation.
  return function solve(weight=e=>e.weight,maximumWeight){
    let max=0,values=weights;
    if(typeof weight==='function'){
      for(let i=0;i<edges.length;i++){values[i]=weight(edges[i]);max=Math.max(max,Math.abs(values[i]));}
    }else{
      if(weight?.length!==edges.length)throw new Error('Matching weight vector has the wrong size');
      values=weight;
      if(maximumWeight===undefined)for(let i=0;i<edges.length;i++)max=Math.max(max,Math.abs(values[i]));else max=maximumWeight;
    }
    const reward=2*count*max+1;
    if(!Number.isSafeInteger(reward*(2*count+1)))throw new Error('Matching weights exceed safe integer range');
    if(maximumWeight===undefined)for(const index of indices)if(!Number.isSafeInteger(values[index]))throw new Error('Pairing weight must be an integer');
    const chosen=solvePairing(topology,remaining,values,reward);if(chosen===null)return null;
    const selected=[...forced];let total=forcedIndices.reduce((sum,i)=>sum+values[i],0);
    for(const i of chosen){selected.push(candidates[i]);total+=values[indices[i]];}
    if([...needM].some(id=>!selected.some(e=>e.member===id))||[...needS].some(id=>!selected.some(e=>e.support===id)))return null;
    return {edges:selected.sort((a,b)=>a.key.localeCompare(b.key)),weight:total};
  };
}

export function maximumPairing(options){return createMaximumPairing(options)(options.weight);}

/** Lawler partition: disjoint subspaces cover every solution except this one. */
export function partitionPairing(state, solution) {
  const fixed = new Set(state.required);
  const free = solution.edges.map((e) => e.key).filter((key) => !fixed.has(key));
  return free.map((key, i) => ({ ...state, required: [...state.required, ...free.slice(0, i)],
    forbidden: [...state.forbidden, key] }));
}
