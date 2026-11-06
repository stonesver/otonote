import {validateHighScoreDeck} from './player-ranking-decks.mjs';
import {arenaRankingDeck,arenaRankIcon,arenaRankingPreview} from './arena-ranking-decks.mjs';
/** Independent public observations. Nothing here logs in or calls the game. */
const absolute=value=>typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
/** A score-to-threshold conversion, not a personal-rank response from the game. */
export function arenaRankingTier(point,{rankData,context,observation}={}) {
 const season=context?.season,band=context?.league?.bandId,stamp=Date.parse(observation?.observedAt);
 if(!integer(point)||!rankData?.capabilities?.ranks||!rankData.serverScopes?.includes(context?.serverId)
  ||observation?.sourceReleaseId!==rankData.sourceReleaseId||observation?.serverId!==context.serverId
  ||observation?.seasonId!==season?.id||observation?.bandId!==band
  ||!Number.isFinite(stamp)||!(Date.parse(season?.validFrom)<=stamp&&stamp<Date.parse(season?.validUntil)))return null;
 const source=rankData.ranks.filter(r=>r.bandId===band);
 if(!source.length||source.some(r=>!integer(r.threshold)||!integer(r.tier,1)||!integer(r.division,1)
  ||typeof r.name!=='string'||(r.opensAt?!absolute(r.opensAt):r.openingSourceText!=='')))return null;
 const rows=source.filter(r=>!r.opensAt||absolute(r.opensAt)&&Date.parse(r.opensAt)<=stamp).sort((a,b)=>a.threshold-b.threshold);
 if(new Set(rows.map(r=>r.threshold)).size!==rows.length)return null;
 return rows.filter(r=>r.threshold<=point).at(-1)??null;
}
export function validateArenaRankings(value,scope) {
 if(value?.schemaVersion!==1||['serverId','seasonId','bandId'].some(k=>value[k]!==scope[k])
  ||!['available','stale','empty','unavailable'].includes(value.status)||!Array.isArray(value.entries)
  ||value.entries.length>100||value.nextCursor!==null&&(typeof value.nextCursor!=='string'||value.nextCursor.length>1024))throw Error('Invalid arena ranking response');
 if(value.status==='unavailable') {
  if(value.entries.length||value.observedAt!==null||value.expiresAt!==null||value.nextCursor!==null||value.snapshotId!==null)throw Error('Invalid missing arena ranking');
  return value;
 }
 if(!absolute(value.observedAt)||!absolute(value.expiresAt)||Date.parse(value.expiresAt)<=Date.parse(value.observedAt)
  ||!/^[a-f0-9]{64}$/.test(value.snapshotId??'')||!integer(value.maxRank)||!integer(value.totalEntries)
  ||!integer(value.coverage?.startRank,1)||!integer(value.coverage?.endRank,value.coverage.startRank)
  ||value.coverage.endRank-value.coverage.startRank>=1000||value.totalEntries>1000
  ||value.entries.length>value.totalEntries||value.status==='empty'&&value.totalEntries!==0
  ||value.status==='available'&&value.totalEntries===0)throw Error('Invalid arena ranking observation');
 const ids=new Set();let previous=0;
 for(const row of value.entries) {
  if(typeof row?.playerId!=='string'||!row.playerId||row.playerId.length>128||ids.has(row.playerId)
   ||typeof row.name!=='string'||row.name.length>100||!integer(row.rank,1)||!integer(row.point)
   ||row.rank<previous||row.rank<value.coverage.startRank||row.rank>Math.min(value.coverage.endRank,value.maxRank))throw Error('Invalid arena ranking entry');
  validateHighScoreDeck(row.deck);
  ids.add(row.playerId);previous=row.rank;
 }
 return value;
}

export function createArenaRankingClient({fetcher=fetch,now=()=>Date.now(),onChange=()=>{},live=false}={}) {
 let key='',scope=null,generation=0,abort=null,state={status:'select-server',data:null,entries:[],loadingMore:false};
 const notify=()=>onChange(getState());
 function getState() {
  return {...state,status:state.data&&Date.parse(state.data.expiresAt)<=now()&&['available','empty','stale'].includes(state.status)?'stale':state.status,scope};
 }
 async function request(append=false,quiet=false) {
  if(quiet&&(state.loadingMore||state.refreshing||state.status==='loading'||state.data?.mode!=='dynamic'&&state.entries.length>100))return;
  const previous=state;
  const stamp=++generation;abort?.abort();abort=new AbortController();
  state=quiet?{...state,refreshing:true,refreshError:false}:append?{...state,loadingMore:true,paginationError:false}:{status:'loading',data:null,entries:[],loadingMore:false};notify();
  const params=new URLSearchParams({server:scope.serverId,season:scope.seasonId,band:scope.bandId,limit:String(quiet?Math.max(50,Math.min(previous.entries.length,100)):50)});
  if(scope.rank!==undefined)params.set('rank',String(scope.rank));
  if(scope.end!==undefined)params.set('end',String(scope.end));
  if(append&&state.data?.nextCursor)params.set('cursor',state.data.nextCursor);
  try {
   let response=await fetcher((live&&scope.rank!==undefined?'/api/v1/arena-rankings-live?':'/api/v1/arena-rankings?')+params,{signal:abort.signal,cache:'no-store',credentials:'omit'});
   if(live&&scope.rank!==undefined&&scope.end===undefined&&[404,501].includes(response.status))response=await fetcher('/api/v1/arena-rankings?'+params,{signal:abort.signal,cache:'no-store',credentials:'omit'});
   if(live&&scope.end!==undefined&&[404,501].includes(response.status)){state={status:'lookup-unavailable',data:null,entries:[],loadingMore:false};notify();return;}
   if(response.status===429){const retry=Number(response.headers?.get?.('Retry-After'));state={...previous,status:previous.data?previous.status:'busy',refreshing:false,retryAfter:Number.isFinite(retry)?retry:60};notify();return;}
   if(stamp!==generation)return;
   if(response.status===409){state={status:'changed',data:null,entries:[],loadingMore:false};notify();return;}
   if(!response.ok)throw Error('Ranking unavailable');
   const data=validateArenaRankings(await response.json(),scope);
   if(stamp!==generation)return;
   if(scope.end!==undefined&&data.status!=='unavailable'&&(data.coverage.startRank!==scope.rank||data.coverage.endRank!==scope.end))throw Error('Range mismatch');
   if(scope.rank&&data.status!=='unavailable'&&!(data.coverage.startRank<=scope.rank&&scope.rank<=data.coverage.endRank))throw Error('Range mismatch');
   if(quiet&&data.snapshotId===previous.data?.snapshotId){state={...previous,refreshing:false,refreshError:false,retryAfter:null};notify();return;}
   if(append&&((data.nextCursor&&(!data.entries.length||data.nextCursor===state.data?.nextCursor))||data.snapshotId!==state.data?.snapshotId||data.entries.some(row=>state.entries.some(old=>old.playerId===row.playerId))
     ||data.entries[0]?.rank<state.entries.at(-1)?.rank)){
    state={status:'changed',data:null,entries:[],loadingMore:false};notify();return;
   }
   state={status:data.status==='unavailable'?'not-collected':data.status,data,entries:append?[...state.entries,...data.entries]:data.entries,loadingMore:false};notify();
  }catch(error) {
   if(stamp!==generation||error.name==='AbortError')return;
   state=quiet?{...previous,refreshing:false,refreshError:true}:append?{...state,loadingMore:false,paginationError:true}:{status:'error',data:null,entries:[],loadingMore:false};notify();
  }
 }
 function select(next) {
  const newKey=JSON.stringify(next);
  if(newKey===key){notify();return;}
  key=newKey;scope=next;++generation;abort?.abort();
  const missing=!next.serverId?'select-server':!next.seasonId?'select-season':!next.bandId?'select-band':null;
  if(missing){state={status:missing,data:null,entries:[],loadingMore:false};notify();return;}
  void request();
 }
 return {select,getState,check:()=>scope?.serverId&&scope.seasonId&&scope.bandId?request(false,true):undefined,reload:()=>scope?.serverId&&scope.seasonId&&scope.bandId?request():undefined,
  more:()=>state.data?.nextCursor&&!state.loadingMore?request(true):undefined,
  destroy:()=>{++generation;abort?.abort();}};
}

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function arenaRankingsView({state,t,time,rankData,context,visuals={},base='',scopeLabel='',now=Date.now()}) {
 const copy={loading:t('正在读取玩家排行榜…','Loading player rankings…'),
  'select-server':t('选择账号区服后查看对应排行榜。','Choose an account server to view its rankings.'),
  'select-season':t('请选择已收录赛季。','Choose a recorded season.'),'select-band':t('请选择乐队。','Choose a band.'),
  'lookup-unavailable':t('指定名次查询服务尚未接通，可返回前 1000 名或稍后重试。','Rank lookup service is not connected. Return to the top 1000 or try later.'),
  'not-collected':t('此区服、赛季和乐队的排行榜尚未采集。','Rankings have not been collected for this server, season and band.'),
  empty:t('本次官方响应未返回所查区间的排名记录。','The official response returned no ranking entries in this range.'),
  stale:t('榜单快照已过期，以下为上次采集记录。','This snapshot has expired. Entries below are from the previous capture.'),
  error:t('排行榜暂时无法读取，请重试。','Rankings could not be loaded. Retry.'),
  changed:t('榜单已更新，请重新载入后继续查看。','Rankings have changed. Reload before continuing.')};
 const data=state.data,status=state.status;
 const scoped=state.scope?.serverId&&state.scope?.seasonId&&state.scope?.bandId;
 const rankForm=scoped?`<form class="arena-rank-search" data-arena-rank-form><label>${t('起始名次','Start rank')}<input name="rank" type="number" inputmode="numeric" min="1" max="2147483647" step="1" required value="${escape(state.scope.rank??1)}"></label><span aria-hidden="true">–</span><label>${t('结束名次','End rank')}<input name="end" type="number" inputmode="numeric" min="1" max="2147483647" step="1" placeholder="${t('留空查单名次','Blank for one rank')}" value="${escape(state.scope.end??'')}"></label><button type="submit">${t('查询','Find')}</button>${state.scope.rank!==undefined?`<button type="button" data-action="ranking-top">${t('返回前 1000','Back to top 1000')}</button>`:''}<small>${t('每次最多 100 名 · 留空结束名次可查单个排名','Up to 100 ranks · Leave end blank for one rank')}</small></form>`:'';
 return `<div data-ranking-overview><header class="arena-section-header"><div><h2>${t('玩家排行榜','Player rankings')}</h2><p class="arena-meta">${escape(scopeLabel)}</p></div>${scoped?`<div class="arena-actions"><button type="button" data-action="my-rank" aria-haspopup="dialog">${t('我的排名','My rank')}</button><button type="button" data-action="ranking-refresh"${status==='loading'?' disabled':''}>${t('刷新榜单','Refresh rankings')}</button></div>`:''}</header>
  ${rankForm}${status==='busy'||state.retryAfter?`<p class="arena-ranking-status" role="status">${escape(t(`查询频率已限制，请约 ${state.retryAfter??60} 秒后重试。`,`Query rate limited. Retry in about ${state.retryAfter??60} seconds.`))}</p>`:''}${state.refreshError?`<p class="arena-ranking-status" role="status">${t('更新失败，保留上次查询结果。','Update failed. Showing the previous results.')}</p>`:''}
  ${copy[status]?`<p class="arena-ranking-status" role="status">${escape(copy[status])}</p>`:''}
  ${data?.mode==='dynamic'?`<p class="arena-meta">${t('按需查询 · 最多 100 名 · 共用 5 分钟缓存','On-demand lookup · Up to 100 ranks · Shared 5-minute cache')}</p>`:data?.snapshotId?`<p class="arena-meta">${t('默认展示已采集的前 1000 名；指定名次／范围按需查询。','Showing the captured top 1000; specific ranks and ranges are queried on demand.')}</p>`:''}
  ${data&&data.snapshotId?`<p class="arena-meta">${escape((data.mode==='dynamic'?t('查询于 ','Queried '):t('采集于 ','Captured '))+time(data.observedAt))} · ${escape(t(`已采集第 ${data.coverage.startRank}–${data.coverage.endRank} 名区间 · 共 ${data.totalEntries} 条`,`Captured rank range ${data.coverage.startRank}–${data.coverage.endRank}`))}${data.mode==='dynamic'?' · '+escape(t(`官方最大名次 ${data.maxRank.toLocaleString()}`,`Official maximum rank ${data.maxRank.toLocaleString()}`)):''}${Date.parse(data.observedAt)>now?' · '+t('快照时间晚于设备时间','Snapshot is dated after device time'):''}</p>`:''}
  ${state.entries.length?`<div class="arena-ranking-columns" aria-hidden="true"><span>#</span><span>${t('玩家','Player')}</span><span>${t('队伍预览','Team preview')}</span><span>${t('积分对应段位','Rank by points')}</span><span>${t('积分','Points')}</span><span></span></div>`:''}</div>${state.entries.length?`<ol class="arena-ranking-list" aria-label="${t('玩家排名','Player ranks')}">${state.entries.map(row=>{
   const tier=arenaRankingTier(row.point,{rankData,context,observation:data});
   return `<li data-player-rank="${row.rank}" data-player-id="${escape(row.playerId)}"><details class="arena-ranking-player"><summary><span class="arena-player-rank" aria-label="${escape(t(`第 ${row.rank} 名`,`Rank ${row.rank}`))}">${row.rank}</span><span class="arena-player-name">${escape(row.name||t('未命名玩家','Unnamed player'))}</span>${arenaRankingPreview(row.deck,{visuals,t})}<span class="arena-player-tier" data-tier="${tier?.tier??''}" title="${escape(tier?t('按同版配置及快照采集时的积分门槛换算','Converted using matching rules and thresholds at capture time'):t('段位门槛或快照版本未通过核验','Rank thresholds or snapshot version could not be verified'))}">${arenaRankIcon(rankData,tier?.tier)}<span>${escape(tier?.name??t('段位待核验','Rank unverified'))}</span></span><strong class="arena-player-score" aria-label="${escape(t('榜单积分 ','Ranking points ')+row.point)}">${row.point.toLocaleString()}</strong><span class="arena-deck-toggle">${t('查看队伍','View team')}<span aria-hidden="true">⌄</span></span></summary><div class="arena-ranking-deck">${arenaRankingDeck(row.deck,{visuals,base,serverId:context?.serverId,t})}</div></details></li>`;
  }).join('')}</ol>`:''}<div data-ranking-footer>${state.entries.length?`<p class="arena-meta">${t('段位按快照积分与同版门槛换算，不代表玩家当前实时段位。','Ranks are converted from snapshot points and matching thresholds, not the player’s current live rank.')}</p>`:''}
  ${status==='stale'&&!state.entries.length?`<p class="arena-meta">${t('上次快照未返回所查区间的排名记录。','The previous snapshot returned no entries in this range.')}</p>`:''}
  ${state.paginationError?`<p class="arena-ranking-status" role="status">${t('更多排名读取失败，已加载记录保留。','More rankings could not be loaded. Loaded entries are retained.')}</p>`:''}
  ${data?.nextCursor?`<button type="button" data-action="ranking-more"${state.loadingMore?' disabled':''}>${state.loadingMore?t('加载中…','Loading…'):state.paginationError?t('重试加载更多','Retry loading more'):t('查看更多排名','Show more rankings')}</button><small class="arena-ranking-count">${t(`已显示 ${state.entries.length} / ${data.totalEntries} · 下滑继续加载`,`Showing ${state.entries.length} / ${data.totalEntries} · Scroll for more`)}</small><span data-ranking-sentinel aria-hidden="true"></span>`:state.entries.length?`<p class="arena-meta">${t(`已显示全部 ${state.entries.length} 条已采集记录`,`All ${state.entries.length} captured entries are shown`)}</p>`:''}</div>`;
}
