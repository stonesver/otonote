import test from 'node:test';
import assert from 'node:assert/strict';
import { maximumPairing } from '../../packages/scoring/scoring-rules/maximum-pairing.mjs';
import { createScoreReplay } from '../../packages/scoring/scoring-rules/formal-score-replay.mjs';
import { readFileSync } from 'node:fs';
import { createFormalSongCalculator } from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import { createFormationCalculator } from '../../packages/scoring/scoring-rules/formation-power.mjs';
import { createTeamDraft } from '../src/lib/team-draft.mjs';
import { compilePairingModels } from '../src/lib/inventory-optimizer.mjs';
import { resolveSearchInput } from '../../packages/scoring/scoring-rules/formation-input.mjs';

function random(seed) {
  return max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
}

// Independent subset enumeration includes negative weights, missing edges,
// shared characters, required vertices, locked edges and forbidden edges.
test('compact residual matching agrees with exhaustive constrained small graphs', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const next = random(seed), edges = [];
    for (let m = 0; m < 5; m++) for (let s = 0; s < 4; s++) if (next(5))
      edges.push({key:`${m}|${s}`,member:m,support:s,character:m===4?0:m,weight:next(11)-5});
    const required = seed%3 ? [] : [edges[next(edges.length)].key];
    const forbidden = seed%4 ? [] : [edges[next(edges.length)].key];
    const requiredMembers = [next(5)], requiredSupports = seed%2 ? [next(4)] : [];
    let optimum = -Infinity;
    for (let a=0;a<edges.length;a++)for(let b=a+1;b<edges.length;b++)for(let c=b+1;c<edges.length;c++){
      const team=[edges[a],edges[b],edges[c]],keys=team.map(e=>e.key);
      if(['member','support','character'].some(field=>new Set(team.map(e=>e[field])).size!==3)
        ||required.some(k=>!keys.includes(k))||forbidden.some(k=>keys.includes(k))
        ||requiredMembers.some(m=>!team.some(e=>e.member===m))||requiredSupports.some(s=>!team.some(e=>e.support===s)))continue;
      optimum=Math.max(optimum,team.reduce((sum,e)=>sum+e.weight,0));
    }
    const result=maximumPairing({edges,count:3,required,forbidden,requiredMembers,requiredSupports});
    assert.equal(result?.weight??-Infinity,optimum,`seed ${seed}`);
    // Real callers reweight shared immutable edges for skill/reward profiles.
    // Check both the optimum and the exact tie-selected pairing under locks.
    const weight = e => 3*e.weight + e.member;
    const copied=maximumPairing({edges:edges.map(e=>({...e,weight:weight(e)})),count:3,required,forbidden,requiredMembers,requiredSupports});
    const shared=maximumPairing({edges:edges.map(Object.freeze),weight,count:3,required,forbidden,requiredMembers,requiredSupports});
    assert.equal(shared?.weight,copied?.weight);
    assert.deepEqual(shared?.edges.map(e=>e.key),copied?.edges.map(e=>e.key));
  }
});

test('score-only replay preserves late-command and rewind state without copying or mutating notes', () => {
  for (let seed=1;seed<=40;seed++) {
    const next=random(seed),scoreNote=(note,state)=>({score:Math.max(0,Math.floor((state.general+state.perfect)*10000+note.id))});
    const full=createScoreReplay({musicLengthMs:2000,scoreNote});
    const compact=createScoreReplay({musicLengthMs:2000,scoreNote,retainNotes:false});
    for(let i=0;i<300;i++){
      const timeMs=next(3000),action=next(5);
      if(action<2){
        const note=Object.freeze({timeMs,id:i,sourceIndex:next(3),sequence:9999});
        full.addNote(note);compact.addNote(note);
      } else if(action===2){
        const command={timeMs,ownerId:next(5)*100+1,general:Math.fround((next(7)-3)/10),perfect:Math.fround(next(3)/10)};
        full.addFactor(command);compact.addFactor(command);
      } else {
        assert.equal(compact.calculate(timeMs),full.calculate(timeMs),`seed ${seed}, query ${i}`);
        assert.deepEqual(compact.state,full.state);
      }
    }
    assert.equal(compact.calculate(5000),full.calculate(5000));
    assert.deepEqual(compact.state,full.state);
    assert.equal(compact.notes.length,0);
  }
});

test('score-only replay preserves pending fixed-score installation and rollback',()=>{
  const create=retainNotes=>createScoreReplay({musicLengthMs:500,retainNotes,scoreNote:()=>({score:7})});
  const full=create(true),compact=create(false);
  for(const engine of [full,compact]){
    engine.addNote({timeMs:20});engine.addFixedScore({timeMs:40,score:500});
    engine.calculate(40);engine.addFactor({timeMs:10,ownerId:1,general:Math.fround(.3)});
  }
  for(const time of [0,40,500,0,40]){
    assert.equal(compact.calculate(time),full.calculate(time));assert.deepEqual(compact.state,full.state);
  }
});

function fixture() {
  const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
  const chart={id:'music-chart-10000103',trackId:'music-100001',difficulty:'expert',bpmEvents:[{tick:0,bpm:125}],
    skillTimings:[1,2,3,4,5],feverRanges:[],notes:Array.from({length:60},(_,i)=>({id:String(i),type:'tap',tick:i*79+1}))};
  const draft=createTeamDraft({selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty,
    slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`}))});
  return {rules,chart,draft};
}

test('cached factor histories across powers and teams equal explicit native trace replay',()=>{
  const {rules,chart,draft}=fixture(),calculator=createFormalSongCalculator(rules,chart);
  for(let i=0;i<12;i++){
    const next=structuredClone(draft);next.modifiers.growth={};
    for(const s of next.slots){
      next.modifiers.growth[s.memberCardId]={level:i+1,rank:i%5+1,awake:1,skillLevel:1};
      next.modifiers.growth[s.supportCardId]={level:i+1,rank:1};
    }
    if(i%2)[next.slots[0],next.slots[2]]=[next.slots[2],next.slots[0]];
    const actual=calculator.calculate(next),traced=calculator.calculate(next,{includeTrace:true});
    for(const key of Object.keys(actual))assert.deepEqual(actual[key],traced[key],`iteration ${i}: ${key}`);
  }
});

test('fixed-score adapters retain every order evaluation across repeated calculations',()=>{
  const {rules,chart,draft}=fixture();
  const event={_id:1};rules.tables.Event.push(event);
  draft.modifiers.event={id:event._id,sourceReleaseId:rules.sourceReleaseId};
  let calls=0;
  const adapter={sourceReleaseId:rules.sourceReleaseId,supports:row=>row._id===event._id,
    resolve:()=>({effects:[{phase:'fixed_score'}]}),
    handlers:{fixed_score:(score,effects,{order})=>{calls++;return score+order[0]*10;}}};
  const calculator=createFormalSongCalculator(rules,chart,{eventAdapters:[adapter]});
  for(let i=0;i<2;i++){
    const result=calculator.calculate(draft);
    assert.equal(result.eventFixedScoreGain,20);
    assert.equal(calls,120*(i+1));
  }
});

test('linear ordinary note envelope dominates native integer scores at varied powers and factors',()=>{
  const {rules,chart}=fixture(),calculator=createFormalSongCalculator(rules,chart);
  for(const power of [0,1,999,100000,10000000,100000000]) {
    const coefficients=calculator.linearUpperBound(power);
    for(const factor of [0,Math.fround(.01),1,Math.fround(1.234567),4,20]) {
      const exact=calculator.upperBound(power,factor);
      assert.ok(coefficients.reduce((sum,c)=>sum+c*factor,0)>=exact,`${power}/${factor}`);
    }
  }
});

test('single-slot pairing kernel equals complete formation breakdown and validates the whole formation',()=>{
  const {rules,draft}=fixture(),calculator=createFormationCalculator(rules);
  for(let i=0;i<5;i++)assert.deepEqual(calculator.calculateSlot(draft,i),calculator.calculate(draft).slots[i]);
  const invalid=structuredClone(draft);invalid.slots[4]=invalid.slots[0];
  assert.throws(()=>calculator.calculateSlot(invalid,0),/Duplicate/);
  assert.throws(()=>calculator.calculateSlot(draft,5),/slot index/);
});

test('indexed Master lookup keeps strict numeric field matching',()=>{
  const {rules}=fixture(),member=rules.tables.MemberCard[0];
  const level=rules.tables.MemberCardLevel.find(r=>r._group===member._memberCardLevelGroup&&r._level===1);
  level._level='1';
  assert.throws(()=>createFormationCalculator(rules).resolveGrowth(member,'Member',{level:1}),/level 1/);
});

test('job-local pair models reuse only identical inputs and honor cancellation',async()=>{
  const {rules,draft}=fixture(),input=resolveSearchInput(rules,draft),modelCache={};
  const first=await compilePairingModels(rules,input,{modelCache});
  const second=await compilePairingModels(rules,structuredClone(input),{modelCache});assert.equal(second,first);
  const changed=structuredClone(input);changed.draft.modifiers.memoryPoints={1:100};
  const third=await compilePairingModels(rules,changed,{modelCache});assert.notEqual(third,first);
  assert.notDeepEqual(third,first);
  const controller=new AbortController();controller.abort();
  assert.equal(await compilePairingModels(rules,changed,{modelCache,signal:controller.signal}),null);
});
