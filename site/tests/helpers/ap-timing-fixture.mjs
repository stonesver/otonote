import {eventYieldOracleFixture} from './event-yield-oracle-fixture.mjs';

export function timingFixture() {
  const { rules, chart, draft } = eventYieldOracleFixture();
  chart.notes = Array.from({length:30},(_,i)=>({id:`tap-${i}`,type:'tap',tick:900+i*111,position:i%2?12:2,size:6}));
  chart.duration = 10;
  for (const row of rules.tables.LiveSkillEffect) row._effectValue = 0;
  for (const row of rules.tables.SupportCard) row._supportSkillId01 = row._supportSkillId02 = 0;
  rules.tables.SupportCard.find(row=>row._id===1)._supportSkillId01 = 990;
  rules.tables.SupportCardRank.forEach(row=>row._supportSkill01Level=1);
  rules.tables.SkillCondition.push({_id:990,_conditionType:5000,_conditionValues:[],_isPositive:true,_conditionTargetIDs:[3]});
  rules.tables.SkillConditionSet.push({_id:990,_group:990,_conditionIds:[990]});
  rules.tables.SkillCumulativeCondition.push({_id:990,_skillCumulativeConditionType:1000,_conditionValues:[2],_conditionTargetIDs:[41,46],_maxCumulativeCount:6});
  rules.tables.SupportSkillEffect.push({...rules.tables.SupportSkillEffect[0],_id:990,_supportSkillID:990,_level:1,
    _skillTriggerConditionGroup:53,_skillTriggerType:1,_skillConditionGroup:990,_skillReleaseConditionGroup:0,
    _skillCumulativeConditionID:990,_effectValue:2000,_maxEffectValue:12000,_skillEffectType:2001,
    _effectExecuteLimitCount:0,_effectExecuteLimitResetConditionGroup:0,_effectLimitCount:0,_skillTargetIDs:[],_activationTimeSecond:5});
  return { rules, chart, draft };
}

export function fixedBoostTimingFixture() {
  const {rules,chart,draft}=timingFixture();
  rules.tables.SupportCard.find(row=>row._id===1)._supportSkillId01=0;
  rules.tables.MemberCard.find(row=>row._id===1)._performancePowerMax+=378;
  chart.skillTimings[0]=.981;
  chart.notes=[980,995].map((tick,i)=>({id:`rounding-${i}`,type:'tap',tick,position:i*4,size:4}));
  for(const row of rules.tables.LiveSkillEffect){
    row._skillEffectType=2000;row._skillTargetIDs=[];row._skillConditionGroup=0;
    row._effectValue=3000;row._activationTimeSecond=.05;
  }
  return {rules,chart,draft};
}
