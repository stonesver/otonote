import {normalizePlaylistEntries} from './playlist-store.mjs';
import {stableSnapshotHash} from './scoring-engine.mjs';
import {filterValues} from './filter-controls.mjs';
export const chartKey = chart => `${chart.trackId}:${chart.difficulty}`;
const reasons = {missing_song:'当前区服不可用',missing_difficulty:'当前资料没有此难度',mode:'当前模式不可用',event:'不在活动允许曲目中',difficulty:'被难度条件排除',level:'超过最高等级',band:'被乐队条件排除',attribute:'被属性条件排除',data:'谱面计算资料暂缺',removed:'本次已移除'};
/** Resolve membership before loading any chart or invoking a scorer. Missing data
 * stays visible as a coverage gap, rather than silently changing the saved list. */
export function resolveCalculationScope({tracks,charts,selection={kind:'all'},playlists=[],recommendations=[],context={},sourceReleaseId,
  allowedTrackIds=null,modeTrackIds=null,difficulty='all',maxLevel=40,band='',attribute='',fixedRangeTitle}) {
  // A tool-defined song or event pool is independent of a remembered playlist.
  if(fixedRangeTitle)selection={kind:'all'};
  const source = selection.kind==='playlist' ? playlists.find(p=>p.id===selection.id) : selection.kind==='recommended' ? recommendations.find(p=>p.id===selection.id) : null;
  if(!['all','playlist','recommended','temporary'].includes(selection.kind))throw Error('计算范围无效');
  if(['playlist','recommended'].includes(selection.kind)&&!source)throw Error('所选歌单已不存在，请重新选择计算范围');
  const title=fixedRangeTitle??source?.name??(selection.kind==='temporary'?'本次临时范围':'全部可用谱面');
  const entries=selection.entries ? normalizePlaylistEntries(selection.entries) : source?.entries;
  if(selection.kind==='temporary'&&!entries)throw Error('临时范围无效');
  const requested = new Map(), excluded=[], trackMap=new Map(tracks.map(t=>[t.id,t]));
  const reject=(trackId,difficulty,reason)=>excluded.push({trackId,difficulty,reason,message:reasons[reason]});
  if(entries)for(const e of entries){
    if(!trackMap.has(e.trackId)){reject(e.trackId,null,'missing_song');continue;}
    const found=charts.filter(c=>c.trackId===e.trackId);
    if(e.difficulties==='all') {if(!found.length)reject(e.trackId,null,'missing_difficulty');for(const c of found)requested.set(chartKey(c),c);}
    else for(const d of e.difficulties){const c=found.find(c=>c.difficulty===d);if(c)requested.set(chartKey(c),c);else reject(e.trackId,d,'missing_difficulty');}
  } else for(const c of charts)requested.set(chartKey(c),c);
  const allowed=allowedTrackIds==null?null:new Set(allowedTrackIds),modeAllowed=modeTrackIds==null?null:new Set(modeTrackIds);
  const ds=difficulty==='all'?null:new Set(Array.isArray(difficulty)?difficulty:[difficulty]);
  const bands=new Set(filterValues(band)),attributes=new Set(filterValues(attribute).map(String)),effective=[];
  const durations=new Map(tracks.map(t=>[t.id,Number(t.audioDuration)||0]));
  for(const c of charts)durations.set(c.trackId,Math.max(durations.get(c.trackId)||0,Number(c.duration)||0));
  for(const c of requested.values()){
    const t=trackMap.get(c.trackId);
    const reason=!t?'missing_song':modeAllowed&&!modeAllowed.has(c.trackId)?'mode':allowed&&!allowed.has(c.trackId)?'event':
      ds&&!ds.has(c.difficulty)?'difficulty':c.level>maxLevel?'level':bands.size&&!t.bandIds?.some(b=>bands.has(b))?'band':attributes.size&&!attributes.has(String(t.musicType))?'attribute':!c.analysisDataUrl?'data':null;
    if(reason)reject(c.trackId,c.difficulty,reason);else effective.push({...c,title:t.title??c.trackId,seconds:durations.get(c.trackId)||null});
  }
  const membership=effective.map(chartKey).sort();
  return {title,source:{kind:fixedRangeTitle?'fixed':selection.kind,id:source?.id??null,revision:source?.revision??null},adjusted:Boolean(selection.entries),
    context,sourceReleaseId,candidates:effective,excluded,songCount:new Set(effective.map(c=>c.trackId)).size,chartCount:effective.length,
    requestedSongCount:entries?entries.length:new Set(charts.map(c=>c.trackId)).size,requestedChartCount:requested.size,
    dataIncomplete:excluded.some(e=>['data','missing_song','missing_difficulty'].includes(e.reason)),
    fingerprint:stableSnapshotHash({context,sourceReleaseId,membership})};
}
export function requireCalculationScope(scope) {if(!scope.chartCount)throw Error(scope.source.kind==='fixed'?'固定曲目范围为空，请检查活动曲池、难度与谱面资料':'计算范围为空，请调整歌单或筛选条件；不会自动改为全曲计算');return scope;}
export function scopeSummary(scope) {if(!scope)return '综合能力比较：未指定歌曲';return `范围：${scope.title}${scope.adjusted?' · 本次已调整':''} · ${scope.songCount} 首 / ${scope.chartCount} 张谱面${scope.excluded.length?`；${scope.excluded.length} 个条目未参与`:''}`;}

/** Keep result counts and cache identity tied to the charts actually selected. */
export function selectedChartScope(scope,draft) {
  assertChartInScope(scope,draft);
  const candidates=scope.candidates.filter(c=>c.trackId===draft.selectedSongId&&c.difficulty===draft.selectedDifficulty);
  return {...scope,candidates,songCount:1,chartCount:1,fingerprint:stableSnapshotHash({context:scope.context,sourceReleaseId:scope.sourceReleaseId,membership:candidates.map(chartKey).sort()})};
}

export function assertChartInScope(scope,draft) {requireCalculationScope(scope);if(!draft.selectedSongId)throw Error('请先选择歌曲和难度。');if(!scope.candidates.some(c=>c.trackId===draft.selectedSongId&&c.difficulty===draft.selectedDifficulty))throw Error(scope.source.kind==='fixed'?'当前谱面不在指定曲目范围内或资料暂缺，请重新选曲。':'当前谱面不在计算范围内，请从歌单中选曲或扩大范围。');}
