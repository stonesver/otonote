import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeObservations,numericValue,regions} from '../web/model.mjs';

const catalog={region:'test',sourceReleaseId:'synthetic-release',cards:[{id:'member-card-1',kind:'member',name:'合成角色'},{id:'support-card-1',kind:'support',name:'合成留影'}]};
const row=(key,observations,extra={})=>({key,kind:'member',cardId:'member-card-1',selected:true,observations,...extra});

test('two screenshot modes merge observations without inventing skills or rewriting field semantics',()=>{
  const input=[row('training',{training:4,awakeningStars:1}),row('level',{level:80,awakeningStars:1})];
  const draft=mergeObservations(input,catalog);
  assert.deepEqual(draft.cards[0].observations,{training:4,awakeningStars:1,level:80});
  assert.equal(draft.cards.length,1);assert.deepEqual(draft.conflicts,[]);
  assert.equal('skillLevel' in draft.cards[0].observations,false);
  assert.equal('awake' in draft.cards[0].observations,false);
  assert.deepEqual(input[0].observations,{training:4,awakeningStars:1});
});
test('conflicting screenshots must be reviewed; unknown IDs are never silently accepted',()=>{
  const draft=mergeObservations([row('a',{level:80}),row('b',{level:70})],catalog);
  assert.deepEqual(draft.conflicts,[{id:'member-card-1',field:'level',values:[80,70]}]);
  assert.throws(()=>mergeObservations([row('x',{}, {cardId:'member-card-999'})],catalog));
});
test('unmatched, unchecked and missing values cannot erase known growth',()=>{
  const draft=mergeObservations([row('a',{level:70}),row('b',{level:null}),row('unknown',{level:80},{cardId:'',selected:false}),row('unchecked',{level:90},{selected:false})],catalog);
  assert.deepEqual(draft.cards[0].observations,{level:70});assert.deepEqual(draft.excluded,['unknown','unchecked']);
});
test('ambiguous OCR and illegal manual edits are rejected',()=>{
  assert.equal(numericValue('l','support',90),null);assert.equal(numericValue('80','member-level',20),null);
  assert.equal(numericValue('6','member-training',90),null);assert.equal(numericValue('1','support',90),1);
  assert.throws(()=>mergeObservations([row('a',{training:6})],catalog));
  assert.throws(()=>mergeObservations([row('a',{level:NaN})],catalog));
});
test('complete rows only, scaled samples and unsupported aspect ratios',()=>{
  assert.equal(regions(1280,905,'member-level').length,18);
  assert.equal(regions(1280,905,'support').length,20);
  assert.equal(regions(960,679,'support').length,20);
  assert.throws(()=>regions(900,1280,'member-level'));
});
