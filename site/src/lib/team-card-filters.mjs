const identity = value => String(value ?? '').replace(/^(?:band|character|attribute|rarity)-/, '');
const list = value => (Array.isArray(value) ? value : value == null ? [] : [value]).map(identity);
export function teamCardFacets(card) {
  return {attribute:list(card.attributeCode ?? card._cardType), rarity:list(card.rarity ?? card._rarity),
    band:list(card.bandIds ?? card.bandId ?? card._bandID),
    character:list(card.characterIds ?? card.featuredCharacterIds ?? card.characterId ?? card._characterIDs ?? card._characterID)};
}

/** Search and explicit filters intersect; sorting never changes the caller's catalog. */
export function filterTeamCards(cards, {query='',attribute='',band='',character='',rarity='',ownership='',owned=[],sort='default',growth={}} = {}) {
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), own=new Set(owned);
  const result=cards.filter(card=>{
    const facets=teamCardFacets(card);
    if(Object.entries({attribute,band,character,rarity}).some(([key,value])=>value!==''&&value!=null&&!facets[key].includes(identity(value))))return false;
    if(ownership==='owned'&&!own.has(card.id)||ownership==='unowned'&&own.has(card.id))return false;
    const text=[card.displayName,card.shortLabel,card.subtitle,card.description,card.relationLabel,card.id].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word=>text.includes(word));
  });
  const name=card=>card.displayName??card.shortLabel??card.id;
  if(sort==='name')result.sort((a,b)=>name(a).localeCompare(name(b)));
  if(sort==='rarity-desc')result.sort((a,b)=>Number(teamCardFacets(b).rarity[0]??0)-Number(teamCardFacets(a).rarity[0]??0)||name(a).localeCompare(name(b)));
  if(sort==='level-desc')result.sort((a,b)=>(growth[b.id]?.level??-1)-(growth[a.id]?.level??-1)||name(a).localeCompare(name(b)));
  return result;
}

export function teamCardFilterOptions(cards, data={}) {
  const values={attribute:new Set(),band:new Set(),character:new Set(),rarity:new Set()};
  for(const card of cards)for(const [kind,ids] of Object.entries(teamCardFacets(card)))for(const id of ids)if(id)values[kind].add(id);
  return Object.fromEntries(Object.entries(values).map(([kind,ids])=>[kind,[...ids].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).map(value=>{
    const visual=data.filterVisualOptions?.[kind]?.find(option=>identity(option.value)===value||identity(option.id)===value);
    const catalog=kind==='band'?data.bands:kind==='character'?data.characters:null;
    const entity=catalog?.find(row=>identity(row.masterId??row.id)===value);
    const card=kind==='rarity'?cards.find(row=>teamCardFacets(row).rarity.includes(value)):null;
    return {value,label:visual?.label??entity?.displayName??entity?.name??card?.rarityLabel??value,...(visual?.icon?{icon:visual.icon}:{})};
  })]));
}
