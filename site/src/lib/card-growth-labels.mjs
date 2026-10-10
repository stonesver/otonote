// Game field names are not UI terminology: member awake raises the level cap,
// while member rank is awakening. Support rank is breakthrough.
export function cardGrowthLabel(field, kind='member', locale='zh-CN') {
  const labels={level:['等级','Level'],rank:kind==='support'?['突破','Breakthrough']:['觉醒','Awakening'],
    awake:['突破（特训）','Breakthrough (training)'],skillLevel:['演出技能','Live skill'],gekisouSkillLevel:['激奏技能','Gekisou skill']};
  return labels[field]?.[locale==='en'?1:0]??field;
}
