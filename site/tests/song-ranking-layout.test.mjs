import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from '@astrojs/compiler-rs';
import {transform as transpile} from 'esbuild';
import {experimental_AstroContainer} from 'astro/container';
import {parse} from 'parse5';
import {rankingTableColumns} from '../src/lib/song-ranking-table.mjs';

const moduleUrl=code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const runtime=moduleUrl(`export * from ${JSON.stringify(import.meta.resolve('astro/compiler-runtime'))};export const createMetadata=()=>({});export const renderScript=()=>'';`);
const fixture=moduleUrl(`
  export const catalog={release:{id:'fixture',region:'global',locale:'zh-CN'},musicCharts:[],bands:[]};
  export const filterVisual=()=>({});
  export const activeReleaseContext={locale:'zh-CN'};
  export const getRuntimeUiLabels=()=>({scoreWorkbench:{}});
  export const LOGICAL_LANE_COUNT=12;
  export const sharedSongRankings={releases:{global:'fixture'},artwork:{},ordinary:[{id:'chart-a',trackId:'global--song-a',title:'Fixture Song',difficulty:'expert',level:25,bands:[],bandLabels:[],expectedScore:123456,chartSeconds:100,audioSeconds:110,applicableEditions:['global'],pendingEditions:[]}],gekisou:[]};
`);
async function compile(source,children={}) {
  const {code}=await transform(source,{filename:'ranking-layout.astro',internalURL:'astro/compiler-runtime'});
  const js=(await transpile(code,{loader:'ts',format:'esm'})).code;
  return moduleUrl(js.replace(/(["'])(astro\/compiler-runtime|\.\.?\/[^"']+)\1/g,(_,quote,specifier)=>JSON.stringify(
    specifier.startsWith('astro/')?runtime:specifier.endsWith('song-ranking-table.mjs')?new URL('../src/lib/song-ranking-table.mjs',import.meta.url).href:
    specifier.endsWith('song-ranking-options.mjs')?new URL('../src/lib/song-ranking-options.mjs',import.meta.url).href:
    specifier.endsWith('.astro')?children[specifier.split('/').at(-1)]??children.fallback:fixture)));
}
const attr=(node,name)=>node.attrs?.find(a=>a.name===name)?.value;
const walk=node=>[node,...(node.childNodes??[]).flatMap(walk)];
async function render(region="global"){
  (await import(fixture)).catalog.release.region=region;
  const fallback=await compile('<div><slot /></div>');
  const icon=await compile(await readFile(new URL('../src/components/RankingIcon.astro',import.meta.url),'utf8'));
  const workbench=await compile(await readFile(new URL('../src/components/ScoreWorkbench.astro',import.meta.url),'utf8'));
  const chartDialog=await compile(await readFile(new URL('../src/components/RankingChartDialog.astro',import.meta.url),'utf8'),{fallback,'ScoreWorkbench.astro':workbench});
  const {default:Page}=await import(await compile(await readFile(new URL('../src/pages/tools/song-ranking/index.astro',import.meta.url),'utf8'),{fallback,'RankingIcon.astro':icon,'RankingChartDialog.astro':chartDialog}));
  return {html:await (await experimental_AstroContainer.create()).renderToString(Page)};
}
test('the complete sortable table is already rendered before scripts, with exactly one owner for every filter',async()=>{
  const {html}=await render(),nodes=walk(parse(html)),keys=rankingTableColumns().map(c=>c.key);
  assert.deepEqual(nodes.filter(n=>attr(n,'data-sort')!==undefined).map(n=>attr(n,'data-sort')),keys);
  for(const key of ['query','difficulty','band','attribute','edition','status','minLevel','maxLevel','minSeconds','maxSeconds','minBpm','maxBpm','minDensity','maxDensity','minValue','maxValue']) {
    assert.equal(nodes.filter(n=>attr(n,'data-filter')===key).length,1,`${key} must have one owner`);
  }
  const body=nodes.find(n=>attr(n,'data-rows')!==undefined),row=body.childNodes.find(n=>n.tagName==='tr');
  assert.equal(row.childNodes.filter(n=>n.tagName==='td').length,keys.length+1);
  assert.match(html,/Fixture Song/);assert.match(html,/123,456/);
});
test('advanced conditions are native closed disclosures and the data region is keyboard scrollable',async()=>{
  const {html}=await render(),nodes=walk(parse(html));
  const panels=nodes.filter(n=>attr(n,'data-toolbar-panel')!==undefined);
  assert.equal(panels.length,3);assert.ok(panels.every(n=>n.tagName==='details'&&attr(n,'open')===undefined));
  const region=nodes.find(n=>attr(n,'data-results')!==undefined);
  assert.equal(attr(region,'tabindex'),'0');assert.equal(attr(region,'role'),'region');assert.match(attr(region,'aria-label'),/横向/);
  assert.doesNotMatch(html,/ranking-picks|data-picks/);
});

test('metadata stays in frozen song labels, grade targets remain accessible and replay is advanced',async()=>{
  const {html}=await render(),nodes=walk(parse(html));
  const options=nodes.find(n=>attr(n,'data-metric')!==undefined).childNodes.filter(n=>n.tagName==='option').map(n=>attr(n,'value'));
  for(const key of ['bandLabel','attribute','editionLabel','calculationState','enteredRank'])assert.ok(!options.includes(key));
  for(const key of ['requiredPower','targetScore'])assert.ok(options.includes(key));
  const target=nodes.find(n=>attr(n,'data-grade-target')!==undefined);
  assert.deepEqual(target.childNodes.filter(n=>n.tagName==='option').map(n=>attr(n,'value')),['2','3','4','5','6','7']);
  assert.equal(nodes.filter(n=>attr(n,'data-load-more')!==undefined).length,1);
  assert.equal(nodes.filter(n=>attr(n,'data-prev')!==undefined||attr(n,'data-next')!==undefined).length,0);
  assert.equal(nodes.filter(n=>attr(n,'class')?.split(' ').includes('ranking-tag')).length,4);
  const advanced=nodes.find(n=>attr(n,'class')==='ranking-advanced-replay');
  assert.equal(advanced.tagName,'details');assert.equal(attr(advanced,'open'),undefined);
  assert.deepEqual(nodes.filter(n=>attr(n,'data-edition-choice')!==undefined).map(n=>attr(n,'data-edition-choice')),['global','jp']);
  assert.equal(attr(nodes.find(n=>attr(n,'data-filter')==='edition'),'hidden'),'');
  assert.match(html,/每首歌仅显示一张/);assert.match(html,/排名最靠前的难度/);
});

test('website editions select their own initial scope, with no all-editions option',async()=>{
  for(const region of ['global','jp']){
    const {html}=await render(region),nodes=walk(parse(html));
    const field=nodes.find(n=>attr(n,'data-filter')==='edition');
    const options=field.childNodes.filter(n=>n.tagName==='option');
    assert.deepEqual(options.map(n=>attr(n,'value')),['global','jp']);
    assert.equal(attr(options.find(n=>attr(n,'selected')!==undefined),'value'),region);
    assert.equal(nodes.filter(n=>attr(n,'data-edition-choice')===region).map(n=>attr(n,'aria-pressed'))[0],'true');
    assert.equal(attr(nodes.find(n=>n.tagName==='song-ranking'),'data-site-edition'),region);
  }
});
test('chart dialog reuses the inert music analysis workbench and state is icon-only',async()=>{
  const {html}=await render(),nodes=walk(parse(html));
  const dialog=nodes.find(n=>attr(n,'data-ranking-chart-dialog')!==undefined);
  assert.equal(dialog.tagName,'dialog');assert.equal(attr(dialog,'open'),undefined);
  const template=nodes.find(n=>attr(n,'data-ranking-chart-template')!==undefined);
  assert.equal(walk(template.content).filter(n=>n.tagName==='score-workbench').length,1);
  const state=nodes.find(n=>attr(n,'class')?.split(' ').includes('ranking-tag--state'));
  assert.ok(state.childNodes.some(n=>attr(n,'class')==='ranking-state-symbol'));
  assert.ok(state.childNodes.every(n=>n.nodeName!=='#text'||!n.value.trim()));
});
