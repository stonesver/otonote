import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryModel, selectHistory, summarizeHistory, shareSummary, historyDay} from '../src/lib/gacha-history.mjs';

const catalog = {
  pools:[{id:1,name:'灯的卡池',prizeGroupIds:[8],products:[{id:10,ensuredCount:1}]}, {id:2,name:'生日卡池',prizeGroupIds:[9]}],
  prizes:[{id:101,resourceType:2,resourceId:1,groupId:8,isPickup:true},
    {id:102,resourceType:3,resourceId:2,groupId:8,isPickup:false},
    {id:103,resourceType:2,resourceId:3,groupId:9,isPickup:true}],
  cards:[{masterId:1,resourceType:2,name:'灯 SSR',rarity:4}, {masterId:2,resourceType:3,name:'留影 R',rarity:2},
    {masterId:3,resourceType:2,name:'生日 BD',rarity:20}],
};
const snapshot = (ids = [101,102], extra = {}) => ({format:'otonote-gacha-history',schemaVersion:1,
  queriedAt:'2026-10-04T12:00:00Z',source:{serverId:'global-hmt'},
  coverage:{scope:'server_returned',historyKind:'execution'},
  batches:[{poolId:1,productId:10,executedAt:Date.parse('2026-10-04T00:00:00Z')/1000,prizes:ids.map(prizeId=>({prizeId,converted:false}))}],...extra});

test('counts each identical prize and batch, while member/support identities remain separate',()=>{
  const raw=snapshot([101,101,102]);raw.batches.push(structuredClone(raw.batches[0]));
  const model=createHistoryModel(raw,catalog),s=summarizeHistory(model.records);
  assert.equal(s.total,6);assert.equal(s.ssr,4);assert.equal(s.pickup,4);assert.equal(s.batches,2);
  assert.equal(new Set(model.records.map(r=>r.key)).size,6);
});
test('unknown mappings suppress ratings; old content and missing card metadata stay usable',()=>{
  for(const content of [{}, {...catalog,cards:[]}]){
    const s=summarizeHistory(createHistoryModel(snapshot(),content).records);
    assert.equal(s.total,2);assert.equal(s.unknown,2);assert.equal(s.title,'欧气暂不定级');
  }
});
test('same prize in a different pool is not invented as UP; legacy stays unassigned',()=>{
  const raw=snapshot([101]);raw.batches[0].poolId=2;
  assert.equal(createHistoryModel(raw,catalog).records[0].pickup,null);
  raw.batches[0].poolId=null;raw.batches[0].executedAt=null;raw.coverage.historyKind='legacy';
  const model=createHistoryModel(raw,catalog);assert.equal(model.records[0].poolName,'未归属卡池');
  assert.equal(summarizeHistory(model.records).undated,1);
  assert.equal(selectHistory(model,{from:'2026-01-01'}).length,0);
});
test('date filtering uses UTC+8 and pool scope; invalid intervals refuse a misleading result',()=>{
  assert.equal(historyDay(Date.parse('2026-10-04T16:01:00Z')/1000),'2026-10-05');
  const raw=snapshot();raw.batches.push({...structuredClone(raw.batches[0]),poolId:2,executedAt:Date.parse('2026-10-04T16:01:00Z')/1000});
  const model=createHistoryModel(raw,catalog);
  assert.equal(selectHistory(model,{pool:'2',from:'2026-10-05',to:'2026-10-05'}).length,2);
  assert.equal(selectHistory(model,{pool:'1',from:'2026-10-05'}).length,0);
  assert.throws(()=>selectHistory(model,{from:'2026-10-06',to:'2026-10-05'}),/开始日期/);
});
test('empty and small samples are distinct; known samples get transparent entertainment labels',()=>{
  assert.equal(summarizeHistory([]).rate,null);
  assert.equal(summarizeHistory(createHistoryModel(snapshot([101]),catalog).records).title,'欧气初显');
  for(const [hits,title] of [[0,'非酋渡劫'],[2,'平稳发挥'],[5,'小欧怡情'],[10,'欧皇附体']]){
    const ids=[...Array(hits).fill(101),...Array(100-hits).fill(102)];
    assert.equal(summarizeHistory(createHistoryModel(snapshot(ids),catalog).records).title,title);
  }
});
test('SSR and special rarities have separate counts, not a numeric rarity greater-than test',()=>{
  const s=summarizeHistory(createHistoryModel(snapshot([101,102,103]),catalog).records);
  assert.equal(s.ssr,1);assert.equal(s.special,1);assert.equal(s.high,2);
});
test('share contract contains aggregate facts only and uses the selected pool statistics',()=>{
  const model=createHistoryModel(snapshot(),catalog);const s=summarizeHistory(selectHistory(model,{pool:'1'}));
  Object.assign(s,{account:'PRIVATE',credential:'PRIVATE',records:model.records});
  const shared=shareSummary(s,'灯的卡池',model.queriedAt);
  assert.equal(shared.total,2);assert.equal(shared.ssr,1);assert.equal(shared.poolName,'灯的卡池');
  assert.equal(JSON.stringify(shared).includes('PRIVATE'),false);
  assert.equal('records' in shared,false);assert.equal('executedAt' in shared,false);
});
test('malformed responses never partially enter the model',()=>{
  for(const extra of [{schemaVersion:2},{source:{serverId:'jp'}},{queriedAt:'bad'},{batches:[{poolId:1,productId:1,executedAt:0,prizes:[]}]}]){
    assert.throws(()=>createHistoryModel(snapshot([101],extra),catalog));
  }
});
