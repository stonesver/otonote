/** Entity bindings survive translations, export formats and content revisions.
 * Byte/content hashes describe a version; they are not an entity identifier.
 * Missing/conflicting evidence is left to the caller's conservative fallback.
 */
export const stableContent = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const positive = n => Number.isSafeInteger(n) && n > 0;
const logicalPath = s => typeof s === 'string' && s.includes('/') && !/[\\?#%]/.test(s)
  && s.split('/').every(part => part && part !== '.' && part !== '..');
const ids = (values, pattern) => Array.isArray(values) && values.every(v => pattern.test(String(v)))
  ? [...new Set(values)].sort() : null;
const key = (kind, fields) => stableContent([kind, 'entity-binding-v1', ...fields]);

export function entityIdentity(kind, row, asset) {
  if (kind === 'characters') {
    if (!positive(row.masterId) || row.id !== `character-${row.masterId}` || !/^band-[1-9]\d*$/.test(row.bandId)) return null;
    if (asset?.containerPath !== `Assets/AddressableResources/Character/Image/${row.masterId}/character_thumbnail.png`) return null;
    if (!positive(row.birthday?.month) || row.birthday.month > 12 || !positive(row.birthday?.day) || row.birthday.day > 31) return null;
    return key(kind,[asset.containerPath,row.bandId,row.birthday.month,row.birthday.day]);
  }
  if (kind === 'bands') {
    const cast=ids(row.characterIds,/^character-[1-9]\d*$/);
    if (!positive(row.masterId) || row.id !== `band-${row.masterId}` || !cast?.length
      || asset?.containerPath !== `Assets/AddressableResources/Band/${row.masterId}/band_logo.png`) return null;
    return key(kind,[asset.containerPath,cast]);
  }
  if (kind === 'immersive') {
    if (!positive(row.id) || !positive(row.bandId) || !logicalPath(row.background) || !row.background.startsWith('Spot/')) return null;
    return key(kind,[row.id,row.bandId,row.background]);
  }
  if (kind === 'live2d') {
    // Resource-only still/mini variants may have no costume ID or character ID.
    if (!logicalPath(row.modelPath) || !row.category || !row.usage || !row.variant) return null;
    return key(kind,[row.characterId ?? null,row.modelPath,row.category,row.usage,row.variant]);
  }
  if (kind === 'bgm') {
    // cueName is the named audio resource; the suffix distinguishes cues within it.
    if (typeof row.cueName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]+$/.test(row.cueName)) return null;
    const prefix=`bgm-${row.cueName}-`, suffix=String(row.id).slice(prefix.length);
    if (!String(row.id).startsWith(prefix) || !/^\d+$/.test(suffix)) return null;
    return key(kind,[row.cueName,suffix]);
  }
  if (kind === 'bandItems') {
    if (!positive(row.masterId) || row.id !== `band-item-${row.masterId}` || !positive(row.resourceGroupId) || !/^band-[1-9]\d*$/.test(row.bandId)) return null;
    if (row.containerPath !== `Assets/AddressableResources/Band/${row.bandId.slice(5)}/BandItem/${row.masterId}/band_item.png`) return null;
    return key(kind,[row.containerPath,row.bandId,row.resourceGroupId]);
  }
  if (kind === 'skills') {
    const targets=ids(row.targetIds,/^skill-target-[1-9]\d*$/);
    const types=Array.isArray(row.effects) && row.effects.length && row.effects.every(effect=>Number.isSafeInteger(effect.type))
      ? [...new Set(row.effects.map(effect=>effect.type))].sort((a,b)=>a-b) : null;
    if (!positive(row.masterId) || !['leader','live','support','gekisou','gekisou_support'].includes(row.kind) || row.id !== `${row.kind.replace('_','-')}-skill-${row.masterId}` || !targets || !types) return null;
    return key(kind,[row.kind,row.masterId,types,targets]);
  }
  if (kind === 'gallery') {
    const cast=ids(row.characterIds,/^[1-9]\d*$/),bands=ids(row.bandIds,/^[1-9]\d*$/);
    if (!['comics','stamps','stickers','backgrounds'].includes(row.mediaType) || !logicalPath(row.sourceResource) || !cast || !bands) return null;
    return key(kind,[row.mediaType,row.sourceResource,cast,bands]);
  }
  return null;
}

/** Preserve resource and gameplay differences without splitting directory rows. */
export function entityComparison(kind, row, asset) {
  if (kind === 'characters' || kind === 'bands') return stableContent([asset?.sha256,row.mainColor,row.subColor,row.role]);
  if (kind === 'immersive') return stableContent([row.contentIdentity,row.duration,!!row.assetRoot]);
  if (kind === 'live2d') return stableContent([row.sourceSha256,row.motions,row.expressions,row.physics]);
  if (kind === 'bgm') return stableContent([row.audio?.sha256,row.status]);
  if (kind === 'gallery') return stableContent([row.sourceSha256,row.status]);
  return row.contentComparison ?? row.contentIdentity ?? '';
}

/** Older published gallery projections omitted their verified Master binding.
 * Recover it only when the same pinned manifest agrees with the row's bytes.
 */
export function bindGalleryRows(rows, manifest) {
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.assets)) return rows;
  const bindings=new Map();
  for (const asset of manifest.assets) {
    const id=stableContent([asset.kind,asset.id]);
    bindings.set(id,bindings.has(id) ? null : asset);
  }
  return rows.map(row=>{
    const binding=bindings.get(stableContent([row.mediaType,row.id]));
    if (!binding || !row.sourceSha256 || binding.sha256 !== row.sourceSha256 || binding.status !== 'available'
      || !logicalPath(binding.asset) || !row.image?.endsWith('/'+binding.image)) return row;
    return {...row,sourceResource:binding.asset};
  });
}

/** Keep available media reachable when the preferred edition has no export. */
export function preferAvailable(primary, secondary) {
  const available = row => row.state !== undefined ? row.state === 'available'
    : row.status !== undefined ? row.status === 'available'
    : 'assetRoot' in row ? !!row.assetRoot : true;
  return !available(primary) && available(secondary);
}
