import test from 'node:test';
import assert from 'node:assert/strict';
import {eventSongCandidates,eventSongYield,sortEventSongs,estimateEventSong,eventRewardForScore} from '../src/lib/event-song-ranking.mjs';
import {summarizeScoreDistribution} from '../src/lib/scoring-rules/score-distribution.mjs';

test('expected event rewards cross thresholds before averaging, including integer reward rounding',()=>{
 const model={rewards:({scoreRank,mode='ordinary',liveBoost=2})=>({scoreRank,mode,liveBoost,eventId:17,
   badges:Math.floor((scoreRank===2?3:10)*1.5),eventPoints:scoreRank===2?2:6,challengePoints:0})};
 const result={scoreBasis:'expectedScore',scoreRank:3,thresholds:[{rank:2,score:0},{rank:3,score:100}],scoreDistribution:summarizeScoreDistribution([99,101])};
 const reward=eventRewardForScore(model,result,{liveBoost:2});
 assert.equal(reward.badges,9.5); // (floor(3*1.5) + floor(10*1.5)) / 2, not 15.
 assert.equal(reward.eventPoints,4);assert.equal(reward.eventId,17);assert.equal(reward.liveBoost,2);
 assert.equal(reward.scoreRank,null);assert.equal(reward.rewardBasis,'order_expectation');
 assert.equal(eventSongYield(reward).badges,4.75);
 assert.equal(eventRewardForScore(model,{...result,scoreBasis:'minimumScore',scoreRank:2},{}).badges,4);
 assert.equal(eventRewardForScore(model,{...result,scoreBasis:'maximumScore'},{}).badges,15);
 const missing={...result,scoreDistribution:undefined};assert.throws(()=>eventRewardForScore(model,missing,{}),/完整/);
 assert.throws(()=>eventRewardForScore(model,{...result,scoreDistribution:{...result.scoreDistribution,complete:false}},{}),/完整/);
 const boundary={...result,scoreDistribution:summarizeScoreDistribution([100,100])};
 assert.equal(eventRewardForScore(model,boundary,{mode:'challenge'}).badges,15);
});

test('ranking uses each currency separately and breaks equal yields by song length',()=>{
 const rows=[
  {id:'long',seconds:120,level:20,yield:{badges:100,eventPoints:90,challengePoints:50}},
  {id:'short',seconds:90,level:25,yield:{badges:100,eventPoints:90,challengePoints:30}},
  {id:'points',seconds:100,level:20,yield:{badges:80,eventPoints:100,challengePoints:25}},
 ];
 assert.deepEqual(sortEventSongs(rows,'badges').map(r=>r.id),['short','long','points']);
 assert.equal(sortEventSongs(rows,'eventPoints')[0].id,'points');
 assert.equal(sortEventSongs(rows,'challengePoints')[0].id,'long');
 assert.equal(sortEventSongs(rows)[0].id,'short');
});
test('per-fire and per-challenge-point comparison keep zero fire undefined',()=>{
 const reward={mode:'ordinary',liveBoost:2,badges:101,eventPoints:55,challengePoints:30};
 assert.deepEqual(eventSongYield(reward),{badges:50.5,eventPoints:27.5,challengePoints:15});
 assert.deepEqual(eventSongYield({...reward,liveBoost:0}),{badges:null,eventPoints:null,challengePoints:null});
 assert.deepEqual(eventSongYield({...reward,mode:'challenge',challengeCost:200,challengePoints:0}),{badges:.505,eventPoints:.275,challengePoints:0});
});
test('short list respects playable charts, event songs, difficulty and level; duration covers every chart',()=>{
 const tracks=[{id:'a',title:'A',audioDuration:80},{id:'b',title:'B',audioDuration:0}];
 const charts=[{id:'a-e',trackId:'a',difficulty:'expert',level:25,duration:70,analysisDataUrl:'/a'},
  {id:'a-h',trackId:'a',difficulty:'hard',level:16,duration:90,analysisDataUrl:'/h'},
  {id:'b-e',trackId:'b',difficulty:'expert',level:20,duration:0,analysisDataUrl:'/b'},
  {id:'missing',trackId:'b',difficulty:'expert',level:22}];
 const rows=eventSongCandidates({tracks,charts,allowedTrackIds:['a'],maxLevel:30});
 assert.equal(rows.length,1);assert.equal(rows[0].seconds,90);
 assert.equal(eventSongCandidates({tracks,charts,allowedTrackIds:['a'],maxLevel:20}).length,0);
 assert.equal(eventSongCandidates({tracks,charts,difficulty:'all'}).length,3);
 assert.equal(sortEventSongs(eventSongCandidates({tracks,charts}))[0].trackId,'a');
});
test('never infer a gekisou room grade from solo score',()=>{
 assert.throws(()=>estimateEventSong({options:{mode:'gekisou'}}),/团队结算评分/);
});

test('song candidates intersect band and song attribute with difficulty and level filters',()=>{
 const tracks=[{id:'a',bandIds:['band-1'],musicType:1},{id:'b',bandIds:['band-2','band-1'],musicType:2},
  {id:'c',bandIds:['band-2'],musicType:1},{id:'unknown'}];
 const charts=tracks.flatMap(t=>['expert','hard'].map(difficulty=>({id:`${t.id}-${difficulty}`,trackId:t.id,difficulty,level:difficulty==='expert'?25:15,analysisDataUrl:'/chart'})));
 const ids=filters=>eventSongCandidates({tracks,charts,...filters}).map(c=>c.id);
 assert.deepEqual(ids({band:'band-1'}),['a-expert','b-expert']);
 assert.deepEqual(ids({attribute:'1'}),['a-expert','c-expert']);
 assert.deepEqual(ids({band:'band-1',attribute:'2'}),['b-expert']);
 assert.deepEqual(ids({band:'band-1',attribute:'1',difficulty:'all',maxLevel:20}),['a-hard']);
 assert.deepEqual(ids({band:'band-1',attribute:'1',allowedTrackIds:['c']}),[]);
 assert.deepEqual(ids({band:'band-1',attribute:'5'}),[]);
 assert.deepEqual(ids({band:'',attribute:''}),['a-expert','b-expert','c-expert','unknown-expert']);
});
