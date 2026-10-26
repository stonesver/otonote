import test from 'node:test';
import assert from 'node:assert/strict';
import {teamWorkbenchState} from '../src/lib/team-workbench-view.mjs';

test('setup, in-flight work and completed recommendations have distinct states',()=>{
  assert.equal(teamWorkbenchState(), 'setup');
  assert.equal(teamWorkbenchState({running:true,hasResults:true},'running'),'running');
  assert.equal(teamWorkbenchState({finished:true,hasResults:true},'complete'),'results');
  assert.equal(teamWorkbenchState({finished:true,hasResults:false},'complete'),'empty');
});
test('cancellation and failure never present partial candidates as completed work',()=>{
  for(const hasResults of [false,true]) {
    assert.equal(teamWorkbenchState({finished:true,hasResults},'stopped'),'stopped');
    assert.equal(teamWorkbenchState({finished:true,hasResults},'error'),'error');
  }
  assert.equal(teamWorkbenchState({running:true},'stopped'),'running');
});
test('comparison stays accessible during calculation and restores the optimizer state on return',()=>{
  const state={running:true,hasResults:true};
  assert.equal(teamWorkbenchState(state,'running',true),'compare');
  assert.equal(teamWorkbenchState(state,'running',false),'running');
  assert.equal(teamWorkbenchState({},'idle',false),'setup');
});
