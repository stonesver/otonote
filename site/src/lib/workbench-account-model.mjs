import {bandItemGroups} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';

/** Only type 7 affects formation power; other VIP perks must not split these ranges. */
export function tgwBonusRanges(ranks=[]) {
  const ranges=[];
  for(const rank of [...ranks].sort((a,b)=>a.rank-b.rank)) {
    const bonuses=(rank.bonuses??[]).filter(b=>b.type===7);
    const signature=JSON.stringify(bonuses.length?bonuses.map(b=>[b.type,b.rawValue]):[[7,0]]);
    const previous=ranges.at(-1);
    if(previous&&previous.signature===signature&&previous.max+1===rank.rank)previous.max=rank.rank;
    else ranges.push({min:rank.rank,max:rank.rank,signature,bonuses});
  }
  return ranges;
}

/** A calculation assumption; this never writes the actual collection/profile. */
export function maximizeAccount(modifiers,rules,ranks=[],part='all') {
  const next=structuredClone(modifiers??{});
  if(['all','instruments'].includes(part)) {
    next.bandItems={};next.bandItemTotals={};
    for(const group of bandItemGroups(rules))for(const item of group.items)next.bandItems[item.id]=item.maxLevel;
  }
  if(['all','characters'].includes(part)) {
    const max=Math.max(...rules.tables.CharacterRank.map(r=>r._rank));next.characterRanks={...next.characterRanks};
    for(const character of rules.tables.Character)next.characterRanks[character._id]=max;
  }
  if(['all','tgw'].includes(part)&&ranks.length)next.tgwCardRank=Math.max(...ranks.map(r=>r.rank));
  return next;
}
