import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {NOTICE_PAGES, noticeDatetime, noticeTimestamp, calendarDays,normalizeNoticePaths} from '../../backend/admin/static/notice-controls.mjs';

test('Beijing schedule round-trips independently of the browser timezone',()=>{
  const value='2026-10-20T00:15';
  const seconds=noticeTimestamp(value);
  assert.equal(new Date(seconds*1000).toISOString(),'2026-10-19T16:15:00.000Z');
  assert.equal(noticeDatetime(seconds),value);
  assert.equal(noticeTimestamp(''),null);
  assert.equal(noticeDatetime(null),'');
  for(const invalid of ['2026-02-30T12:00','2026-10-20T24:00','2026-10-20T10:60','invalid','2026-10-20'])assert.ok(Number.isNaN(noticeTimestamp(invalid)));
});

test('calendar starts on Monday, includes leap day and crosses year boundaries',()=>{
  const feb=calendarDays(2024,1);
  assert.equal(feb.length,42);
  assert.equal(feb[0].value,'2024-01-29');
  assert.equal(feb.filter(day=>day.current).length,29);
  assert.ok(feb.some(day=>day.value==='2024-02-29'&&day.current));
  const december=calendarDays(2026,11);
  assert.equal(december[0].value,'2026-11-30');
  assert.ok(december.some(day=>day.value==='2027-01-01'&&!day.current));
});

test('all-pages selection is exclusive and redundant scopes do not accumulate',()=>{
  assert.deepEqual(normalizeNoticePaths(['/recruitment/','/events/','/recruitment/']),['/recruitment/','/events/']);
  assert.deepEqual(normalizeNoticePaths(['/events/','/']),['/']);
});

test('page choices are unique logical routes with a real page or dynamic page template',()=>{
  const paths=NOTICE_PAGES.flatMap(([,items])=>items.map(([,path])=>path));
  assert.equal(new Set(paths).size,paths.length);
  for(const path of paths){
    assert.match(path,/^\/(?:[A-Za-z0-9_-]+\/)*$/);
    const file=new URL(`../src/pages${path}index.astro`,import.meta.url);
    const storyCategory=/^\/stories\/(main|extra|viewpoint|friendship)\/$/.test(path);
    assert.ok(existsSync(file)||storyCategory,`missing page: ${path}`);
  }
});
