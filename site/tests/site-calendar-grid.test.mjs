import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftMonth, monthGrid, gridYears, entriesOn } from '../src/lib/site-calendar-grid.mjs';
import { anniversaryStatus, anniversaryText } from '../src/lib/birthday-calendar.mjs';

test('months roll across years in both directions', () => {
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2027, 1, -1), { year: 2026, month: 12 });
  assert.deepEqual(shiftMonth(2026, 3, -14), { year: 2025, month: 1 });
});

test('month grid has six Sunday-first weeks and marks padding days', () => {
  const grid = monthGrid(2027, 1);
  assert.equal(grid.days.length, 42);
  assert.equal(grid.days[0].date, '2026-12-27');
  assert.equal(grid.days[0].inMonth, false);
  assert.equal(grid.days[5].date, '2027-01-01');
  assert.equal(grid.days[5].inMonth, true);
  assert.deepEqual(gridYears(grid), [2026, 2027]);
  assert.deepEqual(gridYears(monthGrid(2026, 6)), [2026]);
});

test('entries cover both end dates and span months', () => {
  const entries = [{ id: 'a', startDate: '2026-12-30', endDate: '2027-01-02' }];
  assert.equal(entriesOn(entries, '2026-12-29').length, 0);
  assert.equal(entriesOn(entries, '2026-12-31').length, 1);
  assert.equal(entriesOn(entries, '2027-01-02').length, 1);
  assert.equal(entriesOn(entries, '2027-01-03').length, 0);
});

test('band anniversary is celebrating on all three days', () => {
  const entry = { startDate: '2026-11-18', endDate: '2026-11-20' };
  assert.deepEqual(anniversaryStatus(entry, '2026-11-17'), { state: 'upcoming', days: 1 });
  for (const [date, day] of [['2026-11-18', 1], ['2026-11-19', 2], ['2026-11-20', 3]]) {
    assert.deepEqual(anniversaryStatus(entry, date), { state: 'celebrating', days: 0, day, total: 3 });
  }
  assert.equal(anniversaryStatus(entry, '2026-11-21').state, 'ended');
  assert.equal(anniversaryText(entry, anniversaryStatus(entry, '2026-11-20')).label, '庆祝中');
  assert.equal(anniversaryText(entry, anniversaryStatus(entry, '2026-11-10')).note, '还有 8 天');
});
