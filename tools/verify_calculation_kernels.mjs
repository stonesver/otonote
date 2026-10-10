import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {values}=parseArgs({options:{baseline:{type:'string'},datasets:{type:'string'},output:{type:'string'}}});
if(!values.baseline||!values.datasets||!values.output)throw new Error('--baseline, --datasets and --output are required');
const root=resolve(import.meta.dirname,'..'),baseline=resolve(values.baseline);
const load=(dir,path)=>import(pathToFileURL(`${dir}/${path}`));
const report={startedAt:new Date().toISOString(),matching:0,growth:0,skills:0,datasets:[]};
const [oldPair,newPair]=await Promise.all([baseline,root].map(p=>load(p,'packages/scoring/scoring-rules/maximum-pairing.mjs')));
let state=7141;const next=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
for(let seed=0;seed<1000;seed++){
 const edges=[];for(let m=0;m<8;m++)for(let s=0;s<7;s++)if(next(5))edges.push({key:`${m}|${s}`,member:m,support:s,character:m%6,weight:next(9)-4});
 const input={edges,count:1+next(5),required:seed%3?[ ]:[edges[next(edges.length)].key],forbidden:seed%4?[]:[edges[next(edges.length)].key],requiredMembers:[next(8)],requiredSupports:seed%2?[]:[next(7)]};
 assert.deepEqual(newPair.maximumPairing(input),oldPair.maximumPairing(input),`matching seed ${seed}`);report.matching++;
}
const factories=await Promise.all([baseline,root].map(async p=>({
 power:(await load(p,'packages/scoring/scoring-rules/formation-power.mjs')).createFormationCalculator,
 skills:(await load(p,'packages/scoring/scoring-rules/formal-skills.mjs')).createFormalSkillResolver,
 geki:(await load(p,'packages/scoring/scoring-rules/gekisou-skill-runtime.mjs')).compileGekisouEffects
})));
for(const data of JSON.parse(readFileSync(values.datasets))){
 const rules=JSON.parse(readFileSync(data.rules)),[old,newer]=factories.map(f=>({power:f.power(rules),skills:f.skills(rules,{dynamic:true}),geki:f.geki}));
 for(const kind of ['Member','Support'])for(const card of rules.tables[`${kind}Card`])for(let rank=1;rank<=5;rank++)for(const awake of kind==='Member'?[1,2,3,4,5]:[1]){
  for(const level of [undefined,1])assert.deepEqual(newer.power.resolveGrowth(card,kind,{rank,awake,level}),old.power.resolveGrowth(card,kind,{rank,awake,level}));report.growth++;
 }
 for(const m of rules.tables.MemberCard)for(const s of rules.tables.SupportCard)for(let skillLevel=1;skillLevel<=5;skillLevel++)for(let rank=1;rank<=5;rank++){
  const memberCardId=`member-card-${m._id}`,supportCardId=`support-card-${s._id}`;
  const d={slots:[{memberCardId,supportCardId}],modifiers:{growth:{[memberCardId]:{level:1,rank:1,awake:1,skillLevel,gekisouSkillLevel:skillLevel},[supportCardId]:{level:1,rank}}}};
  assert.deepEqual(newer.skills(d),old.skills(d));assert.equal(JSON.stringify(newer.geki(rules,d,true,[1,2,3]),(_,v)=>typeof v==='function'?String(v):v),JSON.stringify(old.geki(rules,d,true,[1,2,3]),(_,v)=>typeof v==='function'?String(v):v));report.skills++;
 }
 report.datasets.push({release:rules.sourceReleaseId,members:rules.tables.MemberCard.length,supports:rules.tables.SupportCard.length});console.log(JSON.stringify(report));
}
report.finishedAt=new Date().toISOString();report.failures=0;
mkdirSync(dirname(resolve(values.output)),{recursive:true});
writeFileSync(values.output,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
