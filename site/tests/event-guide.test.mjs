import assert from 'node:assert/strict';
import test from 'node:test';
import { eventTimestamp, eventCountdown } from '../src/lib/event-time.mjs';
import { groupEventBonuses, eventBonusPercentage } from '../src/lib/event-bonus-model.mjs';
test('event source clocks use UTC+9 independently of browser or display timezone',()=>{
  assert.equal(eventTimestamp('2026/09/30 18:00:00','jp'),Date.parse('2026-09-30T09:00:00Z'));
  assert.equal(eventTimestamp('2026/09/30 18:00','jp'),Date.parse('2026-09-30T09:00:00Z'));
  assert.equal(eventTimestamp('2026-09-30T18:00:00+09:00','global'),Date.parse('2026-09-30T09:00:00Z'));
  assert.equal(eventTimestamp('2026/09/30 18:00:00','global'),Date.parse('2026-09-30T09:00:00Z'));
  assert.equal(eventTimestamp('2026/02/30 18:00:00','jp'),null);
  assert.equal(eventTimestamp(null,'jp'),null);
});
test('countdown handles start/end boundaries and invalid schedules',()=>{
  const start=Date.parse('2026-09-30T09:00Z'),end=start+3600000;
  assert.deepEqual(eventCountdown(start,end,start-3600000),{state:'upcoming',label:'距开始 1小时 0分'});
  assert.equal(eventCountdown(start,end,start).state,'active');
  assert.equal(eventCountdown(start,end,end).state,'active');
  assert.equal(eventCountdown(start,end,end+1).state,'ended');
  assert.equal(eventCountdown(null,end,start).state,'unknown');
  assert.equal(eventCountdown(end,start,start).state,'unknown');
});
test('bonus groups combine destinations without conflating card type or rank values',()=>{
  const base={constraints:{resourceTypeConstraint:2,bandId:3,cardType:0},targetNames:['Band'],rankValues:[2000,2300,2600,2900,3200]};
  const effects=[{...base,bonusKind:'EventPoint'},{...base,bonusKind:'ParameterAll'}, {...base,constraints:{...base.constraints,resourceTypeConstraint:3},bonusKind:'EventItem'}];
  const groups=groupEventBonuses(effects);
  assert.equal(groups.length,2);
  assert.deepEqual(groups[0].effects.map(e=>e.bonusKind),['EventPoint','ParameterAll']);
  assert.deepEqual(groups[0].effects[0].rankValues,base.rankValues);
  assert.equal(groups[1].constraints.resourceTypeConstraint,3);
});

test('bonus percentages follow the client display division and floor fractional values',()=>{
  assert.deepEqual([2000,2300,2600,2900,3200].map(eventBonusPercentage),[20,23,26,29,32]);
  assert.deepEqual([1500,1750,2000,2250,2500].map(eventBonusPercentage),[15,17,20,22,25]);
  assert.equal(eventBonusPercentage(3000),30);
  assert.equal(eventBonusPercentage(5000),50);
  assert.equal(eventBonusPercentage(0),0);
  assert.equal(eventBonusPercentage(null),null);
  assert.equal(eventBonusPercentage(undefined),null);
  assert.equal(eventBonusPercentage(Infinity),null);
});
