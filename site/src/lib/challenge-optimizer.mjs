import {optimizePractical} from './practical-optimizer.mjs';
import {createEventEfficiency} from './scoring-rules/event-efficiency.mjs';

/** Challenge scoring uses the event power/song context at every search stage.
 * This bounded search deliberately does not use the ordinary-score upper bound. */
export async function optimizeChallenge({rules,eventId,draft,chart,scope='owned',inventory,
  objective='maximum_song_score',signal,onProgress,yieldControl}) {
  if(!['owned','selected'].includes(scope))throw Error('请选择已保存卡库或当前十张卡');
  if(!['maximum_song_score','expected_song_score'].includes(objective))throw Error('无效的挑战出分目标');
  const model=createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId});
  if(!rules.tables.ChallengeMusic.some(r=>r._eventId===eventId&&`music-${r._liveMusicId}`===draft.selectedSongId))throw Error('请先选择本期挑战歌曲');
  const next=structuredClone(draft);
  next.modifiers??={};
  next.modifiers.event={id:eventId,sourceReleaseId:rules.sourceReleaseId};
  if(scope==='owned') {
    if(!inventory)throw Error('请先导入并保存实际卡库与养成');
    const growth=structuredClone(inventory.growth??{});
    for(const [id,value] of Object.entries(next.modifiers.growth??{}))growth[id]={...growth[id],...value};
    next.modifiers.growth=growth;
  }
  const result=await optimizePractical({rules,draft:next,chart,scope,inventory,objective,performanceScenario:next.modifiers.performanceScenario,
    eventAdapters:[model.challengeAdapter(rules)],signal,onProgress,yieldControl});
  return {...result,mode:'challenge',eventId};
}
