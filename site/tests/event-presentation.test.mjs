import test from 'node:test';
import assert from 'node:assert/strict';
import {eventPresentationState} from '../src/lib/event-presentation.mjs';

test('event view distinguishes ready, live partials, final results and no matches',()=>{
 assert.equal(eventPresentationState(),'setup');
 assert.equal(eventPresentationState({running:true,hasResults:true}),'running');
 assert.equal(eventPresentationState({hasResults:true,feedbackState:'complete'}),'results');
 assert.equal(eventPresentationState({feedbackState:'complete'}),'empty');
});
test('errors and stopped searches retain their state even when partial results exist',()=>{
 for(const feedbackState of ['error','stopped'])for(const hasResults of [true,false])assert.equal(eventPresentationState({feedbackState,hasResults}),feedbackState);
 assert.equal(eventPresentationState({quick:true,running:true,feedbackState:'error'}),'quick');
});
