/** Exact cardinality matching with character capacities and mandatory vertices.
 * The topology is reusable when only integer weights change. Each solve resets
 * all residual capacities; no approximate matching or warm-start state leaks. */
export function createMaximumPairing({edges,count=5,required=[],forbidden=[],requiredMembers=[],requiredSupports=[]}) {
  const byKey=required.length?new Map(edges.map(e=>[e.key,e])):null;
  const banned=new Set(forbidden),forced=required.map(key=>byKey.get(key));
  const impossible=()=>null;
  if(forced.some(e=>!e||banned.has(e.key))||forced.length>count)return impossible;
  for(const field of ['member','support','character'])if(new Set(forced.map(e=>e[field])).size!==forced.length)return impossible;
  const usedValues=Object.fromEntries(['member','support','character'].map(field=>[field,new Set(forced.map(e=>e[field]))]));
  const used=(field,value)=>usedValues[field].has(value);
  const candidates=[],indices=[];
  edges.forEach((e,i)=>{if(!banned.has(e.key)&&!used('member',e.member)&&!used('support',e.support)&&!used('character',e.character)){candidates.push(e);indices.push(i);}});
  const needM=new Set(requiredMembers.filter(id=>!used('member',id))),needS=new Set(requiredSupports.filter(id=>!used('support',id)));
  const remaining=count-forced.length;
  if(needM.size>remaining||needS.size>remaining)return impossible;
  const graph=[[],[]],to=[],costs=[],initial=[],rewardArcs=[],arcs=[],source=0,sink=1;
  const node=()=>{graph.push([]);return graph.length-1;};
  const add=(a,b)=>{const i=to.length;to.push(b,a);costs.push(0,0);initial.push(1,0);graph[a].push(i);graph[b].push(i+1);return i;};
  const characterNodes=new Map(),memberNodes=new Map(),supportNodes=new Map();
  // Preserve the original insertion and relaxation order, including ties.
  for(const e of candidates){
    let c=characterNodes.get(e.character),m=memberNodes.get(e.member),s=supportNodes.get(e.support);
    const newC=c===undefined,newM=m===undefined,newS=s===undefined;
    if(newC){c=node();characterNodes.set(e.character,c);}
    if(newM){m=node();memberNodes.set(e.member,m);}
    if(newS){s=node();supportNodes.set(e.support,s);}
    if(newC)add(source,c);
    if(newM){const arc=add(c,m);if(needM.has(e.member))rewardArcs.push(arc);}
    if(newS){const arc=add(s,sink);if(needS.has(e.support))rewardArcs.push(arc);}
    arcs.push(add(m,s));
  }
  const cost=Float64Array.from(costs),initialCapacity=Uint8Array.from(initial),capacity=new Uint8Array(to.length);
  const distance=new Float64Array(graph.length),previous=new Int32Array(graph.length),queued=new Uint8Array(graph.length),weights=new Float64Array(edges.length);
  // Reuse queue storage without retaining the previous solve's logical length.
  // Residual capacities, distances and queue membership are still reset.
  const forcedIndices=forced.map(e=>edges.indexOf(e)),queue=[];
  // Linear probes can supply integer weights in the original edge order.
  return function solve(weight=e=>e.weight){
    let max=0,values=weights;
    if(typeof weight==='function'){
      for(let i=0;i<edges.length;i++){values[i]=weight(edges[i]);max=Math.max(max,Math.abs(values[i]));}
    }else{
      if(weight?.length!==edges.length)throw new Error('Matching weight vector has the wrong size');
      values=weight;for(let i=0;i<edges.length;i++)max=Math.max(max,Math.abs(values[i]));
    }
    const reward=2*count*max+1;
    if(!Number.isSafeInteger(reward*(2*count+1)))throw new Error('Matching weights exceed safe integer range');
    for(const arc of rewardArcs){cost[arc]=-reward;cost[arc^1]=reward;}
    for(let i=0;i<candidates.length;i++){
      const value=values[indices[i]];if(!Number.isSafeInteger(value))throw new Error('Pairing weight must be an integer');
      cost[arcs[i]]=-value;cost[arcs[i]^1]=value;
    }
    capacity.set(initialCapacity);
    for(let flow=0;flow<remaining;flow++){
      distance.fill(Infinity);queued.fill(0);
      let queueLength=1;queue[0]=source;queued[source]=1;distance[source]=0;
      for(let cursor=0;cursor<queueLength;cursor++){
        const u=queue[cursor];queued[u]=0;const fromDistance=distance[u];
        for(const edge of graph[u]){
          if(!capacity[edge])continue;
          const v=to[edge],next=fromDistance+cost[edge];
          if(distance[v]>next){distance[v]=next;previous[v]=edge;if(!queued[v]){queue[queueLength++]=v;queued[v]=1;}}
        }
      }
      if(!Number.isFinite(distance[sink]))return null;
      for(let v=sink;v!==source;){const edge=previous[v];capacity[edge]--;capacity[edge^1]++;v=to[edge^1];}
    }
    const selected=[...forced];let total=forcedIndices.reduce((sum,i)=>sum+values[i],0);
    for(let i=0;i<candidates.length;i++)if(!capacity[arcs[i]]){selected.push(candidates[i]);total+=values[indices[i]];}
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
