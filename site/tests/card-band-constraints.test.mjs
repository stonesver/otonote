import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveSearchInput} from '../../packages/scoring/scoring-rules/formation-input.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
import {readCardBandConstraints,cardBandFilterSummary} from '../src/lib/card-band-constraints.mjs';
import {readOptimizerConstraints} from '../src/lib/optimizer-search-summary.mjs';
import {eventYieldStageInput} from '../src/lib/event-yield-stage.mjs';
import {eventSearchPartition} from '../src/lib/event-search-cache.mjs';
import {optimizeEventYield,eventCandidateKey} from '../src/lib/event-yield-optimizer.mjs';
import {optimizeChallenge} from '../src/lib/challenge-optimizer.mjs';
import {proveEventYieldGroups} from '../src/lib/event-yield-group-proof.mjs';
import {eventYieldOracleFixture} from './helpers/event-yield-oracle-fixture.mjs';
import {validateEventCardPool} from '../src/lib/event-reward-candidates.mjs';

const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
const draft=createTeamDraft();
const resolve=constraints=>resolveSearchInput(rules,draft,{scope:'reference',constraints});
const bandFor=new Map(rules.tables.Character.map(row=>[row._id,row._bandID]));
const supportFor=new Map(rules.tables.SupportCard.map(row=>[`support-card-${row._id}`,row]));
const memberFor=new Map(rules.tables.MemberCard.map(row=>[`member-card-${row._id}`,row]));

test('member and support band restrictions are independent and multi-select uses a union',()=>{
  const all=resolve({}),members=resolve({bandId:[1]}),supports=resolve({supportBandId:[2]});
  assert.deepEqual(members.inventory.supportCardIds,all.inventory.supportCardIds);
  assert.deepEqual(supports.inventory.memberCardIds,all.inventory.memberCardIds);
  assert.ok(members.inventory.memberCardIds.every(id=>bandFor.get(memberFor.get(id)._characterID)===1));
  const both=resolve({bandId:[1],supportBandId:[2,3]});
  assert.deepEqual(both.inventory.memberCardIds,members.inventory.memberCardIds);
  const expected=all.inventory.supportCardIds.filter(id=>supportFor.get(id)._characterIDs.some(character=>[2,3].includes(bandFor.get(character))));
  assert.deepEqual(both.inventory.supportCardIds,expected);
  assert.ok(both.inventory.supportCardIds.includes('support-card-61'),'mixed-band memory matches any featured character');
  assert.throws(()=>resolve({supportBandId:0}),/supportBandId/);
});

test('owned and selected pools retain growth, reject insufficient cards and preserve required choices',()=>{
  const f=eventYieldOracleFixture(),before=structuredClone(f);
  for(const scope of ['owned','selected']){
    const input=resolveSearchInput(f.rules,f.draft,{scope,inventory:f.inventory,constraints:{bandId:[1],supportBandId:[1]}});
    assert.equal(input.inventory.supportCardIds.length,5);
    assert.deepEqual(input.draft.modifiers.growth,f.draft.modifiers.growth);
    assert.throws(()=>resolveSearchInput(f.rules,f.draft,{scope,inventory:f.inventory,constraints:{supportBandId:[2]}}),/至少五位不同角色及五张留影/);
    assert.throws(()=>validateEventCardPool({...f,scope,constraints:{supportBandId:[2]}}),/至少五位不同角色及五张留影/);
  }
  assert.throws(()=>resolveSearchInput(f.rules,f.draft,{scope:'owned',inventory:f.inventory,
    constraints:{supportBandId:[1],requiredSupportIds:[6]}}),/必选留影被筛选/);
  assert.deepEqual(f,before);
});

function field(values){
  const options=['','1','2','3'].map(value=>({value,textContent:value?`Band ${value}`:'不限',selected:values.includes(value)}));
  return {multiple:true,options,get selectedOptions(){return options.filter(o=>o.selected);}};
}
test('controls, summaries and optimizer constraints preserve independent numeric band selections',()=>{
  const member=field(['1','2']),support=field(['3']);
  assert.deepEqual(readCardBandConstraints(member,support),{bandId:[1,2],supportBandId:[3]});
  assert.equal(cardBandFilterSummary(member,support),'成员乐队：Band 1、Band 2 · 留影关联乐队：Band 3');
  assert.equal(cardBandFilterSummary(field(['']),field([''])),'');
  const nodes={'[data-search-constraints]':{value:'{}'},'[data-search-band]':member,'[data-search-support-band]':support};
  assert.deepEqual(readOptimizerConstraints({querySelector:key=>nodes[key]}),{bandId:[1,2],supportBandId:[3]});
});

test('challenge band inheritance is explicit and effective stage filters isolate caches',async()=>{
  const f=eventYieldOracleFixture(),input={...f,mode:'ordinary',includeChallenge:true,challengeScope:'reference',constraints:{bandId:[1],supportBandId:[1]}};
  assert.deepEqual(eventYieldStageInput(input,'challenge').constraints,{});
  assert.deepEqual(eventYieldStageInput({...input,challengeBandScope:'same'},'challenge').constraints,input.constraints);
  assert.equal(eventYieldStageInput(input,'challenge').scope,'reference');
  const key=await eventSearchPartition(f.rules,1,input);
  assert.notEqual(await eventSearchPartition(f.rules,1,eventYieldStageInput(input,'challenge')),await eventSearchPartition(f.rules,1,eventYieldStageInput({...input,challengeBandScope:'same'},'challenge')));
  for(const constraints of [{},{bandId:[2],supportBandId:[1]},{bandId:[1],supportBandId:[2]}]){
    assert.notEqual(await eventSearchPartition(f.rules,1,{...input,constraints}),key);
    assert.notEqual(eventCandidateKey(f.rules,f.draft,f.inventory,'owned',[],true,constraints),
      eventCandidateKey(f.rules,f.draft,f.inventory,'owned',[],true,input.constraints));
  }
});

test('practical, certified and challenge searches never reintroduce filtered cards from cached candidates',async()=>{
  const f=eventYieldOracleFixture(),candidateCache=new Map(),constraints={bandId:[1],supportBandId:[1]};
  // Card 6 has a large event bonus but belongs to another band.
  const unrestricted=await optimizeEventYield({...f,mode:'ordinary',includeChallenge:false,candidateCache});
  assert.ok(unrestricted.results.some(row=>row.draft.slots.some(slot=>slot.supportCardId==='support-card-6')));
  for(const searchMethod of ['practical','certified']){
    const result=await optimizeEventYield({...f,mode:'ordinary',includeChallenge:false,constraints,candidateCache,searchMethod});
    assert.ok(result.results.length);
    for(const row of result.results)assert.ok(row.draft.slots.every(slot=>slot.supportCardId!=='support-card-6'));
  }
  const challenge=await optimizeChallenge({...f,constraints,maxEvaluations:0});
  assert.equal(challenge.certifiedSearch.bestProven,true);
  assert.ok(challenge.results.every(row=>row.draft.slots.every(slot=>slot.supportCardId!=='support-card-6')));
});

test('reference yield searches and cross-chart proof use filtered maximum growth without changing ownership',async()=>{
  const f=eventYieldOracleFixture(),before=structuredClone(f.inventory),constraints={bandId:[1],supportBandId:[1]};
  // Bound this reference fixture to six memories so the full proof stays small.
  f.rules.tables.MemberCard=f.rules.tables.MemberCard.filter(row=>row._id<=5);
  f.rules.tables.SupportCard=f.rules.tables.SupportCard.filter(row=>row._id<=6);
  const input={...f,scope:'reference',constraints,mode:'ordinary',basis:'expectedScore',liveBoost:1,challengeCost:200,includeChallenge:false};
  const initial=await optimizeEventYield(input);
  assert.equal(initial.certifiedSearch.bestProven,true);
  assert.ok(initial.results[0].draft.slots.every(slot=>slot.supportCardId!=='support-card-6'));
  assert.ok(initial.results[0].draft.modifiers.growth['member-card-1'].level>1);
  const proof=await proveEventYieldGroups({rules:f.rules,eventId:1,input,candidates:[f.candidate],goal:'badges',initialRows:initial.results,
    loadChart:async()=>f.chart,getScoreCache:async()=>new Map()});
  assert.equal(proof.proven,true);
  assert.ok(proof.results.every(row=>row.draft.slots.every(slot=>slot.supportCardId!=='support-card-6')));
  assert.deepEqual(f.inventory,before);
});

test('reward-root proofs and exhaustive pairing fallback keep the same restricted domain',async()=>{
  const f=eventYieldOracleFixture(),constraints={bandId:[1],supportBandId:[1]};
  f.rules.tables.LiveScoreRank.find(row=>row._liveScoreRank===7)._requiredScore=1e12;
  for(const refineScoreTies of [false,true]){
    const result=await optimizeEventYield({...f,constraints,mode:'ordinary',includeChallenge:false,refineScoreTies});
    assert.equal(result.certifiedSearch.bestProven,true);
    if(!refineScoreTies)assert.ok(result.practical.rewardRootCertificate,'exercise the reward-root bound');
    assert.ok(result.results.every(row=>row.draft.slots.every(slot=>slot.supportCardId!=='support-card-6')));
  }
});

test('temporarily including reward cards cannot bypass the selected memory bands',async()=>{
  const f=eventYieldOracleFixture();f.inventory.supportCardIds=f.inventory.supportCardIds.slice(0,5);
  const before=structuredClone(f.inventory);
  const result=await optimizeEventYield({...f,mode:'ordinary',includeChallenge:false,constraints:{supportBandId:[1]},
    rewardCards:[{resourceType:3,resourceId:6}],rewardGrowthOverride:true});
  assert.ok(result.results.length);
  assert.ok(result.results.every(row=>row.draft.slots.every(slot=>slot.supportCardId!=='support-card-6')));
  assert.deepEqual(f.inventory,before);
});

test('band restrictions retain required members, leader and locked pairs through every search path',async()=>{
  const f=eventYieldOracleFixture(),constraints={bandId:[1],supportBandId:[1],leaderId:1,
    requiredMemberIds:[2],requiredSupportIds:[3],lockedPairs:[{memberCardId:1,supportCardId:2}]};
  const legal=row=>{
    assert.equal(row.draft.slots[2].memberCardId,'member-card-1');
    assert.equal(row.draft.slots[2].supportCardId,'support-card-2');
    assert.ok(row.draft.slots.some(slot=>slot.memberCardId==='member-card-2'));
    assert.ok(row.draft.slots.some(slot=>slot.supportCardId==='support-card-3'));
  };
  for(const refineScoreTies of [false,true]){
    const result=await optimizeEventYield({...f,constraints,mode:'ordinary',includeChallenge:false,refineScoreTies});
    assert.equal(result.certifiedSearch.bestProven,true);result.results.forEach(legal);
  }
  const challenge=await optimizeChallenge({...f,constraints,maxEvaluations:0});
  assert.equal(challenge.certifiedSearch.bestProven,true);challenge.results.forEach(legal);
});
