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
test('unknown mappings stay visible without invented rarity or cards',()=>{
  for(const content of [{}, {...catalog,cards:[]}]){
    const s=summarizeHistory(createHistoryModel(snapshot(),content).records);
    assert.equal(s.total,2);assert.equal(s.unknown,2);assert.equal(s.high,0);assert.deepEqual(s.highlights,[]);
    assert.equal(s.kinds.reduce((n,k)=>n+k.total,0)+s.other,s.total);
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
test('empty and small samples show facts without assigning luck ratings',()=>{
  assert.equal(summarizeHistory([]).rate,null);
  assert.equal(summarizeHistory([]).kinds[0].rate,null);
  const s=summarizeHistory(createHistoryModel(snapshot([101]),catalog).records);
  assert.equal(s.title,'本次抽卡');assert.equal(s.kinds[0].rate,100);assert.equal(s.kinds[1].rate,null);
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

test('member and support distributions use their own denominators and keep UP as a subset',()=>{
  const content=structuredClone(catalog);
  content.prizes.push({id:104,resourceType:3,resourceId:4,groupId:8,isPickup:true});
  content.cards.push({masterId:4,resourceType:3,name:'留影 SSR',rarity:4});
  const s=summarizeHistory(createHistoryModel(snapshot([101,101,102,102,102,104]),content).records);
  const [member,support]=s.kinds;
  assert.equal(member.total,2);assert.equal(member.ssr,2);assert.equal(member.rate,100);
  assert.equal(support.total,4);assert.equal(support.ssr,1);assert.equal(support.rate,25);
  assert.equal(member.pickup,2);assert.equal(support.pickup,1);
  for(const k of s.kinds){
    assert.equal(k.distribution.reduce((sum,row)=>sum+row.count,0),k.total);
    for(const row of k.distribution)assert.equal(row.pickup+row.nonPickup+row.pickupUnknown,row.count);
  }
  assert.deepEqual([s.pools[0].member,s.pools[0].support,s.pools[0].pickup],[2,4,3]);
  assert.deepEqual([s.days[0].member,s.days[0].support,s.days[0].pickup],[2,4,3]);
});

test('one card across prize IDs and pools retains separate UP, non-UP and unknown counts',()=>{
  const content=structuredClone(catalog);
  content.prizes.push({id:201,resourceType:2,resourceId:1,groupId:9,isPickup:false});
  const raw=snapshot([101,101]);
  raw.batches.push({...raw.batches[0],poolId:2,prizes:[{prizeId:201,converted:true},{prizeId:101,converted:false}]});
  const s=summarizeHistory(createHistoryModel(raw,content).records);
  assert.equal(s.highlights.length,1);
  const [card]=s.highlights;
  assert.deepEqual([card.count,card.pickup,card.nonPickup,card.pickupUnknown],[4,2,1,1]);
  assert.equal(s.kinds[0].distribution[0].pickupUnknown,1);
  const onlySecond=summarizeHistory(selectHistory(createHistoryModel(raw,content),{pool:'2'}));
  assert.equal(onlySecond.highlights[0].pickup,0);
  assert.equal(onlySecond.highlights[0].count,2);
});

test('matching resource IDs in different card kinds never share a gallery entry',()=>{
  const content=structuredClone(catalog);
  content.prizes.push({id:104,resourceType:3,resourceId:1,groupId:8,isPickup:true});
  content.cards.push({masterId:1,resourceType:3,name:'同编号留影',rarity:4});
  const s=summarizeHistory(createHistoryModel(snapshot([101,104]),content).records);
  assert.equal(s.highlights.length,2);
  assert.notEqual(s.highlights[0].id,s.highlights[1].id);
});

test('items, missing UP flags, unknown rarities and legacy data are not labeled non-UP',()=>{
  const content=structuredClone(catalog);
  content.prizes[0].isPickup=undefined;
  content.prizes.push({id:104,resourceType:4,resourceId:1,groupId:8,isPickup:true});
  const s=summarizeHistory(createHistoryModel(snapshot([101,102,104,999]),content).records);
  assert.equal(s.pickup,0);assert.equal(s.pickupUnknown,2);assert.equal(s.other,2);
  assert.equal(s.kinds[0].pickupUnknown,1);
  content.cards[0].rarity=99;
  const unknown=summarizeHistory(createHistoryModel(snapshot([101]),content).records);
  assert.equal(unknown.kinds[0].ssr,0);assert.equal(unknown.kinds[0].unknown,1);
  assert.equal(unknown.kinds[0].distribution.at(-1).label,'未识别');
});

test('share limits artwork per kind without dropping counts and allowlists nested fields',()=>{
  const content={pools:catalog.pools,prizes:[],cards:[]};
  for(const resourceType of [2,3])for(let i=1;i<=8;i++){
    content.prizes.push({id:resourceType*100+i,resourceType,resourceId:i,groupId:8,isPickup:i===8});
    content.cards.push({masterId:i,resourceType,name:`卡牌 ${i}`,rarity:i===8?3:4,image:'/thumb.webp',artwork:'/art.webp'});
  }
  const model=createHistoryModel(snapshot(content.prizes.map(p=>p.id)),content),s=summarizeHistory(model.records);
  s.highlights.forEach(c=>Object.assign(c,{account:'SECRET',executedAt:'SECRET',href:'/private'}));
  s.kinds[0].distribution[0].credential='SECRET';
  const shared=shareSummary(s,'全部卡池',model.queriedAt);
  assert.equal(s.highlights.length,16);assert.equal(shared.highlights.length,12);
  assert.equal(shared.total,16);assert.equal(shared.ssr,14);assert.equal(shared.pickup,2);
  assert.equal(shared.kinds[0].highlightCount,8);assert.equal(shared.kinds[1].highlightCount,8);
  assert.equal(shared.highlights.filter(c=>c.kind==='member').length,6);
  assert.equal(shared.highlights[0].pickup,1);assert.equal(shared.highlights[0].rarity,3);
  assert.equal(shared.highlights[0].artwork,'/art.webp');
  assert.equal(JSON.stringify(shared).includes('SECRET'),false);
  assert.equal(JSON.stringify(shared).includes('href'),false);
});
