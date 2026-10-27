import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCalculationScope,requireCalculationScope,chartKey,selectedChartScope} from '../src/lib/calculation-scope.mjs';
import {eventSongCandidates} from '../src/lib/event-song-ranking.mjs';
import {planEventSearch} from '../src/lib/event-search-plan.mjs';
import {recommendedPlaylists} from '../src/lib/recommended-playlists.mjs';
const tracks=Array.from({length:12},(_,i)=>({id:`music-${i+1}`,title:`歌 ${i+1}`,audioDuration:60+i,bandIds:['band-1'],musicType:i%3+1}));
const charts=tracks.flatMap((t,i)=>['hard','expert'].map((difficulty,j)=>({id:`${t.id}-${difficulty}`,trackId:t.id,difficulty,level:15+j*10,analysisDataUrl:`/${t.id}-${difficulty}.json`})));
const data={tracks,charts,sourceReleaseId:'fixture'};
const playlist={id:'one',name:'常打',revision:1,entries:[{trackId:'music-1',difficulties:['hard','expert']},{trackId:'music-2',difficulties:'all'},{trackId:'music-999',difficulties:['expert']}]};
const resolve=options=>resolveCalculationScope({...data,selection:{kind:'playlist',id:'one'},playlists:[playlist],...options});
test('intersects playlist, event and difficulty and explains every exclusion',()=>{
 const r=resolve({allowedTrackIds:['music-1'],difficulty:['hard']});assert.equal(r.songCount,1);assert.equal(r.chartCount,1);assert.equal(r.requestedSongCount,3);
 assert.deepEqual(r.excluded.map(e=>e.reason).sort(),['difficulty','event','event','missing_song']);
 assert.equal(r.dataIncomplete,true);
});
test('empty and deleted playlists never fall back to all charts',()=>{
 assert.throws(()=>requireCalculationScope(resolve({allowedTrackIds:[]})),/范围为空/);
 assert.throws(()=>resolve({playlists:[]}),/不存在/);
 assert.throws(()=>requireCalculationScope(resolve({selection:{kind:'temporary',entries:[]}})),/范围为空/);
});
test('temporary additions still obey hard event and page restrictions',()=>{
 const r=resolve({selection:{kind:'playlist',id:'one',entries:[{trackId:'music-3',difficulties:'all'}]},allowedTrackIds:['music-1']});assert.equal(r.chartCount,0);assert.equal(r.adjusted,true);
});
test('missing difficulty and data are visible, and later added all difficulties resolve dynamically',()=>{
 const p={...playlist,entries:[{trackId:'music-1',difficulties:['future']},{trackId:'music-2',difficulties:'all'}]};
 const r=resolve({playlists:[p],charts:charts.map(c=>c.trackId==='music-2'?{...c,analysisDataUrl:null}:c)});assert.equal(r.chartCount,0);assert.deepEqual(r.excluded.map(e=>e.reason),['missing_difficulty','data','data']);
 const more=resolve({charts:[...charts,{...charts[0],id:'future',difficulty:'future',trackId:'music-2'}]});assert.equal(more.chartCount,5);
});
test('all-available remains identical to existing candidate filters',()=>{
 for(const options of [{},{difficulty:['hard'],maxLevel:20},{allowedTrackIds:[]},{attribute:['2']},{band:'unknown'}]){
  const r=resolveCalculationScope({...data,selection:{kind:'all'},difficulty:'expert',...options});
  assert.deepEqual(r.candidates,eventSongCandidates({...data,difficulty:'expert',...options}));
 }
});
test('fingerprint follows membership and context, not playlist name or order',()=>{
 const a=resolve();assert.equal(a.fingerprint,resolve({playlists:[{...playlist,name:'改名',revision:2,entries:[...playlist.entries].reverse()}]}).fingerprint);
 assert.notEqual(a.fingerprint,resolve({difficulty:'hard'}).fingerprint);assert.notEqual(a.fingerprint,resolve({sourceReleaseId:'new'}).fingerprint);
});
test('quick plan cannot escape chosen playlist and full preserves every eligible chart',()=>{
 const r=resolveCalculationScope({...data,selection:{kind:'all'}}),rules={tables:{LiveMusic:tracks.map((t,i)=>({_id:i+1,_musicType:t.musicType}))}};
 const plan=planEventSearch(r.candidates,rules,{selectedSongId:'music-999',selectedDifficulty:'expert'});
 assert.equal(plan.quick.length,6);assert.deepEqual(new Set(plan.full.map(chartKey)),new Set(r.candidates.map(chartKey)));assert.ok(plan.quick.every(c=>r.candidates.includes(c)));
});
test('recommendations use deterministic catalog rules, no unavailable charts or score claims',()=>{
 const rec=recommendedPlaylists(data);assert.equal(rec[0].entries.length,10);assert.equal(rec[0].entries.at(-1).trackId,'music-10');assert.ok(rec.every(p=>p.note));
 const empty=recommendedPlaylists({...data,charts:[]});assert.ok(empty.every(p=>p.entries.length===0));
});

test('selected chart snapshots count only actual work and preserve range membership',()=>{
 const scope=resolve();const one=selectedChartScope(scope,{selectedSongId:'music-1',selectedDifficulty:'hard'});
 assert.equal(one.chartCount,1);assert.equal(one.songCount,1);assert.notEqual(one.fingerprint,scope.fingerprint);
 assert.throws(()=>selectedChartScope(scope,{selectedSongId:'music-12',selectedDifficulty:'hard'}),/不在计算范围/);
});

test('fixed tool pools ignore remembered playlists but retain event and difficulty constraints',()=>{
 for(const selection of [{kind:'temporary',entries:[]},{kind:'playlist',id:'deleted'}]){
  const fixed=resolveCalculationScope({...data,selection,fixedRangeTitle:'本期挑战曲池',allowedTrackIds:['music-2'],difficulty:'hard'});
  assert.equal(fixed.source.kind,'fixed');assert.equal(fixed.title,'本期挑战曲池');assert.equal(fixed.chartCount,1);assert.equal(fixed.candidates[0].trackId,'music-2');
  assert.equal(fixed.adjusted,false);
  assert.throws(()=>requireCalculationScope(resolveCalculationScope({...data,selection,fixedRangeTitle:'本期挑战曲池',allowedTrackIds:[]})),/固定曲目范围为空/);
 }
});
