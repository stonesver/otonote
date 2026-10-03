export const EDITIONS = ['global', 'jp'];
export const editionLabel = (edition, en = false) => edition === 'jp' ? (en ? 'Japan' : '日服') : (en ? 'Global' : '国际版');
export function presenceLabel(value, en = false) {
  if (value?.status !== 'known' || value.editions?.length !== 1 || !EDITIONS.includes(value.editions[0])) return '';
  return en ? `${editionLabel(value.editions[0], true)} only` : `${value.editions[0] === 'jp' ? '日服' : '国际服'}独有`;
}
export function sourceHref(edition, locale, path) {
  return `/${edition}/${locale}${path.startsWith('/') ? path : '/' + path}`;
}
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export {stable as stableContent};

/** Only unique, evidence-backed keys are joined; ambiguous matches remain separate. */
export function mergeEditionRows(primary, secondary, {region, key, path, locale = 'zh-CN', difference = (_row) => '', namespace = true, canMerge = (_left, _right) => true}) {
  const other = region === 'jp' ? 'global' : 'jp';
  const counts = rows => { const out = new Map(); for (const row of rows ?? []) { const k = key(row); if (k) out.set(k, (out.get(k) ?? 0) + 1); } return out; };
  const leftCounts = counts(primary), rightCounts = counts(secondary);
  const right = new Map((secondary ?? []).map(row => [key(row), row]));
  const consumed = new Set();
  const wrap = (row, edition, pair) => ({...row,
    sourceEdition: edition, sourceId: row.id,
    sourceHref: path ? sourceHref(edition, locale, path(row)) : undefined,
    editionPresence: {status: secondary == null || !key(row) ? 'unknown' : 'known', editions: pair ? EDITIONS : [edition],
      different: pair ? difference(row) !== difference(pair) : false,
      counterparts: pair && path ? [{edition:other, href:sourceHref(other, locale, path(pair))}] : []}
  });
  const rows = primary.map(row => {
    const k = key(row), match = k && leftCounts.get(k) === 1 && rightCounts.get(k) === 1 && canMerge(row,right.get(k)) ? right.get(k) : null;
    if (match) consumed.add(match);
    return wrap(row, region, match);
  });
  for (const row of secondary ?? []) if (!consumed.has(row)) {
    rows.push({...wrap(row, other), id:namespace ? `${other}--${row.id}` : row.id});
  }
  return rows;
}

function cardResourceIdentity(kind, row, asset) {
  if (!['memberCards', 'supportCards'].includes(kind) || !Number.isSafeInteger(row.assetId) || row.assetId <= 0) return null;
  const member = kind === 'memberCards';
  const path = `Assets/AddressableResources/${member ? 'MemberCard' : 'SupportCard'}/${row.assetId}/${member ? 'member_full' : 'snap_full'}.png`;
  // Match the Master binding against the actual primary resource, not just an ID
  // or title. PNG encoding and bundle revisions are not card identities.
  if (row.sourceContainerPath !== path || asset?.containerPath !== path) return null;
  const characters = member ? [row.characterId] : row.featuredCharacterIds;
  if (!Array.isArray(characters) || !characters.length || !characters.every(id => /^character-[1-9]\d*$/.test(id))) return null;
  if (![row.rarity, row.attributeCode].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return stable([kind, 'resource-binding-v1', path, [...new Set(characters)].sort(), row.rarity, row.attributeCode]);
}

export function catalogIdentity(kind, row, catalog) {
  if(kind==='musicTracks' && row.contentIdentity)return stable([kind,row.contentIdentity]);
  const assetId = row.primaryAssetId ?? row.profileAssetId ?? row.jacketAssetId ?? row.logoAssetId;
  const asset = catalog.assets?.find(a => a.id === assetId);
  const cardIdentity = cardResourceIdentity(kind, row, asset);
  if (cardIdentity) return cardIdentity;
  if (!asset?.sha256) return null;
  const fields = kind === 'memberCards' ? [row.rarity, row.attributeCode, row.assetId]
    : kind === 'supportCards' ? [row.rarity, row.attributeCode, row.assetId]
    : kind === 'musicTracks' ? [row.musicSoundId, row.composer, row.arranger]
    : kind === 'characters' ? [row.birthday?.month, row.birthday?.day]
    : kind === 'bands' ? [row.mainColor, row.subColor] : [];
  return stable([kind, asset.sha256, fields]);
}

export function mergeCatalogs(primary, secondary, locale) {
  const region = primary.release.region, other = region === 'jp' ? 'global' : 'jp';
  const paths = {bands:r=>`/characters/?band=${r.id}`, characters:r=>`/characters/${r.id}/`, memberCards:r=>`/cards/members/${r.id}/`,
    supportCards:r=>`/cards/supports/${r.id}/`, musicTracks:r=>`/music/${r.id}/`};
  const merged = {...primary}, foreignAssets = new Map((secondary?.assets ?? []).map(a=>[a.id, `${other}--${a.id}`]));
  const remaps = {};
  for (const kind of Object.keys(paths)) {
    // Bind identity to each source before comparing; asset IDs can collide.
    const mark = (rows, catalog) => (rows ?? []).map(row=>({...row, libraryIdentity:catalogIdentity(kind,row,catalog)}));
    merged[kind] = mergeEditionRows(mark(primary[kind], primary), secondary ? mark(secondary[kind], secondary) : null, {
      region, locale, key:r=>r.libraryIdentity, path:paths[kind],
      difference:r=>stable([r.contentComparison,r.performancePowerMax,r.technicPowerMax,r.visualPowerMax,r.liveSkillId,r.leaderSkillId,r.supportSkillIds,r.maxLevel])
    });
    remaps[kind] = new Map();
    for (const row of merged[kind]) {
      if (row.sourceEdition === other) remaps[kind].set(row.sourceId,row.id);
      else if (row.editionPresence.editions.length === 2) {
        const counterpart = (secondary[kind] ?? []).find(r=>catalogIdentity(kind,r,secondary) === row.libraryIdentity);
        if (counterpart) remaps[kind].set(counterpart.id,row.id);
      }
    }
  }
  for (const kind of Object.keys(paths)) for (const row of merged[kind]) if (row.sourceEdition === other) {
    for (const field of ['primaryAssetId','thumbnailAssetId','profileAssetId','jacketAssetId','logoAssetId','whiteLogoAssetId']) if (row[field]) row[field] = foreignAssets.get(row[field]) ?? row[field];
    for (const field of ['variantAssetIds','portraitAssetIds']) if (row[field]) row[field] = row[field].map(id=>foreignAssets.get(id) ?? id);
    for (const [field, type] of [['characterId','characters'],['bandId','bands']]) if (row[field]) row[field] = remaps[type].get(row[field]) ?? row[field];
    for (const [field, type] of [['bandIds','bands'],['characterIds','characters'],['featuredCharacterIds','characters'],['vocalCharacterIds','characters']]) if (row[field]) row[field] = row[field].map(id=>remaps[type].get(id) ?? id);
  }
  merged.assets = [...primary.assets, ...(secondary?.assets ?? []).map(asset=>({...asset,id:foreignAssets.get(asset.id)}))];
  merged.musicCharts = [...primary.musicCharts, ...(secondary?.musicCharts ?? []).filter(chart=>String(remaps.musicTracks.get(chart.trackId)).startsWith(other+'--')).map(chart=>({...chart,id:`${other}--${chart.id}`,trackId:remaps.musicTracks.get(chart.trackId)}))];
  merged.libraryReleases = {[region]:primary.release.id, ...(secondary ? {[other]:secondary.release.id} : {})};
  return merged;
}
