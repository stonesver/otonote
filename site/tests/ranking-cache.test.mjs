import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm, readdir, cp, appendFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {loadSongRankingData} from '../../packages/scoring/server/song-ranking-data.mjs';
import {calculateRankingRow, SONG_RANKING_BENCHMARK} from '../../packages/scoring/song-ranking.mjs';
import {prepareFormalChart} from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import {algorithmFingerprint, rankingContext, rowCacheKey, cachedRankingRow, dataDigest, readCache, writeCache} from '../../packages/scoring/server/ranking-row-cache.mjs';
const sourceRoot = fileURLToPath(new URL('../../packages/scoring/', import.meta.url));
const rules = JSON.parse(await readFile(join(sourceRoot, 'data/formal-scoring-rules.json')));
const chart = {id:'music-chart-10000103',trackId:'music-100001',difficulty:'expert',sourceReleaseId:rules.sourceReleaseId,
  duration:45,bpmEvents:[{tick:0,bpm:120}],skillTimings:[0,10,20,30,40],
  notes:[{id:'tap-0',type:'tap',tick:480}],feverRanges:[{start:1,end:5},{start:11,end:15},{start:21,end:25}]};
const track = {id:chart.trackId,title:'中文',bandIds:['band-1'],bandLabels:['中文乐队'],musicTypeLabel:'属性',audioDuration:45};
const benchmark = SONG_RANKING_BENCHMARK;
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'ranking-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'chart.json'),JSON.stringify(chart));
  return {rules,releaseId:rules.sourceReleaseId,tracks:[track],charts:[{id:chart.id,trackId:chart.trackId,difficulty:chart.difficulty,analysisDataUrl:'/chart.json'}],publicRoot:root,cacheRoot:join(root,'cache')};
}
async function files(root) {
  try {
    return (await Promise.all((await readdir(root,{withFileTypes:true})).map(async e => e.isDirectory() ? files(join(root,e.name)) : [join(root,e.name)]))).flat();
  } catch (error) { if(error.code==='ENOENT') return []; throw error; }
}

test('row keys bind full algorithm, benchmark, rules, identities and numerical chart fields',()=>{
  const context=rankingContext({algorithm:'algorithm-a',benchmark,rules});
  const key=rowCacheKey({context,chart,mode:'ordinary'});
  for(const changed of [{...chart,id:'music-chart-10000102'},{...chart,trackId:'music-100002'},
    {...chart,difficulty:'hard'},{...chart,duration:46},{...chart,notes:[{...chart.notes[0],tick:960}]}]) {
    assert.notEqual(rowCacheKey({context,chart:changed,mode:'ordinary'}),key);
  }
  assert.notEqual(rowCacheKey({context,chart,mode:'gekisou'}),key);
  for(const change of [{algorithm:'b',benchmark,rules},{algorithm:'algorithm-a',benchmark:{...benchmark,power:1},rules},
    {algorithm:'algorithm-a',benchmark,rules:{...rules,native:{...rules.native,difficultyIncrement:0}}},
    {algorithm:'algorithm-a',benchmark,rules:{...rules,tables:{...rules.tables,extra:[1]}}}]) {
    assert.notEqual(rankingContext(change),context);
  }
  assert.equal(rankingContext({algorithm:'algorithm-a',benchmark,rules:{...rules,sourceReleaseId:'next'}}),context);
  assert.equal(rowCacheKey({context,chart:{...chart,sourceReleaseId:'next',analysisDataUrl:'/en/chart',sourcePath:'elsewhere'},mode:'ordinary'}),key);
});

test('row hits rebind current display fields and hash without running score calculation',async t=>{
  const options=await fixture(t), context=rankingContext({algorithm:'test',benchmark,rules});
  let calls=0;
  const input={cacheRoot:options.cacheRoot,context,chart,track,mode:'ordinary',chartHash:prepareFormalChart(rules,chart).chartHash,
    compute:()=>{calls++;return calculateRankingRow({rules,chart,track});}};
  const first=await cachedRankingRow(input);
  const current={...track,title:'English',bandLabels:['English band'],musicTypeLabel:'type',audioDuration:99};
  const second=await cachedRankingRow({...input,chart:{...chart,sourceReleaseId:'next'},track:current,chartHash:'current-chart-hash'});
  assert.equal(calls,1);assert.equal(second.expectedScore,first.expectedScore);assert.equal(second.title,'English');
  assert.deepEqual(second.bandLabels,['English band']);assert.equal(second.attribute,'type');assert.equal(second.audioSeconds,99);
  assert.equal(second.skillReference.chartHash,'current-chart-hash');
});

test('aggregate and row corruption regenerate; completed promises never bypass disk validation',async t=>{
  const input=await fixture(t), expected=clone(await loadSongRankingData(input));
  const aggregate=join(input.cacheRoot,expected.fingerprint+'.json');
  const rows=(await files(join(input.cacheRoot,'rows-v1'))).filter(p=>p.endsWith('.json'));
  assert.equal(rows.length,2);
  const damaged=JSON.parse(await readFile(aggregate));damaged.data.ordinary[0].expectedScore=-1;
  await writeFile(aggregate,JSON.stringify(damaged));
  for(const path of rows) await writeFile(path,'{"truncated":');
  assert.deepEqual(clone(await loadSongRankingData(input)),expected);
  // Even a digest-valid incomplete record is a miss, including legacy plain JSON.
  const incomplete=JSON.parse(await readFile(aggregate));delete incomplete.data.gekisou[0].sampleCount;
  incomplete.sha256=dataDigest(incomplete.data);await writeFile(aggregate,JSON.stringify(incomplete));
  assert.deepEqual(clone(await loadSongRankingData(input)),expected);
  await writeFile(aggregate,JSON.stringify(expected));
  assert.deepEqual(clone(await loadSongRankingData(input)),expected);
  const other={...input,cacheRoot:join(input.publicRoot,'other-cache')};
  assert.deepEqual(clone(await loadSongRankingData(other)),expected);
  assert.ok((await stat(join(other.cacheRoot,expected.fingerprint+'.json'))).isFile());
});

test('locale/release changes reuse row files, but current release and track gates still apply',async t=>{
  const input=await fixture(t), first=await loadSongRankingData(input);
  const before=await files(join(input.cacheRoot,'rows-v1'));
  const releaseId='next-release';
  const nextRules={...rules,sourceReleaseId:releaseId,verificationStatus:'reference_compatible',
    referenceProfile:{dataCompatibility:'scoring_tables_matched',currentGameplayVerified:false,
      sourceReleaseId:rules.native.sourceReleaseId,nativeSha256:rules.nativeSha256}};
  // Same bound rule metadata is needed to isolate a change of release identity.
  await loadSongRankingData({...input,rules:{...nextRules,sourceReleaseId:input.releaseId}});
  const baseline=await files(join(input.cacheRoot,'rows-v1'));
  await writeFile(join(input.publicRoot,'next.json'),JSON.stringify({...chart,sourceReleaseId:releaseId}));
  const next={...input,rules:nextRules,releaseId,tracks:[{...track,title:'English'}],charts:[{...input.charts[0],analysisDataUrl:'/next.json'}]};
  const actual=await loadSongRankingData(next);
  assert.equal((await files(join(input.cacheRoot,'rows-v1'))).length,baseline.length);
  assert.equal(actual.ordinary[0].title,'English');assert.notEqual(actual.ordinary[0].skillReference.chartHash,first.ordinary[0].skillReference.chartHash);
  const cold=await loadSongRankingData({...next,cacheRoot:join(input.publicRoot,'cold')});assert.deepEqual(clone(actual),clone(cold));
  await assert.rejects(loadSongRankingData({...next,releaseId:'wrong'}),/版本/);
  await assert.rejects(loadSongRankingData({...next,tracks:[]}),/歌曲/);
  assert.equal(before.length,2);
});

test('changed chart, native rules and algorithm sources invalidate persistent scores',async t=>{
  const input=await fixture(t);
  const copy=join(input.publicRoot,'source');await cp(sourceRoot,copy,{recursive:true});input.sourceRoot=copy;
  const first=await loadSongRankingData(input);
  await writeFile(join(input.publicRoot,'chart.json'),JSON.stringify({...chart,notes:[...chart.notes,{id:'tap-1',type:'tap',tick:7200}]}));
  const changed=await loadSongRankingData(input);assert.notEqual(changed.ordinary[0].expectedScore,first.ordinary[0].expectedScore);
  assert.equal((await files(join(input.cacheRoot,'rows-v1'))).length,4);
  const changedRules=structuredClone(rules);changedRules.native.difficultyIncrement*=2;
  const modified=await loadSongRankingData({...input,rules:changedRules});assert.notEqual(modified.ordinary[0].expectedScore,changed.ordinary[0].expectedScore);
  const fingerprint=await algorithmFingerprint(copy);await appendFile(join(copy,'scoring-rules/formal-note-core.mjs'),'\n// algorithm revision\n');
  assert.notEqual(await algorithmFingerprint(copy),fingerprint);
  const latest=await loadSongRankingData(input);assert.notEqual(latest.fingerprint,changed.fingerprint);
  assert.equal((await files(join(input.cacheRoot,'rows-v1'))).length,8);
});

test('independent processes publish complete atomic envelopes for the same key',async t=>{
  const input=await fixture(t), path=join(input.publicRoot,'concurrent.json');
  const helper=new URL('../../packages/scoring/server/ranking-row-cache.mjs',import.meta.url).href;
  const script=`import {writeCache} from ${JSON.stringify(helper)};await Promise.all(Array.from({length:8},()=>writeCache(${JSON.stringify(path)},'key',{value:[1,2,3]})));`;
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script]);let error='';child.stderr.on('data',s=>error+=s);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(error)));});
  await Promise.all([run(),run(),run()]);assert.deepEqual(await readCache(path,'key',()=>true),{value:[1,2,3]});
  assert.deepEqual((await files(input.publicRoot)).filter(p=>p.endsWith('.tmp')),[]);
});
