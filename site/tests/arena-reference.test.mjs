import test from 'node:test';
import assert from 'node:assert/strict';
import {arenaRankGroups} from '../src/lib/arena-reference.mjs';
import {arenaFixture} from './fixtures/arena.mjs';
test('only genuinely matching band rank tables become a shared reference',()=>{
 const data=arenaFixture();data.ranks.push(...data.ranks.map(row=>({...row,id:row.id+'other',bandId:'2'})));
 const saved=structuredClone(data);assert.equal(arenaRankGroups(data).length,1);assert.equal(arenaRankGroups(data)[0].bands.length,2);assert.deepEqual(data,saved);
 data.ranks.at(-1).threshold++;assert.equal(arenaRankGroups(data).length,2);
 data.ranks.at(-1).threshold--;data.ranks.at(-1).opensAt='2026-11-01T00:00:00Z';assert.equal(arenaRankGroups(data).length,2);
 data.capabilities.ranks=false;assert.deepEqual(arenaRankGroups(data),[]);
});
