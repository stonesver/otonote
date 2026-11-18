import test from 'node:test';
import assert from 'node:assert/strict';
import {eventTimestamp,eventCountdown,formatEventTime,eventTimeLabel} from '../src/lib/event-time.mjs';
import {rankingEventState} from '../src/lib/player-ranking-events.mjs';
import {homeEvents} from '../src/lib/home-content.mjs';

test('Global Master event at 15:00 starts at 14:00 Beijing in detail and home',()=>{
 const startAt='2026/11/18 15:00:00',endAt='2026/11/27 14:59:59';
 const start=Date.parse('2026-11-18T06:00:00Z');
 assert.equal(eventTimestamp(startAt,'global'),start);
 const [event]=homeEvents([{id:6,name:'Event',schedule:{startAt,endAt,timeZone:null}}],'global',start);
 assert.equal(event.start,start);
 assert.equal(rankingEventState({startAt,endAt,edition:'global'},start),'active');
 assert.equal(eventCountdown(event.start,event.end,start-1).state,'upcoming');
 assert.equal(eventCountdown(event.start,event.end,start).state,'active');
 assert.equal(event.end,Date.parse('2026-11-27T05:59:59Z'));
 assert.equal(eventTimestamp(startAt,'jp'),start);
});
test('explicit time zones win and invalid dates remain unavailable',()=>{
 assert.equal(eventTimestamp('2026/09/30 18:00:00','global','UTC'),Date.parse('2026-09-30T18:00:00Z'));
 assert.equal(eventTimestamp('2026/09/30 18:00:00','jp','Asia/Taipei'),Date.parse('2026-09-30T10:00:00Z'));
 assert.equal(eventTimestamp('2026-09-30T18:00:00+08:00','jp'),Date.parse('2026-09-30T10:00:00Z'));
 for(const value of [null,'','unknown','2026/02/30 00:00:00'])assert.equal(eventTimestamp(value,'global'),null);
 assert.equal(eventTimestamp('2026/09/30 18:00:00','global','unknown'),null);
});

test('event display converts UTC+9 source clocks without losing midnight or explicit offsets',()=>{
 assert.equal(formatEventTime('2026/11/18 15:00:00','global'),'2026/11/18 14:00');
 assert.equal(formatEventTime('2026/11/18 00:30:00','global'),'2026/11/17 23:30');
 assert.equal(formatEventTime('2026/11/27 14:59:59','global',null,true),'2026/11/27 13:59:59');
 assert.equal(formatEventTime('2026-11-18T14:00:00+08:00','global'),'2026/11/18 14:00');
 assert.equal(formatEventTime('2026/11/18 15:00:00','jp'),'2026/11/18 15:00');
 assert.match(eventTimeLabel('global'),/北京时间/);
 assert.equal(formatEventTime(null,'global'),'—');
});
