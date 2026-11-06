/** Read-only probes of combinations missing from the baseline.
 * Usage: node scripts/verify_referenced_skill_combinations.mjs MASTER INVENTORY OUTPUT [--include-unreferenced]
 * Actual effect rows remain intact; isolated bindings and input states are
 * synthetic. This executes the current JS implementation, not a client binary.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createFormationCalculator } from '../packages/scoring/scoring-rules/formation-power.mjs';
import { createFormalSkillResolver } from '../packages/scoring/scoring-rules/formal-skills.mjs';
import { createOrdinarySkillLifecycle } from '../packages/scoring/scoring-rules/formal-performance-state.mjs';
import { createFrameClock, skillEndFrame } from '../packages/scoring/scoring-rules/formal-frame-clock.mjs';
import { compileGekisouEffects } from '../packages/scoring/scoring-rules/gekisou-skill-runtime.mjs';
import { replayGekisouFrames } from '../packages/scoring/scoring-rules/gekisou-frame-replay.mjs';

const [master, input, output, scopeFlag] = process.argv.slice(2);
if (!master || !input || !output) throw new Error('Required: MASTER INVENTORY OUTPUT');
if(scopeFlag && scopeFlag!=='--include-unreferenced')throw new Error('Unknown scope flag');
const root = fileURLToPath(new URL('../', import.meta.url));
const inventory = JSON.parse(readFileSync(input));
const rules = JSON.parse(readFileSync(join(root, 'packages/scoring/data/formal-scoring-rules.json')));
for (const name of Object.keys(rules.tables)) {
  const path = join(master, `Master${name}.json`);
  if (existsSync(path)) rules.tables[name] = JSON.parse(readFileSync(path))._allData;
}
const t = rules.tables, sha = value => createHash('sha256').update(value).digest('hex');
const referencedKeys = [...Array.from({length:10}, (_,i)=>`LeaderSkill:${53+i}`), 'LiveSkill:9',
  ...[72,74,75,72070,72074].map(id=>`SupportSkill:${id}`), 'GekisouSkill:22', 'GekisouSkill:23'];
const unreferencedKeys=[...Array.from({length:15},(_,i)=>90061+i),...Array.from({length:21},(_,i)=>90079+i),
  90101,90106,90116,90121].map(id=>`LeaderSkill:${id}`);
const keys=[...referencedKeys,...(scopeFlag?unreferencedKeys:[])];
const tableId = family => `_${family[0].toLowerCase()}${family.slice(1)}ID`;
const clock = createFrameClock({frameRate:60});
const close = (a,b) => assert.ok(Math.abs(a-b)<.00001, `${a} != ${b}`);
const rate = bp => Math.fround(Math.floor(Math.fround(Math.fround(bp/10000)*100000))/100000);
const bandOf = member => t.Character.find(c=>c._id===member._characterID)._bandID;
const byId = (table,id) => t[table].find(r=>r._id===id);
const rawSource = JSON.stringify(rules);

function checkClosure(skill) {
  const rows = t[`${skill.family}Effect`].filter(r=>r[tableId(skill.family)]===skill.skillId);
  assert.deepEqual(rows, skill.effects.map(e=>e.raw));
  const target = selector => assert.deepEqual(byId('SkillTarget',selector.sourceId),selector.raw);
  for (const e of skill.effects) {
    e.targets.selectors.forEach(target);
    for (const program of Object.values(e.conditions)) {
      assert.deepEqual(program.sourceGroup ? t.SkillConditionSet.filter(s=>s._group===program.sourceGroup).map(s=>s._id) : [],
        program.anyOf.map(s=>s.sourceSetId));
      for (const g of program.anyOf) {
        assert.deepEqual(byId('SkillConditionSet',g.sourceSetId)._conditionIds,g.allOf.map(c=>c.sourceId));
        for (const c of g.allOf) { assert.deepEqual(byId('SkillCondition',c.sourceId),c.raw); c.targets.selectors.forEach(target); }
      }
    }
    if(e.cumulative) {assert.deepEqual(byId('SkillCumulativeCondition',e.cumulative.sourceId),e.cumulative.raw);e.cumulative.targets.selectors.forEach(target);}
    assert.equal(t.SkillEffectSetting.find(s=>s._skillEffectType===e.raw._skillEffectType)._phase,e.timing.phase);
  }
  if(skill.parent) assert.deepEqual(byId(skill.family,skill.skillId),skill.parent);
  for(const ref of skill.references) {
    const card=byId(ref.cardTable,ref.cardId);assert.equal(card[ref.slot],skill.skillId);
  }
}

// Independent selectors for this bounded scope: no implementation matcher is
// used to construct expected leader rates.
function targetMatch(member,id) {
  const target=byId('SkillTarget',id);
  assert.equal(target._skillTargetType,3);
  assert.equal(target._characterID,0);assert.equal(target._tagID,0);
  assert.equal(target._gekisouSkillCategories.length,0);
  return (!target._bandID || bandOf(member)===target._bandID) &&
    (!target._cardType || member._cardType===target._cardType) &&
    (!target._liveSkillCategories.length || target._liveSkillCategories.some(c=>byId('LiveSkill',member._liveSkillID)._skillCategories.includes(c))) &&
    (!target._gekisouMissionType || byId('GekisouSkill',member._gekisouSkillID)._gekisouMissionType===target._gekisouMissionType);
}
function leaders(skill) {
  const calc=createFormationCalculator(rules);let cases=0;
  const unreferenced=unreferencedKeys.includes(skill.key);
  const matrix=unreferenced?[1,2,3,4,5].flatMap(band=>[1,2,3,4,5].flatMap(cardType=>[1,2,3].flatMap(mission=>[1,2,3].map(category=>({
    ...t.MemberCard[0],_characterID:t.Character.find(c=>c._bandID===band)._id,_cardType:cardType,
    _liveSkillID:t.LiveSkill.find(s=>s._skillCategories.includes(category))._id,
    _gekisouSkillID:t.GekisouSkill.find(s=>s._gekisouMissionType===mission)._id}))))):[];
  for (const level of skill.levels) {
    const rows=skill.effects.filter(e=>e.level===level).map(e=>e.raw);
    const countRow=rows.find(r=>r._skillCumulativeConditionID);
    const cumulative=countRow&&byId('SkillCumulativeCondition',countRow._skillCumulativeConditionID);
    const allowed=cumulative?cumulative._conditionTargetIDs.map(id=>byId('SkillTarget',id)._cardType):[];
    for(const count of cumulative?[0,1,2,3,4,5]:[0]) {
      const formation=t.MemberCard.slice(0,5).map((member,i)=>({member:cumulative?{...member,_cardType:i<count?allowed[0]:[1,2,3,4,5].find(v=>!allowed.includes(v))}:member}));
      for (const member of [...t.MemberCard,...matrix]) {
        const expected=[0,0,0];
        for(const row of rows) {
          if(row._skillTargetIDs.length&&!row._skillTargetIDs.some(id=>targetMatch(member,id)))continue;
          const times=row._skillCumulativeConditionID?Math.min(count,cumulative._maxCumulativeCount):1;
          const components=row._skillEffectType===1000?[0,1,2]:[{1001:1,1002:2,1003:0,1501:1,1502:2}[row._skillEffectType]];
          for(const component of components){assert.notEqual(component,undefined);expected[component]+=row._effectValue*times;}
        }
        assert.deepEqual(calc.effectRates(member,rows,formation),expected);cases++;
      }
    }
  }
  // Exercise actual category vs display category disagreement and any-overlap
  // semantics independently of the currently authored members' combinations.
  const categoryTargets=[...new Set(skill.effects.flatMap(e=>e.raw._skillTargetIDs))].filter(id=>byId('SkillTarget',id)._liveSkillCategories.length);
  for(const id of categoryTargets){
    const requested=byId('SkillTarget',id)._liveSkillCategories[0];
    for(const [actual,display,expected] of [[[requested],[99],true],[[99],[requested],false],[[99,requested],[99],true]]){
      const r=structuredClone(rules),member=r.tables.MemberCard[0],parent=r.tables.LiveSkill.find(s=>s._id===member._liveSkillID);
      parent._skillCategories=actual;parent._displaySkillCategories=display;
      assert.equal(createFormationCalculator(r).matchesTarget(member,id),expected);cases++;
    }
  }
  return {cases,checks:['all_levels_actual_member_targets','overlapping_sources_sum_per_component',
    ...(unreferenced?['225_synthetic_target_combinations_per_level','all_power_expands_three_components']:[]),
    ...(categoryTargets.length?['actual_not_display_category','category_any_overlap']:[]),
    ...([61,62].includes(skill.skillId)?['0_to_5_same_attribute_members_count_once_each','cap_two','empty_recipient_targets_benefit_every_member']:[])]};
}

function missingLeaderCumulative(skill){
  const calc=createFormationCalculator(rules);let cases=0;
  for(const e of skill.effects){
    assert.equal(e.raw._skillEffectType,1503);assert.equal(e.raw._skillCumulativeConditionID,0);
    for(const mission of [1,2]){
      const member={...t.MemberCard[0],_gekisouSkillID:t.GekisouSkill.find(s=>s._gekisouMissionType===mission)._id};
      assert.throws(()=>calc.effectRates(member,[e.raw],t.MemberCard.slice(0,5).map(member=>({member}))),/Unsupported leader cumulative condition/);cases++;
    }
  }
  return {status:'data_incomplete',cases,reasonCodes:['leader_cumulative_required'],
    checks:['all_levels_missing_required_cumulative','current_executor_rejects_even_before_recipient_filter'],
    requiredAction:'Confirm intended opcode or supply the cumulative source/unit/cap; never coerce 1503 to 1003 or invent a count.'};
}

function ordinary(skill,level,band) {
  const r=structuredClone(rules), ref=skill.references[0];
  const member=r.tables.MemberCard.find(c=>skill.family==='LiveSkill'?c._id===ref.cardId:bandOf(c)===band);
  const support=r.tables.SupportCard.find(c=>c._id===(skill.family==='SupportSkill'?ref.cardId:1));
  member._liveSkillID=skill.family==='LiveSkill'?skill.skillId:0;
  support._supportSkillId01=support._supportSkillId02=0;
  if(skill.family==='SupportSkill')support[ref.slot]=skill.skillId;
  const d={slots:[{memberCardId:`member-card-${member._id}`,supportCardId:`support-card-${support._id}`}],
    modifiers:{growth:{[`member-card-${member._id}`]:{skillLevel:level},[`support-card-${support._id}`]:{rank:level}}}};
  const compiled=createFormalSkillResolver(r,{dynamic:true})(d)[0];
  const source=skill.effects.filter(e=>e.level===level).map(e=>e.id);
  assert.deepEqual((skill.family==='LiveSkill'?compiled.liveEffects:compiled.supportEffects).map(e=>e.id),source);
  const make=()=>createOrdinarySkillLifecycle({skills:[compiled,...Array.from({length:4},()=>({liveEffects:[],supportEffects:[]}))],
    skillTimes:[1000,2000,3000,4000,5000],skillOrder:[0,1,2,3,4],clock,life:{at:()=>1000},skillEndFrame});
  return {compiled,make};
}
function liveRelease(skill) {
  let cases=0;
  for(const level of skill.levels) for(const grade of [1,2,3,4,5,6]) {
    const {compiled,make}=ordinary(skill,level), lifecycle=make();
    const extra=compiled.liveEffects.find(e=>e.release), base=compiled.liveEffects.find(e=>!e.release);
    assert.deepEqual(extra.release,[3]);assert.deepEqual(base.targets,[5,6]);
    lifecycle.advance(60,[{judgement:3,timeMs:999}]);
    lifecycle.advance(61,[{judgement:3,timeMs:1010}]);
    assert.equal(lifecycle.skillTrace.filter(x=>x.action==='release').length,0);
    lifecycle.advance(63,[{judgement:grade,timeMs:1040},{judgement:grade,timeMs:1041}]);
    const released=lifecycle.skillTrace.filter(x=>x.action==='release');
    assert.equal(released.length,grade===3?1:0);
    if(grade===3) {assert.equal(released[0].effectId,extra.id);assert.equal(released[0].timeMs,1041);}
    close(lifecycle.commands.reduce((v,c)=>v+(c.perfect??0),0),rate(base.rate*10000)+(grade===3?0:rate(extra.rate*10000)));
    lifecycle.advance(skillEndFrame(clock,1000,base.durationRawMs).frame);
    close(lifecycle.commands.reduce((v,c)=>v+(c.perfect??0),0),0);cases++;
  }
  return {cases,checks:['all_levels_both_handles','only_GOOD_releases_extra','activation_and_next_frame_skip_release','last_matching_timestamp','expiry_no_double_removal']};
}
function conversion(skill) {
  let cases=0;const startup=skill.skillId===75;
  for(const level of skill.levels) for(const band of startup?[1,2]:[1]) {
    const {compiled,make}=ordinary(skill,level,band), e=compiled.supportEffects.find(e=>e.active);
    assert.ok(e);const lifecycle=make();lifecycle.advance(0);
    if(!startup) {assert.equal(lifecycle.convert(4).judgement,4);lifecycle.advance(60);}
    const target=startup?1:4, value=startup?3:5;
    const untouched=startup?[3,4,5,6]:[1,2,3,5,6];
    for(const j of untouched)assert.equal(lifecycle.convert(j).judgement,j);
    for(let i=0;i<e.limitCount;i++)assert.equal(lifecycle.convert(startup?(i%2?2:1):target).judgement,value);
    assert.equal(lifecycle.convert(target).judgement,target);
    if(startup) {lifecycle.advance(60);assert.equal(lifecycle.convert(target).judgement,target);assert.equal(lifecycle.converters.length,1);}
    else {
      const expires=make();expires.advance(60);
      // Conversion participates in inputs on the expiry frame, before advance.
      assert.equal(expires.convert(4).judgement,5);
      expires.advance(skillEndFrame(clock,1000,e.durationRawMs).frame);
      assert.equal(expires.convert(4).judgement,4);
    }
    cases++;
  }
  return {cases,checks:['all_ranks_actual_limits','only_success_consumes','unmatched_judgements_preserved',
    ...(startup?['positive_and_negative_band_branches','startup_once_no_member_recharge']:['activation_boundary','duration_expiry'])]};
}
function cumulative(skill) {
  let cases=0;
  for(const level of skill.levels)for(const band of [1,2])for(const repeat of [0,1]) {
    const {compiled,make}=ordinary(skill,level,band), e=compiled.liveEffects.find(e=>e.active), lifecycle=make();
    const c=e.cumulative;assert.ok(c);assert.deepEqual(c.targets,[5,6]);
    const net=()=>lifecycle.commands.reduce((v,x)=>v+(x.general??0),0);
    let count=0;lifecycle.advance(60,[{judgement:4,timeMs:1000}]);close(net(),0);
    for(let i=1;i<=c.maximum*c.unit+2;i++) {
      lifecycle.advance(60+i,[{judgement:i%2?5:6,timeMs:clock.at(60+i).timeMs},{judgement:4,timeMs:clock.at(60+i).timeMs}]);
      count++;close(net(),rate(Math.min(c.maximumBP,Math.min(c.maximum,Math.floor(count/c.unit))*c.stepBP)));
    }
    lifecycle.advance(skillEndFrame(clock,1000,e.durationRawMs).frame);close(net(),0);cases++;
  }
  return {cases,checks:['all_ranks_both_band_branches','PERFECT_and_JUST_only','unit_floor_count_cap_effect_cap','old_handle_replaced','expiry_and_fresh_run_reset']};
}
function gekisou(skill) {
  let cases=0;
  for(const level of skill.levels) {
    const r=structuredClone(rules),member=r.tables.MemberCard.find(c=>c._id===skill.references[0].cardId),support=r.tables.SupportCard[0];
    support._gekisouSupportSkillId01=support._gekisouSupportSkillId02=0;
    const draft={slots:[{memberCardId:`member-card-${member._id}`,supportCardId:`support-card-${support._id}`}],
      modifiers:{growth:{[`member-card-${member._id}`]:{gekisouSkillLevel:level}}}};
    const effects=compileGekisouEffects(r,draft,true),mission=skill.parent._gekisouMissionType;
    assert.equal(effects.length,2);
    assert.deepEqual(compileGekisouEffects(r,draft,true,[mission===1?2:1]),[]);
    const reduction=effects.find(e=>e.definition._skillEffectType===3004).definition._effectValue;
    const bonus=effects.find(e=>e.definition._skillEffectType!==3004);
    if(skill.skillId===22)close(bonus.operator.gaugeFactor(bonus),bonus.definition._effectValue/10000);
    const grades=[5,1,5,1,5,1,1],events=[1000,1100,1200,3500,4000,4100,6500].map((timeMs,i)=>({id:String(i),type:1,
      scoreIndex:i,timeMs,inputFrame:timeMs,originalJudgement:grades[i]}));
    const frames=Array.from({length:12000},(_,timeMs)=>({timeMs,deltaSeconds:.001}));
    const result=replayGekisouFrames(r,{events,skillTimes:[]},[{index:1,missionType:mission,startMs:1000,endMs:2000},
      {index:2,missionType:mission,startMs:4000,endMs:5000}],effects,{ranks:[1,1],frameRate:60,frames,timingOffsetMs:0},1,
      {trace:true,performanceInput:{judgements:events}});
    const damage=Math.trunc(Math.fround(Math.fround(100)*Math.fround(1-Math.fround(reduction/10000))));
    assert.deepEqual(result.events.map(e=>e.lifeAtInput),[1000,1000-damage,1000-damage,900-damage,900-damage,900-2*damage,800-2*damage]);
    assert.equal(result.transitions.filter(x=>x.action==='start').length,4);
    assert.equal(result.transitions.filter(x=>x.action==='end').length,4);
    if(skill.skillId===23) {
      assert.equal(result.states[0].combo,1+bonus.definition._effectValue);
      assert.equal(result.states[1].combo,0); // MISS still breaks; count increase is not protection.
    }
    cases++;
    // Short sections above close before Lv.1-4's 3/4/5/6 second timeout.
    // A long section distinguishes timed expiration from Lv.5 section upkeep.
    const seconds=bonus.definition._activationTimeSecond;
    const late=seconds?1000+seconds*1000+200:7500;
    const longEvents=[1000,1100,late].map((timeMs,i)=>({id:`long-${i}`,type:1,scoreIndex:i,timeMs,
      inputFrame:timeMs,originalJudgement:i?1:5}));
    const long=replayGekisouFrames(r,{events:longEvents,skillTimes:[]},
      [{index:1,missionType:mission,startMs:1000,endMs:9000}],effects,
      {ranks:[1],frameRate:60,frames,timingOffsetMs:0},1,{trace:true,performanceInput:{judgements:longEvents}});
    assert.deepEqual(long.events.map(e=>e.lifeAtInput),[1000,1000-damage,seconds?900-damage:1000-2*damage]);
    assert.equal(long.transitions.filter(x=>x.action==='end').length,2);cases++;
  }
  return {cases,checks:['all_levels_both_effects','mission_applicability','two_sections_release_and_reentry','MISS_damage_and_outside_section_cleanup',
    'Lv1_to_4_timed_expiry_vs_Lv5_section_lifetime',
    skill.skillId===23?'combo_addition_survives_break_as_section_skill_not_threshold_or_guard':'gauge_factor_and_reduction_compose']};
}

const results=[];
for(const key of keys) {
  const skill=inventory.skills.find(s=>s.key===key);assert.ok(skill,key);
  assert.equal(Boolean(skill.references.length),referencedKeys.includes(key));checkClosure(skill);
  const result={key,sourceClosureHashes:skill.effects.map(e=>e.sourceClosureHash),levels:skill.levels,effectRows:skill.effects.length};
  try {
    const probe=[90088,90089,90090].includes(skill.skillId)&&skill.family==='LeaderSkill'?missingLeaderCumulative:
      skill.family==='LeaderSkill'?leaders:skill.family==='LiveSkill'?liveRelease:
      skill.family==='GekisouSkill'?gekisou:skill.skillId===74?cumulative:conversion;
    Object.assign(result,{status:'implementation_confirmed'},probe(skill));
  } catch(error) {console.error(error.stack);Object.assign(result,{status:'needs_investigation',failure:error.message});}
  results.push(result);
}
assert.equal(JSON.stringify(rules),rawSource,'the probes must not mutate the source rules');
const evidenceFiles=['scripts/verify_referenced_skill_combinations.mjs',
  ...['formation-power','formal-skills','formal-performance-state','formal-frame-clock','gekisou-skill-runtime','skill-condition-program','gekisou-effect-operators','gekisou-frame-replay','gekisou-rules'].map(n=>`packages/scoring/scoring-rules/${n}.mjs`),
  'site/tests/scoring-content-compatibility.test.mjs','site/tests/gekisou-life-reduction.test.mjs','site/tests/gekisou-skill-composition.test.mjs',
  'site/tests/performance-scenarios.test.mjs','site/tests/fixtures/current-ordinary-native.json'];
const report={schemaVersion:1,sourceVersion:inventory.sourceVersion,verification:'actual_rows_current_js_offline',
  scope:`${keys.length} definitions (${referencedKeys.length} referenced); no production source changes or client execution; excludes whole-pool optimization and full Unity scheduling`,
  codeAndTestHashes:Object.fromEntries(evidenceFiles.map(path=>[path,sha(readFileSync(resolve(root,path)))])),results,
  totals:{definitions:results.length,effectRows:results.reduce((n,r)=>n+r.effectRows,0),
    cases:results.reduce((n,r)=>n+(r.cases??0),0),confirmed:results.filter(r=>r.status==='implementation_confirmed').length,
    dataIncomplete:results.filter(r=>r.status==='data_incomplete').length}};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.totals));
for(const r of results)console.log(r.key,r.status,r.cases??r.failure);
if(report.totals.confirmed+report.totals.dataIncomplete!==keys.length)process.exitCode=1;
