// Cold local replay of the worker's FULL candidate pass, with the same stage,
// goal, cache and scheduler semantics. Missing charts fail preflight rather
// than silently narrowing the song range. No network requests or IDB writes.
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {cpus,platform,arch,release} from 'node:os';
const {values}=parseArgs({allowNegative:true,options:{root:{type:'string',default:resolve(import.meta.dirname,'..')},data:{type:'string'},'band-items':{type:'string'},
 catalog:{type:'string'},'public-root':{type:'string'},'chart-map':{type:'string'},input:{type:'string'},output:{type:'string'},event:{type:'string'},
 mode:{type:'string',default:'ordinary'},goal:{type:'string',default:'both'},basis:{type:'string',default:'expectedScore'},
 difficulty:{type:'string',default:'expert'},'max-level':{type:'string',default:'40'},
 'challenge-difficulty':{type:'string',default:'expert'},'challenge-max-level':{type:'string',default:'40'},
 'include-challenge':{type:'boolean',default:false},eco:{type:'boolean',default:true},'time-limit-ms':{type:'string',default:'120000'},
 evaluations:{type:'string',default:'0'},'preflight-only':{type:'boolean',default:false}
 ,'cpu-limit-ms':{type:'string',default:'0'}
}});
for(const key of ['data','catalog','event','output'])if(!values[key])throw Error(`Missing --${key}`);
if(Number(values.evaluations)!==0)throw Error('Full batch benchmark requires --evaluations 0; production full mode always performs complete search');
if(!values['public-root']&&!values['chart-map'])throw Error('Supply --public-root or --chart-map (chart id/analysis URL -> absolute local file)');
const load=p=>import(pathToFileURL(resolve(values.root,p))),read=p=>JSON.parse(readFileSync(p));
const {optimizeEventYield}=await load('site/src/lib/event-yield-optimizer.mjs');
const productionRunner=existsSync(resolve(values.root,'site/src/lib/event-yield-batch.mjs'))?(await load('site/src/lib/event-yield-batch.mjs')).runEventYieldBatch:null;
const proveGroup=productionRunner?(await load('site/src/lib/event-yield-group-proof.mjs')).proveEventYieldGroups:null;
const {eventYieldGoals,selectEventYieldRows}=await load('site/src/lib/event-yield-goals.mjs');
const {eventSongCandidates}=await load('site/src/lib/event-song-ranking.mjs');
const {eventYieldStageInput}=await load('site/src/lib/event-yield-stage.mjs');
const {planEventSearch}=await load('site/src/lib/event-search-plan.mjs');
const {createCalculationScheduler}=await load('site/src/lib/calculation-scheduler.mjs');
const {createInventoryManager}=await load('site/src/lib/inventory-manager.mjs');
const {createTeamDraft}=await load('site/src/lib/team-draft.mjs');
const {maximizeAccount}=await load('site/src/lib/workbench-account-model.mjs');
const {withBandItemLevels}=await load('packages/scoring/scoring-rules/band-item-levels.mjs');
const raw=read(values.data),rawRules=raw.rules??raw,rules=values['band-items']?withBandItemLevels(rawRules,read(values['band-items'])):rawRules,
 catalog=read(values.catalog),personal=values.input?read(values.input):{};
if(catalog.release?.id!==rules.sourceReleaseId)throw Error('Catalog/rules release_mismatch');
const manager=createInventoryManager(rules),inventory=personal.inventory??{memberCardIds:rules.tables.MemberCard.map(r=>`member-card-${r._id}`),
 supportCardIds:rules.tables.SupportCard.map(r=>`support-card-${r._id}`),growth:{}};
if(!personal.inventory)for(const kind of ['member','support'])for(const id of inventory[`${kind}CardIds`])inventory.growth[id]=manager.preset(id,kind,'maximum');
const account=maximizeAccount({},rules);account.tgwCardRank=Math.max(...rules.tables.VipRankBonus.map(r=>r._vipRank));
const draft=personal.draft??createTeamDraft({modifiers:personal.account??account});
const input={draft,inventory,scope:'owned',mode:values.mode,goal:values.goal,basis:values.basis,liveBoost:1,challengeCost:200,budget:100,startingCP:0,
 includeChallenge:values['include-challenge'],challengeScope:'same',challengeBasis:values.basis,searchDepth:'full',eco:values.eco,
 ...personal.options,maxEvaluations:Number(values.evaluations)};
const allowed=rules.tables.ChallengeMusic.filter(r=>r._eventId===Number(values.event)).map(r=>`music-${r._liveMusicId}`);
const data={tracks:catalog.musicTracks,charts:catalog.musicCharts};
const candidates=eventSongCandidates({...data,allowedTrackIds:input.mode==='challenge'?allowed:null,difficulty:values.difficulty,maxLevel:Number(values['max-level'])});
const challenges=eventSongCandidates({...data,allowedTrackIds:allowed,difficulty:values['challenge-difficulty'],maxLevel:Number(values['challenge-max-level'])});
const selected=planEventSearch(candidates,rules,input.draft).full,cycle=input.mode==='ordinary'&&input.includeChallenge;
if(!selected.length||cycle&&!challenges.length)throw Error('No eligible candidates');
const jobs=[...(cycle?challenges.map(candidate=>({candidate,mode:'challenge'})):[]),...selected.map(candidate=>({candidate,mode:input.mode}))];
const chartMap=values['chart-map']?read(values['chart-map']):{},charts=new Map(),missing=[],chartFiles={};
const hash=x=>createHash('sha256').update(x).digest('hex');
const inputFiles=Object.fromEntries(['data','band-items','catalog','chart-map','input'].filter(k=>values[k]).map(k=>[k,{path:resolve(values[k]),sha256:hash(readFileSync(values[k]))}]));
for(const {candidate:c} of jobs){
 if(charts.has(c.id))continue;
 const path=chartMap[c.id]??chartMap[c.analysisDataUrl]??(values['public-root']?resolve(values['public-root'],c.analysisDataUrl.replace(/^\//,'')):null);
 if(!path||!existsSync(path)){missing.push({id:c.id,url:c.analysisDataUrl,path});continue;}
 const bytes=readFileSync(path),chart=JSON.parse(bytes);
 if(chart.sourceReleaseId!=null&&chart.sourceReleaseId!==rules.sourceReleaseId||!c.sourceReleaseIds?.includes(rules.sourceReleaseId))throw Error(`Chart release_mismatch: ${c.id}`);
 if(chart.id!==c.id||chart.trackId!==c.trackId||chart.difficulty!==c.difficulty)throw Error(`Chart identity mismatch: ${c.id}`);
 charts.set(c.id,chart);chartFiles[c.id]={path:resolve(path),sha256:hash(bytes),analysisDataUrl:c.analysisDataUrl,
  releaseBinding:chart.sourceReleaseId?'payload_and_catalog':'catalog_sourceReleaseIds_and_immutable_analysisDataUrl'};
}
const preflight={sourceReleaseId:rules.sourceReleaseId,mode:input.mode,goal:input.goal,basis:input.basis,eco:input.eco,searchDepth:'full',
 fullCandidateSet:true,ordinaryCandidates:input.mode==='ordinary'?selected.length:0,challengeCandidates:cycle?challenges.length:input.mode==='challenge'?selected.length:0,
 plannedCharts:jobs.length,plannedInvocations:jobs.reduce((n,j)=>n+eventYieldGoals(input.goal,j.mode).length,0),availableLocalCharts:charts.size,missing};
if(values['preflight-only']||missing.length){writeFileSync(values.output,JSON.stringify(preflight,null,2)+'\n');console.log(JSON.stringify({...preflight,missing:missing.length}));
 if(missing.length)process.exitCode=2;process.exit();}
const sources={};
for(const directory of ['packages/scoring','site/src/lib'])for(const entry of readdirSync(resolve(values.root,directory),{recursive:true,withFileTypes:true})){
 if(!entry.isFile()||!(entry.name.endsWith('.mjs')||directory==='packages/scoring'&&entry.name.endsWith('.json')))continue;
 const path=resolve(entry.parentPath??entry.path,entry.name);sources[path.slice(resolve(values.root).length+1)]=hash(readFileSync(path));
}
const sorted=Object.fromEntries(Object.entries(sources).sort(([a],[b])=>a.localeCompare(b)));
const scoringSources=Object.fromEntries(Object.entries(sorted).filter(([p])=>p.startsWith('packages/scoring/')&&!/bound|maximum-pairing|search-queue/.test(p)||p==='site/src/lib/formation-candidate-evaluator.mjs'));
const candidateCache=new Map(),challengePlanCache=new Map(),challengeRows=[],rows=[],samples=[],groupSamples=[],controller=new AbortController();
const yieldControl=createCalculationScheduler({eco:input.eco}),start=performance.now(),cpu=process.cpuUsage();
const checkBudget=()=>{
 if(Number(values['time-limit-ms'])&&performance.now()-start>=Number(values['time-limit-ms']))controller.abort();
 const used=process.cpuUsage(cpu);if(Number(values['cpu-limit-ms'])&&(used.user+used.system)/1000>=Number(values['cpu-limit-ms']))controller.abort();
};
const record=({candidate,mode,goal,witnessOnly=false,practicalSeed=false,result,wallMs})=>{
 const parts=[result.practical.fullScoreCalculations,result.certifiedSearch?.fullScoreCalculations,result.certifiedSearch?.boundScoreCalculations];
 let counterCoverage=parts.every(Number.isSafeInteger)?'complete':'incomplete';
 if(counterCoverage==='incomplete'&&practicalSeed&&Number.isSafeInteger(parts[0])){
  parts[1]=0;parts[2]=0;counterCoverage='derived_practical_only';
 }
 if(counterCoverage==='incomplete'&&result.certifiedSearch?.proof==='global_grade_and_bonus_ceiling'&&Number.isSafeInteger(parts[0])){
  parts[1]??=0;parts[2]??=0;counterCoverage='derived_global_ceiling';
 }
 samples.push({id:candidate.id,mode,goal,witnessOnly,practicalSeed,wallMs,optimality:result.optimality,status:result.status,certificate:result.certifiedSearch,
  counterCoverage,fullScoreCalculations:counterCoverage!=='incomplete'?parts.reduce((a,b)=>a+b,0):null,
  practical:result.practical,best:result.results[0]?{scoreRank:result.results[0].reward.scoreRank,total:result.results[0].total,expectedScore:result.results[0].expectedScore}:null});
 if(practicalSeed)console.log(JSON.stringify({practicalSeed:candidate.id,goal,wallMs,best:samples.at(-1).best,elapsedMs:performance.now()-start}));
 checkBudget();
};
let completedCharts=0,batchResult,reportedProgressAt=0,firstResultMs=null;
if(productionRunner){
 batchResult=await productionRunner({rules,eventId:Number(values.event),candidates,challengeCandidates:challenges,input,candidateCache,challengePlanCache,
  loadChart:async c=>charts.get(c.id),yieldControl,signal:controller.signal,proveGroup,
  onJobComplete:record,onGroupComplete:({goal,proof})=>{groupSamples.push({goal,...proof});checkBudget();console.log(JSON.stringify({groupGoal:goal,proven:proof.proven,error:proof.error,
    best:proof.results?.[0]?{song:proof.results[0].song.id,total:proof.results[0].total,scoreRank:proof.results[0].reward.scoreRank}:null,stats:proof.stats,elapsedMs:performance.now()-start}));},
  onMessage:m=>{checkBudget();const now=performance.now();if(firstResultMs===null&&m.rows?.length){firstResultMs=now-start;console.log(JSON.stringify({firstResultMs,done:m.done,total:m.total}));}if(m.type==='progress'&&m.detail?.phase==='event-group-proof'&&now-reportedProgressAt>2000){
    reportedProgressAt=now;console.log(JSON.stringify({stage:m.stage,group:m.detail.group,groups:m.detail.groups,leaders:m.detail.leaders,
      visited:m.detail.visited,expanded:m.detail.expanded,completed:m.detail.completed,elapsedMs:now-start,best:m.detail.bestCandidate?.total}));
   }else if(m.type==='partial'&&now-reportedProgressAt>2000){reportedProgressAt=now;console.log(JSON.stringify({done:m.done,total:m.total,elapsedMs:now-start,evaluatedCharts:m.evaluatedCharts,prunedCharts:m.prunedCharts}));}}});
 completedCharts=batchResult.done;rows.push(...batchResult.rows);
}else for(const {candidate,mode} of jobs){
 if(controller.signal.aborted)break;
 const scoreCache=new Map(),stageInput=eventYieldStageInput(input,mode),found=[];
 for(const goal of eventYieldGoals(input.goal,mode)){
  if(controller.signal.aborted)break;
  const at=performance.now();
  const result=await optimizeEventYield({rules,eventId:Number(values.event),...stageInput,candidate,chart:charts.get(candidate.id),challengeRows,
   candidateCache,scoreCache,challengePlanCache,yieldControl,signal:controller.signal,includeChallenge:mode==='ordinary'&&input.includeChallenge,goal,
   onProgress:checkBudget});
  record({candidate,mode,goal,result,wallMs:performance.now()-at});
  found.push(...result.results.map(r=>({...r,recommendationGoals:[goal],search:{optimality:result.optimality,...result.certifiedSearch}})));
 }
 if(cycle&&mode==='challenge')challengeRows.push(...found);else rows.push(...found);
 const retained=selectEventYieldRows(rows,input.goal,30);rows.splice(0,rows.length,...retained);completedCharts++;
 console.log(JSON.stringify({completedCharts,total:jobs.length,elapsedMs:performance.now()-start,last:samples.at(-1)?.id,bestProven:samples.at(-1)?.certificate?.bestProven}));
}
const usage=process.cpuUsage(cpu),complete=!controller.signal.aborted&&(batchResult?batchResult.coverageComplete:samples.length===preflight.plannedInvocations);
const groupCountersComplete=groupSamples.every(g=>Number.isSafeInteger(g.stats?.fullScoreCalculations)&&Number.isSafeInteger(g.stats?.boundScoreCalculations));
const groupFullScoreCalculations=groupCountersComplete?groupSamples.reduce((n,g)=>n+g.stats.fullScoreCalculations+g.stats.boundScoreCalculations,0):null;
const summary={...preflight,node:process.version,environment:{platform:platform(),arch:arch(),osRelease:release(),cpu:cpus()[0]?.model,cpuCount:cpus().length,v8:process.versions.v8},
 inputHash:hash(JSON.stringify({rules,input,eventId:Number(values.event),jobs,chartFiles})),inputFiles,sourceHash:hash(JSON.stringify(sorted)),scoringModelHash:hash(JSON.stringify(scoringSources)),sourceManifest:sorted,
 chartFiles,runner:productionRunner?'production_shared_batch':'legacy_individual_full_pass',completedCharts,completedInvocations:samples.length,
 evaluatedCharts:batchResult?.evaluatedCharts,prunedCharts:batchResult?.prunedCharts,witnessCharts:batchResult?.witnessCharts,coverageComplete:batchResult?.coverageComplete,
 globalProofs:batchResult?.globalProofs,failures:batchResult?.failures,groupSamples,timeLimitMs:Number(values['time-limit-ms']),cpuLimitMs:Number(values['cpu-limit-ms']),complete,
 allProven:complete&&(batchResult?batchResult.allProven:samples.every(r=>r.certificate?.bestProven)),
 firstResultMs,wallMs:performance.now()-start,cpuMs:(usage.user+usage.system)/1000,rssBytes:process.resourceUsage().maxRSS*1024,
 groupFullScoreCalculations,fullScoreCalculations:groupCountersComplete&&samples.every(r=>r.counterCoverage!=='incomplete')?samples.reduce((n,r)=>n+r.fullScoreCalculations,groupFullScoreCalculations):null,
 expanded:samples.reduce((n,r)=>n+(r.certificate?.expanded??0),0)+groupSamples.reduce((n,g)=>n+(g.stats?.expanded??0),0),samples,
 winners:selectEventYieldRows(rows,input.goal).map(r=>({song:r.song.id,total:r.total,scoreRank:r.reward.scoreRank,recommendationGoals:r.recommendationGoals,search:r.search}))};
writeFileSync(values.output,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({output:values.output,complete,allProven:summary.allProven,wallMs:summary.wallMs,cpuMs:summary.cpuMs}));
