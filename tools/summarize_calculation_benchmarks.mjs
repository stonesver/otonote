import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const {values}=parseArgs({options:{directory:{type:'string',default:'output/calculation-algorithms'},
  output:{type:'string'},audit:{type:'string'},'allow-partial':{type:'boolean',default:false},'require-controls':{type:'boolean',default:false},
  'control-phases':{type:'string',default:'replay,search,events,planner'},'preserve-search':{type:'boolean',default:false}}});
const directory=resolve(values.directory), failures=[];
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const rows=path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const quantile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
const stats=values=>({count:values.length,p50:quantile(values,.5),p95:quantile(values,.95),maximum:quantile(values,1),
  total:values.reduce((a,b)=>a+b,0)});
const counts=(rows,key)=>Object.fromEntries([...new Set(rows.map(r=>r[key]??'unspecified'))].map(value=>[value,rows.filter(r=>(r[key]??'unspecified')===value).length]));
const report={generatedAt:new Date().toISOString(),directory,phases:{},failures};
for(const phase of ['replay','gekisou','search','events']){
  const paths=['baseline','optimized'].map(prefix=>resolve(directory,`${prefix}-${phase}.jsonl`));
  if(paths.some(p=>!existsSync(p)||!existsSync(p+'.summary.json'))){failures.push(`${phase}: missing run`);continue;}
  const summaries=paths.map(p=>read(p+'.summary.json'));
  const [before,after]=paths.map(rows), old=new Map(before.map(r=>[r.key,r]));
  if(new Set(before.map(r=>r.key)).size!==before.length||new Set(after.map(r=>r.key)).size!==after.length)
    failures.push(`${phase}: duplicate result keys`);
  for(const key of ['samples','growth','searchEvaluations','chartStride'])
    if(summaries[0][key]!==summaries[1][key])failures.push(`${phase}: different ${key}`);
  const identity=s=>s.datasets.map(d=>[d.sourceReleaseId,d.rulesSha256,d.chartsSha256,d.members,d.supports,d.masterCharts]);
  if(JSON.stringify(identity(summaries[0]))!==JSON.stringify(identity(summaries[1])))failures.push(`${phase}: different datasets`);
  for(const [index,summary] of summaries.entries()){
    if(summary.diagnosticMemory)failures.push(`${phase}: diagnostic GC run cannot serve as a timing comparison`);
    if(summary.finishedAt&&summary.rows!==[before,after][index].length)failures.push(`${phase}: result count differs from summary`);
    if(summary.finishedAt&&summary.datasets.some(d=>d.testedCharts!==d.masterCharts||d.missing.length||d.extra.length))
      failures.push(`${phase}: incomplete chart census`);
  }
  const missing=before.filter(r=>!after.some(n=>n.key===r.key)).map(r=>r.key), extra=after.filter(r=>!old.has(r.key)).map(r=>r.key);
  const errors=[...before,...after].filter(r=>r.error);
  if(summaries.some(s=>!s.finishedAt))failures.push(`${phase}: unfinished run`);
  if(missing.length||extra.length)failures.push(`${phase}: coverage differs (${missing.length} missing, ${extra.length} extra)`);
  if(errors.length)failures.push(`${phase}: ${errors.length} calculation failures`);
  const hashMismatches=after.filter(r=>old.has(r.key)&&(['replay','gekisou'].includes(phase)||['power','practical'].includes(r.mode))
    &&r.fingerprint!==old.get(r.key).fingerprint).map(r=>r.key);
  const optimumMismatches=after.filter(r=>old.get(r.key)?.optimality==='proven_within_model'&&r.optimality==='proven_within_model'
    &&r.value!==old.get(r.key).value).map(r=>r.key);
  const rewardRegressions=phase==='events'?after.filter(r=>old.has(r.key)&&r.value<old.get(r.key).value).map(r=>r.key):[];
  const boundedRegressions=phase==='search'?after.filter(r=>r.mode==='score'&&old.has(r.key)&&r.value<old.get(r.key).value).map(r=>r.key):[];
  const proofRegressions=after.filter(r=>old.get(r.key)?.optimality==='proven_within_model'&&r.optimality!=='proven_within_model').map(r=>r.key);
  const gapRegressions=after.filter(r=>old.has(r.key)&&Number.isFinite(r.gap)&&Number.isFinite(old.get(r.key).gap)
    &&r.gap>old.get(r.key).gap+1e-8).map(r=>r.key);
  const searchChanges=values['preserve-search']?after.filter(r=>old.has(r.key)&&['search','events'].includes(phase)
    && ['fingerprint','evaluated','optimality','status','gap','frontier'].some(k=>r[k]!==old.get(r.key)[k])).map(r=>r.key):[];
  if(searchChanges.length)failures.push(`${phase}: search result or certificate changed`);
  if(hashMismatches.length||optimumMismatches.length||rewardRegressions.length||boundedRegressions.length||proofRegressions.length||gapRegressions.length)failures.push(`${phase}: result or proof regression`);
  const modes={};
  for(const mode of new Set(after.map(r=>r.mode))){
    const current=after.filter(r=>r.mode===mode&&old.has(r.key)&&!r.error&&!old.get(r.key).error);
    const previous=current.map(r=>old.get(r.key));
    modes[mode]={rows:current.length,beforeWallMs:stats(previous.map(r=>r.wallMs)),afterWallMs:stats(current.map(r=>r.wallMs)),
      beforeCpuMs:stats(previous.map(r=>r.cpuMs)),afterCpuMs:stats(current.map(r=>r.cpuMs)),
      afterRssBytes:stats(current.filter(r=>r.rssBytes!=null).map(r=>r.rssBytes)),
      pairedCpuSpeedup:stats(current.map(r=>old.get(r.key).cpuMs/r.cpuMs)),
      beforeEvaluated:stats(previous.filter(r=>r.evaluated!=null).map(r=>r.evaluated)),afterEvaluated:stats(current.filter(r=>r.evaluated!=null).map(r=>r.evaluated)),
      beforeGap:stats(previous.filter(r=>r.gap!=null).map(r=>r.gap)),afterGap:stats(current.filter(r=>r.gap!=null).map(r=>r.gap)),
      values:{improved:current.filter(r=>r.value>old.get(r.key).value).length,equal:current.filter(r=>r.value===old.get(r.key).value).length,
        decreased:current.filter(r=>r.value<old.get(r.key).value).length},
      afterOptimality:counts(current,'optimality'),afterStatus:counts(current,'status')};
  }
  report.phases[phase]={beforeRows:before.length,afterRows:after.length,complete:summaries.every(s=>s.finishedAt)&&!missing.length&&!extra.length,
    missing,extra,errors,hashMismatches,optimumMismatches,rewardRegressions,boundedRegressions,proofRegressions,gapRegressions,searchChanges,modes,
    datasets:summaries[1].datasets,machine:summaries[1].machine,node:summaries[1].node,
    startedAt:summaries.map(s=>s.startedAt),finishedAt:summaries.map(s=>s.finishedAt??null),afterMaxRssKiB:summaries[1].maxRssKiB};
}
const audit=values.audit?resolve(values.audit):resolve(directory,'full-growth-audit.jsonl.summary.json');
if(existsSync(audit)){
  report.cardAudit=read(audit);
  if(!report.cardAudit.finishedAt||report.cardAudit.failures)failures.push('Card audit incomplete or failed');
}else failures.push('Missing card audit');
if(values['require-controls']){
  report.controls={};
  for(const phase of values['control-phases'].split(',')){
    const paths=['baseline','optimized','optimized','baseline'].map((prefix,index)=>resolve(directory,`control-${phase}-${index}-${prefix}.jsonl`));
    if(paths.some(p=>!existsSync(p)||!existsSync(p+'.summary.json'))){failures.push(`control ${phase}: missing run`);continue;}
    const summaries=paths.map(p=>read(p+'.summary.json')), runs=paths.map(rows);
    if(summaries.some(s=>!s.finishedAt||s.failures||s.mismatches||s.diagnosticMemory)){failures.push(`control ${phase}: unfinished, diagnostic or failed run`);continue;}
    const identity=s=>JSON.stringify([s.samples,s.growth,s.searchEvaluations,s.chartStride,s.selectedChart,
      s.datasets.map(d=>[d.sourceReleaseId,d.rulesSha256,d.chartsSha256,d.members,d.supports,d.masterCharts,d.testedCharts])]);
    if(summaries.some(s=>identity(s)!==identity(summaries[0])))failures.push(`control ${phase}: different inputs`);
    const maps=runs.map(r=>new Map(r.map(row=>[row.key,row]))), keys=runs[0].map(r=>r.key);
    if(!keys.length||maps.some((m,i)=>m.size!==keys.length||m.size!==runs[i].length||keys.some(key=>!m.has(key)))){failures.push(`control ${phase}: coverage differs`);continue;}
    const groups={};
    for(const key of keys){
      const row=maps.map(m=>m.get(key)),mode=row[0].mode;
      if(row.some(r=>r.error))failures.push(`control ${phase}: calculation error ${key}`);
      if((['replay','gekisou','planner'].includes(phase)||['power','practical'].includes(mode))&&row.some(r=>r.fingerprint!==row[0].fingerprint||r.resultsFingerprint!==row[0].resultsFingerprint))
        failures.push(`control ${phase}: snapshot differs ${key}`);
      for(const [a,b]of [[0,3],[1,2]])if(['fingerprint','resultsFingerprint','gap','status','optimality','evaluated','frontier'].some(k=>row[a][k]!==row[b][k]))
        failures.push(`control ${phase}: repeat differs ${key}`);
      if(['score','yield','challenge'].includes(mode)&&Math.min(row[1].value,row[2].value)<Math.max(row[0].value,row[3].value))
        failures.push(`control ${phase}: value regression ${key}`);
      if(row[0].resultValues&&row[1].resultValues&&(row[1].resultValues.length<row[0].resultValues.length
        ||row[0].resultValues.some((value,i)=>row[1].resultValues[i]<value)))failures.push(`control ${phase}: retained result regression ${key}`);
      if(row[0].optimality==='proven_within_model'&&row[1].optimality!=='proven_within_model'||Number.isFinite(row[0].gap)&&row[1].gap>row[0].gap+1e-8)
        failures.push(`control ${phase}: proof regression ${key}`);
      const average=(field,a,b)=>(row[a][field]+row[b][field])/2;
      (groups[mode]??=[]).push({beforeWallMs:average('wallMs',0,3),afterWallMs:average('wallMs',1,2),
        beforeCpuMs:average('cpuMs',0,3),afterCpuMs:average('cpuMs',1,2),beforeRssBytes:average('rssBytes',0,3),afterRssBytes:average('rssBytes',1,2)});
    }
    report.controls[phase]={order:['baseline','optimized','optimized','baseline'],rowsPerRun:keys.length,
      startedAt:summaries.map(s=>s.startedAt),finishedAt:summaries.map(s=>s.finishedAt),
      peakRssMiB:summaries.map(s=>s.maxRssKiB/1024),
      modes:Object.fromEntries(Object.entries(groups).map(([mode,group])=>[mode,{
        ...Object.fromEntries(['beforeWallMs','afterWallMs','beforeCpuMs','afterCpuMs','beforeRssBytes','afterRssBytes'].map(field=>[field,stats(group.map(r=>r[field]).filter(Number.isFinite))])),
        pairedWallSpeedup:stats(group.map(r=>r.beforeWallMs/r.afterWallMs)),
        pairedCpuSpeedup:stats(group.map(r=>r.beforeCpuMs/r.afterCpuMs))
      }]))};
  }
}
report.complete=failures.length===0;
if(values.output)writeFileSync(values.output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({complete:report.complete,failures,phases:Object.fromEntries(Object.entries(report.phases)
  .map(([key,value])=>[key,{before:value.beforeRows,after:value.afterRows,mismatches:value.hashMismatches.length,modes:value.modes}]))},null,2));
if(!report.complete&&!values['allow-partial'])process.exitCode=1;
