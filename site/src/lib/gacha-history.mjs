/** Query-local records and descriptive statistics. No storage or network access. */
export const RARITIES = {2:'R', 3:'SR', 4:'SSR', 10:'EX', 20:'BD'};
export const HIGH_RARITIES = new Set([4, 10, 20]);
export const LUCK_RULE = '仅按本次 SSR / EX / BD 占比评语：≥10% 欧皇、≥5% 小欧、≥2% 平稳、其余非酋；不足 20 抽不定级。含保证抽取，不是官方概率、玩家排名或下次预测。';
const integer = (n, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function historyDay(seconds) {
  if (!seconds) return '';
  // TW/HK/MO game history is displayed in UTC+8 regardless of the browser zone.
  return new Date(seconds * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function historyTime(seconds) {
  return seconds ? new Date(seconds * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') : '时间未记录';
}

export function createHistoryModel(snapshot, catalog = {}) {
  if (!object(snapshot) || snapshot.format !== 'otonote-gacha-history' || snapshot.schemaVersion !== 1
      || snapshot.source?.serverId !== 'global-hmt' || snapshot.coverage?.scope !== 'server_returned'
      || !['execution','legacy','empty'].includes(snapshot.coverage?.historyKind)
      || !Array.isArray(snapshot.batches) || snapshot.batches.length > 10000
      || typeof snapshot.queriedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.queriedAt))) {
    throw Error('抽卡记录格式不受支持，请重新查询。');
  }
  const pools = new Map((catalog.pools ?? []).map(p => [p.id, p]));
  const prizes = new Map((catalog.prizes ?? []).map(p => [p.id, p]));
  const cards = new Map((catalog.cards ?? []).map(c => [`${c.resourceType}:${c.masterId}`, c]));
  const records = [];
  snapshot.batches.forEach((batch, batchIndex) => {
    if (!object(batch) || !(batch.poolId === null || integer(batch.poolId, 1))
        || !(batch.productId === null || integer(batch.productId, 1))
        || !(batch.executedAt === null || integer(batch.executedAt, 1, 253402271999))
        || !Array.isArray(batch.prizes) || !batch.prizes.length || batch.prizes.length > 10000) {
      throw Error('抽卡批次格式无效，未载入记录。');
    }
    const pool = pools.get(batch.poolId);
    const product = pool?.products?.find(p => p.id === batch.productId);
    for (const [index, item] of batch.prizes.entries()) {
      if (!object(item) || !integer(item.prizeId, 1) || typeof item.converted !== 'boolean' || records.length >= 10000) {
        throw Error('奖品记录格式无效或数量过多。');
      }
      const prize = prizes.get(item.prizeId);
      const card = prize && cards.get(`${prize.resourceType}:${prize.resourceId}`);
      const isCard = prize && [2, 3].includes(prize.resourceType);
      const known = Boolean(prize && (!isCard || (card && RARITIES[card.rarity])));
      // A prize group must actually belong to this pool before claiming UP.
      const pickup = known && pool?.prizeGroupIds?.includes(prize?.groupId) ? prize.isPickup === true : null;
      records.push({
        key:`${batchIndex}:${index}`, batchIndex, poolId:batch.poolId,
        poolName:pool?.name ?? (batch.poolId ? `未收录卡池 #${batch.poolId}` : '未归属卡池'),
        productId:batch.productId, executedAt:batch.executedAt, day:historyDay(batch.executedAt),
        prizeId:item.prizeId, converted:item.converted, known, pickup,
        kind:prize?.resourceType === 2 ? 'member' : prize?.resourceType === 3 ? 'support' : prize ? 'item' : 'unknown',
        rarity:card?.rarity ?? null,
        name:card?.name ?? (prize ? `${isCard ? '未收录卡牌' : '道具'} #${prize.resourceId}` : `未识别奖品 #${item.prizeId}`),
        image:card?.image ?? null, href:card?.href ?? null,
        guaranteed:product ? product.ensuredCount > 0 : null,
      });
    }
  });
  return {records, queriedAt:new Date(snapshot.queriedAt).toISOString(),
    historyKind:snapshot.coverage.historyKind, legacyOmittedCount:snapshot.coverage.legacyOmittedCount ?? 0};
}

export function selectHistory(model, {pool = 'all', from = '', to = ''} = {}) {
  for (const date of [from, to]) if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('日期格式无效。');
  if (from && to && from > to) throw Error('开始日期不能晚于结束日期。');
  return model.records.filter(r => (pool === 'all' || String(r.poolId ?? 'unknown') === pool)
    && (!from || (r.day && r.day >= from)) && (!to || (r.day && r.day <= to)));
}

export function summarizeHistory(records) {
  const total = records.length;
  const unknown = records.filter(r => !r.known).length;
  const high = records.filter(r => r.known && HIGH_RARITIES.has(r.rarity));
  const ssr = records.filter(r => r.known && r.rarity === 4).length;
  const pickup = records.filter(r => r.pickup === true).length;
  const pickupUnknown = records.filter(r => r.pickup === null).length;
  const rate = total ? high.length / total * 100 : null;
  const counts = new Map(), pools = new Map(), days = new Map();
  for (const r of records) {
    const rarity = !r.known ? '未识别' : r.kind === 'item' ? '道具' : RARITIES[r.rarity];
    counts.set(rarity, (counts.get(rarity) ?? 0) + 1);
    const key = r.poolId ?? 'unknown';
    const pool = pools.get(key) ?? {id:key, name:r.poolName, total:0, high:0};
    pool.total++; pool.high += Number(r.known && HIGH_RARITIES.has(r.rarity)); pools.set(key, pool);
    if (r.day) {
      const day = days.get(r.day) ?? {day:r.day, total:0, high:0};
      day.total++; day.high += Number(r.known && HIGH_RARITIES.has(r.rarity)); days.set(r.day, day);
    }
  }
  const distribution = ['SSR','EX','BD','SR','R','道具','未识别'].filter(label => counts.has(label)).map(label => ({label, count:counts.get(label)}));
  const dates = [...days.keys()].sort();
  let title = '等待你的抽卡故事', caption = '登录后生成本次成绩单。';
  if (total && unknown) { title = '欧气暂不定级'; caption = `有 ${unknown} 条奖品未识别，先保留真实记录。`; }
  else if (total < 20 && total) { title = high.length ? '欧气初显' : '欧气待观测'; caption = '不足 20 抽，先看记录，不急着定级。'; }
  else if (total >= 20) {
    title = rate >= 10 ? '欧皇附体' : rate >= 5 ? '小欧怡情' : rate >= 2 ? '平稳发挥' : '非酋渡劫';
    caption = rate >= 10 ? '这份成绩单，闪闪发光。' : rate >= 5 ? '有一点幸运，也有一点惊喜。' : rate >= 2 ? '把每一次相遇，留在这份记录里。' : '这次手气有点凉，记录也是故事。';
  }
  return {total, unknown, ssr, high:high.length, special:high.length - ssr, pickup, pickupUnknown, rate,
    title, caption, distribution, pools:[...pools.values()].sort((a,b) => b.total - a.total || String(a.id).localeCompare(String(b.id))),
    days:[...days.values()].sort((a,b) => a.day.localeCompare(b.day)),
    from:dates[0] ?? '', to:dates.at(-1) ?? '', undated:records.filter(r => !r.day).length,
    batches:new Set(records.map(r => r.batchIndex)).size};
}

/** Strict allowlist: share rendering never receives a response, identity or credential. */
export function shareSummary(summary, poolName, queriedAt) {
  return {title:summary.title, caption:summary.caption, poolName:String(poolName).slice(0,160),
    queriedDay:historyDay(Math.floor(Date.parse(queriedAt) / 1000)),
    total:summary.total, high:summary.high, ssr:summary.ssr, special:summary.special,
    pickup:summary.pickup, pickupUnknown:summary.pickupUnknown, unknown:summary.unknown,
    rate:summary.rate, from:summary.from, to:summary.to, undated:summary.undated,
    distribution:summary.distribution.map(({label,count}) => ({label,count})),
    pools:summary.pools.map(({name,total,high}) => ({name,total,high}))};
}
