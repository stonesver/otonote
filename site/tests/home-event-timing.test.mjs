import test from 'node:test';
import assert from 'node:assert/strict';
import { homeEventTiming, homeEvents } from '../src/lib/home-content.mjs';
import { releaseTimestamp } from '../src/lib/recent-releases.mjs';

const start = releaseTimestamp('2026/09/30 18:00:00', 'jp');
const end = start + 2 * 86400000;

test('upcoming home events show only the start countdown using the regional clock', () => {
  const timing = homeEventTiming(start, end, Date.parse('2026-09-30T08:00:00Z'));
  assert.deepEqual(timing, {state:'upcoming', label:'距开始 1小时 0分', endLabel:''});
  assert.match(homeEventTiming(start, end, start - 1).label, /1分钟/);
});

test('start and end boundaries replace outdated countdown tags', () => {
  assert.deepEqual(homeEventTiming(start, end, start), {state:'active', label:'进行中', endLabel:'距结束 2天 0小时'});
  assert.equal(homeEventTiming(start, end, end - 1).endLabel, '距结束 1分钟');
  assert.deepEqual(homeEventTiming(start, end, end), {state:'ended', label:'已结束', endLabel:''});
});

test('missing and reversed schedules avoid invented countdowns', () => {
  for (const [a,b] of [[null,end],[start,null],[end,start],[start,start],[NaN,end]]) {
    assert.deepEqual(homeEventTiming(a,b,start), {state:'unknown', label:'时间待确认', endLabel:''});
  }
});

test('English tags preserve both timing meanings', () => {
  assert.deepEqual(homeEventTiming(start,end,start-60000,true), {state:'upcoming',label:'Starts in 1m',endLabel:''});
  assert.deepEqual(homeEventTiming(start,end,start,true), {state:'active',label:'Live now',endLabel:'Ends in 2d 0h'});
  assert.equal(homeEventTiming(start,end,end,true).label, 'Ended');
});

test('homeEvents ranks active, soonest upcoming, and recent ended events up to limit 3', () => {
  const mk = (id, s, e) => ({ id, name: `E${id}`, schedule: { startAt: s, endAt: e, timeZone: 'Asia/Tokyo' } });
  const now = releaseTimestamp('2026/10/01 12:00:00', 'jp');
  const events = [
    mk(1, '2026/09/20 18:00:00', '2026/09/28 21:00:00'),
    mk(2, '2026/10/10 18:00:00', '2026/10/18 21:00:00'),
    mk(3, '2026/09/30 18:00:00', '2026/10/08 21:00:00'),
    mk(4, '2026/10/03 18:00:00', '2026/10/09 21:00:00'),
  ];
  assert.deepEqual(homeEvents(events, 'jp', now, 3).map((e) => e.id), [3, 4, 2]);
});
