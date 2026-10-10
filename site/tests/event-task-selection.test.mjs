import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventTaskSelection,defaultEventId} from '../src/lib/event-task-selection.mjs';
test('entry selects newest challenge event by schedule and preserves explicit valid links',()=>{
 const events=[{_id:99,_eventType:1,_startAt:'2026/09/01 18:00:00'},{_id:3,_eventType:1,_startAt:'2026/10/10 18:00:00'},{_id:4,_eventType:2,_startAt:'2026/11/01 18:00:00'}];
 assert.equal(defaultEventId(events,null),'3');
 assert.equal(defaultEventId(events,'99'),'99');
 assert.equal(defaultEventId(events,'404'),'3');
 assert.equal(defaultEventId([],null),null);
 assert.equal(defaultEventId([{_id:1,_eventType:1},{_id:2,_eventType:1}],null),'2');
});
const empty={selectedSongId:null,selectedDifficulty:null,mode:'ordinary',songScope:'all'};
test('rush song never changes the automatic yield filters or phase',()=>{
 const state=createEventTaskSelection('team',empty),rush=state.switchTo('challenge',empty);
 assert.equal(rush.selectedSongId,null);assert.equal(rush.mode,'challenge');
 const result=state.switchTo('team',{...rush,selectedSongId:'music-rush',selectedDifficulty:'expert'});
 assert.deepEqual(result,empty);
 assert.equal(state.switchTo('challenge',result).selectedSongId,'music-rush');
});
test('specified yield chart survives rush and quick task changes',()=>{
 const selected={...empty,selectedSongId:'music-normal',selectedDifficulty:'hard',songScope:'selected'};
 const state=createEventTaskSelection('team',selected),rush=state.switchTo('challenge',selected);
 const quick=state.switchTo('quick',{...rush,selectedSongId:'music-rush',selectedDifficulty:'expert'});
 assert.deepEqual(state.switchTo('team',quick),selected);
});
test('a direct rush link seeds only the rush task',()=>{
 const initial={...empty,mode:'challenge',selectedSongId:'music-rush',selectedDifficulty:'expert'};
 assert.deepEqual(createEventTaskSelection('challenge',initial).switchTo('team',initial),empty);
});

test('ordinary song scope and selected chart survive switching to direct challenge songs',async()=>{
 const {createEventPhaseSelection}=await import('../src/lib/event-task-selection.mjs');
 const initial={...empty,selectedSongId:'music-normal',selectedDifficulty:'hard',songScope:'selected'},state=createEventPhaseSelection(initial);
 const challenge=state.switchTo('challenge',{...initial,mode:'challenge'});
 assert.equal(challenge.songScope,'selected');assert.equal(challenge.selectedSongId,null);
 const selected={...challenge,selectedSongId:'music-event',selectedDifficulty:'expert'};state.capture(selected);
 assert.deepEqual(state.switchTo('ordinary',{...selected,mode:'ordinary'}),initial);
 assert.deepEqual(state.switchTo('challenge',{...initial,mode:'challenge'}),selected);
});
test('automatic ordinary range stays automatic after using a challenge chart or applying a challenge plan',async()=>{
 const {createEventPhaseSelection}=await import('../src/lib/event-task-selection.mjs');
 const state=createEventPhaseSelection(empty);
 state.capture({mode:'challenge',songScope:'all',selectedSongId:'music-event',selectedDifficulty:'hard'});
 assert.deepEqual(state.switchTo('ordinary',{mode:'ordinary',songScope:'selected',selectedSongId:'music-event',selectedDifficulty:'hard'}),empty);
});
