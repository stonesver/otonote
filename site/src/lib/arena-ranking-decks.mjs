import {orderedDeckSlots} from './player-ranking-decks.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Public ArenaRanking compilation only; no inference about when this deck was used. */
export function arenaRankingDeck(deck,{visuals={},base='',serverId,t}) {
 if(!deck?.cards?.length)return `<p class="arena-meta">${t('这位玩家的队伍暂未提供。','This player’s team is not available.')}</p>`;
 function card(value,kind){
  const info=(kind==='support'?visuals.supports:visuals.members)?.find(c=>c.id===String(value?.masterId));
  const label=info?.name??(value?`#${value.masterId}`:t('未提供','Not provided'));
  const path=info?`${base}cards/${kind==='support'?'supports':'members'}/${encodeURIComponent(info.href)}/?server=${encodeURIComponent(serverId??'')}`:null;
  const content=`${info?.image?`<img src="${escape(info.image)}" alt="" loading="lazy" decoding="async">`:'<span class="arena-deck-placeholder" aria-hidden="true">—</span>'}<span>${escape(label)}</span>`;
  const growth=value?[value.rank!=null?t(`突破 ${value.rank}`,`Rank ${value.rank}`):'',kind==='member'&&value.awake!=null?t(`觉醒 ${value.awake}`,`Awake ${value.awake}`):''].filter(Boolean).join(' · '):'';
  return `<div class="arena-deck-card"><small>${kind==='support'?t('留影','Support'):t('成员','Member')}</small>${path?`<a href="${escape(path)}">${content}</a>`:`<div>${content}</div>`}${growth?`<small>${escape(growth)}</small>`:''}</div>`;
 }
 return `<div class="arena-deck-heading"><strong>${t('玩家队伍','Player team')}</strong>${deck.totalPower?`<span>${t('综合力','Power')} ${deck.totalPower.toLocaleString()}</span>`:''}</div><p class="arena-meta">${t('这是排行榜附带的玩家队伍，不一定是获得当前积分时使用的队伍。','This is the team provided with the ranking, which may differ from the team used to earn these points.')}</p><div class="arena-deck-slots">${orderedDeckSlots(deck).map(slot=>`<section><h3>${t(`位置 ${slot.slot+1}`,`Slot ${slot.slot+1}`)}<small>${slot.performanceOrder!=null?t(`演出 ${slot.performanceOrder+1}`,`Order ${slot.performanceOrder+1}`):'—'}</small></h3>${card(slot.member,'member')}${card(slot.support,'support')}</section>`).join('')}</div>`;
}
export function arenaRankIcon(rankData,tier){
 const image=rankData?.rankIcons?.find?.(r=>r.tier===tier)?.image;
 return typeof image==='string'&&image.length<=90000&&/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(image)?`<img class="arena-rank-icon" src="${image}" alt="" width="22" height="24" loading="lazy">`:'';
}

export function arenaRankingPreview(deck,{visuals={},t}) {
 if(!deck?.cards?.length)return `<span class="arena-team-missing">${t('队伍暂缺','Team unavailable')}</span>`;
 return `<span class="arena-team-preview" aria-hidden="true">${orderedDeckSlots(deck).map(slot=>{
  const card=visuals.members?.find(c=>c.id===String(slot.member?.masterId));
  return `<span title="${escape(card?.name??(slot.member?'#'+slot.member.masterId:t('未提供','Not provided')))}">${card?.image?`<img src="${escape(card.image)}" alt="" width="32" height="32" loading="lazy" decoding="async">`:'—'}</span>`;
 }).join('')}</span>`;
}
