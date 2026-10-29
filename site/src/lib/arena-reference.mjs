/** Group genuinely identical rank tables; UI selection never changes their contents. */
export function arenaRankGroups(data) {
 if(!data?.capabilities?.ranks)return [];
 const groups=new Map();
 for(const league of data.leagues??[]) {
  const rows=data.ranks.filter(row=>row.bandId===league.bandId).sort((a,b)=>a.tier-b.tier||a.division-b.division);
  if(!rows.length)continue;
  const key=JSON.stringify(rows.map(({tier,division,threshold,name,opensAt,openingSourceText})=>({tier,division,threshold,name,opensAt:opensAt??null,openingSourceText:openingSourceText??null})));
  if(!groups.has(key))groups.set(key,{rows,bands:[]});
  groups.get(key).bands.push(league);
 }
 return [...groups.values()];
}
