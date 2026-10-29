/** Resolve a published official snapshot; URL values never supply card results. */
export function arenaDeckTrend(data, context, musicId, {now=Date.now()}={}) {
 if(!context?.serverId)return {status:'select-server'};
 if(!context.season)return {status:'select-season'};
 if(!context.league)return {status:'select-band'};
 if(data?.limitations?.includes('deckTrends_invalid'))return {status:'invalid'};
 if(data?.capabilities?.deckTrends!==undefined&&typeof data.capabilities.deckTrends!=='boolean')return {status:'invalid'};
 if(!data?.capabilities?.deckTrends)return {status:'not-collected'};
 if(!Array.isArray(data.deckTrends))return {status:'invalid'};
 const scoped=data.deckTrends.filter(r=>r?.serverId===context.serverId&&r.seasonId===context.season.id&&r.bandId===context.league.bandId);
 if(!scoped.length)return {status:'not-collected'};
 if(!musicId)return {status:'select-song'};
 const matches=scoped.filter(r=>r.musicId===musicId);
 if(matches.length!==1)return {status:matches.length?'invalid':'not-collected'};
 const snapshot=matches[0];
 const absolute=typeof snapshot.observedAt==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot.observedAt)&&Number.isFinite(Date.parse(snapshot.observedAt));
 if(snapshot.source!=='ArenaService.DeckTrend'||!absolute||!/^[a-f0-9]{64}$/.test(snapshot.sourceRevision??'')
  ||['leaders','members','supports'].some(k=>!Array.isArray(snapshot[k])||snapshot[k].some(id=>typeof id!=='string'||!/^\d+$/.test(id)||Number(id)<=0)))return {status:'invalid'};
 const observed=Date.parse(snapshot.observedAt),condition=context.condition;
 const period=condition&&Number.isFinite(Date.parse(condition.validFrom))?
  (observed<Date.parse(condition.validFrom)?'before-period':observed>=Date.parse(condition.validUntil)?'after-period':'within-period'):null;
 return {status:['leaders','members','supports'].some(k=>snapshot[k].length)?'available':'empty',snapshot,period,future:observed>now};
}
