import test from 'node:test';
import assert from 'node:assert/strict';
import {arenaContext,arenaIdentity,arenaParams,baseAP,validateArena} from '../src/lib/arena-context.mjs';
import {arenaFixture,arenaNow as now} from './fixtures/arena.mjs';
const resolve=(data,query='',opts={})=>arenaContext(data,query,{now,...opts});
test('edition, server, IDs and optional old snapshots fail closed',()=>{
 const d=arenaFixture();assert.equal(resolve(null).status,'missing');
 assert.throws(()=>validateArena(d,{region:'jp',sourceReleaseId:d.sourceReleaseId}));
 assert.equal(resolve(d,'server=jp').status,'invalid-server');assert.equal(resolve(d,'server=global-en').entryReady,false);
 assert.equal(resolve(d,'season=unknown').status,'unknown-season');assert.equal(resolve(d,'band=unknown').status,'unknown-band');
 assert.equal(resolve(d,'regulation=unknown').status,'unknown-regulation');assert.equal(resolve(d,'view=bad').status,'invalid-view');
 assert.equal(resolve(d,'',{requireBand:true}).status,'select-band');
 assert.equal(resolve(d,'server=global-hmt').entryReady,true);assert.equal(resolve(d).entryReady,false);
});
test('league maps to band, 0 and 99 survive without song-dependent guesses',()=>{
 const d=arenaFixture();const c=resolve(d,'band=2');assert.equal(c.league.id,'l9');assert.deepEqual(c.condition.missions,[3,0,1]);
 assert.equal(resolve(d).condition.attribute,99);assert.equal(resolve(d,'regulation=r0').condition.attribute,0);
 assert.equal(resolve(d,'regulation=r0').status,'history');assert.equal(resolve(d,'regulation=r2').status,'preview');
});
test('half-open boundaries, identical adjacent values, overlap, missing successor and season intersection',()=>{
 const d=arenaFixture(),end=Date.parse(d.regulations[1].validUntil);
 assert.equal(resolve(d,'',{now:end-1}).condition.id,'r1');assert.equal(resolve(d,'',{now:end}).condition.id,'r2');
 assert.notEqual(arenaIdentity(d,resolve(d,'',{now:end-1})),arenaIdentity(d,resolve(d,'',{now:end})));
 assert.equal(resolve(d,'',{now:Date.parse('2026-10-31T00:00:00Z')}).status,'no-condition');
 assert.equal(resolve(d,'',{now:Date.parse('2026-11-01T00:00:00Z')}).season.id,'s2');
 d.regulations.push({...d.regulations[1],id:'conflict'});assert.equal(resolve(d).status,'condition-conflict');
 d.regulations.pop();d.seasons[0].validUntil='2026-10-28T05:00:00Z';assert.equal(resolve(d).condition.validUntil,'2026-10-28T05:00:00.000Z');
 d.seasons.push({...d.seasons[0],id:'overlap'});assert.equal(resolve(d).status,'season-conflict');
});
test('unverified time is queryable but never a current handoff; local capabilities stay independent',()=>{
 const d=arenaFixture();d.capabilities.conditions=false;
 assert.equal(resolve(d,'season=s1').status,'unverified');assert.deepEqual(resolve(d,'season=s1').schedule,[]);assert.equal(resolve(d,'season=s1').entryReady,false);
 assert.equal(baseAP(d,1,5).at(-1).points,-40);
 d.basePoints.pop();assert.equal(baseAP(d,1,5),null);assert.equal(baseAP(d,2,5),null);
});
test('pinned links and context identity follow content revisions without trusting URL conditions',()=>{
 const d=arenaFixture(),c=resolve(d,'server=global-hmt&attribute=1&missions=3');
 assert.equal(c.condition.attribute,99);const p=arenaParams(c,{pin:true});
 assert.equal(p.get('season'),'s1');assert.equal(p.get('regulation'),'r1');assert.equal(p.has('attribute'),false);
 const previous=arenaIdentity(d,c);d.sourceRevision='b'.repeat(64);assert.notEqual(arenaIdentity(d,c),previous);
});

test('malformed display capabilities and unsupported time adapters are rejected',()=>{
 const d=arenaFixture(),identity={region:'global',sourceReleaseId:d.sourceReleaseId};
 d.timeSemanticsVersion='unknown';assert.throws(()=>validateArena(d,identity));
 d.timeSemanticsVersion='inclusive-second-v1';d.rewards[0].items[0].count=-1;assert.throws(()=>validateArena(d,identity));
});

test('default band selection rejects duplicate league mappings and unknown opening constraints',()=>{
 const d=arenaFixture();d.leagues.push({...d.leagues[0],id:'other-league'});
 assert.equal(resolve(d).status,'league-conflict');d.leagues.pop();delete d.leagues[0].openingSourceText;
 assert.equal(resolve(d).status,'unverified-opening');assert.equal(resolve(d).entryReady,false);
});

test('03:00 Beijing activates a new official interval even with identical types; absent successors never carry over',()=>{
 const d=arenaFixture(),boundary=Date.parse('2026-10-28T19:00:00Z');
 d.regulations[1].validUntil=new Date(boundary).toISOString();
 d.regulations[2].validFrom=new Date(boundary).toISOString();
 const before=resolve(d,'server=global-hmt',{now:boundary-1});
 const after=resolve(d,'server=global-hmt',{now:boundary});
 assert.deepEqual(before.condition.missions,after.condition.missions);
 assert.notEqual(arenaIdentity(d,before),arenaIdentity(d,after));
 d.regulations.splice(2,1);
 const missing=resolve(d,'server=global-hmt',{now:boundary});
 assert.equal(missing.status,'no-condition');assert.equal(missing.current,null);assert.equal(missing.condition,null);assert.equal(missing.entryReady,false);
});
test('published activity-boundary attributes switch only on explicit configured intervals',()=>{
 const d=arenaFixture(),boundary=Date.parse('2026-10-28T04:00:00Z');
 d.activityPeriods=[{id:'e1',validFrom:new Date(boundary).toISOString(),validUntil:'2026-10-31T04:00:00Z'}];
 d.regulations[1].validUntil=new Date(boundary).toISOString();
 d.regulations[2].validFrom=new Date(boundary).toISOString();d.regulations[2].attribute=1;
 assert.equal(resolve(d,'',{now:boundary-1}).condition.attribute,99);
 assert.equal(resolve(d,'',{now:boundary}).condition.attribute,1);
 d.regulations.splice(2,1);assert.equal(resolve(d,'',{now:boundary}).status,'no-condition');
 d.activityPeriods[0].validFrom='2026/10/28 12:00:00';assert.throws(()=>validateArena(d,{region:'global',sourceReleaseId:d.sourceReleaseId}));
});
