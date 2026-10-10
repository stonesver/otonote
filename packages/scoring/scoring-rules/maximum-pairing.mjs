/** Exact cardinality matching with character capacities and mandatory vertices.
 * Every edge has an already-rounded integer weight. No skill proxy is used. */
export function maximumPairing({ edges, count = 5, required = [], forbidden = [], requiredMembers = [], requiredSupports = [], weight = edge => edge.weight }) {
  const byKey = required.length ? new Map(edges.map((e) => [e.key, e])) : null;
  const banned = new Set(forbidden), forced = required.map((key) => byKey.get(key));
  if (forced.some((e) => !e || banned.has(e.key)) || forced.length > count) return null;
  for (const field of ["member", "support", "character"]) if (new Set(forced.map((e) => e[field])).size !== forced.length) return null;
  const usedValues = Object.fromEntries(["member", "support", "character"].map(field => [field, new Set(forced.map(e => e[field]))]));
  const used = (field, value) => usedValues[field].has(value);
  const candidates = edges.filter((e) => !banned.has(e.key) && !used("member", e.member)
    && !used("support", e.support) && !used("character", e.character));
  const needM = new Set(requiredMembers.filter((id) => !used("member", id)));
  const needS = new Set(requiredSupports.filter((id) => !used("support", id)));
  const remaining = count - forced.length;
  if (needM.size > remaining || needS.size > remaining) return null;
  const max = edges.reduce((n, e) => Math.max(n, Math.abs(weight(e))), 0);
  const reward = 2 * count * max + 1;
  if (!Number.isSafeInteger(reward * (2 * count + 1))) throw new Error("Matching weights exceed safe integer range");
  // Keep insertion order identical to the object residual graph: ties in
  // shortest paths therefore choose the same pairing. Flat numeric arcs avoid
  // allocating two edge objects and predecessor pairs per candidate per flow.
  const graph = [[], []], to = [], cost = [], capacity = [];
  const source = 0, sink = 1;
  const node = () => { graph.push([]); return graph.length - 1; };
  function add(a, b, weight) {
    const index = to.length;
    to.push(b, a); cost.push(weight, -weight); capacity.push(1, 0);
    graph[a].push(index); graph[b].push(index + 1);
    return index;
  }
  const characterNodes = new Map(), memberNodes = new Map(), supportNodes = new Map(), arcs = [];
  for (const e of candidates) {
    const value = weight(e);
    if (!Number.isSafeInteger(value)) throw new Error("Pairing weight must be an integer");
    let c=characterNodes.get(e.character),m=memberNodes.get(e.member),s=supportNodes.get(e.support);
    const newC=c===undefined,newM=m===undefined,newS=s===undefined;
    if(newC){c=node();characterNodes.set(e.character,c);}
    if(newM){m=node();memberNodes.set(e.member,m);}
    if(newS){s=node();supportNodes.set(e.support,s);}
    if(newC)add(source,c,0);
    if(newM)add(c,m,needM.has(e.member)?-reward:0);
    if(newS)add(s,sink,needS.has(e.support)?-reward:0);
    arcs.push(add(m,s,-value));
  }
  const distance = new Float64Array(graph.length), previous = new Int32Array(graph.length), queued = new Uint8Array(graph.length);
  for (let flow = 0; flow < remaining; flow++) {
    distance.fill(Infinity); queued.fill(0);
    const queue = [source]; queued[source] = 1; distance[source] = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const u = queue[cursor]; queued[u] = 0;
      for (const edge of graph[u]) {
        const v = to[edge], next = distance[u] + cost[edge];
        if (capacity[edge] && distance[v] > next) {
          distance[v] = next; previous[v] = edge;
          if (!queued[v]) { queue.push(v); queued[v] = 1; }
        }
      }
    }
    if (!Number.isFinite(distance[sink])) return null;
    for (let v = sink; v !== source;) {
      const edge = previous[v];
      capacity[edge]--; capacity[edge ^ 1]++; v = to[edge ^ 1];
    }
  }
  const selected = [...forced, ...candidates.filter((_, i) => !capacity[arcs[i]])];
  if ([...needM].some((id) => !selected.some((e) => e.member === id))
    || [...needS].some((id) => !selected.some((e) => e.support === id))) return null;
  return { edges: selected.sort((a, b) => a.key.localeCompare(b.key)), weight: selected.reduce((s, e) => s + weight(e), 0) };
}

/** Lawler partition: disjoint subspaces cover every solution except this one. */
export function partitionPairing(state, solution) {
  const fixed = new Set(state.required);
  const free = solution.edges.map((e) => e.key).filter((key) => !fixed.has(key));
  return free.map((key, i) => ({ ...state, required: [...state.required, ...free.slice(0, i)],
    forbidden: [...state.forbidden, key] }));
}
