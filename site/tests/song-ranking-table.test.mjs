import test from 'node:test';
import assert from 'node:assert/strict';
import {rankingTableColumns,formatRankingCell,rankingStatusTags,rankingMetricExplanation} from '../src/lib/song-ranking-table.mjs';
import {rankRefinedSongRows as rank,RANKING_OPTIONS,RANKING_SORT_OPTIONS} from '../src/lib/song-ranking-options.mjs';

const row=(id,patch={})=>({id,title:id,trackId:`global--${id}`,sourceEdition:'global',level:25,difficulty:'expert',bands:['band-1'],bandLabels:['MyGO!!!!!'],attribute:'MyGO!!!!!',
  expectedScore:1000,baseScore:700,skillScoreGain:300,minimumScore:800,maximumScore:1200,p10Score:900,chartSeconds:100,audioSeconds:110,
  applicableEditions:['global'],pendingEditions:[],meta:{averageDensity:4,peakDensity:12,bpmMin:120,bpmMax:180},...patch});
test('every sortable metric has a visible column in its applicable table, without duplicate columns',()=>{
  const ordinary=rankingTableColumns(),gekisou=rankingTableColumns('gekisou'),grade=rankingTableColumns('ordinary','requiredPower');
  assert.equal(ordinary.length,27);assert.equal(gekisou.length,32);assert.equal(grade.length,29);
  for(const columns of [ordinary,gekisou,grade]) {
    assert.equal(columns[0].key,'title');assert.equal(new Set(columns.map(c=>c.key)).size,columns.length);
    assert.ok(columns.every(c=>c.width>0&&c.labels===RANKING_OPTIONS[c.key]));
  }
  assert.deepEqual([...new Set([...ordinary,...gekisou,...grade].map(c=>c.key))].sort(),Object.keys(RANKING_SORT_OPTIONS).sort());
  assert.deepEqual(grade.slice(1,3).map(c=>c.key),['requiredPower','targetScore']);
  for(const key of ['enteredRank','bandLabel','attribute','editionLabel','calculationState'])assert.ok(!grade.some(c=>c.key===key));
});
test('title and metadata columns sort in both directions, with missing data last',()=>{
  const rows=[row('b',{title:'Song 10',bandLabels:['Z'],attribute:null}),row('a',{title:'Song 2',bandLabels:['A'],attribute:'M'}),row('missing',{title:'',bandLabels:[],attribute:null})];
  assert.deepEqual(rank(rows,{metric:'title'}).map(r=>[r.id,r.rank]),[['a',1],['b',2],['missing',null]]);
  assert.deepEqual(rank(rows,{metric:'title',direction:'desc'}).map(r=>r.id),['b','a','missing']);
  assert.deepEqual(rank(rows,{metric:'bandLabel'}).map(r=>r.id),['a','b','missing']);
  assert.deepEqual(rank(rows,{metric:'attribute',direction:'desc'}).map(r=>r.rank),[1,null,null]);
});
test('difficulty uses game order, and one-chart-per-song honors the selected text sort',()=>{
  const rows=['expert','normal','easy','hard'].map((difficulty,i)=>row(String(i),{difficulty,songIdentity:'same'}));
  assert.deepEqual(rank(rows,{metric:'difficulty'}).map(r=>r.difficulty),['easy','normal','hard','expert']);
  assert.deepEqual(rank(rows,{metric:'difficulty',direction:'desc',grouping:'songs'}).map(r=>r.difficulty),['expert']);
});
test('selected, chart, audio and cycle duration columns stay distinct and sortable',()=>{
  const result=rank([row('a')],{metric:'cycleSeconds',durationBasis:'audio',overhead:30})[0];
  assert.equal(formatRankingCell('chartSeconds',result),'100 s');
  assert.equal(formatRankingCell('audioSeconds',result),'110 s');
  assert.equal(formatRankingCell('durationSeconds',result),'110 s');
  assert.equal(formatRankingCell('cycleSeconds',result),'140 s');
  assert.equal(formatRankingCell('audioSeconds',{audioSeconds:null}),'—');
});
test('table formats raw ratios, missing values and pending edition labels without hiding information',()=>{
  assert.equal(formatRankingCell('skillShare',{skillShare:0.25}),'25%');
  assert.equal(formatRankingCell('scoreMultiplier',{scoreMultiplier:5.4321}),'5.4321×');
  assert.equal(formatRankingCell('expectedScore',{expectedScore:NaN}),'—');
  const source=row('a',{applicableEditions:['jp'],pendingEditions:['global']});
  assert.equal(formatRankingCell('editionLabel',source),'日服 · 待算：国际版');
  assert.equal(formatRankingCell('calculationState',{...source,pending:true}),'基准待计算');
  assert.equal(formatRankingCell('calculationState',{...source,calculation:'replay'}),'已完成精算');
});
test('both grade columns recompute the selected reference before sorting, rather than using stale fields',()=>{
  const thresholds=Array.from({length:6},(_,i)=>({rank:i+2,score:i*100}));
  const a=row('a',{benchmark:{power:100000},gradeReferences:{global:{verified:true,thresholds}}});
  const b=row('b',{benchmark:{power:100000},gradeReferences:{global:{verified:true,thresholds:thresholds.map(r=>({...r,score:r.score*2}))}}});
  const target=rank([b,a],{metric:'targetScore',targetRank:5,gradeEdition:'global',profile:'benchmark'});
  assert.deepEqual(target.map(r=>r.targetScore),[300,600]);
  const grades=rank([a,b],{metric:'enteredRank',gradeEdition:'global',profile:'benchmark',score:350});
  assert.deepEqual(grades.map(r=>r.enteredRank),[5,3]);
  assert.equal(formatRankingCell('enteredRank',grades[0]),'A');
});

test('identity tags distinguish song attributes, score editions and calculation provenance',()=>{
  const tags=rankingStatusTags(row('a',{attribute:'Ave Mujica',applicableEditions:['jp'],pendingEditions:['global']}));
  assert.equal(tags.find(t=>t.kind==='band').label,'MyGO!!!!!');
  assert.equal(tags.find(t=>t.kind==='attribute').label,'Ave Mujica');
  assert.equal(tags.find(t=>t.kind==='edition').label,'日服 · 待算：国际版');
  assert.equal(rankingStatusTags(row('a',{pending:true})).find(t=>t.kind==='state').state,'pending');
  assert.equal(rankingStatusTags(row('a',{calculation:'replay'})).find(t=>t.kind==='state').label,'精算');
});
test('P10 explanations distinguish skill orders from LUCK sampling',()=>{
  assert.match(rankingMetricExplanation('p10Score'),/120.*12/);
  assert.match(rankingMetricExplanation('p10Efficiency','gekisou'),/LUCK.*10%/);
  assert.equal(rankingMetricExplanation('expectedScore'),'');
});

test('target grade reorders the easier chart and unverified power remains unranked',()=>{
  const reference=scores=>({verified:true,thresholds:scores.map((score,i)=>({rank:i+2,score}))});
  const a=row('a',{benchmark:{power:100000},gradeReferences:{global:reference([0,100,200,300,400,900])}});
  const b=row('b',{benchmark:{power:100000},gradeReferences:{global:reference([0,100,200,300,500,800])}});
  const missing=row('missing',{benchmark:{power:100000}});
  for(const [targetRank,first] of [[6,'a'],[7,'b']]){
    const result=rank([missing,b,a],{edition:'global',metric:'requiredPower',targetRank,profile:'benchmark'});
    assert.equal(result[0].id,first);
    assert.equal(result.at(-1).rank,null);
    assert.equal(formatRankingCell('requiredPower',result[0]),targetRank===6?'约 40,000':'约 80,000');
  }
});
