import test from 'node:test';
import assert from 'node:assert/strict';
import { siteCalendarForYear, nextBandAnniversary } from '../src/lib/site-calendar.mjs';
import { nextBirthday } from '../src/lib/birthday-calendar.mjs';

const catalog = { projectionContext: { region: 'global' }, bands: [
  { id: 'band-1', displayName: 'MyGO!!!!!' }, { id: 'band-3', displayName: 'MewType' }
], characters: [{ id: 'character-1', displayName: 'A', birthday: { month: 2, day: 29 } }] };
const arena = { capabilities: { conditions: true }, serverScopes: ['global-hmt'], seasons: [
  { id: '1', name: 'S1', validFrom: '2026-12-30T16:00:00Z', validUntil: '2027-01-01T16:00:00Z' }
] };
const events = [{ id: 1, name: 'Event', schedule: { startAt: '2026/12/31 23:30:00',
  endAt: '2027/01/01 00:30:00', displayEndAt: '2027/01/10 00:00:00', timeZone: 'Asia/Tokyo' } }];
const input = { catalog, arena, events, year: 2026 };

test('anniversary stays current through the third local day and rolls to next year', () => {
  const during = Date.parse('2026-11-20T15:30:00Z');
  const global = nextBandAnniversary(catalog, during);
  assert.equal(global.startDate, '2026-11-18');
  assert.equal(global.endDate, '2026-11-20');
  assert.equal(global.id, 'band-3');
  const jp = { ...catalog, projectionContext: { region: 'jp' } };
  assert.equal(nextBandAnniversary(jp, during).startDate, '2027-11-18');
  assert.equal(nextBirthday(11, 21, during, 'jp').days, 0);
  assert.equal(nextBirthday(11, 21, during, 'global').days, 1);
  assert.deepEqual(siteCalendarForYear({ ...input, year: 2025 }).entries, []);
  assert.equal(siteCalendarForYear(input).entries.filter(e => e.kind === 'band-anniversary').length, 1);
});

test('timed intervals respect server days, published scope, and exclusive season ends', () => {
  const { entries } = siteCalendarForYear(input);
  const event = entries.find(e => e.kind === 'event');
  assert.deepEqual([event.startDate, event.endDate], ['2026-12-31', '2026-12-31']);
  assert.equal(event.until, Date.parse('2027-01-01T00:30:01+09:00'));
  const later = siteCalendarForYear({ ...input, year: 2027 }).entries;
  assert.ok(!later.some(e => e.kind === 'event'));
  assert.equal(later.find(e => e.kind === 'arena-season').endDate, '2027-01-01');
  assert.ok(!siteCalendarForYear({ ...input, serverId: 'global-en' }).entries.some(e => e.kind === 'arena-season'));
  const jp = siteCalendarForYear({ ...input, year: 2027, arena: null, catalog: { ...catalog, projectionContext: { region: 'jp' } } });
  assert.equal(jp.entries.find(e => e.kind === 'event').endDate, '2027-01-01');
  assert.deepEqual(jp.seasonScopes, []);
  assert.ok(!jp.entries.some(e => e.kind === 'arena-season'));
  assert.equal(siteCalendarForYear({ ...input, year: 2028 }).entries.find(e => e.kind === 'birthday').startDate, '2028-02-29');
  assert.ok(!entries.some(e => e.kind === 'birthday'));
});
