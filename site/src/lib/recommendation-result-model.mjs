export function recommendationScenarioLabel(result) {
  if(result.planning?.label)return result.planning.label;
  const s=result.draft?.modifiers?.planningScenario;
  if(s?.plan&&s.plan.enabled!==false)return '培养计划';
  if(s?.scope==='reference')return '参考队伍 · 满养成';
  if(s?.scope==='trial')return '试用队伍';
  if(result.planning?.missingActual||s?.unknownGrowth==='reference')return '包含参考养成';
  return s?.scope==='owned'?'当前养成':'所选养成';
}
export function visibleRecommendations(results) {
  const seen=new Set();return results.filter(result=>{
    const key=JSON.stringify([result.draft?.slots,result.draft?.modifiers?.growth]);
    if(seen.has(key))return false;seen.add(key);return true;
  }).slice(0,3);
}
