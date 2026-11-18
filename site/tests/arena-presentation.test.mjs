import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveArenaCondition} from '../src/lib/arena-presentation.mjs';
test('a song resolves delegated mission slots and attribute without changing official identity',()=>{
 const condition={attribute:0,missions:[1,0,3]},saved=structuredClone(condition);
 const result=resolveArenaCondition(condition,{id:'song',attribute:2,missions:[2,3,1]});
 assert.deepEqual(result,{attribute:2,missions:[1,3,3],songDependent:true,songId:'song',resolved:true});
 assert.deepEqual(condition,saved);
});
test('fixed three types require no song; unknown song types are never invented',()=>{
 assert.deepEqual(resolveArenaCondition({attribute:99,missions:[1,2,3]}).missions,[1,2,3]);
 const result=resolveArenaCondition({attribute:0,missions:[0,2,3]});
 assert.equal(result.resolved,false);assert.equal(result.attribute,null);assert.equal(result.missions[0],null);
 assert.equal(resolveArenaCondition(null),null);
});
