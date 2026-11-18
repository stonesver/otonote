import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {build} from 'esbuild';
import {compile} from 'svelte/compiler';

const compiled=await build({stdin:{contents:`import {render} from 'svelte/server';
 import Component from './src/components/calculation/RecommendationOverview.svelte';
 export const overview = props => render(Component,{props}).body;`,resolveDir:fileURLToPath(new URL('../',import.meta.url))},
 bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'svelte-server',setup(b){
  b.onLoad({filter:/\.svelte$/},({path})=>({contents:compile(readFileSync(path,'utf8'),{filename:path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(path)}));
 }}]});
const {overview}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const base={mode:'ordinary',objective:'expected_song_score',index:0,scenarioLabel:'参考队伍',trainingDescriptions:[],locale:'zh-CN',createTeamView:()=>{throw Error('Client roster is not server-rendered');}};
const render=result=>overview({...base,result});
test('reference and streaming results never invent actual-growth gains',()=>{
 const html=render({value:1234.6,delta:100,planning:{missingActual:true,plannedTeamCurrentValue:null,trainingChanges:[]}});
 assert.match(html,/1,235/);assert.match(html,/参考养成，非当前实力/);assert.doesNotMatch(html,/较当前养成方案/);
});
test('training comparison preserves zero values and distinguishes missing baseline',()=>{
 const html=render({value:1234,delta:null,planning:{missingActual:true,currentValue:null,plannedTeamCurrentValue:0,targetValue:1234,trainingChanges:[{id:'member-card-1'}]}});
 assert.match(html,/当前卡库方案<\/dt><dd>—/);assert.match(html,/这套队伍按当前养成<\/dt><dd>0/);
 assert.match(html,/这套队伍达到目标后<\/dt><dd>1,234/);assert.match(html,/材料消耗尚未核算/);
 assert.match(html,/持有情况未确认，不与当前卡库最佳队伍比较/);
});
test('negative and zero deltas retain their signs and display styles',()=>{
 assert.match(render({value:1,delta:-2.5}),/class="is-negative">-2.5 较当前养成方案/);
 assert.match(render({value:1,delta:0}),/class="is-positive">\+0 较当前养成方案/);
});
test('Svelte result labels use the existing English translations',()=>{
 const html=overview({...base,locale:'en',scenarioLabel:'当前养成',result:{value:1234}});
 assert.match(html,/Recommended team/);assert.doesNotMatch(html,/[\u4e00-\u9fff]/);
});
test('Svelte recommendations distinguish useful timing plans from on-time results',()=>{
 const plan={adjustments:[{scoreIndex:1,timingOffsetMs:-25}],score:120,onTimeMinimumScore:100};
 assert.match(render({value:120,apTimingPlan:plan}),/微操预计分/);
 const noGain=render({value:100,apTimingPlan:{...plan,score:100}});
 assert.match(noGain,/正拍预计分/);assert.doesNotMatch(noGain,/微操预计分/);
 assert.match(overview({...base,locale:'en',result:{value:120,apTimingPlan:plan}}),/Estimated timing score/);
});
