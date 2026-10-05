/** Query-local records and descriptive statistics. No storage or network access. */
export const RARITIES = {2:'R', 3:'SR', 4:'SSR', 10:'EX', 20:'BD'};
export const HIGH_RARITIES = new Set([4, 10, 20]);
export const CARD_KINDS = {member:'角色卡', support:'留影'};
export const SHARE_CARDS_PER_KIND = 6;
export const STATISTICS_NOTE = '角色卡与留影分别统计，占比以各自的记录数为分母，包含保证抽取。当期 UP 指抽取时所属卡池的 UP；资料不全时标为未判定。';
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
      const pickup = known && isCard && pool?.prizeGroupIds?.includes(prize?.groupId)
        && typeof prize.isPickup === 'boolean' ? prize.isPickup : null;
      records.push({
        key:`${batchIndex}:${index}`, batchIndex, poolId:batch.poolId,
        poolName:pool?.name ?? (batch.poolId ? `未收录卡池 #${batch.poolId}` : '未归属卡池'),
        productId:batch.productId, executedAt:batch.executedAt, day:historyDay(batch.executedAt),
        prizeId:item.prizeId, converted:item.converted, known, pickup,
        kind:prize?.resourceType === 2 ? 'member' : prize?.resourceType === 3 ? 'support' : prize ? 'item' : 'unknown',
        rarity:card?.rarity ?? null, cardId:isCard ? prize.resourceId : null,
        name:card?.name ?? (prize ? `${isCard ? '未收录卡牌' : '道具'} #${prize.resourceId}` : `未识别奖品 #${item.prizeId}`),
        image:card?.image ?? null, artwork:card?.artwork ?? card?.image ?? null, href:card?.href ?? null,
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

function kindSummary(records, kind, label) {
  const rows = records.filter(r => r.kind === kind);
  const counts = new Map();
  for (const row of rows) {
    const rarity = row.known ? RARITIES[row.rarity] : '未识别';
    const group = counts.get(rarity) ?? {label:rarity, count:0, pickup:0, nonPickup:0, pickupUnknown:0};
    group.count++;
    group[row.pickup === true ? 'pickup' : row.pickup === false ? 'nonPickup' : 'pickupUnknown']++;
    counts.set(rarity, group);
  }
  const distribution = ['SSR','EX','BD','SR','R','未识别']
    .filter(label => counts.has(label) || ['SSR','SR','R'].includes(label))
    .map(label => counts.get(label) ?? {label, count:0, pickup:0, nonPickup:0, pickupUnknown:0});
  const ssr = counts.get('SSR')?.count ?? 0;
  return {kind, label, total:rows.length, ssr, rate:rows.length ? ssr / rows.length * 100 : null,
    special:(counts.get('EX')?.count ?? 0) + (counts.get('BD')?.count ?? 0),
    pickup:rows.filter(r => r.pickup === true).length, pickupUnknown:rows.filter(r => r.pickup === null).length,
    unknown:rows.filter(r => !r.known).length, distribution};
}

function countRecord(group, record) {
  group.total++;
  group.high += Number(record.known && HIGH_RARITIES.has(record.rarity));
  group[record.kind in CARD_KINDS ? record.kind : 'other']++;
  group.pickup += Number(record.pickup === true);
}

export function summarizeHistory(records) {
  const total = records.length;
  const unknown = records.filter(r => !r.known).length;
  const high = records.filter(r => r.known && HIGH_RARITIES.has(r.rarity));
  const ssr = records.filter(r => r.known && r.rarity === 4).length;
  const pickup = records.filter(r => r.pickup === true).length;
  const pickupUnknown = records.filter(r => r.kind !== 'item' && r.pickup === null).length;
  const rate = total ? high.length / total * 100 : null;
  const counts = new Map(), pools = new Map(), days = new Map(), cards = new Map();
  for (const r of records) {
    const rarity = !r.known ? '未识别' : r.kind === 'item' ? '道具' : RARITIES[r.rarity];
    counts.set(rarity, (counts.get(rarity) ?? 0) + 1);
    const key = r.poolId ?? 'unknown';
    const pool = pools.get(key) ?? {id:key, name:r.poolName, total:0, high:0, member:0, support:0, other:0, pickup:0};
    countRecord(pool, r); pools.set(key, pool);
    if (r.day) {
      const day = days.get(r.day) ?? {day:r.day, total:0, high:0, member:0, support:0, other:0, pickup:0};
      countRecord(day, r); days.set(r.day, day);
    }
    if (r.known && r.kind in CARD_KINDS) {
      // Different prize IDs can represent the same card in different pools.
      const id = `${r.kind}:${r.cardId}`;
      const card = cards.get(id) ?? {id, kind:r.kind, name:r.name, rarity:r.rarity,
        image:r.image, artwork:r.artwork, href:r.href, count:0, pickup:0, nonPickup:0, pickupUnknown:0};
      card.count++;
      card[r.pickup === true ? 'pickup' : r.pickup === false ? 'nonPickup' : 'pickupUnknown']++;
      cards.set(id, card);
    }
  }
  const distribution = ['SSR','EX','BD','SR','R','道具','未识别'].filter(label => counts.has(label)).map(label => ({label, count:counts.get(label)}));
  const dates = [...days.keys()].sort();
  const kinds = Object.entries(CARD_KINDS).map(([kind,label]) => kindSummary(records,kind,label));
  const highlights = [...cards.values()].filter(card => HIGH_RARITIES.has(card.rarity) || card.pickup)
    .sort((a,b) => Number(b.pickup > 0) - Number(a.pickup > 0) || b.count - a.count || a.id.localeCompare(b.id));
  const title = total ? '本次抽卡' : '暂无记录';
  const caption = total ? kinds.map(k => `${k.label} ${k.total} 张`).join(' · ') : '当前范围内没有抽卡记录。';
  return {total, unknown, ssr, high:high.length, special:high.length - ssr, pickup, pickupUnknown, rate,
    title, caption, kinds, highlights, other:records.filter(r => !(r.kind in CARD_KINDS)).length,
    distribution, pools:[...pools.values()].sort((a,b) => b.total - a.total || String(a.id).localeCompare(String(b.id))),
    days:[...days.values()].sort((a,b) => a.day.localeCompare(b.day)),
    from:dates[0] ?? '', to:dates.at(-1) ?? '', undated:records.filter(r => !r.day).length,
    batches:new Set(records.map(r => r.batchIndex)).size};
}

/** Strict allowlist: share rendering never receives a response, identity or credential. */
export function shareSummary(summary, poolName, queriedAt) {
  const highlights = Object.keys(CARD_KINDS).flatMap(kind => summary.highlights
    .filter(card => card.kind === kind).slice(0, SHARE_CARDS_PER_KIND));
  return {title:summary.title, caption:summary.caption, poolName:String(poolName).slice(0,160),
    queriedDay:historyDay(Math.floor(Date.parse(queriedAt) / 1000)),
    total:summary.total, high:summary.high, ssr:summary.ssr, special:summary.special,
    pickup:summary.pickup, pickupUnknown:summary.pickupUnknown, unknown:summary.unknown,
    rate:summary.rate, from:summary.from, to:summary.to, undated:summary.undated,
    distribution:summary.distribution.map(({label,count}) => ({label,count})),
    other:summary.other,
    kinds:summary.kinds.map(({kind,label,total,ssr,special,rate,pickup,pickupUnknown,unknown,distribution}) =>
      ({kind,label,total,ssr,special,rate,pickup,pickupUnknown,unknown,
        highlightCount:summary.highlights.filter(card => card.kind === kind).length,
        distribution:distribution.map(({label,count,pickup,nonPickup,pickupUnknown}) => ({label,count,pickup,nonPickup,pickupUnknown}))})),
    highlights:highlights.map(({kind,name,rarity,artwork,image,count,pickup,nonPickup,pickupUnknown}) =>
      ({kind,name,rarity,artwork,image,count,pickup,nonPickup,pickupUnknown})),
    pools:summary.pools.map(({name,total,high,member,support,other,pickup}) => ({name,total,high,member,support,other,pickup}))};
}
