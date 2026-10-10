import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bandItemGroups,validateBandItemTotals,bandItemEffects} from '../../packages/scoring/scoring-rules/band-item-totals.mjs';
import {createFormationCalculator} from '../../packages/scoring/scoring-rules/formation-power.mjs';
import {createPersonalGrowthStore,applyPersonalGrowth} from '../src/lib/personal-growth-store.mjs';
import {createTeamDraft,parseTeamDraftSearch,serializeTeamDraftSearch} from '../src/lib/team-draft.mjs';
const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
const calculator=createFormationCalculator(rules),groups=bandItemGroups(rules);
const draft=(modifiers,bandId=1)=>{const ids=rules.tables.Character.filter(c=>c._bandID===bandId).map(c=>c._id);const member=rules.tables.MemberCard.find(c=>ids.includes(c._characterID));return createTeamDraft({slots:[null,null,{memberCardId:`member-card-${member._id}`}],modifiers});};
test('instrument effects follow mutable levels, preserve all rows, and validate warmed lookups',()=>{
 const r=structuredClone(rules),id=groups[0].items[0].id;
 const rows=level=>r.tables.BandItemSkillEffect.filter(row=>row._bandItemId===id&&row._level===level);
 r.tables.BandItemSkillEffect.push({...rows(2)[0],_id:999999});
 const settings={bandItems:{[id]:1}};
 assert.deepEqual(bandItemEffects(r,settings),rows(1));
 settings.bandItems[id]=2;assert.deepEqual(bandItemEffects(r,settings),rows(2));
 settings.bandItems[id]=0;assert.deepEqual(bandItemEffects(r,settings),[]);
 for(const value of [-1,1.5,NaN,'1',10000]){
  settings.bandItems[id]=value;assert.throws(()=>bandItemEffects(r,settings),/Unknown instrument\/level/);
 }
 assert.throws(()=>bandItemEffects(r,{bandItems:{999999:0}}),/Unknown instrument/);
 // An aggregate overrides that band's details before validating detail levels.
 const aggregate={bandItemTotals:{[groups[0].bandId]:10}};
 assert.deepEqual(bandItemEffects(rules,{...aggregate,bandItems:{[id]:'ignored'}}),bandItemEffects(rules,aggregate));
});
test('band totals reproduce every item distribution, including 0 and maximum, without double counting',()=>{
 for(const group of groups){
  assert.equal(group.supported,true);
  for(const levels of [group.items.map(()=>0),[1,2,3,4,5],group.items.map(i=>i.maxLevel)]){
   const bandItems=Object.fromEntries(group.items.map((i,n)=>[i.id,levels[n]]));
   const totals={[group.bandId]:levels.reduce((a,b)=>a+b,0)};
   const exact=calculator.calculate(draft({bandItems},group.bandId));
   assert.deepEqual(calculator.calculate(draft({bandItemTotals:totals},group.bandId)),exact);
   assert.deepEqual(calculator.calculate(draft({bandItems,bandItemTotals:totals},group.bandId)),exact);
  }
 }
});
test('aggregate override applies only to its band; another bands detail survives',()=>{
 const r=structuredClone(rules),c=createFormationCalculator(r);
 const first=groups[0],other=groups[1];
 const total=10,base={[other.items[0].id]:7};
 const all={...base,[first.items[0].id]:total};
 assert.deepEqual(c.calculate(draft({bandItems:{...base,[first.items[1].id]:30},bandItemTotals:{[first.bandId]:total}})),c.calculate(draft({bandItems:all})));
});
test('nonlinear or unequal items cannot use totals and invalid totals fail closed',()=>{
 for(const value of [-1,1.5,251,NaN])assert.throws(()=>validateBandItemTotals(rules,{1:value}));
 assert.throws(()=>validateBandItemTotals(rules,{999:10}));
 const r=structuredClone(rules);r.tables.BandItemSkillEffect.find(e=>e._bandItemId===101&&e._level===2)._effectValue++;
 assert.equal(bandItemGroups(r).find(g=>g.bandId===1).supported,false);
 assert.throws(()=>validateBandItemTotals(r,{1:10}));
});
test('totals round trip through profile and share link; applying them does not fabricate item records',()=>{
 const entries=new Map(),storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),get length(){return entries.size;},key:i=>[...entries.keys()][i]};
 const store=createPersonalGrowthStore({rules,context:{region:'global',serverId:'global-hmt'},storage});
 store.saveAccount({bandItemTotals:{1:50},bandItems:{101:7}});
 assert.deepEqual(store.read().account,{bandItems:{101:7},bandItemTotals:{1:50}});
 const team=draft({});applyPersonalGrowth(team,store.read());
 assert.deepEqual(team.modifiers.bandItems,{101:7});assert.equal(team.modifiers.bandItemTotals[1],50);
 assert.equal(parseTeamDraftSearch(serializeTeamDraftSearch(team)).draft.modifiers.bandItemTotals[1],50);
 const backup=store.fromImport(JSON.parse(JSON.stringify(store.read())));assert.equal(backup.account.bandItemTotals[1],50);
});
test('explicit shared item settings win over saved aggregate defaults',()=>{
 const profile={account:{bandItemTotals:{1:100},bandItems:{101:7}},inventory:{growth:{}}};
 const team=draft({bandItems:{101:1}});applyPersonalGrowth(team,profile);
 assert.equal(team.modifiers.bandItemTotals,undefined);assert.deepEqual(team.modifiers.bandItems,{101:1});
});
