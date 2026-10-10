import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLifeReplay, applyLifeCommand } from '../../packages/scoring/scoring-rules/formal-performance-state.mjs';
import { scoreFrame, liveSkillCommands, replayScoreTimeline } from '../../packages/scoring/scoring-rules/formal-score-replay.mjs';
import { createPerformanceTemplate, createPerformanceSongCalculator } from '../../packages/scoring/scoring-rules/formal-performance-replay.mjs';
import { createTeamDraft } from '../src/lib/team-draft.mjs';
import { createFormalSongCalculator } from '../../packages/scoring/scoring-rules/formal-song-score.mjs';
import { createFormalSkillResolver } from '../../packages/scoring/scoring-rules/formal-skills.mjs';
import { createOrdinaryScoreBound, ordinaryReplayApplicationLimit } from '../../packages/scoring/scoring-rules/ordinary-score-bound.mjs';
import { maximumPairing, partitionPairing } from '../../packages/scoring/scoring-rules/maximum-pairing.mjs';
import { compilePairingModels, draftFromPairing, optimizeInventory } from '../src/lib/inventory-optimizer.mjs';
import { resolveSearchInput } from '../../packages/scoring/scoring-rules/formation-input.mjs';

// Dense native-prefix oracle, deliberately independent of the sparse index.
function denseLife(maximumLife, length) {
  const buckets = [], last = scoreFrame(length) + 49;
  let cursor = -1, cache = { life: maximumLife, guard: 0, reduction: 0 };
  const bucketOf = t => Math.min(last, scoreFrame(t));
  return {
    add(command) {
      const b = bucketOf(command.timeMs), list = buckets[b] ??= [];
      let i = list.length;
      while (i && list[i - 1].timeMs > command.timeMs) i--;
      list.splice(i, 0, command);
      if (cursor >= b) cursor = b - 1;
    },
    at(t) {
      const b = bucketOf(t), reuse = cursor >= 0 && cursor < b;
      let state = reuse ? { ...cache } : { life: maximumLife, guard: 0, reduction: 0 };
      for (let i = reuse ? cursor + 1 : 0; i < b; i++)
        for (const c of buckets[i] ?? []) state = applyLifeCommand(state, c, maximumLife);
      if (cursor < b || cursor < 0) { cursor = b - 1; cache = { ...state }; }
      for (const c of buckets[b] ?? []) { if (c.timeMs > t) break; state = applyLifeCommand(state, c, maximumLife); }
      return state.life;
    }
  };
}

test('sparse life index preserves native prefix invalidation across randomized late commands and backward queries', () => {
  for (let seed = 1; seed <= 12; seed++) {
    let state = seed;
    const next = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const dense = denseLife(1000, 240000), sparse = createLifeReplay(1000, 240000);
    for (let i = 0; i < 500; i++) {
      if (next(3) === 0) {
        const command = { timeMs: next(250000), kind: next(7), value: next(10001), safety: Boolean(next(2)), overHeal: Boolean(next(2)) };
        dense.add(command); sparse.add(command);
      } else {
        const time = next(250000);
        assert.equal(sparse.at(time), dense.at(time), `seed ${seed}, operation ${i}, time ${time}`);
      }
    }
  }
});

function* permutations(values) {
  if (!values.length) { yield []; return; }
  for (let i=0;i<values.length;i++) for (const tail of permutations(values.filter((_,j)=>i!==j))) yield [values[i],...tail];
}

test('timed ordinary bounds dominate exhaustive native replay for every constrained leader subspace and objective', async () => {
  for (let seed = 1; seed <= 3; seed++) {
    const rules = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
    const chart = { id: 'music-chart-10000103', trackId: 'music-100001', difficulty: 'expert',
      bpmEvents: [{tick:0,bpm:125}], skillTimings: [1,2,3,4,5], feverRanges: [],
      notes: Array.from({length:40}, (_,i)=>({id:String(i),type:'tap',tick: i*157+1})) };
    const template = rules.tables.LiveSkillEffect.find(e=>e._liveSkillID===1&&e._level===1);
    for (let i=1;i<=5;i++) {
      const id=900000+i;
      rules.tables.MemberCard.find(m=>m._id===i)._liveSkillID=id;
      rules.tables.LiveSkillEffect.push({...template,_id:id,_liveSkillID:id,_effectValue:(seed*1711+i*2333)%14000,
        _activationTimeSecond: .021 + i*1.117, _skillConditionGroup:0});
    }
    const draft=createTeamDraft({selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty,
      slots:[1,2,3,4,5].map(i=>({memberCardId:`member-card-${i}`,supportCardId:`support-card-${i}`}))});
    const frameRate=[30,60,120][seed-1];
    const input=resolveSearchInput(rules,draft), song=createFormalSongCalculator(rules,chart,{frameRate}), resolver=createFormalSkillResolver(rules), pairs=new Map();
    for(const m of input.inventory.memberCardIds)for(const s of input.inventory.supportCardIds)pairs.set(`${m}|${s}`,resolver({slots:[{memberCardId:m,supportCardId:s}],modifiers:input.draft.modifiers})[0]);
    const models=await compilePairingModels(rules,input), supports=input.inventory.supportCardIds;
    for(const model of models) {
      const root={leader:model.leader,required:[],forbidden:[]}, solution=maximumPairing({edges:model.edges,requiredMembers:[model.leader]});
      const states=[root,...partitionPairing(root,solution)];
      const all=[];
      for(const order of permutations(supports)) {
        const members=[...input.inventory.memberCardIds], leaderIndex=members.indexOf(model.leader);
        [members[2],members[leaderIndex]]=[members[leaderIndex],members[2]];
        const d={...input.draft,slots:members.map((m,i)=>({memberCardId:m,supportCardId:order[i]}))};
        assert.equal(d.slots[2].memberCardId,model.leader);
        all.push({keys:d.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`),score:song.calculate(d)});
      }
      for(const metric of ['expectedScore','minimumScore','maximumScore']) {
        const bound=createOrdinaryScoreBound({song,pairSkills:pairs,legacyFactor:10,input,metric,frameRate});
        const legacy=createOrdinaryScoreBound({song,pairSkills:pairs,legacyFactor:10,input,metric,frameRate,localRewinds:false,assignmentBound:false});
        for(const state of states) {
          const solved=maximumPairing({edges:model.edges,required:state.required,forbidden:state.forbidden,requiredMembers:[model.leader]});
          if(!solved)continue;
          const upper=bound(state,model,solved,()=>draftFromPairing(input,model.leader,solved.edges));
          const trueBest=Math.max(...all.filter(r=>state.required.every(k=>r.keys.includes(k))&&state.forbidden.every(k=>!r.keys.includes(k))).map(r=>r.score[metric]));
          assert.ok(upper>=trueBest,`${seed} ${model.leader} ${metric}: ${upper} < ${trueBest}`);
          assert.ok(upper<=legacy(state,model,solved,()=>draftFromPairing(input,model.leader,solved.edges)));
          const joint=bound.withPriority(state,model,solved,()=>draftFromPairing(input,model.leader,solved.edges));
          assert.equal(joint.upper,upper);
          assert.equal(joint.priority,legacy(state,model,solved,()=>draftFromPairing(input,model.leader,solved.edges)));
        }
      }
    }
    const full=await optimizeInventory({rules,chart,draft,objective:'expected_song_score',topN:1,maxEvaluations:0,yieldControl:async()=>{}});
    const defaultSong=createFormalSongCalculator(rules,chart);
    const brute=Math.max(...models.flatMap(model=>[...permutations(supports)].map(order=>{
      const d=draftFromPairing(input,model.leader,model.edges.filter(e=>order[input.inventory.memberCardIds.indexOf(e.member)]===e.support));return defaultSong.calculate(d).expectedScore;
    })));
    assert.equal(full.results[0].value,brute);
  }
});

test('local rewind error covers dense bucket boundaries, coincident effects and all ideal frame rates', () => {
  const u=2**-24, gamma=n=>n*u/(1-n*u);
  for(const frameRate of [30,60,120]) for(let seed=1;seed<=30;seed++) {
    const skillTimes=[0,39,40,79,80].map(t=>t+seed);
    const skills=Array.from({length:5},(_,i)=>({liveEffects:[0,1].map(j=>({active:true,type:j?2001:2000,
      rate:((seed*13+i*17+j*19)%29-7)/31,durationRawMs:Math.fround([0.01,16,39.999,40,83.2][(i+j+seed)%5])}))}));
    const commands=liveSkillCommands([4,2,0,3,1],skills,skillTimes,frameRate);
    const events=Array.from({length:240},(_,i)=>({timeMs:i,sourceIndex:i}));
    const profiles=skills.map(s=>({effects:s.liveEffects}));
    const applications=ordinaryReplayApplicationLimit({events,skillTimes},profiles,frameRate);
    assert.ok(Number.isFinite(applications)&&applications<=21);
    const absolute=commands.reduce((sum,c)=>sum+Math.abs(c.general??c.perfect),0)/2;
    const undo=commands.length*applications;
    const stateError=gamma(2*undo+1)*(1+4*absolute)+(1+gamma(2*undo+1))*undo*gamma(commands.length)*2*absolute;
    const error=stateError+u*(1+2*absolute+stateError);
    const replay=replayScoreTimeline({events,commands,frameRate,scoreNote:(note,state)=>({score:0,factor:Math.fround(state.general+state.perfect)})});
    for(const note of replay.notes) {
      const exact=1+commands.filter(c=>c.timeMs<=note.timeMs).reduce((sum,c)=>sum+(c.general??c.perfect),0);
      assert.ok(Math.abs(note.result.factor-exact)<=error,`${frameRate}/${seed}/${note.timeMs}`);
    }
  }
  const profile=[{effects:[]}], ordinary={events:[{timeMs:40}],skillTimes:[0,40,80,120,160]};
  assert.equal(ordinaryReplayApplicationLimit({...ordinary,events:[{timeMs:2**20}]},profile),Infinity);
  assert.equal(ordinaryReplayApplicationLimit({...ordinary,events:[{timeMs:40,inputFrame:0}]},profile),Infinity);
});

test('assignment bounds cover alternative characters, same-character variants and locked subspaces',async()=>{
  const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
  const chosen=[],characters=new Set();
  for(const card of rules.tables.MemberCard)if(!characters.has(card._characterID)&&chosen.length<7){chosen.push(card);characters.add(card._characterID);}
  const variant=rules.tables.MemberCard.find(card=>!chosen.includes(card)&&characters.has(card._characterID));
  if(variant)chosen.push(variant);
  const template=rules.tables.LiveSkillEffect.find(e=>e._liveSkillID===1&&e._level===1);
  chosen.forEach((card,i)=>{
    const id=910000+i;card._liveSkillID=id;
    rules.tables.LiveSkillEffect.push({...template,_id:id,_liveSkillID:id,_effectValue:1000+i*1931,
      _activationTimeSecond:.02+i*.71,_skillConditionGroup:0});
  });
  const memberCardIds=chosen.map(c=>`member-card-${c._id}`),supportCardIds=rules.tables.SupportCard.slice(0,7).map(c=>`support-card-${c._id}`);
  const growth=Object.fromEntries([...memberCardIds,...supportCardIds].map(id=>[id,{level:1,rank:1,awake:1,skillLevel:1}]));
  const chart={id:'music-chart-10000103',trackId:'music-100001',difficulty:'expert',bpmEvents:[{tick:0,bpm:125}],
    skillTimings:[1,2,3,4,5],feverRanges:[],notes:Array.from({length:80},(_,i)=>({id:String(i),type:'tap',tick:i*71+1}))};
  const draft=createTeamDraft({selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty,modifiers:{growth},
    slots:memberCardIds.slice(0,5).map((memberCardId,i)=>({memberCardId,supportCardId:supportCardIds[i]}))});
  const input=resolveSearchInput(rules,draft,{scope:'owned',inventory:{memberCardIds,supportCardIds,growth}});
  const models=await compilePairingModels(rules,input),resolver=createFormalSkillResolver(rules),pairs=new Map();
  for(const memberCardId of memberCardIds)for(const supportCardId of supportCardIds)
    pairs.set(`${memberCardId}|${supportCardId}`,resolver({slots:[{memberCardId,supportCardId}],modifiers:input.draft.modifiers})[0]);
  let random=771;const shuffle=xs=>{xs=[...xs];for(let i=xs.length-1;i>0;i--){random=(Math.imul(random,1664525)+1013904223)>>>0;const j=random%(i+1);[xs[i],xs[j]]=[xs[j],xs[i]];}return xs;};
  const character=new Map(chosen.map(c=>[`member-card-${c._id}`,c._characterID]));
  for(const frameRate of [30,60,120]){
    const song=createFormalSongCalculator(rules,chart,{frameRate});
    const bounds=Object.fromEntries(['expectedScore','minimumScore','maximumScore'].map(metric=>[metric,
      createOrdinaryScoreBound({song,pairSkills:pairs,legacyFactor:100,input,metric,frameRate})]));
    for(const model of models){
      const root={leader:model.leader,required:[],forbidden:[]},solution=maximumPairing({edges:model.edges,requiredMembers:[model.leader]});
      const states=[root,...partitionPairing(root,solution)].map(state=>{
        const power=maximumPairing({edges:model.edges,...state,requiredMembers:[model.leader]});
        return power&&{state,upper:Object.fromEntries(Object.entries(bounds).map(([metric,bound])=>[metric,bound(state,model,power,()=>draftFromPairing(input,model.leader,power.edges))]))};
      }).filter(Boolean);
      for(let sample=0;sample<12;sample++){
        const members=[model.leader],used=new Set([character.get(model.leader)]);
        for(const id of shuffle(memberCardIds))if(members.length<5&&!used.has(character.get(id))){members.push(id);used.add(character.get(id));}
        const supports=shuffle(supportCardIds),edges=members.map((m,i)=>model.edges.find(e=>e.member===m&&e.support===supports[i]));
        const candidate=draftFromPairing(input,model.leader,edges),score=song.calculate(candidate),keys=new Set(edges.map(e=>e.key));
        for(const {state,upper}of states)if(state.required.every(k=>keys.has(k))&&state.forbidden.every(k=>!keys.has(k)))
          for(const metric of Object.keys(bounds))assert.ok(upper[metric]>=score[metric],`${frameRate}/${model.leader}/${sample}/${metric}`);
      }
    }
  }
});

test('batched performance orders preserve individual scores, hashes and traces with healing and conversion', () => {
  const rules = JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json', import.meta.url)));
  const chart = { id: 'music-chart-10000103', trackId: 'music-100001', difficulty: 'expert',
    bpmEvents: [{ tick: 0, bpm: 125 }], skillTimings: [1, 2, 3, 4, 5], feverRanges: [],
    notes: [100, 200, 300, 400, 1000, 1100, 2000, 3000, 4000, 6000].map((tick, i) => ({ id: String(i), type: 'tap', tick })) };
  const draft = createTeamDraft({ selectedSongId: chart.trackId, selectedDifficulty: chart.difficulty,
    slots: [1,2,3,4,5].map(i => ({ memberCardId: `member-card-${i}`, supportCardId: `support-card-${i}` })) });
  rules.tables.SupportCard.find(s => s._id === 1)._supportSkillId01 = 51;
  rules.tables.SupportCard.find(s => s._id === 2)._supportSkillId01 = 31;
  const performance = createPerformanceTemplate(rules, chart);
  performance.judgements.forEach((n, i) => { n.judgement = [1,4,2,3,5][i % 5]; });
  const calculator = createPerformanceSongCalculator(rules, chart, { performance });
  const orders = [[0,1,2,3,4], [4,3,2,1,0], [1,0,3,2,4]];
  assert.deepEqual(calculator.calculateOrders(draft, { skillOrders: orders, includeTrace: true }),
    orders.map(skillOrder => calculator.calculate(draft, { skillOrder, includeTrace: true })));
  assert.throws(() => calculator.calculateOrders(draft, { skillOrders: [] }), /至少/);
  assert.throws(() => calculator.calculateOrders(draft, { skillOrders: [[0,0,1,2,3]] }), /排列/);
});
