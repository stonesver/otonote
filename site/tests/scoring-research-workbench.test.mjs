import test from 'node:test';
import assert from 'node:assert/strict';
import {getRuntimeUiLabels} from '../src/lib/runtime-ui-labels.ts';

// Exercise the actual page method, substituting only DOM nodes and the worker
// transport. Numerical behavior is covered by the scoring integration tests.
const registry = new Map();
globalThis.HTMLElement = class {};
globalThis.customElements = { get:name=>registry.get(name), define:(name,value)=>registry.set(name,value) };
globalThis.document = { createElement:()=>({textContent:''}) };
await import('../src/lib/scoring-research-workbench.mjs');
const Workbench = registry.get('scoring-research-workbench');

function fixture(mode) {
  const page = new Workbench(), nodes = new Map();
  page.querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector,{textContent:'',value:'0',replaceChildren(){},append(){}});
    return nodes.get(selector);
  };
  page.querySelectorAll = selector => selector === '[data-gekisou-rank]' ? [1,1,1].map(value=>({value:String(value)})) : [];
  page.querySelector('[data-scoring-mode]').value = mode;
  page.querySelector('[data-gekisou-fps]').value = '60';
  page.querySelector('[data-gekisou-batches]').value = '1';
  page.scoreRequest = 0;
  page.draft = {slots:Array.from({length:5},(_,i)=>({memberCardId:`member-${i}`,supportCardId:`support-${i}`}))};
  page.data = {formalRules:{},sourceReleaseId:'fixture'};
  page.labels = {song:{invalidShare:'invalid share',unavailable:'unavailable',gekisouEstimate:'score {power}',
    breakdown:'base {base}',scenario:'AP',orderPercentiles:'P10 {p10}',topology:'notes {events}',factors:'power {power}'}};
  let calls = 0;
  page.calculateInWorker = async payload => {
    calls++; assert.equal(payload.mode,mode);
    return {expectedScore:1000,power:100,sampleCount:120,minimumScore:900,maximumScore:1100,
      baseScore:800,skillScoreGain:200,standardError:0,rankingBonusShare:0,sections:[],warnings:[],
      scoreDistribution:{kind:'skill_orders',p10:900,p50:1000,p90:1100},skills:[],
      chart:{eventCount:1,masterFullCombo:1,difficultyFactor:1,convertedNoteCount:1},inputHash:'fixture'};
  };
  return {page,calls:()=>calls,output:()=>page.querySelector('[data-song-score]').textContent,
    details:()=>page.querySelector('[data-song-score-details]').textContent};
}

for (const mode of ['ordinary','gekisou']) {
  test(`${mode}: missing personal growth warns but the complete manual team still calculates`, async () => {
    const f = fixture(mode);
    await f.page.renderSongScore({notes:[{}]}, {}, [{code:'personal_growth_unavailable',severity:'warning',message:'Personal growth not loaded'}]);
    assert.equal(f.calls(),1); assert.equal(f.output(),(1000).toLocaleString());
    assert.match(f.details(),/Personal growth not loaded/);
  });
  test(`${mode}: an invalid card remains blocking even alongside an optional-data warning`, async () => {
    const f = fixture(mode);
    await f.page.renderSongScore({notes:[{}]}, {}, [{severity:'warning',message:'No presets'},{code:'unknown_member_card',severity:'error'}]);
    assert.equal(f.calls(),0); assert.equal(f.output(),'unavailable');
    assert.equal(f.details(),'invalid share');
  });
}

test('fixed performance displays its life and combo and exports the exact supplied input',async()=>{
  const f=fixture('ordinary'), supplied={version:'fixture',judgements:[{scoreIndex:0,judgement:1}]};
  f.page.labels=getRuntimeUiLabels('zh-CN').scoringResearch;
  f.page.performanceInput={value:supplied};
  const transport=f.page.calculateInWorker;
  f.page.calculateInWorker=async payload=>{
    assert.deepEqual(payload.performance,supplied);
    return {...await transport(payload),performance:{maxCombo:12,life:900,lowestLife:800,convertedCount:2,judgementCounts:{1:1,2:0}}};
  };
  await f.page.renderSongScore({notes:[{}]}, {}, []);
  assert.match(f.page.querySelector('[data-performance-summary]').textContent,/最大连击 12.*结束生命 900.*最低生命 800/);
  assert.doesNotMatch(f.details(),/120|随机/);
  assert.deepEqual(JSON.parse(f.page.querySelector('[data-scoring-snapshot-json]').textContent).performance,supplied);
});

test('failed replacement clears the previous downloadable result instead of leaving stale notes',async()=>{
  const f=fixture('ordinary');
  f.page.querySelector('[data-scoring-snapshot-json]').textContent=JSON.stringify({result:{expectedScore:999}});
  await f.page.renderSongScore({notes:[{}]}, {}, [{severity:'error'}]);
  const snapshot=JSON.parse(f.page.querySelector('[data-scoring-snapshot-json]').textContent);
  assert.equal(snapshot.status,'unavailable');assert.equal(snapshot.result,undefined);
});

test('compact score presentation receives real bounds and clears them on a failed replacement',async()=>{
 const f=fixture('ordinary'),seen=[];f.page.scoreView={renderResult:result=>seen.push(result),refresh(){}};
 await f.page.renderSongScore({notes:[{}]}, {}, []);
 assert.equal(seen[0],null);assert.equal(seen.at(-1).expectedScore,1000);assert.equal(seen.at(-1).minimumScore,900);assert.equal(seen.at(-1).maximumScore,1100);
 await f.page.renderSongScore({notes:[{}]}, {}, [{severity:'error'}]);assert.equal(seen.at(-1),null);
});
