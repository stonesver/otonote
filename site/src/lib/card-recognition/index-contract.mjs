/** This algorithm contract must change when ORB feature layout changes. */
export const RECOGNITION_ALGORITHM = 'ORB-1000-member450-support300-edge10-fast7-v2';
const MAX_BYTES = 128 * 1024 * 1024;
export function validateRecognitionIndex(index, {region, sourceReleaseId}) {
  if (index?.schemaVersion !== 1 || index.region !== region || index.sourceReleaseId !== sourceReleaseId)
    throw Error('识别索引与当前卡库版本不一致，请刷新页面后重试');
  if (index.algorithm !== RECOGNITION_ALGORITHM) throw Error('此识别索引需要更新工具，请刷新页面后重试');
  if (index.featuresPath !== 'recognition/features.bin.gz' || !/^[a-f0-9]{64}$/.test(index.featuresSha256)
    || !['compressedBytes','decodedBytes'].every(k => Number.isSafeInteger(index[k]) && index[k] > 0 && index[k] <= MAX_BYTES)
    || !Array.isArray(index.cards) || !index.cards.length || index.cards.length > 10000) throw Error('识别索引格式无效');
  const seen = new Set();
  for (const card of index.cards) {
    const key = JSON.stringify([card.id, card.assetId]);
    if (!['member','support'].includes(card.kind) || !card.id?.startsWith(card.kind+'-card-')
      || typeof card.assetId !== 'string' || seen.has(key) || !Number.isInteger(card.count) || card.count < 4 || card.count > 1000
      || ![['descriptorOffset',32],['pointOffset',8]].every(([field,width]) => Number.isSafeInteger(card[field]) && card[field] >= 0
        && card[field] % 4 === 0 && card[field] + card.count * width <= index.decodedBytes)) throw Error('识别索引卡面范围无效');
    seen.add(key);
  }
  return index;
}
export function recognitionCoverage(index, catalog) {
  validateRecognitionIndex(index, {region:catalog.release.region, sourceReleaseId:catalog.release.id});
  const cards = [...catalog.memberCards, ...catalog.supportCards], known = new Map(cards.map(c => [c.id,c]));
  const indexed = new Set();
  for (const entry of index.cards) {
    const card = known.get(entry.id);
    if (!card || !card.variantAssetIds.includes(entry.assetId)) throw Error('识别索引包含其他版本的卡面');
    indexed.add(entry.id);
  }
  const missingAssets = index.missing?.length ?? 0;
  return {status:missingAssets || indexed.size < cards.length ? 'partial':'available', cards:indexed.size, totalCards:cards.length, missingAssets};
}
