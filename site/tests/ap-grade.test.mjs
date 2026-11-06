import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {applyAPBasis,estimateAPChart,eventToolSearch,withAPScoreThresholds,scoreThresholds} from '../src/lib/ap-grade.mjs';
import {parseTeamDraftSearch,createTeamDraft} from '../src/lib/team-draft.mjs';
import {createCalculationScheduler} from '../src/lib/calculation-scheduler.mjs';

test('AP basis and next-grade gap use score thresholds, including exact crossing',()=>{
 const row={minimumScore:99,expectedScore:100,maximumScore:120,thresholds:[{rank:2,score:0},{rank:3,score:100},{rank:4,score:200}]};
 assert.equal(applyAPBasis(row).scoreRank,3);assert.equal(applyAPBasis(row).minimumRank,2);
 assert.equal(applyAPBasis(row).nextRankGap,100);assert.equal(applyAPBasis(row,'minimumScore').nextRankGap,1);
 assert.throws(()=>applyAPBasis(row,'manual'));assert.equal(row.scoreRank,undefined);
});
test('AP forecast works without events and retains full skill-order scoring',()=>{
 const rules=JSON.parse(readFileSync(new URL('../src/data/formal-scoring-rules.json',import.meta.url)));
 const chart=JSON.parse(readFileSync(new URL('../public/data/music-charts/music-chart-10003803.json',import.meta.url)));chart.sourceReleaseId=rules.sourceReleaseId;
 const music=rules.tables.LiveMusic.find(m=>`music-${m._id}`===chart.trackId);music._liveScoreRankGroup=999;
 rules.tables.LiveScoreRank=[2,3,4,5,6,7].map((rank,i)=>({_group:999,_liveScoreRank:rank,_requiredScore:i*1000000}));
 delete rules.tables.Event;
 const draft=createTeamDraft({slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`}))});
 const original=structuredClone(draft),candidate={id:chart.id,trackId:chart.trackId,difficulty:chart.difficulty};
 const r=estimateAPChart({rules,draft,chart,candidate});
 assert.equal(r.orderCount,120);assert.equal(r.thresholds.length,6);assert.ok(r.minimumScore<=r.expectedScore&&r.expectedScore<=r.maximumScore);
 assert.equal(r.scoreDistribution.count,120);assert.equal(r.scoreDistribution.complete,true);
 assert.equal(r.gradeProbabilities.reduce((sum,g)=>sum+g.count,0),120);
 assert.equal(r.scoreDistribution.minimum,r.minimumScore);assert.equal(r.scoreDistribution.maximum,r.maximumScore);
 assert.ok(Math.abs(r.scoreDistribution.mean-r.expectedScore)<1e-8);
 assert.deepEqual(draft,original);assert.throws(()=>estimateAPChart({rules,draft,chart,candidate,mode:'gekisou'}),/团队/);
 const query=eventToolSearch({...draft,selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty},{mode:'challenge',eventId:1,scoreRank:r.scoreRank,basis:'minimumScore',boost:3,cost:800});
 const linked=parseTeamDraftSearch(query).draft,params=new URLSearchParams(query);
 assert.deepEqual(linked.slots,draft.slots);assert.equal(linked.selectedSongId,chart.trackId);
 assert.equal(params.get('eventMode'),'challenge');assert.equal(params.get('cost'),'800');assert.equal(params.get('apBasis'),'minimumScore');
});
test('eco scheduler rests between CPU slices and shares overlapping pauses',async()=>{
 let time=0,finish;const sleeps=[];
 const scheduler=createCalculationScheduler({eco:true,now:()=>time,sleep:ms=>{sleeps.push(ms);return new Promise(r=>finish=r);}});
 await scheduler();assert.deepEqual(sleeps,[]);time=20;
 const a=scheduler(),b=scheduler();assert.deepEqual(sleeps,[40]);finish();await Promise.all([a,b]);
 time=25;await scheduler();assert.deepEqual(sleeps,[40]);
});


test('older artifacts can read catalog grade thresholds without altering scoring tables',()=>{
 const rules={tables:{LiveMusic:[{_id:1,_liveScoreRankGroup:7}],LiveSettings:[{_key:'preserve',_value:123}]}};
 const ranks=[2,3,4,5,6,7].map((rank,i)=>({rank,requiredScore:i*1000}));
 const supplemented=withAPScoreThresholds(rules,[{id:'music-1',soloRewards:{scoreRanks:ranks}}]);
 assert.deepEqual(scoreThresholds(supplemented,1),ranks.map(r=>({rank:r.rank,score:r.requiredScore})));
 assert.equal(supplemented.tables.LiveSettings,rules.tables.LiveSettings);assert.equal(rules.tables.LiveScoreRank,undefined);
 assert.throws(()=>scoreThresholds(rules,1),/分数线/);
});
