import {entriesFromCharts} from './playlist-store.mjs';
/** Transparent catalog rules, not personalised optimal-song claims. No scoring
 * or full-song fetch is performed to offer these starting scopes. */
export function recommendedPlaylists({tracks,charts,sourceReleaseId}) {
  const seconds=new Map(tracks.map(t=>[t.id,Number(t.audioDuration)||0]));
  for(const c of charts)seconds.set(c.trackId,Math.max(seconds.get(c.trackId)||0,Number(c.duration)||0));
  const usable=charts.filter(c=>c.analysisDataUrl);
  const songs=[...new Set(usable.map(c=>c.trackId))].filter(id=>seconds.get(id)>0).sort((a,b)=>seconds.get(a)-seconds.get(b)||a.localeCompare(b)).slice(0,10);
  const short=usable.filter(c=>songs.includes(c.trackId));
  const approachable=usable.filter(c=>['normal','hard'].includes(c.difficulty)&&c.level<=20).sort((a,b)=>a.level-b.level||(seconds.get(a.trackId)||Infinity)-(seconds.get(b.trackId)||Infinity)||a.id.localeCompare(b.id)).slice(0,20);
  return [
    {id:'short-songs-v1',name:'短时长候选',entries:entriesFromCharts(short),note:'按当前目录时长升序取前 10 首有计算资料的歌曲，包含其可计算难度。仅减少单次演出时长，不保证单位耗火或单位时间收益最高。'},
    {id:'moderate-charts-v1',name:'低等级练习候选',entries:entriesFromCharts(approachable),note:'NORMAL / HARD、Lv.20 及以下，按等级、时长选前 20 张可计算谱面。不保证个人发挥或达档结果。'}
  ].map(p=>({...p,revision:1,sourceReleaseId}));
}
