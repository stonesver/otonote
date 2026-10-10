// Relax support uniqueness while keeping character capacity and the leader.
// This bounds a profile's INTEGER proxy, not song score or reward. Ties may
// safely be skipped only when visiting leaders in the original order.
export function pairingProfileBound(edges, leader, count = 5, weight = edge => edge.weight) {
  const maxima = new Map();
  let leaderBest = -Infinity, character;
  for (const e of edges) {
    const value = weight(e);
    maxima.set(e.character, Math.max(maxima.get(e.character) ?? -Infinity, value));
    if (e.member === leader) { leaderBest = Math.max(leaderBest, value); character = e.character; }
  }
  maxima.delete(character);
  const others = [...maxima.values()].sort((a,b) => b-a);
  return others.length < count-1 ? -Infinity : leaderBest + others.slice(0,count-1).reduce((a,b)=>a+b,0);
}
