import { createFormationCalculator, requireInteger } from './formation-power.mjs';
import { prepareFormalChart } from './formal-song-score.mjs';
import { stableSnapshotHash } from '../scoring-engine.mjs';

// Independent, source-closed pieces only. A partial total is never presented
// as a full Gekisou score or admitted to the score optimizer.
export function gekisouMissionPattern(missions) {
  if (!Array.isArray(missions) || missions.length !== 3 || missions.some(m => ![0,1,2,3].includes(m))) throw new Error('Invalid Gekisou missions');
  if (missions.includes(0)) return 0;
  return new Set(missions).size === 1 ? 1 : new Set(missions).size === 3 ? 2 : 3;
}
export function gekisouRankingBonus(rules, { missions, sectionIndex, rank, sectionScore }) {
  requireInteger(sectionIndex,'section index',1,3); requireInteger(rank,'rank',1,5);
  requireInteger(sectionScore,'section score',0,Number.MAX_SAFE_INTEGER);
  const pattern=gekisouMissionPattern(missions);
  const row=rules.tables.LiveGekisouRankingScoreBonus.find(r=>r._missionPattern===pattern&&r._count===sectionIndex&&r._rank===rank);
  if(!row)throw new Error('Unsupported Gekisou ranking table');
  const result=BigInt(sectionScore)*BigInt(row._scoreBonusPercent)/100n;
  if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Gekisou ranking bonus overflow');
  return {additionalScore:Number(result),percent:row._scoreBonusPercent,pattern,rank,sectionIndex,sourceRowId:row._id};
}
export function gekisouComboFactor(rules,count) {
  requireInteger(count,'Gekisou combo',0,Number.MAX_SAFE_INTEGER);
  let cumulative=0;
  for(const r of rules.tables.LiveComboScoreBonus.filter(r=>r._comboBonusType===1).sort((a,b)=>a._requiredComboCount-b._requiredComboCount)) {
    if(r._requiredComboCount>count)break;
    cumulative=Math.fround(cumulative+Math.fround(r._bonusFactor));
  }
  return Math.fround(1+Math.min(1,cumulative));
}
export function resolveGekisouSkills(rules,draft,{ missions = null } = {}) {
  const calculator=createFormationCalculator(rules),t=rules.tables;
  function skill(kind,id,level,slotIndex,sourceCardId) {
    if(!id)return [];
    const name=kind==='member'?'GekisouSkill':'GekisouSupportSkill';
    const parent=t[name].find(r=>r._id===id);
    if(!parent)throw new Error(`Unknown ${name}: ${id}`);
    // Mission applicability belongs to the parent, so irrelevant skills need
    // neither effect nor condition support for this song.
    if(missions && !missions.includes(parent._gekisouMissionType))return [];
    const rows=t[`${name}Effect`].filter(r=>r[kind==='member'?'_gekisouSkillID':'_gekisouSupportSkillID']===id&&r._level===level);
    if(!rows.length)throw new Error(`Missing ${name} ${id} level ${level}`);
    return [{kind,slotIndex,sourceCardId,id,level,missionType:parent._gekisouMissionType??null,effects:rows.map(row=>{
      const conditions={};
      for(const field of ['_skillTriggerConditionGroup','_skillConditionGroup','_skillReleaseConditionGroup','_effectExecuteLimitResetConditionGroup']) {
        const group=row[field];conditions[field]=group?t.SkillConditionSet.filter(s=>s._group===group).map(s=>({...s,conditions:s._conditionIds.map(id=>{
          const c=t.SkillCondition.find(r=>r._id===id);if(!c)throw new Error(`Missing condition ${id}`);return c;
        })})):[];
        if(group&&!conditions[field].length)throw new Error(`Missing condition group ${group}`);
      }
      const cumulative=row._skillCumulativeConditionID?t.SkillCumulativeCondition.find(r=>r._id===row._skillCumulativeConditionID):null;
      if(row._skillCumulativeConditionID&&!cumulative)throw new Error('Missing cumulative condition');
      const phase=t.SkillEffectSetting.find(s=>s._skillEffectType===row._skillEffectType)?._phase;
      return {definition:row,phase,conditions,cumulative};
    })}];
  }
  return draft.slots.flatMap((slot,index)=>{
    if(!slot.memberCardId||!slot.supportCardId)throw new Error('激奏需要完整的五张成员与五张留影');
    const member=calculator.card(slot.memberCardId,'member'),support=calculator.card(slot.supportCardId,'support');
    const g=draft.modifiers?.growth??{},level=requireInteger(g[slot.memberCardId]?.gekisouSkillLevel??1,'Gekisou skill level',1,5);
    const rank=calculator.resolveGrowth(support,'Support',g[slot.supportCardId]).rankRow;
    return [...skill('member',member._gekisouSkillID,level,index,slot.memberCardId),...[1,2].flatMap(i=>skill('support',support[`_gekisouSupportSkillId0${i}`],rank[`_gekisouSupportSkill0${i}Level`],index,slot.supportCardId))];
  });
}
export function inspectGekisouScenario(rules,draft,chart) {
  const formation=createFormationCalculator(rules).calculate(draft),timeline=prepareFormalChart(rules,chart);
  if(draft.selectedSongId!==timeline.trackId||draft.selectedDifficulty!==timeline.difficulty)throw new Error('激奏歌曲与谱面不一致');
  const music=rules.tables.LiveMusic.find(r=>`music-${r._id}`===timeline.trackId);
  const missions=[1,2,3].map(i=>music[`_gekisouMission${i}`]);
  const ranges=chart.gekisouRanges??chart.feverRanges;
  if(!Array.isArray(ranges)||ranges.length!==3||ranges.some((r,i)=>!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start||(i&&r.start<ranges[i-1].end)))throw new Error('无有效的三段激奏区间');
  const skills=resolveGekisouSkills(rules,draft);
  return {status:'incomplete_rules',optimizerEligible:false,score:null,power:formation.total.total,
    sourceReleaseId:rules.sourceReleaseId,ruleSetVersion:rules.ruleSetVersion,inputHash:stableSnapshotHash({draft,chartHash:timeline.chartHash}),
    missionPattern:gekisouMissionPattern(missions),skills,
    sections:ranges.map((r,i)=>({index:i+1,missionType:missions[i],start:r.start,end:r.end,
      rankingPercents:[1,2,3,4,5].map(rank=>gekisouRankingBonus(rules,{missions,sectionIndex:i+1,rank,sectionScore:0}).percent)})),
    blockers:['device_input_and_simultaneous_order','ifix_method_override_audit'],
    warnings:['此接口仅检查规则与技能；单曲条件分数使用逐帧计算器，并显式指定输入时钟、抽样与名次条件。','Perfect 不等于 JUST；未指定对手时不能推断区段名次。']};
}
