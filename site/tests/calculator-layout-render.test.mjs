import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from '@astrojs/compiler-rs';
import {experimental_AstroContainer} from 'astro/container';
import {parse} from 'parse5';

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const runtime = moduleUrl(`export * from ${JSON.stringify(import.meta.resolve('astro/compiler-runtime'))};
  export const createMetadata = () => ({}); export const renderScript = () => '';`);
const projection = moduleUrl(`
  export const sharedTeamPresentation=()=>({filterVisualOptions:{},growthIcons:{}});
  export const catalog = {release:{id:'fixture',locale:'zh-CN'},musicTracks:[],musicCharts:[],bands:[],characters:[],cardTaxonomy:{attributes:[],rarities:[]}};
  export const memberCards=[],supportCards=[],projections=[],skillFilters={facets:[]};
  export const globalSystems={sourceReleaseId:'fixture',vipRanks:[]},bandItemDatabase={items:[]};
  export const activeReleaseContext={locale:'zh-CN'},TEAM_RULE_SET={officialSlotCount:5};
  export const getAsset=()=>null,getCardRarity=()=>null,getCardAttribute=()=>null,filterVisual=()=>({});
  export const getRuntimeUiLabels=()=>({locale:'zh-CN',teamDraft:{}});
  export const scoringRulesAvailable=()=>true;
  export default {sourceReleaseId:'fixture',ruleSetVersion:'fixture'};
`);
// Exercise the real parent HTML with small child slots; no browser scripts run.
async function compile(source, child) {
  const {code} = await transform(source, {filename:'layout.astro',internalURL:'astro/compiler-runtime'});
  return moduleUrl(code.replace(/(["'])(astro\/compiler-runtime|\.\.?\/[^"']+)\1/g, (_,quote,specifier) =>
    JSON.stringify(specifier.startsWith('astro/') ? runtime : specifier.endsWith('.astro') ? child : projection)));
}
const attr = (node,name) => node.attrs?.find(a=>a.name===name)?.value;
const hasClass = (node,name) => attr(node,'class')?.split(/\s+/).includes(name);
function walk(node) { return [node,...(node.childNodes??[]).flatMap(walk)]; }
function within(node, name) {
  for(let parent=node.parentNode;parent;parent=parent.parentNode) if(attr(parent,'data-workbench-part')===name)return true;
  return false;
}

test('deck HTML already contains the current layout and no dormant legacy panels before scripts', async () => {
  const child = await compile('<div><slot /><slot name="search" /><slot name="quick" /><slot name="results" /></div>');
  const source=await readFile(new URL('../src/components/TeamDraftWorkbench.astro',import.meta.url),'utf8');
  const {default:Component}=await import(await compile(source,child));
  const container=await experimental_AstroContainer.create();
  const html=await container.renderToString(Component),nodes=walk(parse(html));
  for(const [field,part] of [['data-song-select','song'],['data-search-scope','conditions'],['data-search-band','conditions'],['data-search-support-band','conditions'],['data-pairing-mode','conditions'],['data-optimize-pairing','main'],['data-pairing-results','main']]) {
    const controls=nodes.filter(n=>attr(n,field)!==undefined);
    assert.equal(controls.length,1,`${field} must have one owner`);
    assert.ok(within(controls[0],part),`${field} belongs to its workbench fragment`);
  }
  for(const legacy of ['calculator-journey','journey-step','journey-manual','team-workbench-grid','score-preparation']) {
    assert.ok(!nodes.some(n=>hasClass(n,legacy)),`${legacy} must be removed, not hidden`);
  }
  for(const legacy of ['data-team-slots','data-card-results','data-instrument-controls','data-character-rank-controls']) assert.ok(!nodes.some(n=>attr(n,legacy)!==undefined),`${legacy} now belongs to the shared editor`);
  assert.doesNotMatch(html,/高级面板|data-production-breakdown|data-power-trace/);
});
