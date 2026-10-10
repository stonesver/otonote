import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{directory:{type:'string'},output:{type:'string'},phases:{type:'string',default:'replay,gekisou,search,events,planner'}}});
if(!values.directory||!values.output)throw new Error('--directory and --output are required');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const quantile=(xs,q)=>[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*q)-1)];
const stats=xs=>{
  const present=xs.filter(Number.isFinite),q=p=>present.length?quantile(present,p):null;
  return {count:present.length,minimum:q(0),p50:q(.5),p95:q(.95),maximum:q(1),total:present.reduce((a,b)=>a+b,0)};
};
const failures=[],report={generatedAt:new Date().toISOString(),order:['original','round1','round2','round2','round1','original'],phases:{},failures};
for(const phase of values.phases.split(',')){
  if(!['replay','gekisou','search','events','planner','challenge'].includes(phase))throw new Error(`Invalid phase: ${phase}`);
  const paths=report.order.map((label,i)=>resolve(values.directory,`${phase}-${i}-${label}.jsonl`));
  const runs=paths.map(path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  const summaries=paths.map(path=>read(path+'.summary.json'));
  const inputs=s=>JSON.stringify([s.samples,s.growth,s.searchEvaluations,s.chartStride,s.selectedChart,
    s.datasets.map(d=>[d.sourceReleaseId,d.rulesSha256,d.chartsSha256,d.testedCharts])]);
  if(summaries.some(s=>!s.finishedAt||s.failures||s.mismatches||inputs(s)!==inputs(summaries[0])))failures.push(`${phase}: unfinished, failed, or different inputs`);
  const maps=runs.map(rows=>new Map(rows.map(r=>[r.key,r]))),keys=runs[0].map(r=>r.key);
  if(!keys.length)throw new Error(`${phase}: no result rows`);
  if(maps.some((m,i)=>m.size!==keys.length||runs[i].length!==keys.length||keys.some(k=>!m.has(k))))throw new Error(`${phase}: coverage differs`);
  const modes={};
  for(const key of keys){
    const rows=maps.map(m=>m.get(key)),mode=rows[0].mode;
    if(rows.some(r=>r.error))failures.push(`${phase}: calculation failure ${key}`);
    const fields=['fingerprint','resultsFingerprint','evaluated','optimality','status','gap','frontier'];
    if(fields.some(f=>rows[0][f]!==rows[5][f]))failures.push(`${phase}: original repeat changed ${key}`);
    if([1,2,3,4].some(i=>fields.some(f=>rows[i][f]!==rows[1][f])))failures.push(`${phase}: round-1 result or certificate changed ${key}`);
    if(['score','yield','challenge'].includes(mode)&&[1,2,3,4].some(i=>rows[i].value<rows[0].value))
      failures.push(`${phase}: original objective regressed ${key}`);
    if((['replay','gekisou','planner'].includes(phase)||['power','practical'].includes(mode))&&rows.some(r=>r.fingerprint!==rows[0].fingerprint))
      failures.push(`${phase}: original snapshot changed ${key}`);
    const average=(field,a,b)=>(rows[a][field]+rows[b][field])/2;
    const sample={};
    for(const [label,a,b] of [['original',0,5],['round1',1,4],['round2',2,3]])
      sample[label]=Object.fromEntries(['wallMs','cpuMs','rssBytes'].map(field=>[field,average(field,a,b)]));
    (modes[mode]??=[]).push(sample);
  }
  report.phases[phase]={rowsPerRun:keys.length,machine:summaries[0].machine,node:summaries[0].node,
    maxRssMiB:Object.fromEntries(['original','round1','round2'].map(label=>[label,summaries.filter((_,i)=>report.order[i]===label).map(s=>s.maxRssKiB/1024)])),
    startedAt:summaries.map(s=>s.startedAt),finishedAt:summaries.map(s=>s.finishedAt),
    modes:Object.fromEntries(Object.entries(modes).map(([mode,samples])=>[mode,{
      inputs:samples.length,
      measurements:Object.fromEntries(['original','round1','round2'].map(label=>[label,Object.fromEntries(['wallMs','cpuMs','rssBytes'].map(field=>[field,stats(samples.map(r=>r[label][field]))]))])),
      speedup:Object.fromEntries(['original','round1'].map(label=>[label,Object.fromEntries(['wallMs','cpuMs'].map(field=>[field,{
        ...stats(samples.map(r=>r[label][field]/r.round2[field])),
        faster:samples.filter(r=>r[label][field]>r.round2[field]).length,
        slower:samples.filter(r=>r[label][field]<r.round2[field]).length
      }]))]))
    }]))};
}
report.complete=!failures.length;
writeFileSync(values.output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({complete:report.complete,failures,phases:Object.fromEntries(Object.entries(report.phases).map(([p,s])=>[p,{rows:s.rowsPerRun,modes:Object.fromEntries(Object.entries(s.modes).map(([m,d])=>[m,Object.fromEntries(Object.entries(d.speedup).map(([v,stats])=>[v,{wall:stats.wallMs.p50,cpu:stats.cpuMs.p50}]))]))}]))},null,2));
if(failures.length)process.exitCode=1;
