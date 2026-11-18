// Embedded kernel generated from maximum-pairing-kernel.ts; see tools/build_pairing_kernel.mjs.
// Each synchronous call resets its flow state. Changing topology also clears
// costs and copies every immutable array, including after memory growth.
const module=new WebAssembly.Module(Uint8Array.from(atob('AGFzbQEAAAABKwJgC39/f39/f39/f39/AX9gF39/f39/fH9/f39/f39/f39/f39/f39/AX8CDwEDZW52Bm1lbW9yeQIAAQMDAgABBxwDB2F1Z21lbnQAAAVzb2x2ZQABBm1lbW9yeQIACu8GAuwDAgl/AnwDQCABIBBKBEBBACEMA0AgACAMSgRAIAcgDEEDdGpEAAAAAAAA8H85AwAgCSAMakEAOgAAIAxBAWohDAwBCwtBACEMQQEhC0EBIRMgCkEANgIAIAlBAToAACAHRAAAAAAAAAAAOQMAA0AgE0EASgRAIAogDEECdGooAgAhDSAMQQFqIgwgAEYEQEEAIQwLIBNBAWshEyAJIA1qQQA6AAAgByANQQN0aisDACEVIAIgDUEBakECdGooAgAhDyACIA1BAnRqKAIAIRIDQCAPIBJKBEAgAyASQQJ0aigCACIRIAZqLQAABEAgFSAFIBFBA3RqKwMAoCIUIAcgBCARQQJ0aigCACINQQN0aiIOKwMAYwRAIA4gFDkDACAIIA1BAnRqIBE2AgAgCSANai0AAEUEQCAKIAtBAnRqIA02AgAgE0EBaiETIAkgDWpBAToAACALQQFqIgsgAEYEf0EABSALCyELCwsLIBJBAWohEgwBCwsMAQsLIAcrAwhEAAAAAAAA8H9hBEBBAA8LQQEhDANAIAwEQCAIIAxBAnRqKAIAIgwgBmoiCyALLQAAQQFrOgAAIAxBAXMiDCAGaiILIAstAABBAWo6AAAgBCAMQQJ0aigCACEMDAELCyAQQQFqIRAMAQsLQQEL/gIBBX8gCyAKIAL8CgAAA0AgBCAaSgRAIAkgEyAaQQJ0aigCACICQQN0aiAFmjkDACAJIAJBAXNBA3RqIAU5AwAgGkEBaiEaDAELCyAVBEADQCADIBtKBEAgCSASIBtBAnRqKAIAQQN0akQAAAAAAADwfzkDACAbQQFqIRsMAQsLCwNAIAMgGUoEQCAZQQJ0IgIgEmooAgAhBCAQIAIgEWooAgBBA3RqKwMAIQUgFQR/IAkgBEEDdGorAwAgBZpkBUEBCwRAIAkgBEEDdGogBZo5AwAgCSAEQQFzQQN0aiAFOQMAIBYgBEECdGogGTYCAAsgGUEBaiEZDAELCyAAIAEgBiAHIAggCSALIAwgDSAOIA8QAEUEQEF/DwsDQCADIBhKBEAgCyASIBhBAnRqKAIAai0AAAR/QQAFIBUEfyAWIBIgGEECdGooAgBBAnRqKAIAIBhGBUEBCwsEQCAUIBdBAnRqIBg2AgAgF0EBaiEXCyAYQQFqIRgMAQsLIBcL'),c=>c.charCodeAt(0)));

const memory=new WebAssembly.Memory({initial:1});
const {solve}=new WebAssembly.Instance(module,{env:{memory}}).exports;
let current,views,p;
export function solvePairing(topology,remaining,weights,reward){
 const nodes=topology.offsets.length-1,arcs=topology.destinations.length,candidates=topology.indices.length,rewards=topology.rewardArcs.length;
 if(current!==topology){
  let offset=1024;
  const reserve=(length,bytes)=>{offset=Math.ceil(offset/bytes)*bytes;const address=offset;offset+=length*bytes;return address;};
  p={offsets:reserve(nodes+1,4),adjacency:reserve(arcs,4),destinations:reserve(arcs,4),cost:reserve(arcs,8),initial:reserve(arcs,1),capacity:reserve(arcs,1),distance:reserve(nodes,8),previous:reserve(nodes,4),queued:reserve(nodes,1),queue:reserve(nodes,4),weights:reserve(weights.length,8),indices:reserve(candidates,4),candidateArcs:reserve(candidates,4),rewardArcs:reserve(rewards,4),selected:reserve(topology.count,4),best:reserve(arcs,4)};
  if(memory.buffer.byteLength<offset)memory.grow(Math.ceil((offset-memory.buffer.byteLength)/65536));
  views={offsets:new Int32Array(memory.buffer,p.offsets,nodes+1),adjacency:new Int32Array(memory.buffer,p.adjacency,arcs),destinations:new Int32Array(memory.buffer,p.destinations,arcs),cost:new Float64Array(memory.buffer,p.cost,arcs),initial:new Uint8Array(memory.buffer,p.initial,arcs),weights:new Float64Array(memory.buffer,p.weights,weights.length),indices:new Int32Array(memory.buffer,p.indices,candidates),candidateArcs:new Int32Array(memory.buffer,p.candidateArcs,candidates),rewardArcs:new Int32Array(memory.buffer,p.rewardArcs,rewards),selected:new Int32Array(memory.buffer,p.selected,topology.count)};
  for(const key of ['offsets','adjacency','destinations','initial','indices','candidateArcs','rewardArcs'])views[key].set(topology[key]);
  views.cost.fill(0);current=topology;
 }
 views.weights.set(weights);
 const n=solve(nodes,remaining,arcs,candidates,rewards,reward,p.offsets,p.adjacency,p.destinations,p.cost,p.initial,p.capacity,p.distance,p.previous,p.queued,p.queue,p.weights,p.indices,p.candidateArcs,p.rewardArcs,p.selected,topology.compact?1:0,p.best);
 return n<0?null:views.selected.subarray(0,n);
}
