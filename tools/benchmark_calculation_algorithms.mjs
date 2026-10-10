import { readFileSync, readdirSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
  root: { type: 'string', default: resolve(import.meta.dirname, '..') },
  datasets: { type: 'string' }, output: { type: 'string' },
  phase: { type: 'string', default: 'replay' }, samples: { type: 'string', default: '3' },
  limit: { type: 'string', default: '0' }, evaluations: { type: 'string', default: '20' },
  stride: { type: 'string', default: '1' },
  'chart-id': { type: 'string' },
  'diagnostic-memory': { type: 'boolean', default: false },
  compare: { type: 'string' }
} });
if (!values.datasets || !values.output) throw new Error('--datasets and --output are required');
if (!['audit','planner','replay','gekisou','search','events','challenge'].includes(values.phase)) throw new Error('Invalid phase');
if (!Number.isSafeInteger(Number(values.stride)) || Number(values.stride)<1) throw new Error('Invalid chart stride');
const sha256 = value => createHash('sha256').update(value).digest('hex');
if (values['diagnostic-memory'] && !globalThis.gc) throw new Error('Memory diagnostics require --expose-gc');
let memorySamples = [], memoryPhase = '', memoryTicks = 0;
const sampleMemory = (phase, collect = false) => {
  if (!values['diagnostic-memory']) return;
  if (collect) globalThis.gc();
  memorySamples.push({ phase, collected: collect, ...process.memoryUsage() });
};
const load = p => import(pathToFileURL(resolve(values.root, p)));
const { createTeamDraft } = await load('site/src/lib/team-draft.mjs');
const { createFormalSongCalculator } = await load('packages/scoring/scoring-rules/formal-song-score.mjs');
const { createScenarioSongCalculator } = await load('packages/scoring/scoring-rules/performance-scenario-calculator.mjs');
const { createPerformanceScenario } = await load('packages/scoring/scoring-rules/performance-scenarios.mjs');
const { createGekisouSongCalculator } = await load('packages/scoring/scoring-rules/gekisou-song-score.mjs');
const { createFormalSkillResolver } = await load('packages/scoring/scoring-rules/formal-skills.mjs');
const { compileGekisouEffects } = await load('packages/scoring/scoring-rules/gekisou-skill-runtime.mjs');
const { createFormationCalculator } = await load('packages/scoring/scoring-rules/formation-power.mjs');
const { stableSnapshotHash } = await load('packages/scoring/scoring-engine.mjs');
const { optimizeInventory } = await load('site/src/lib/inventory-optimizer.mjs');
const { optimizePractical } = await load('site/src/lib/practical-optimizer.mjs');
const { optimizeChallenge } = await load('site/src/lib/challenge-optimizer.mjs');
const { optimizeEventYield } = await load('site/src/lib/event-yield-optimizer.mjs');
const { createEventEfficiency,createChallengeSpendingPlanner,planChallengeSpending } = await load('packages/scoring/scoring-rules/event-efficiency.mjs');
const datasets = JSON.parse(readFileSync(values.datasets));
const expected = new Map(values.compare ? readFileSync(values.compare, 'utf8').trim().split('\n').filter(Boolean).map(line => {
  const r = JSON.parse(line); return [r.key, r];
}) : []);
mkdirSync(dirname(resolve(values.output)), { recursive: true });
writeFileSync(values.output, '');
const summary = { node: process.version, root: values.root, phase: values.phase, samples: Number(values.samples),
  machine: { platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCPUs:cpus().length },
  growth:'level=1, rank=1, awake=1, skillLevel=1, gekisouSkillLevel=1', searchEvaluations:Number(values.evaluations),chartStride:Number(values.stride),
  selectedChart: values['chart-id'] ?? null,
  diagnosticMemory: values['diagnostic-memory'],
  startedAt: new Date().toISOString(), datasets: [], rows: 0, failures: 0, mismatches: 0, cpuMs: 0, wallMs: 0 };
const emit = row => { appendFileSync(values.output, JSON.stringify(row) + '\n'); summary.rows++; if (row.error) summary.failures++; if (row.equal === false) summary.mismatches++; summary.cpuMs += row.cpuMs ?? 0; summary.wallMs += row.wallMs ?? 0; };
for (const dataset of datasets) {
  const rules = JSON.parse(readFileSync(dataset.rules)), tables = rules.tables;
  const files = readdirSync(dataset.charts).filter(f => /^music-chart-\d+\.json$/.test(f)).sort();
  const ids = new Set(files.map(f => Number(/\d+/.exec(f)[0]))), masters = tables.LiveMusicScore.map(r => r._id);
  const missing = masters.filter(id => !ids.has(id)), extra = [...ids].filter(id => !masters.includes(id));
  if (missing.length || extra.length) throw new Error(`Incomplete chart corpus ${rules.sourceReleaseId}: missing=${missing}, extra=${extra}`);
  const census = { sourceReleaseId: rules.sourceReleaseId, rulesHash: stableSnapshotHash(rules), ruleSetVersion: rules.ruleSetVersion,
    rulesSha256:sha256(readFileSync(dataset.rules)),chartsSha256:sha256(files.map(f=>sha256(readFileSync(resolve(dataset.charts,f)))).join('\n')),
    verificationStatus: rules.verificationStatus, members: tables.MemberCard.length, supports: tables.SupportCard.length,
    masterCharts: masters.length, chartFiles: files.length, testedCharts: 0, missing, extra, coveredMembers: [], coveredSupports: [] };
  const events=tables.Event.filter(e=>e._eventType===1&&(!dataset.eventIds||dataset.eventIds.includes(e._id)));
  census.eventIds=events.map(e=>e._id);
  summary.datasets.push(census);
  const memberCoverage = new Set(), supportCoverage = new Set(), resolver = createFormalSkillResolver(rules, { dynamic: true });
  const growth = {};
  for (const card of tables.MemberCard) growth[`member-card-${card._id}`] = { level: 1, rank: 1, awake: 1, skillLevel: 1, gekisouSkillLevel: 1 };
  for (const card of tables.SupportCard) growth[`support-card-${card._id}`] = { level: 1, rank: 1 };
  const inventory = { memberCardIds: tables.MemberCard.map(c => `member-card-${c._id}`), supportCardIds: tables.SupportCard.map(c => `support-card-${c._id}`), growth };
  if(values.phase==='planner'){
    for(const event of events)for(const metric of ['badges','eventPoints']){
      const model=createEventEfficiency({tables,sourceReleaseId:rules.sourceReleaseId,eventId:event._id});
      const options=tables.ChallengeMusicBoostBonus.map(r=>model.rewards({mode:'challenge',scoreRank:7,
        rewardBP:12345,eventPointBP:23456,challengeCost:r._consumedChallengePointCount}));
      const start=performance.now(),cpu=process.cpuUsage();
      const query=createChallengeSpendingPlanner?createChallengeSpendingPlanner(options,metric):cp=>planChallengeSpending(options,cp,metric);
      const results=Array.from({length:1000},(_,i)=>query(i*7919%500001)),usage=process.cpuUsage(cpu);
      emit({key:`${rules.sourceReleaseId}:planner:${event._id}:${metric}`,mode:metric,queries:results.length,
        wallMs:performance.now()-start,cpuMs:(usage.user+usage.system)/1000,fingerprint:stableSnapshotHash(results)});
    }
    continue;
  }
  if (values.phase === 'audit') {
    const calculator=createFormationCalculator(rules);
    for (const [kind,cards] of [['Member',tables.MemberCard],['Support',tables.SupportCard]]) for(const card of cards) {
      for(let rank=1;rank<=5;rank++) for(const awake of kind==='Member'?[1,2,3,4,5]:[1]) {
        const key=`${rules.sourceReleaseId}:growth:${kind}:${card._id}:${rank}:${awake}`;
        try {const maximum=calculator.resolveGrowth(card,kind,{rank,awake});calculator.resolveGrowth(card,kind,{rank,awake,level:1});emit({key,supported:true,maximumLevel:maximum.level});}
        catch(error){emit({key,error:error.message});}
      }
    }
    for (const memberCardId of inventory.memberCardIds) for (const supportCardId of inventory.supportCardIds) {
      for(let skillLevel=1;skillLevel<=5;skillLevel++)for(let rank=1;rank<=5;rank++) {
        const key=`${rules.sourceReleaseId}:${memberCardId}:${supportCardId}:${skillLevel}:${rank}`;
        try {
          const draft={slots:[{memberCardId,supportCardId}],modifiers:{growth:{
            [memberCardId]:{...growth[memberCardId],skillLevel,gekisouSkillLevel:skillLevel},[supportCardId]:{...growth[supportCardId],rank}}}};
          resolver(draft);compileGekisouEffects(rules,draft,true,[1,2,3]);
          emit({key,supported:true});
        } catch (error) {emit({key,error:error.message});}
      }
    }
    census.coveredMembers=inventory.memberCardIds;census.coveredSupports=inventory.supportCardIds;
    census.auditSkillLevels=[1,2,3,4,5];census.auditSupportRanks=[1,2,3,4,5];
    continue;
  }
  for (const [index, file] of files.entries()) {
    if (values['chart-id'] && file !== `${values['chart-id']}.json`) continue;
    if (Number(values.limit) && index >= Number(values.limit)) break;
    if(index%Number(values.stride))continue;
    const chart = JSON.parse(readFileSync(resolve(dataset.charts, file)));
    if (chart.sourceReleaseId && chart.sourceReleaseId !== rules.sourceReleaseId) throw new Error(`Chart release mismatch: ${file}`);
    if (values.phase === 'challenge' && !tables.ChallengeMusic.some(m => events.some(e => e._id === m._eventId)
      && `music-${m._liveMusicId}` === chart.trackId)) continue;
    const selected = [], characters = new Set();
    for (let i = 0; i < tables.MemberCard.length && selected.length < 5; i++) {
      const member = tables.MemberCard[(index + i) % tables.MemberCard.length];
      if (!characters.has(member._characterID)) { selected.push(member); characters.add(member._characterID); }
    }
    const slots = selected.map((m, i) => ({ memberCardId: `member-card-${m._id}`, supportCardId: `support-card-${tables.SupportCard[(index * 5 + i) % tables.SupportCard.length]._id}` }));
    slots.forEach(s => { memberCoverage.add(s.memberCardId); supportCoverage.add(s.supportCardId); });
    const draft = createTeamDraft({ slots, selectedSongId: chart.trackId, selectedDifficulty: chart.difficulty, modifiers: { growth } });
    const base = { rules, chart, draft, scope: 'owned', inventory, topN: 1,
      yieldControl: async () => { if (values['diagnostic-memory'] && ++memoryTicks % 100 === 0) sampleMemory(memoryPhase); },
      onProgress: p => { const phase = p.stage ?? p.phase; if (values['diagnostic-memory'] && phase !== memoryPhase) {
        sampleMemory(memoryPhase); memoryPhase = phase; sampleMemory(phase, true);
      } } };
    const jobs = values.phase === 'replay' ? [
      ['ideal', () => createFormalSongCalculator(rules, chart).calculate(draft)],
      ['steady', () => createScenarioSongCalculator(rules, chart, { performanceScenario: { profile: 'steady', samples: Number(values.samples) } }).calculate(draft)]
    ] : values.phase === 'gekisou' ? [
      ['gekisou-ideal',()=>createGekisouSongCalculator(rules,chart,{scenario:{batches:2}}).calculate(draft)],
      ['gekisou-steady-fixed-order',()=>createGekisouSongCalculator(rules,chart,{
        performance:createPerformanceScenario(rules,chart,{profile:'steady',seed:20260927}),
        performanceOrder:'fixed',scenario:{batches:2}}).calculate(draft)]
    ] : values.phase === 'search' ? [
      ['power', () => optimizeInventory({ ...base, objective: 'formation_power', maxEvaluations: 0 })],
      ['score', () => optimizeInventory({ ...base, objective: 'expected_song_score', maxEvaluations: Number(values.evaluations) })],
      ['practical', () => optimizePractical({ ...base, objective: 'expected_song_score' })]
    ] : ['events','challenge'].includes(values.phase) ? events.flatMap(event => {
      const candidate = { id: chart.id, trackId: chart.trackId, difficulty: chart.difficulty, title: chart.trackId, seconds: chart.duration };
      const eventBase = { ...base, candidate, eventId: event._id, includeChallenge: false };
      return [...(values.phase === 'events' ? [['yield', () => optimizeEventYield(eventBase),event._id]] : []),
        ...(tables.ChallengeMusic.some(m => m._eventId === event._id && `music-${m._liveMusicId}` === chart.trackId)
          ? [['challenge', () => optimizeChallenge({ ...base, eventId: event._id }),event._id]] : [])];
    }) : [];
    for (const [mode, job,eventId] of jobs) {
      memorySamples = []; memoryPhase = 'start'; memoryTicks = 0; sampleMemory('start', true);
      const key = `${rules.sourceReleaseId}:${chart.id}:${mode}${eventId==null?'':`:event-${eventId}`}`, start = performance.now(), cpu = process.cpuUsage();
      try {
        const result = await job(), usage = process.cpuUsage(cpu);
        const comparable = ['replay','gekisou'].includes(values.phase) ? result : { status: result.status, optimality: result.optimality, values: result.results.map(r => r.value), upperBound: result.upperBound };
        const fingerprint = stableSnapshotHash(comparable), before = expected.get(key);
        if(values.compare&&!before)throw new Error(`Missing comparison baseline: ${key}`);
        expected.delete(key);
        const value=result.expectedScore??result.results[0]?.value;
        sampleMemory('returned'); sampleMemory('returned', true);
        const exactComparison=['replay','gekisou'].includes(values.phase)||mode==='power'||mode==='practical';
        const certifiedComparison=before?.optimality==='proven_within_model'&&result.optimality==='proven_within_model';
        emit({ key, chartId: chart.id, mode,eventId,wallMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000,
          rssBytes: process.memoryUsage().rss, fingerprint,
          ...(values['diagnostic-memory'] ? { memorySamples } : {}),
          ...(result.results ? { resultsFingerprint: stableSnapshotHash(result.results),
            resultValues: result.results.map(row=>row.value),
            resultObjectives: result.results.map(row=>({value:row.value,total:row.total,scoreRank:row.reward?.scoreRank,
              expectedScore:row.expectedScore,maximumScore:row.maximumScore})) } : {}),
          ...(before ? { ...(exactComparison?{equal:before.fingerprint===fingerprint}:certifiedComparison?{equal:before.value===value}:{}),
            valueDelta:value-before.value,beforeWallMs:before.wallMs,beforeCpuMs:before.cpuMs,beforeOptimality:before.optimality,beforeGap:before.gap } : {}),
          value,evaluated: result.evaluated, status: result.status,
          optimality: result.optimality, gap: result.optimalityGap??result.certifiedSearch?.optimalityGap,
          frontier:result.certifiedSearch?.frontier,scoringCoverage: result.scoringCoverage });
      } catch (error) { const usage = process.cpuUsage(cpu); emit({ key, chartId: chart.id, mode, error: error.message, wallMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000 }); }
    }
    census.testedCharts++;
    census.coveredMembers = [...memberCoverage].sort(); census.coveredSupports = [...supportCoverage].sort();
    writeFileSync(values.output + '.summary.json', JSON.stringify(summary, null, 2));
    if ((index + 1) % 10 === 0) console.log(JSON.stringify({ release: rules.sourceReleaseId, charts: index + 1, total: files.length, failures: summary.failures, mismatches: summary.mismatches }));
  }
}
summary.finishedAt = new Date().toISOString();
summary.maxRssKiB = process.resourceUsage().maxRSS;
if(values.compare&&expected.size){summary.missingComparisons=[...expected.keys()];summary.failures+=expected.size;}
writeFileSync(values.output + '.summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (summary.failures || summary.mismatches) process.exitCode = 1;
