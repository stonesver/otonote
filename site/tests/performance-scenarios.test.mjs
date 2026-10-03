import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTeamDraft } from '../src/lib/team-draft.mjs';
import { createPerformanceTemplate, createPerformanceSongCalculator, validatePerformance } from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import { createPerformanceScenario, normalizePerformanceScenario, resolveTimingJudgement } from '../../packages/scoring/scoring-rules/performance-scenarios.mjs';
import { createScenarioSongCalculator } from '../../packages/scoring/scoring-rules/performance-scenario-calculator.mjs';
import { createGekisouSongCalculator } from '../../packages/scoring/scoring-rules/gekisou-song-score.mjs';
import { replayGekisouFrames } from '../../packages/scoring/scoring-rules/gekisou-frame-replay.mjs';

const rules = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
function fixture(times = [100,200,300,400,1000,1100,1200,2100,3100,4100,5100,6100,7100]) {
  const r = structuredClone(rules);
  const c = { id: 'music-chart-10000103', trackId: 'music-100001', difficulty: 'expert', bpmEvents: [{tick:0,bpm:125}],
    skillTimings: [1,2,3,4,5], feverRanges: [{start:1,end:2},{start:3,end:4},{start:5,end:7}],
    notes: times.map((tick,i)=>({id:`tap-${i}`,type:'tap',tick,position:0,size:1})) };
  r.tables.LiveMusicScore.find(row=>row._id===10000103)._musicScoreLevel=5;
  const music = r.tables.LiveMusic.find(row=>row._id===100001); [1,2,3].forEach(i=>music[`_gekisouMission${i}`]=i);
  for(const m of r.tables.MemberCard) m._gekisouSkillID=0;
  for(const s of r.tables.SupportCard) { s._supportSkillId01=s._supportSkillId02=0;s._gekisouSupportSkillId01=s._gekisouSupportSkillId02=0; }
  for(const e of r.tables.LiveSkillEffect) e._effectValue=0;
  const d = createTeamDraft({ slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`})),selectedSongId:c.trackId,selectedDifficulty:c.difficulty });
  return {r,c,d,p:createPerformanceTemplate(r,c)};
}
test('reference profiles are seeded chart inputs independent from teams; hard ranges change only their events',()=>{
  const {r,c} = fixture();
  const s = {profile:'steady',seed:42,samples:2};
  const a = createPerformanceScenario(r,c,s), b = createPerformanceScenario(r,c,s);
  assert.deepEqual(a,b); assert.notDeepEqual(a,createPerformanceScenario(r,c,s,1));
  assert.equal(validatePerformance(r,c,a).valid,true);
  const difficult=createPerformanceScenario(r,c,{...s,difficultRanges:[{startMs:1000,endMs:2000,spreadMultiplier:2}]});
  a.judgements.forEach((row,i)=>{if(row.timeMs<1000||row.timeMs>2000)assert.deepEqual(row,difficult.judgements[i]);});
  assert.throws(()=>normalizePerformanceScenario({samples:17}),/player samples/);
  assert.throws(()=>normalizePerformanceScenario({profile:'expert'}),/未知/);
});
test('raw timing respects GREAT GOOD BAD MISS windows and JUST requires enabled note type',()=>{
  for(const [timingOffsetMs,expected] of [[0,5],[60,4],[90,3],[110,2],[140,1]])assert.equal(resolveTimingJudgement(rules,{type:1,timingOffsetMs}),expected);
  assert.equal(resolveTimingJudgement(rules,{type:1,timingOffsetMs:0},{justEnabled:true}),6);
  assert.equal(resolveTimingJudgement(rules,{type:22,timingOffsetMs:0},{justEnabled:true}),5);
  assert.equal(resolveTimingJudgement(rules,{type:1,timingOffsetMs:0,missed:true},{justEnabled:true}),1);
  assert.equal(resolveTimingJudgement(rules,{type:1,originalJudgement:4,timingOffsetMs:0},{justEnabled:true,justExpansion:()=>100}),4);
});
test('Gekisou non-AP input reconstructs life/combo, score targets, perfect counts and traces',()=>{
  const {r,c,d,p}=fixture();
  [1,2,3,4,5,4,3,1,2,5,5,5,5].forEach((j,i)=>p.judgements[i].judgement=j);
  const result=createGekisouSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  const trace=result.bestSample;
  assert.equal(trace.performance.life,700); assert.equal(trace.performance.totalDamage,300);
  assert.equal(trace.performance.fullCombo,false); assert.equal(trace.performance.maxCombo,5);
  assert.deepEqual(trace.notes.map(n=>n.judgement),p.judgements.map(n=>n.judgement));
  assert.equal(trace.notes.reduce((s,n)=>s+n.score,0)+trace.rankingBonus,result.expectedScore);
  assert.equal(trace.notes.filter(n=>n.judgement<=2).reduce((s,n)=>s+n.score,0),0);
  assert.equal(result.orderCount,1);
});
test('ordinary recovery and life-conditioned score skills use the same phase order in Gekisou',()=>{
  const {r,c,d,p}=fixture();
  p.judgements.slice(0,4).forEach(n=>n.judgement=1);
  r.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=51;
  for(const e of r.tables.SupportSkillEffect.filter(e=>e._supportSkillID===51))e._effectValue=100;
  const effect=r.tables.LiveSkillEffect.find(e=>e._liveSkillID===1&&e._level===1);
  effect._skillConditionGroup=14;effect._skillEffectType=2004;effect._skillTargetIDs=[41,46];effect._effectValue=10000;
  const ordinary=createPerformanceSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  const result=createGekisouSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  assert.deepEqual(result.bestSample.ordinarySkillTrace,ordinary.skillTrace);
  assert.deepEqual(result.skillPlayback.variants[0].skillTrace,ordinary.skillTrace);
  assert.equal(result.skillPlayback.skills[0].supportEffects[0].contribution,'life_recovery');
  assert.equal(result.bestSample.ordinarySkillTrace.find(e=>e.type===2004).currentLife,700);
  assert.deepEqual(result.bestSample.notes.map(n=>n.lifeAtInput),ordinary.bestOrderNotes.map(n=>n.lifeAtInput));
});
test('ordinary converters in Gekisou consume only successful input after their activation frame',()=>{
  const {r,c,d,p}=fixture([1000,1010,1100,1200,1300,1400,6001]);
  r.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=31;
  p.judgements.forEach(n=>n.judgement=4);p.judgements[2].judgement=5;
  const a=createPerformanceSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  const b=createGekisouSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  assert.deepEqual(b.bestSample.notes.map(n=>n.judgement),a.bestOrderNotes.map(n=>n.judgement));
  assert.equal(b.bestSample.performance.convertedCount,3);
});
test('shared adapter records fixed raw sample hashes and aggregates actual outcome distributions',()=>{
  const {r,c,d}=fixture();
  for(const mode of ['ordinary','gekisou']) {
    const calc=createScenarioSongCalculator(r,c,{mode,performanceScenario:{profile:'practice',seed:5,samples:2},scorePrecision:'screen'});
    const a=calc.calculate(d,{includeTrace:true}),b=calc.calculate({...d,modifiers:{...d.modifiers,tgwCardRank:2}});
    assert.deepEqual(a.playerSamples.map(s=>s.inputHash),b.playerSamples.map(s=>s.inputHash));
    assert.equal(a.playerSampleCount,2);assert.equal(a.scoreDistribution.count,a.sampleCount);assert.equal(a.orderCount,10);
    assert.equal(a.randomSources.player,true);assert.equal(a.randomSources.skillOrder,true);
    assert.deepEqual(a.performanceScenario,a.playerScenario);assert.equal(a.skillPlayback.randomSampling,true);
    assert.equal(a.expectedScore,a.scoreDistribution.mean);assert.ok(a.minimumScore<=a.maximumScore);
    assert.equal(a.scoreDistribution.complete,false);assert.ok(a.skillPlayback.variants.length>=2);
  }
});

function frameFixture(grades, effects, { missionType = 3, raw = false } = {}) {
  const frames = Array.from({length:4000},(_,timeMs)=>({timeMs,deltaSeconds:.001}));
  const events = grades.map((grade,i)=>({id:String(i),scoreIndex:i,type:1,timeMs:1000+i*100,inputFrame:1000+i*100,
    ...(raw ? {timingOffsetMs:grade} : {originalJudgement:grade})}));
  return replayGekisouFrames(rules,{events,skillTimes:[3000,3100,3200,3300,3400]},
    [{index:1,missionType,startMs:1000,endMs:2000}],effects,
    {ranks:[1],frameRate:60,frames,timingOffsetMs:0},1,{trace:true,performanceInput:{judgements:events}});
}
const effect = (type, overrides = {}) => ({active:true,missionType:3,key:'support:0:test',slotIndex:0,kind:'support',probability:100,
  trigger:[{_conditionType:7010}],definition:{_id:900001,_skillEffectType:type,_activationTimeSecond:1,_effectValue:10000,_effectLimitCount:0,_effectExecuteLimitCount:0},...overrides});
test('window expansion responds to original timing only after activation; explicit grades remain fixed',()=>{
  const expand=effect(4004);
  const raw=frameFixture([3,3,3],[expand],{raw:true});
  assert.deepEqual(raw.events.map(n=>n.judgement),[5,6,6]);
  const explicit=frameFixture([4,4,4],[expand]);
  assert.deepEqual(explicit.events.map(n=>n.judgement),[4,4,4]);
});
test('Gekisou converters use declared target grades and charges, without rescuing other grades',()=>{
  const convert=effect(12006,{targets:[4,3],definition:{_id:900002,_skillEffectType:12006,_activationTimeSecond:0,_effectValue:5,_effectLimitCount:2}});
  const replay=frameFixture([4,4,1,3,4],[convert]);
  assert.deepEqual(replay.events.map(n=>n.judgement),[4,5,1,5,4]);
  assert.equal(replay.performance.convertedCount,2);
  assert.equal(replay.performance.life,900);
});
test('dynamic Gekisou activation reads damaged life and only activates the matching branch',()=>{
  const high=effect(13000,{eligible:life=>life>=1000,definition:{_skillEffectType:13000,_activationTimeSecond:0,_effectValue:2,_effectLimitCount:0}});
  const low=effect(13000,{key:'low',eligible:life=>life<1000,definition:{_skillEffectType:13000,_activationTimeSecond:0,_effectValue:1,_effectLimitCount:0}});
  const replay=frameFixture([1,6,6],[high,low]);
  assert.equal(replay.states[0].effects[0].triggered,false);
  assert.equal(replay.states[0].effects[1].triggered,true);
  assert.equal(replay.states[0].rawJust,2);assert.equal(replay.states[0].just,4);
});
test('Gekisou delayed-input ordinary combo matches ordinary replay rather than future history',()=>{
  const {r,c,d,p}=fixture([100,200,300]);
  r.tables.LiveComboScoreBonus=[{_comboBonusType:0,_requiredComboCount:1,_bonusFactor:.5}];
  p.judgements[0].judgement=1;p.judgements[0].inputFrame=30;
  p.judgements[1].inputFrame=0;p.judgements[2].inputFrame=40;
  const a=createPerformanceSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  const b=createGekisouSongCalculator(r,c,{performance:p}).calculate(d,{includeTrace:true});
  assert.deepEqual(b.bestSample.notes.map(n=>n.comboFactor),a.bestOrderNotes.map(n=>n.comboFactor));
  assert.deepEqual(b.bestSample.notes.map(n=>n.lifeAtInput),a.bestOrderNotes.map(n=>n.lifeAtInput));
  assert.equal(a.expectedScore,b.expectedScore);
});

test('COMBO task breaks retain max; guards preserve only task combo and consume every matching handle',()=>{
  const guard=effect(12004,{missionType:1,targets:[1],definition:{_skillEffectType:12004,_activationTimeSecond:1,_effectLimitCount:1}});
  const plain=frameFixture([5,5,1,5,2,3],[],{missionType:1});
  assert.equal(plain.states[0].combo,1);assert.equal(plain.states[0].maxCombo,2);
  const replay=frameFixture([5,5,1,5,1,3],[guard,{...guard,key:'other'}],{missionType:1});
  assert.equal(replay.events[2].gekisouComboProtected,true);
  assert.equal(replay.events[4].gekisouComboProtected,false);
  assert.equal(replay.states[0].maxCombo,3);assert.equal(replay.states[0].combo,1);
  assert.equal(replay.performance.maxCombo,2);assert.equal(replay.performance.fullCombo,false);
});

test('every released Gekisou support definition accepts explicit non-AP input without assuming full life',()=>{
  const {r,c,d,p}=fixture();
  p.judgements.forEach((row,i)=>row.judgement=[1,2,3,4,5,6][i%6]);
  for(const skill of r.tables.GekisouSupportSkill) {
    const support=r.tables.SupportCard.find(row=>row._id===1);
    support._gekisouSupportSkillId01=skill._id;
    const result=createGekisouSongCalculator(r,c,{performance:p}).calculate(d);
    assert.ok(Number.isSafeInteger(result.expectedScore),`support skill ${skill._id}`);
    assert.equal(result.scenario.life,'replayed');
  }
});
test('raw input preserves unexpanded and effective grades, and disallows a second conflicting frame clock',()=>{
  const replay=frameFixture([3,3],[effect(4004)],{raw:true});
  assert.deepEqual(replay.events.map(n=>n.originalJudgement),[5,5]);
  assert.deepEqual(replay.events.map(n=>n.windowJudgement),[5,6]);
  const {r,c}=fixture();
  assert.throws(()=>createGekisouSongCalculator(r,c,{performanceScenario:{profile:'ideal'},scenario:{frames:[{timeMs:0,deltaSeconds:0}]}}),/时钟/);
});

test('task COMBO transition matches all 48 captured native instruction-block outcomes',async()=>{
  const {applyGekisouComboJudgement}=await import('../../packages/scoring/scoring-rules/gekisou-frame-replay.mjs');
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/gekisou-combo-native.json',import.meta.url)));
  assert.equal(fixture.clientSha256,rules.nativeSha256);
  const targets=mask=>[1,2,3,4,5,6].filter(j=>mask&(1<<j));
  for(const row of fixture.cases){
    const result=applyGekisouComboJudgement({combo:5,maxCombo:8},row.judgement,3,
      [...row.masks.map(mask=>({targets:targets(mask),remaining:2})),...row.unlimited.map(mask=>({targets:targets(mask),remaining:null}))]);
    assert.equal(result.combo,row.combo);assert.equal(result.maxCombo,row.maxCombo);
    assert.deepEqual(result.remaining.slice(0,row.masks.length),row.remaining);
  }
});

test('COMBO ranking uses maximum task combo even after a late break',()=>{
  const {r,c,d,p}=fixture([1010,1100,1200,1300,1400,1500,1600,1700,1800,1900]);
  p.judgements.at(-1).judgement=1;
  const opponent={sections:[{combo:8,luckPoints:0,just:0,noteScore:0,perfectCount:0},
    {combo:0,luckPoints:0,just:0,noteScore:0,perfectCount:0},{combo:0,luckPoints:0,just:0,noteScore:0,perfectCount:0}]};
  const result=createGekisouSongCalculator(r,c,{performance:p,scenario:{opponents:[opponent]}}).calculate(d);
  assert.equal(result.sections[0].currentCombo,0);
  assert.equal(result.sections[0].combo,9);assert.equal(result.sections[0].maxCombo,9);
  assert.equal(result.sections[0].rank,1);
});

test('saved scenario versions are checked and descriptions reflect normalized custom conditions',()=>{
  assert.throws(()=>normalizePerformanceScenario({version:'performance-scenario-v999'}),/版本不受支持/);
  assert.throws(()=>normalizePerformanceScenario({version:'performance-scenario-v0'}),/版本不受支持/);
  const scenario=normalizePerformanceScenario({profile:'steady',timingBiasMs:25,timingSpreadMs:90,missRate:.035,samples:2,
    difficultRanges:[{startMs:1000,endMs:2000,spreadMultiplier:2}],description:'旧的默认说明'});
  assert.match(scenario.description,/25 毫秒/);assert.match(scenario.description,/±90 毫秒/);
  assert.match(scenario.description,/3.5%/);assert.match(scenario.description,/1 处难段/);assert.match(scenario.description,/2 组参考样本/);
  assert.doesNotMatch(scenario.description,/65|旧的默认说明/);
  assert.deepEqual(normalizePerformanceScenario(scenario),scenario);
});
