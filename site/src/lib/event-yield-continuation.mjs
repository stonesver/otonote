import {createChallengeSpendingPlanner} from './scoring-rules/event-efficiency.mjs';
import {compareEventPlans} from './event-yield-goals.mjs';

/** Choose the best evaluated challenge team/song for each consumption tier,
 * then spend only whole plays. The same chosen objective applies to both stages. */
export function challengeContinuation(model,rows,availableCP,metric='badges'){
 return createChallengeContinuationPlanner(model,rows,metric)(availableCP);
}
export function createChallengeContinuationPlanner(model,rows,metric='badges'){
 if(!rows.length)throw Error('缺少可计算的后续挑战方案');
 const secondary=metric==='badges'?'eventPoints':'badges';
 const picks=modelChallengeCosts(model,rows).map(cost=>{
   const options=rows.map(row=>({row,reward:model.rewards({mode:'challenge',scoreRank:row.reward.scoreRank,...row.bonuses,challengeCost:cost})}));
   options.sort((a,b)=>b.reward[metric]-a.reward[metric]||b.reward[secondary]-a.reward[secondary]
     ||compareEventPlans({...a.row,total:a.reward},{...b.row,total:b.reward},metric));
   return options[0];
 });
 const query=createChallengeSpendingPlanner(picks.map(p=>p.reward),metric);
 return availableCP=>{const plan=query(availableCP);return {...plan,stages:plan.consumption.map(c=>({...c,...picks.find(p=>p.reward.challengeCost===c.cost)}))};};
}
// Costs are supplied by the caller's rules, not invented from reward ratios.
function modelChallengeCosts(model,rows){return model.challengeCosts??[...new Set(rows.map(r=>r.reward.challengeCost))];}

/** Reuse the evaluated teams, restricting each spending plan to one chart.
 * Keep all goals' teams, just as the default continuation does. */
export function createChallengeSongPlanners(model,rows,metric='badges'){
 const charts=new Map();
 for(const row of rows){
   if(!charts.has(row.song.id))charts.set(row.song.id,[]);
   charts.get(row.song.id).push(row);
 }
 return [...charts.values()].map(teams=>({song:teams[0].song,plan:createChallengeContinuationPlanner(model,teams,metric)}));
}
