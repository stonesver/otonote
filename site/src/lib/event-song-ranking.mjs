import {estimateAPChart} from './ap-grade.mjs';
import {scoreGradeProbabilities} from './scoring-rules/score-distribution.mjs';

export function eventSongCandidates({tracks,charts,allowedTrackIds=null,difficulty='expert',maxLevel=40,band='',attribute=''}) {
 const allowed=allowedTrackIds==null?null:new Set(allowedTrackIds);
 const matchingTracks=new Set(tracks.filter(t=>(!band||t.bandIds?.includes(band))&&(!attribute||String(t.musicType)===String(attribute))).map(t=>t.id));
 const lengths=new Map(tracks.map(t=>[t.id,Number(t.audioDuration)||0]));
 for(const c of charts)lengths.set(c.trackId,Math.max(lengths.get(c.trackId)||0,Number(c.duration)||0));
 const names=new Map(tracks.map(t=>[t.id,t.title]));
 return charts.filter(c=>c.analysisDataUrl&&(!(band||attribute)||matchingTracks.has(c.trackId))&&(!allowed||allowed.has(c.trackId))&&(difficulty==='all'||c.difficulty===difficulty)&&c.level<=maxLevel)
  .map(c=>({...c,title:names.get(c.trackId)??c.trackId,seconds:lengths.get(c.trackId)||null}));
}

export function eventSongYield(reward) {
 const cost=reward.mode==='challenge'?reward.challengeCost:reward.liveBoost;
 return Object.fromEntries(['badges','eventPoints','challengePoints'].map(k=>[k,cost>0?reward[k]/cost:null]));
}

export function sortEventSongs(rows,metric='short') {
 const time=r=>r.seconds??Infinity;
 return [...rows].sort((a,b)=>{
  if(metric!=='short'){
   const av=a.yield?.[metric],bv=b.yield?.[metric];
   if(av==null&&bv!=null)return 1;if(bv==null&&av!=null)return -1;
   if(av!=null&&bv!=null&&av!==bv)return bv-av;
  }
  return time(a)-time(b)||a.level-b.level||a.id.localeCompare(b.id);
 });
}

export function eventGradeEstimate(model,musicId,score,basis='expectedScore'){
 if(!['expectedScore','minimumScore','maximumScore'].includes(basis))throw Error('Invalid AP score basis');
 const rank=model.scoreRank(musicId,score[basis]);
 return {scoreRank:rank,scoreBasis:basis,estimatedScore:score[basis],minimumRank:model.scoreRank(musicId,score.minimumScore),maximumRank:model.scoreRank(musicId,score.maximumScore)};
}

// Reward rounding happens inside model.rewards BEFORE taking the expectation.
// Only amounts and per-cost ratios are averaged, never IDs, costs or ranks.
export function eventRewardForScore(model, result, options) {
 const reward=model.rewards({...options,scoreRank:result.scoreRank});
 if(result.scoreBasis!=='expectedScore')return {...reward,rewardBasis:'selected_score'};
 if(!result.scoreDistribution||result.scoreDistribution.kind!=='skill_orders'||!result.scoreDistribution.complete)throw Error('平均活动收益需要完整技能顺序分布');
 const grades=scoreGradeProbabilities(result.scoreDistribution,result.thresholds).filter(g=>g.count>0);
 const rewards=grades.map(g=>({probability:g.probability,reward:model.rewards({...options,scoreRank:g.rank})}));
 const amounts={};
 for(const key of ['badges','eventPoints','challengePoints','badgesPerChallengePoint','challengePointsPerBoost','badgesPerBoost']){
   amounts[key]=rewards.every(r=>Number.isFinite(r.reward[key]))?rewards.reduce((sum,r)=>sum+r.reward[key]*r.probability,0):null;
 }
 return {...reward,...amounts,scoreRank:null,rewardBasis:'order_expectation'};
}

// AP score under the chosen skill-order basis, not a bound for real play.
export function estimateEventSong({rules,model,chart,draft,candidate,options}) {
 if(options.mode==='gekisou')throw Error('激奏需要团队结算评分，不能用个人估分推算。');
 const result=estimateAPChart({rules,draft,chart,candidate,mode:options.mode,eventId:model.event._id,basis:options.scoreBasis??'expectedScore'});
 const reward=eventRewardForScore(model,result,options);
 return {...result,reward,yield:eventSongYield(reward),estimated:true};
}
