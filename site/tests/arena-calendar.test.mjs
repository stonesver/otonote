import test from 'node:test';
import assert from 'node:assert/strict';
import {arenaCalendar,arenaCalendarWeek,arenaDateKey} from '../src/lib/arena-calendar.mjs';
const row=(id,from,until)=>({id,validFrom:from,validUntil:until,attribute:99,missions:[1,2,3]});
const context=(rows,from='2026-10-01T00:00:00+08:00',until='2026-12-01T00:00:00+08:00')=>({season:{validFrom:from,validUntil:until},schedule:rows,current:rows[0],condition:rows[0]});
const now=Date.parse('2026-10-30T12:00:00+08:00');
test('calendar uses Beijing days and only the necessary calendar weeks',()=>{
 assert.equal(arenaDateKey('2026-10-29T19:00:00Z'),'2026-10-30');
 const c=context([row('a','2026-10-01T00:00:00+08:00','2026-12-01T00:00:00+08:00')]);
 const model=arenaCalendar(c,{now});assert.equal(model.month,'2026-10');assert.equal(model.cells.length,35);
 assert.equal(model.cells[0].key,'2026-09-28');assert.equal(model.selected.key,'2026-10-30');
 assert.equal(model.previous,null);assert.equal(model.next,'2026-11');
});
test('a single prepublished interval covers many dates without generating rotations',()=>{
 const r=row('month','2026-10-01T03:00:00+08:00','2026-12-01T00:00:00+08:00'),c=context([r]);
 const saved=structuredClone(c),model=arenaCalendar(c,{now,month:'2026-11',day:'2026-11-20'});
 assert.equal(model.selected.primary.id,'month');assert.equal(model.selected.gap,false);assert.deepEqual(model.selected.rows,[r]);
 assert.deepEqual(c,saved);assert.equal(model.previous,'2026-10');assert.equal(model.next,null);
});
test('adjacent daily intervals show the new effective period, with exact exclusive ends',()=>{
 const c=context([row('old','2026-10-29T03:00:00+08:00','2026-10-30T03:00:00+08:00'),row('next','2026-10-30T03:00:00+08:00','2026-10-31T03:00:00+08:00')]);
 const model=arenaCalendar(c,{now});assert.equal(model.selected.primary.id,'next');assert.equal(model.selected.rows.length,1);
 assert.equal(model.selected.gap,false);assert.equal(model.selected.conflict,false);
 const end=model.cells.find(c=>c.key==='2026-10-31');assert.equal(end.gap,true);assert.equal(end.primary.id,'next');
 const unknown=arenaCalendar(c,{now,month:'2026-11',day:'2026-11-01'}).selected;
 assert.equal(unknown.primary,null);assert.equal(unknown.gap,true);
});
test('overlapping or incomplete intervals cannot be presented as a complete known day',()=>{
 const c=context([row('a','2026-10-30T00:00:00+08:00','2026-10-31T00:00:00+08:00'),row('b','2026-10-30T08:00:00+08:00','2026-10-30T18:00:00+08:00')]);
 const model=arenaCalendar(c,{now});assert.equal(model.selected.conflict,true);assert.equal(model.selected.primary,null);
 c.schedule=[row('gap','2026-10-30T03:00:00+08:00','2026-10-31T00:00:00+08:00')];
 assert.equal(arenaCalendar(c,{now}).selected.gap,true);
});
test('calendar honors season limits, leap days, history and invalid URL dates',()=>{
 const r=row('a','2028-02-01T00:00:00+08:00','2028-03-01T00:00:00+08:00'),c=context([r],r.validFrom,r.validUntil);
 const model=arenaCalendar(c,{now,day:'2028-02-29'});assert.equal(model.selected.key,'2028-02-29');
 assert.equal(model.cells.filter(c=>c.inMonth&&c.inSeason).length,29);
 assert.equal(model.previous,null);assert.equal(model.next,null);
 assert.notEqual(arenaCalendar(c,{now,day:'2028-02-31'}).selected.key,'2028-02-31');
 assert.equal(arenaCalendar({...c,schedule:[]},{now}),null);
 assert.equal(arenaCalendar({season:{}},{now}),null);
});
test('weeks entirely outside a partial season are omitted without hiding gaps inside it',()=>{
 const r=row('a','2026-10-27T23:00:00+08:00','2026-11-01T00:00:00+08:00');
 const c=context([r],r.validFrom,'2026-11-29T00:00:00+08:00');
 const october=arenaCalendar(c,{now});assert.equal(october.cells.length,7);
 const november=arenaCalendar(c,{now,month:'2026-11'});assert.equal(november.cells.length,35);
 assert.equal(november.cells.find(d=>d.key==='2026-11-20').gap,true);
 assert.equal(arenaCalendar(c,{now,day:'2026-02-31'}).invalidDay,true);
 assert.equal(arenaCalendar(c,{now,day:'2026-10-01'}).outsideSeason,true);
});

test('compact weeks span months, preserve selected dates and stop at season boundaries',()=>{
 const r=row('a','2026-10-27T23:00:00+08:00','2026-11-29T03:00:00+08:00'),c=context([r],r.validFrom,r.validUntil);
 const week=arenaCalendarWeek(c,arenaCalendar(c,{now}));
 assert.equal(week.cells.length,7);assert.equal(week.cells.at(-1).key,'2026-11-01');
 assert.equal(week.previous,null);assert.equal(week.next,'2026-11-02');
 const next=arenaCalendarWeek(c,arenaCalendar(c,{now,day:week.next}));
 assert.equal(next.previous,'2026-10-27');assert.equal(next.cells[0].key,'2026-11-02');
 const end=arenaCalendarWeek(c,arenaCalendar(c,{now,day:'2026-11-29'}));assert.equal(end.next,null);
});
