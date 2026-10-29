import {artifact,pageContext,snapshot,pinnedContentPointer} from '../runtime/content.mjs';
import {restoreServerLabels} from './server-label.mjs';
import {GAME_SERVERS,resolveServer} from './game-servers.mjs';
import {arenaContext,arenaIdentity,arenaParams,baseAP,validateArena,intervalState,arenaTime,arenaBandPreviews} from './arena-context.mjs';
import {createPopulationClient,populationView} from './arena-population.mjs';
import {installArenaPersonal} from './arena-personal.mjs';
import {arenaRankGroups} from './arena-reference.mjs';
import {createArenaRankingScroll,patchArenaRankings} from './arena-ranking-scroll.mjs';
import {resolveArenaCondition} from './arena-presentation.mjs';
import {arenaTrendView} from './arena-trend-view.mjs';
import {createArenaRankingClient,arenaRankingsView} from './arena-rankings.mjs';
import {createContentUpdateCheck,installArenaUpdates,nextArenaDailyCheck} from './arena-updates.mjs';

const escape = value => String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const option=(value,label,selected)=>`<option value="${escape(value)}"${selected?' selected':''}>${escape(label)}</option>`;
const button=(action,label,extra='')=>`<button type="button" data-action="${action}" ${extra}>${label}</button>`;
export async function installArenaPage(root, {clock=()=>Date.now()} = {}) {
 if (root.dataset.installed) return;
 root.dataset.installed='true';
 const {region,locale,base}=pageContext(),handoff=root.dataset.handoff==='true',en=locale==='en',t=(zh,english)=>en?english:zh;
 const body=root.querySelector('[data-arena-body]'),meta=root.querySelector('[data-arena-meta]'),feedback=root.querySelector('[data-arena-feedback]');
 root.addEventListener('error',event=>{if(event.target instanceof HTMLImageElement)event.target.hidden=true;},true);
 const visuals=JSON.parse(root.querySelector('[data-arena-visuals]').textContent);
 let data=null,context=null,all=false,loading=true,error=null,check=null,freshness='unknown',tier=null,players=5,generation=0,updateNotice='',clockNotice='',trendKind=handoff?'all':'leaders',trendExpanded=false;
 const dialog=root.querySelector('[data-arena-dialog]'),dialogBody=root.querySelector('[data-arena-dialog-body]');
 dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
 let restoreTrendFocus=true;
 dialog.addEventListener('close',()=>{if(restoreTrendFocus)root.querySelector('[data-action="trend-more"]')?.focus();restoreTrendFocus=true;rankingScroll?.observe();});
 const referenceDialog=root.querySelector('[data-arena-reference-dialog]'),referenceBody=root.querySelector('[data-arena-reference-body]');
 let referenceKind=null,restoreReferenceFocus=true,initialViewHandled=false,rankingScroll=null;
 referenceDialog.addEventListener('click',event=>{if(event.target===referenceDialog)referenceDialog.close();});
 referenceDialog.addEventListener('close',()=>{if(restoreReferenceFocus)root.querySelector(`[data-action="reference"][data-value="${referenceKind}"]`)?.focus({preventScroll:true});restoreReferenceFocus=true;rankingScroll?.observe();});
 const population=createPopulationClient({now:clock,onChange:renderPopulation});
 function renderPopulation(state=population.getState()){
  const section=body.querySelector('[data-arena-population]');if(!section)return;
  const open=section.querySelector('details')?.open;
  section.innerHTML=populationView({state,rankData:data,context,ranking:rankingClient.getState().data,t,time});
  if(open)section.querySelector('details').open=true;
 }
 const personal=installArenaPersonal(root,{getData:()=>data,getContext:()=>context,t,time,onClose:()=>rankingScroll?.observe()});
 const rankingClient=createArenaRankingClient({now:clock,onChange:renderRankings,live:true});
 function renderRankings(state=rankingClient.getState()) {
  const section=body.querySelector('[data-arena-rankings]');if(!section)return;
  const server=GAME_SERVERS.find(s=>s.id===context?.serverId);
  section.dataset.rankingState=state.status;section.setAttribute('aria-busy',String(state.status==='loading'||state.loadingMore));
  const markup=arenaRankingsView({state,t,time,now:clock(),rankData:data,context,visuals,base,scopeLabel:[server?.[en?'englishLabel':'label'],context?.season?.name,context?.league?.name].filter(Boolean).join(' · ')});
  patchArenaRankings(section,markup,state.data?.snapshotId);rankingScroll?.observe();renderPopulation();
 }
 rankingScroll=createArenaRankingScroll({root,getState:rankingClient.getState,loadMore:rankingClient.more,isBlocked:()=>dialog.open||referenceDialog.open||personal.isOpen()});
 function referenceNav(){return `<nav class="arena-reference-nav" aria-label="${t('舞台说明','Arena information')}">${[['schedule',t('条件安排','Schedule')],['ranks',t('段位与 AP','Ranks & AP')],['rules',t('奖励与规则','Rewards & rules')]].map(([key,label])=>button('reference',label,`data-value="${key}" aria-haspopup="dialog"`)).join('')}</nav>`;}
 function renderReference(preserve=false){
  if(!referenceKind)return;
  const expanded=preserve?new Set([...referenceBody.querySelectorAll('details[open]')].map(el=>el.querySelector('summary')?.textContent)):null;
  const field=referenceDialog.contains(document.activeElement)?document.activeElement?.dataset.field:null;
  root.querySelector('[data-arena-reference-title]').textContent={schedule:t('条件安排','Condition schedule'),ranks:t('段位与基础 AP','Ranks & base AP'),rules:t('奖励与规则','Rewards & rules')}[referenceKind];
  referenceBody.dataset.section=referenceKind==='ranks'?'points':referenceKind;
  referenceBody.innerHTML=referenceKind==='schedule'?`<p class="arena-meta">${escape([context?.season?.name,context?.league?.name].filter(Boolean).join(' · '))}</p>${schedule()}`:referenceKind==='ranks'?ranks():rules();
  if(expanded)for(const details of referenceBody.querySelectorAll('details'))if(expanded.has(details.querySelector('summary')?.textContent))details.open=true;
  if(field)referenceBody.querySelector(`[data-field="${CSS.escape(field)}"]`)?.focus({preventScroll:true});
 }
 function openReference(kind){
  if(!['schedule','ranks','rules'].includes(kind))return;
  referenceKind=kind;renderReference();if(!referenceDialog.open)referenceDialog.showModal();
 }
 const labels={current:t('当前','Current'),preview:t('预告','Upcoming'),history:t('历史','Historical'),unverified:t('时间待核验','Time unverified')};
 const messages={missing:t('舞台资料暂未提供。','Arena data has not been provided.'),
  'invalid-server':t('链接的账号区服与内容版本不匹配，请重新选择。','Account server does not match this edition. Choose a server.'),
  'invalid-view':t('链接中的视图无效，请重新选择舞台。','The linked view is invalid. Choose a stage.'),
  'unknown-season':t('该赛季资料未收录。','This season has not been recorded.'),
  'unknown-band':t('该乐队资料未收录，请选择已公布乐队。','This band is not recorded. Choose a published band.'),
  'unknown-regulation':t('该条件未收录或不属于所选赛季／乐队。','This condition is not recorded for this season and band.'),
  'no-season':t('当前没有已公布的舞台赛季，可选择已收录资料。','No published arena season is active. Browse recorded seasons.'),
  'no-condition':t('新条件尚未收录，上一期不能用于当前参赛。','New conditions have not been recorded. Previous conditions cannot be used for current entry.'),
  unverified:t('时区或源时间端点尚未核验；原始时间仅供查阅，不能确认当前参赛条件。','Time zone or source endpoints are unverified. Source times are for reference; current entry is unavailable.'),
  'season-conflict':t('赛季时间冲突，当前条件不可用。','Conflicting seasons. Current conditions are unavailable.'),
  'condition-conflict':t('舞台条件存在重叠冲突，当前条件不可用。','Stage conditions overlap. Current conditions are unavailable.'),
  'league-conflict':t('乐队与联赛关联冲突，当前条件不可用。','Conflicting league to band mapping.'),
  'unverified-opening':t('该乐队的开放约束资料尚未确认，不能用于当前参赛。','Opening constraints for this band are unverified. Current entry is unavailable.'),
  'not-open':t('所选乐队尚未开放。','This band is not open yet.'),
  'select-band':t('请选择乐队以查看舞台条件。','Choose a band to view arena conditions.')};
 const attr=code=>code==null?t('选歌查看','Choose song'):code===0?t('选歌查看','Choose song'):code===99?t('ALL／全属性','ALL attributes'):(visuals.attribute.find(v=>Number(v.value)===code)?.label??t(`属性 ${code}`,`Attribute ${code}`));
 const mission=code=>[t('选歌查看','Choose song'), 'COMBO','LUCK','JUST'][code]??t('未知','Unknown');
 const missionCopy=[t('这一段沿用所选歌曲的原始任务。','This section uses the original song mission.'),t('按段内连击表现比较任务结果。','Compares combo performance within the section.'),t('按 LUCK 抽选结果比较任务表现。','Compares LUCK draw results within the section.'),t('按 JUST 表现比较任务结果；PERFECT 不等于 JUST。','Compares JUST performance. PERFECT is not the same as JUST.')];
 function time(value) {if(!value)return t('未核验','Unverified');return new Intl.DateTimeFormat(en?'en-GB':'zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));}
 const range=c=>data?.capabilities.conditions&&c?.validFrom&&c?.validUntil?`${time(c.validFrom)} → ${time(c.validUntil)} ${t('（结束时刻不含）','(end exclusive)')}`:c?.sourceTimeText??t('时间资料暂缺','Time unavailable');
 function summary(c=context) {
  if(!c?.condition)return '';
  return [t('激奏舞台','Gekisou Arena'),GAME_SERVERS.find(s=>s.id===c.serverId)?.[en?'englishLabel':'label']??t('未选账号区服','No account server'),
   c.season.name,c.league.name,attr(resolved(c.condition,c.league.bandId).attribute),resolved(c.condition,c.league.bandId).missions.map(mission).join(' / '),range(c.condition),
   `${t('页面时间','Displayed time')}: ${t('北京时间（UTC+8）','UTC+8')}`,
   `${t('资料时间','Observed at')}: ${data.observedAt??t('未记录','Not recorded')}`,t('抽歌后不能换队。','Teams are locked after song selection.')].join('\n');
 }
 function previousSummary(raw) {
  try {
   const old=JSON.parse(raw);
   if(!old||![0,1,2,3,4,5,99].includes(old.attribute)||!Array.isArray(old.missions)||old.missions.length!==3||old.missions.some(m=>![0,1,2,3].includes(m)))throw Error();
   return [GAME_SERVERS.find(s=>s.id===old.server)?.[en?'englishLabel':'label']??t('区服未确认','Server unverified'),
    data.seasons.find(s=>s.id===old.season)?.name??t('旧赛季','Previous season'),data.leagues.find(l=>l.bandId===old.band)?.name??t('旧乐队','Previous band'),
    attr(old.attribute),old.missions.map(mission).join(' / '),`${old.validFrom??'?'} → ${old.validUntil??'?'}`,t('链接提供，未经重新核验。','Provided by the link; not independently verified.')].join('\n');
  }catch{return t('旧摘要无法解析，请核对当前条件。','The old summary cannot be read. Review current conditions.');}
 }
 function taskIcon(code,mini=false) {
  const short=[t('选歌','Song'),'C','L','J'][code]??'—';
  return `<span class="${mini?'arena-mini-mission':'arena-task-icon'}" data-mission="${code}" title="${escape(mission(code))}" aria-hidden="true"><b>${short}</b></span>`;
 }
 function attributeMark(code,mini=false) {
  const v=visuals.attribute.find(v=>Number(v.value)===code);
  const short=code===0?t('选歌','Song'):code===99?'ALL':v?.label??String(code);
  return `<span class="${mini?'arena-mini-attribute':'arena-attribute-mark'}" title="${escape(attr(code))}" aria-hidden="true">${v?.icon?`<img src="${escape(v.icon)}" alt=""><b>${escape(short)}</b>`:`<b>${escape(short)}</b>`}</span>`;
 }
 function songsFor(bandId=context?.league?.bandId) {return (visuals.songs??[]).filter(s=>s.bandIds.includes(bandId));}
 function songFor(bandId=context?.league?.bandId) {
  const songs=songsFor(bandId),selected=query().get('music');
  return selected?songs.find(s=>s.id===selected)??null:songs[0]??null;
 }
 function resolved(row,bandId=context?.league?.bandId) {return resolveArenaCondition(row,songFor(bandId));}
 function missionMarks(row,bandId,mini=false) {
  const value=resolved(row,bandId);
  return value?.missions.map(m=>m?taskIcon(m,mini):`<span class="arena-mini-unavailable">—</span>`).join('')??'';
 }
 function bandButton(preview) {
  const {league:l,condition,status}=preview,visual=visuals.band.find(b=>b.value===l.bandId),value=resolved(condition,l.bandId);
  const state=labels[status]??(status.includes('conflict')?t('条件冲突','Conflict'):status==='no-condition'?t('未公布','Not published'):t('待核验','Unverified'));
  const description=value?`${attr(value.attribute)} · ${value.missions.map(mission).join(' / ')}`:state;
  return button('band',`<span class="arena-band-top">${visual?.icon?`<img class="arena-band-logo" src="${escape(visual.icon)}" alt="">`:''}<span class="arena-band-name">${escape(l.name)}</span></span><span class="arena-band-bottom"><span class="arena-band-conditions" aria-hidden="true">${value?`${attributeMark(value.attribute,true)}<span class="arena-mini-segments">${missionMarks(condition,l.bandId,true)}</span>`:'<span class="arena-mini-unavailable">—</span>'}</span><span class="arena-band-state">${escape(state)}</span></span>`,
   `class="arena-band" data-value="${escape(l.bandId)}" aria-label="${escape(l.name+' · '+state+' · '+description)}" aria-pressed="${context?.league?.id===l.id}"`);
 }
 function trends(modal=false) {return arenaTrendView({data,context,musicId:query().get('music'),visuals,t,base,time,kind:trendKind,compact:!handoff,expanded:modal||trendExpanded,modal,now:clock()});}
 function shortTime(value) {return new Intl.DateTimeFormat(en?'en-GB':'zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));}
 function card(c=context,title=null) {
  const row=c?.condition;if(!row)return '';
  const next=(c.schedule??[]).find(r=>arenaTime(r.validFrom)>=arenaTime(row.validUntil)),value=resolved(row,c.league.bandId);
  const logo=visuals.band.find(b=>b.value===c.league.bandId)?.icon;
  const same=value.missions.every(m=>m&&m===value.missions[0]),types=same?[value.missions[0]]:value.missions;
  const missionLabel=value.missions.map((m,i)=>t(`第 ${i+1} 段：`,`Section ${i+1}: `)+(m?mission(m):t('请选择歌曲','Choose a song'))).join(' / ');
  const missionLine=`<details class="arena-segments" data-missions="${value.missions.map(m=>m??0).join(',')}"><summary aria-label="${escape(missionLabel)}"><span class="arena-stage-label">${t('激奏','Sections')}</span>${types.map((m,i)=>`${!same&&i?'<span class="arena-segment-arrow" aria-hidden="true">›</span>':''}<strong data-mission="${m??0}">${escape(m?mission(m):t('选歌查看','Choose song'))}${same?'<small>×3</small>':''}</strong>`).join('')}</summary><p>${[...new Set(value.missions)].map(m=>escape(m?mission(m)+'：'+missionCopy[m]:t('选择歌曲后展示实际类型。','Choose a song to see the resolved types.'))).join('<br>')}</p></details>`;
  return `<section class="arena-condition"><header><div class="arena-band-heading">${logo?`<img src="${escape(logo)}" alt="">`:""}<div><span class="arena-kicker">${escape(c.season.name)}</span><h2>${escape(title??c.league.name)}</h2></div></div><span class="arena-state" data-state="${intervalState(row,clock())}">${escape(labels[intervalState(row,clock())])}</span></header>
   <div class="arena-stage-caption"><span class="arena-attribute">${attributeMark(value.attribute)}<span>${escape(attr(value.attribute))}<small>${t('舞台属性','STAGE ATTRIBUTE')}</small></span></span>${missionLine}</div>
   ${value.songDependent?`<label class="arena-dependent-song">${t('查看歌曲','Song conditions')}<select data-field="music">${songsFor(c.league.bandId).map(s=>option(s.id,s.title,s.id===value.songId)).join('')}</select></label>`:''}

   <div class="arena-validity"><span class="arena-live-dot" aria-hidden="true"></span><span class="arena-time" data-valid-from="${escape(row.validFrom)}" data-valid-until="${escape(row.validUntil)}">${escape(shortTime(row.validFrom)+' → '+shortTime(row.validUntil))}</span><small>${t('北京时间','UTC+8')}</small><details class="arena-condition-notes"><summary>${t('时间详情','Details')}</summary><p>${escape(range(row))}</p><p>${escape(t('游戏配置时区：','Source time zone: ')+(data.timeZone??t('待核验','Unverified')))} · ${t('依据设备时间判断，未校准服务器时间。','Uses device time, without server synchronization.')}</p><p>${escape(next?t('下一配置时段：','Next period: ')+range(next):t('下一配置时段暂未公布或收录。','The next period is not published or recorded.'))}</p></details></div></section>`;
 }
 function link(route,params) {return base+route+'?'+params.toString();}
 function query(){return new URLSearchParams(location.search);}
 function select(params,replace=false){if(referenceDialog.open){restoreReferenceFocus=false;referenceDialog.close();}if(dialog.open){restoreTrendFocus=false;dialog.close();}generation++;updateNotice='';clockNotice='';history[replace?'replaceState':'pushState']({},'',location.pathname+'?'+params);render();}
 function update(key,value){if(key==='server'){try{if(value)localStorage.setItem(`ournotes:server:${region}`,value);else localStorage.removeItem(`ournotes:server:${region}`);}catch{}}const p=query();if(value)p.set(key,value);else p.delete(key);if(['server','season','band'].includes(key)){p.delete('rank');p.delete('end');p.delete('regulation');p.delete('context');p.delete('music');trendKind=handoff?'all':'leaders';trendExpanded=false;}if(key==='music')trendExpanded=false;select(p);}
 function selectors() {
  const p=query(),sid=p.get('server')??'',season=p.get('season')??'current',servers=GAME_SERVERS.filter(s=>s.region===region);
  return `<div class="arena-context-bar"><div class="arena-context-title"><span class="arena-live-dot" aria-hidden="true"></span><strong>${escape(context?.season?.name??t('舞台资料','Arena information'))}</strong><small>${t('每日 03:00 核验激奏配置 · 属性随活动切换','Daily check 03:00 UTC+8 · attributes follow events')}</small></div>${referenceNav()}<div class="arena-selectors"><label><span>${t('账号区服','Server')}</span><select data-field="server">${option('',t('选择区服','Choose server'),!sid)}${!servers.some(s=>s.id===sid)&&sid?option(sid,t('无效区服','Invalid server'),true):''}${servers.map(s=>option(s.id,s[en?'englishLabel':'label'],sid===s.id)).join('')}</select></label><label><span>${t('赛季','Season')}</span><select data-field="season">${option('current',t('当前赛季','Current season'),season==='current')}${season!=='current'&&!data?.seasons.some(s=>s.id===season)?option(season,t('未收录赛季','Unrecorded season'),true):''}${[...(data?.seasons??[])].map(s=>option(s.id,s.name+' · '+(labels[data.capabilities.conditions?intervalState(s,clock()):'unverified']??''),season===s.id)).join('')}</select></label></div></div>
   <div class="arena-band-rail"><div class="arena-bands" role="group" aria-label="${t('选择乐队','Choose band')}">${arenaBandPreviews(data,location.search,{now:clock(),region}).map(bandButton).join('')}</div></div>`;
 }
 function entry() {
  return `<aside class="arena-entry"><p>${t('成员限本团 · 留影不限团','Band members · Any support')}<strong>${t('抽歌后不能换队','Team locked after draw')}</strong></p><div class="arena-entry-action"><small id="arena-calculator-state">${t('计算暂未开放','Calculator unavailable')}</small><button class="arena-primary" type="button" disabled aria-describedby="arena-calculator-state">${t('舞台配队','Build arena team')}</button></div></aside>`;
 }
 function schedule() {
  const rows=(context?.schedule??[]).filter(r=>all||intervalState(r,clock())!=='history').slice(0,all?undefined:7);
  return `<section class="arena-section"><header class="arena-section-header">${button('schedule',all?t('仅看当前及之后','Current and upcoming'):t('查看全部已收录安排','All recorded periods'),`aria-expanded="${all}"`)}</header>
   ${rows.length?`<ul class="arena-schedule">${rows.map(c=>`<li>${button('regulation',`<span class="arena-time">${escape(shortTime(c.validFrom)+' → '+shortTime(c.validUntil))}</span><span class="arena-schedule-attribute">${attributeMark(c.attribute,true)}${escape(attr(resolved(c)?.attribute))}</span><span class="arena-schedule-missions" aria-label="${escape(resolved(c)?.missions.map(mission).join(' / '))}">${missionMarks(c,context.league.bandId,true)}</span><small>${escape(labels[intervalState(c,clock())])}</small>`,`data-value="${escape(c.id)}" title="${escape(range(c))}"`)}</li>`).join('')}</ul>`:`<p>${t('后续条件暂未公布或收录。','No later conditions are published or recorded.')}</p>`}</section>`;
 }
 function ranks() {
  const groups=arenaRankGroups(data),rows=groups.flatMap(g=>g.rows);
  const missing=(data?.leagues??[]).filter(l=>!groups.some(g=>g.bands.some(b=>b.bandId===l.bandId)));
  const tiers=[...new Set([...rows.map(r=>r.tier),...(data?.capabilities.basePoints?data.basePoints.map(r=>r.tier):[])])].sort((a,b)=>a-b);
  const tierLabel=k=>rows.find(r=>r.tier===k)?.name.replace(/\s*[1-4１-４]+$/,'')??t(`段位 ${k}`,`Rank ${k}`);if(!tiers.includes(tier))tier=tiers[0]??null;
  const ap=baseAP(data,tier,players);
  return `<section class="arena-ap-query"><header><p>${t('选择赛前段位与对局人数','Choose the pre-match rank and player count')}</p></header><div class="arena-selectors"><label>${t('赛前段位','Rank before match')}<select data-field="tier">${tiers.map(k=>option(k,tierLabel(k),tier===k)).join('')}</select></label><label>${t('对局人数','Players')}<select data-field="players">${[2,3,4,5].map(n=>option(n,t(n+' 人',n+' players'),players===n)).join('')}</select></label></div>
   ${ap?`<ol class="arena-ap-results" aria-label="${t('各名次基础 AP','Base AP by placement')}">${ap.map(row=>`<li><small>${escape(t(`第 ${row.place} 名`,`Place ${row.place}`))}</small><strong data-negative="${row.points<0}">${row.points>=0?'+':''}${row.points}</strong></li>`).join('')}</ol>`:`<p class="arena-notice">${t('当前资料没有此积分配置。','No AP configuration is recorded for this combination.')}</p>`}<p class="arena-ap-note">${t('仅基础 AP，不含道具及其他服务端修正。','Base AP only; excludes items and other server adjustments.')}</p>
   <section class="arena-rank-thresholds"><h3>${t('段位门槛','Rank thresholds')}</h3><p class="arena-meta">${groups.length===1&&missing.length===0?t('各乐队门槛相同，段位与积分分别记录。','All bands share thresholds. Ranks and points are tracked separately.'):t('按配置列出各乐队门槛，相同配置合并展示。','Thresholds are grouped only when band configurations match.')}</p>${groups.map(group=>`<section class="arena-rank-scope">${groups.length>1||missing.length?`<h3>${escape(group.bands.map(b=>b.name).join(' / '))}</h3>`:''}${[...new Set(group.rows.map(r=>r.tier))].map(k=>`<details class="arena-rank"><summary>${escape(tierLabel(k))}</summary><ul>${group.rows.filter(r=>r.tier===k).map(r=>`<li><span>${escape(r.name)}</span><strong>${escape(r.threshold)} AP</strong>${r.openingSourceText==null&&!r.opensAt?`<small>${t('开放约束资料暂缺','Opening constraints unavailable')}</small>`:''}</li>`).join('')}</ul></details>`).join('')}</section>`).join('')}${missing.length?`<p class="arena-notice">${escape(missing.map(l=>l.name).join(' / '))}：${t('段位资料暂缺','Rank data unavailable')}</p>`:''}${!groups.length?`<p>${t('段位资料暂缺。','Rank data is unavailable.')}</p>`:''}</section></section>`;

 }
 function rules() {
  const rewards=data?.capabilities.rewards?data.rewards:[];
  const kinds=[['daily',t('每日奖励','Daily rewards')],['promotion',t('首次晋段奖励','First promotion rewards')],['season',t('赛季奖励','Season rewards')]];
  return `<p class="arena-meta">${t('玩法说明依据 Global 1.1.0；其他区服与版本的适用范围仍需独立核验。','Rules are based on Global 1.1.0. Other servers and versions require separate verification.')}</p><section><h2>${t('如何参赛','How to enter')}</h2><p>${t('成员来自所选乐队，留影不限乐队。提交自己拥有的该乐队歌曲；匹配后抽歌，抽歌后不能换队。','Use members from the selected band and supports from any band. Submit an owned song by this band. A song is drawn after matching; teams are then locked.')}</p></section>
   <section class="arena-section"><h2>${t('奖励如何领取','Rewards')}</h2><p>${t('每日奖励为所有乐队合计，首次晋段奖励按乐队记录；不读取或推断个人领取状态。','Daily rewards are shared across all bands. First promotion rewards are tracked per band. Personal claim status is not read or inferred.')}</p>
   <p>${data?.dailyReward?escape(t(`每日最多 ${data.dailyReward.limit} 次，${data.dailyReward.resetTime} 重置（区服时区${data.timeZone?'：'+data.timeZone+'）':'待核验）'}。`,`Up to ${data.dailyReward.limit} daily rewards; resets at ${data.dailyReward.resetTime} (server time zone ${data.timeZone??'unverified'}).`)):t('每日次数及重置时间的发布资料暂缺。','Published daily limits and reset time are unavailable.')}</p>
   ${kinds.map(([kind,title])=>`<details class="arena-rule-group" open><summary>${escape(title)}</summary>${kind==='season'?`<p>${t('按所有乐队中本赛季最高达到段位结算，下赛季发放。','Based on the highest rank reached across all bands this season; distributed next season.')}</p>`:''}${rewards.some(r=>r.kind===kind)?rewards.filter(r=>r.kind===kind).map(g=>`<details><summary>${escape((g.kind==='promotion'?((data?.leagues??[]).find(l=>l.bandId===g.bandId)?.name??t('乐队资料暂缺','Band unavailable'))+' · ':'')+g.label)}</summary><ul>${g.items.map(i=>`<li class="arena-reward-item">${visuals.items?.find(v=>v.id===i.itemId)?.icon?`<img src="${escape(visuals.items.find(v=>v.id===i.itemId).icon)}" alt="" loading="lazy">`:''}<span>${escape(i.name)}</span><strong>× ${escape(i.count)}</strong></li>`).join('')}</ul></details>`).join(''):`<p>${t('奖励资料暂缺，关联尚未核验或未收录。','Reward data or verified item relationships are unavailable.')}</p>`}</details>`).join('')}</section>
   <section class="arena-section"><h2>${t('段位与赛季如何结算','Rank & season settlement')}</h2><p>${t('各乐队分别记录段位。白银 1 及以下 AP 原样继承，其余具体调整规则待确认。','Ranks are tracked per band. AP at Silver 1 and below carries over unchanged; other adjustments remain unverified.')}</p><p>${t('中断／断线按末名处理；达到每日次数限制后，下次 4:00 解除匹配限制。区服时区与具体处罚调整规则仍需核验。','Interruptions or disconnects are treated as last place. After the daily limit, matching restrictions lift at the next 04:00. Server time zone and exact penalty adjustments require verification.')}</p><p>${t('局内得分、段落任务、对局名次与段位 AP 是不同概念。基础表不等于最终服务端结算，不提供胜率或完整上分预测。','Song score, section missions, match placement and rank AP are separate. Base tables do not predict final server settlement or win rates.')}</p></section>`;
 }
 function handoffBody() {
  const p=arenaParams(context,{pin:true}),incoming=query().get('context'),identity=arenaIdentity(data,context);
  const changed=!!incoming&&(incoming!==identity||context.status!=='current'||context.current?.id!==context.condition?.id);
  const latest=context.current?{...context,condition:context.current}:null;
  return `<p><a class="arena-button" href="${escape(link('arena/',p))}">${t('返回激奏舞台','Back to arena')}</a></p>
   ${card()}${changed?`<section class="arena-notice"><h2>${t('舞台条件已更新','Stage conditions have changed')}</h2><p>${t('链接来自旧条件或旧版资料，请核对当前条件。链接内属性没有被用于解析。','This link refers to older conditions or data. Review the current conditions. Linked attributes are not used as authoritative input.')}</p><details><summary>${t('查看链接携带的旧摘要（未经核验）','Previous linked summary (unverified)')}</summary><p class="arena-old-summary">${escape(previousSummary(incoming.slice(0,4000)))}</p></details>${latest?card(latest,t('当前最新条件','Latest current conditions')):''}${button('current',t('明确使用当前条件','Use current conditions'))}</section>`:''}
   <section class="arena-section"><h2>${t('舞台配队计算尚未开放','Arena team calculation is not available yet')}</h2><p>${context.entryReady&&freshness==='current'&&!changed?t('当前条件已就绪，计算功能接入后将在这里使用。','Current conditions are ready for a future calculator integration.'):t('当前仅供查阅与复制，尚未形成可用的当前参赛上下文。','Available for reference and copying. A usable current entry context is not established.')}</p>
   ${!context.serverId?`<p class="arena-notice">${t('请先选择账号区服。不会访问或迁移其他区服卡库。','Choose an account server. Other server collections are not accessed or migrated.')}</p>`:!context.scopeConfirmed?`<p class="arena-notice">${t('此账号区服的舞台适用范围尚未确认。','Arena coverage for this account server is unverified.')}</p>`:''}
   ${['history','preview'].includes(context.status)?`<p class="arena-notice">${t('历史／预告条件不能用于当前参赛配队。','Historical or upcoming conditions cannot be used for current entry.')}</p>`:''}
   <div class="arena-actions"><a class="arena-button" href="${escape(link('arena/',new URLSearchParams({...Object.fromEntries(p),view:'rules'})))}">${t('查看舞台规则','View arena rules')}</a>${button('copy-summary',t('复制条件摘要','Copy conditions'),!context.condition?'disabled':'')}</div></section>`;
 }
 function render(preserveDisclosure=false) {
  if(loading)return;
  const expanded=preserveDisclosure?new Set([...body.querySelectorAll('details[open]')].map(d=>d.querySelector('summary')?.textContent)):null;
  const bandScroll=body.querySelector('.arena-bands')?.scrollLeft??0;
  const active=document.activeElement,focus=active?.closest('[data-field]')?.dataset.field;
  context=arenaContext(data,location.search,{now:clock(),region,requireBand:handoff});
  meta.textContent=`${t('资料观察时间：','Observed at: ')}${data?.observedAt?time(data.observedAt):t('未记录','Not recorded')} · ${t('北京时间','UTC+8')}`;
  const notice=error??messages[context.status]??(context.status==='current'&&!context.scopeConfirmed?t('账号区服未选或适用范围尚未确认，以下条件仅供资料查阅。','Account server is unselected or its coverage is unverified. Conditions below are for reference.'):null);
  const recordedSongs=(Array.isArray(data?.deckTrends)?data.deckTrends:[]).filter(r=>r?.serverId===context.serverId&&r.seasonId===context.season?.id&&r.bandId===context.league?.bandId);
  const recordedSong=recordedSongs.find(r=>['leaders','members','supports'].some(k=>r[k]?.length))??recordedSongs[0];
  if(context.condition&&(context.condition.attribute===0||context.condition.missions.includes(0)||recordedSong)&&!query().has('music')) {
   const song=recordedSong?{id:recordedSong.musicId}:songFor();if(song){const p=query();p.set('music',song.id);history.replaceState({},'',location.pathname+'?'+p);context=arenaContext(data,p,{now:clock(),region,requireBand:handoff});}
  }
  const stage=card()||`<section class="arena-condition arena-condition-empty"><h2>${t('当前舞台条件','Current conditions')}</h2><p>${escape(notice??t('条件暂缺','Conditions unavailable'))}</p></section>`;
  const tools=handoff?handoffBody()+trends():`<div class="arena-stage-wrap">${stage}${entry()}</div>${trends()}
   ${context.previous?`<details class="arena-previous"><summary>${t('上一期（已过期）','Previous period (expired)')}</summary><p>${escape(range(context.previous))}</p></details>`:''}
   <section class="arena-section arena-population" data-arena-population aria-label="${t('段位人数','Tier population')}"></section>
   <section class="arena-section arena-player-rankings" data-arena-rankings aria-label="${t('玩家排行榜','Player rankings')}"></section>
`;
  body.innerHTML=`${selectors()}${notice?`<p class="arena-notice" role="status">${escape(notice)}</p>`:''}${context.condition&&context.status!=='current'?button('current',t('查看当前条件','View current conditions')):''}${tools}<details class="arena-source-details"><summary>${t('资料来源与时间说明','Source & timing')}</summary><p>${escape(data?.observedAt?t('官方配置核验时间：','Official configuration checked at: ')+time(data.observedAt):t('资料尚未提供','Data unavailable'))}</p><p>${escape(t('已核验账号区服：','Verified servers: ')+(data?.serverScopes.map(id=>GAME_SERVERS.find(s=>s.id===id)?.[en?'englishLabel':'label']??id).join(' / ')||t('待核验','Unverified')))}</p>${context?.season?`<p>${escape(t('赛季参赛时间：','Season entry: ')+range(context.season))}</p>`:''}<p>${t('页面时间为北京时间；有效时间不含结束时刻。','Displayed in UTC+8; the end of an interval is exclusive.')}</p></details>`;
  const bandRail=body.querySelector('.arena-bands');if(bandRail){bandRail.scrollLeft=bandScroll;const selected=bandRail.querySelector('[aria-pressed="true"]');if(selected){const box=selected.getBoundingClientRect(),frame=bandRail.getBoundingClientRect();bandRail.scrollLeft+=box.left<frame.left?box.left-frame.left:box.right>frame.right?box.right-frame.right:0;}}
  if(dialog.open)dialogBody.innerHTML=trends(true);
  if(referenceDialog.open)renderReference(true);
  if(expanded)for(const details of body.querySelectorAll('details'))if(expanded.has(details.querySelector('summary')?.textContent))details.open=true;
  root.querySelector('[data-action="copy-link"]').disabled=!data;
  root.setAttribute('aria-busy','false');
  restoreServerLabels(document,GAME_SERVERS);
  if(!handoff){const scope={serverId:context.serverId,seasonId:context.season?.id??null,bandId:context.league?.bandId??null};personal.select(scope);population.select(scope);rankingClient.select({...scope,...(query().has('rank')?{rank:Number(query().get('rank')),end:Number(query().get('end')??query().get('rank'))}:{})});}
  if(focus)root.querySelector(`[data-field="${focus}"]`)?.focus();
  if(!initialViewHandled){initialViewHandled=true;if(['ranks','rules'].includes(context.view))openReference(context.view);}
 }
 async function copy(text){try{await navigator.clipboard.writeText(text);feedback.textContent=t('已复制。','Copied.');}catch{feedback.textContent=t('复制失败，可选择下方文本复制。','Copy failed. Select the text below.');const textarea=document.createElement('textarea');textarea.readOnly=true;textarea.value=text;textarea.style.width='100%';body.append(textarea);textarea.focus();textarea.select();}}
 root.addEventListener('input',event=>{if(event.target.closest('[data-arena-rank-form]'))event.target.closest('form').elements.end.setCustomValidity('');});
 root.addEventListener('submit',event=>{
  if(!event.target.matches('[data-arena-rank-form]'))return;
  event.preventDefault();const form=event.target,from=form.elements.rank,to=form.elements.end;to.setCustomValidity('');
  if(!form.reportValidity())return;const start=Number(from.value),end=Number(to.value||from.value);
  if(end<start||end-start>=100){to.setCustomValidity(t('结束名次应不小于起始名次，每次最多 100 名。','End rank must be at least the start rank, with at most 100 ranks.'));to.reportValidity();return;}
  const params=query();params.set('rank',String(start));params.set('end',String(end));select(params);
 });
 root.addEventListener('change',event=>{const key=event.target.dataset.field;if(!key)return;if(key==='players'||key==='tier'){if(key==='players')players=Number(event.target.value);else tier=Number(event.target.value);renderReference(true);}else {update(key,event.target.value);root.querySelector(`[data-field="${CSS.escape(key)}"]`)?.focus();}});
 root.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action;
  if(action==='reference'){openReference(target.dataset.value);return;}
  if(action==='reference-close'){referenceDialog.close();return;}
  if(action==='ranking-top'){const p=query();p.delete('rank');p.delete('end');select(p);return;}
  if(action==='ranking-refresh'){await rankingClient.reload();return;}
  if(action==='ranking-more'){await rankingClient.more();return;}
  if(action==='dialog-close'){dialog.close();return;}
  if(action==='trend-more'){dialogBody.innerHTML=trends(true);dialog.showModal();return;}
  if(action==='trend-kind'){const inDialog=dialog.contains(target);trendKind=target.dataset.value;trendExpanded=false;render(true);if(inDialog)dialogBody.innerHTML=trends(true);(inDialog?dialog:body).querySelector(`[data-action="trend-kind"][data-value="${CSS.escape(trendKind)}"]`)?.focus();return;}
  if(action==='refresh'){if(error){location.reload();return;}await refresh(true);return;}
  if(action==='copy-link'){const p=arenaParams(context,{pin:true});await copy(location.origin+link(handoff?'tools/arena/':'arena/',p));return;}
  if(action==='copy-summary'){if(context.condition)await copy(summary());return;}
  if(action==='reload'){location.reload();return;}
  if(action==='current'){const p=query();p.set('season','current');p.delete('regulation');p.delete('context');select(p);return;}
  if(action==='schedule'){all=!all;renderReference(true);referenceBody.querySelector('[data-action="schedule"]')?.focus();return;}
  if(action==='view'||action==='band'||action==='regulation'){const field=action==='view'?'view':action;update(field,target.dataset.value);root.querySelector(`[data-action="${action}"][data-value="${CSS.escape(target.dataset.value)}"]`)?.focus({preventScroll:true});}
 });
 window.addEventListener('click',event=>{
  const anchor=event.target.closest?.('.context-switcher a[href]');if(!anchor||!context)return;
  const url=new URL(anchor.href,location.href),targetRegion=url.pathname.match(/^\/(global|jp)\//)?.[1];
  if(url.origin!==location.origin||targetRegion!==region||!/^\/(global|jp)\/(zh-CN|en)\/(arena|tools\/arena)\/?$/.test(url.pathname))return;
  const params=arenaParams(context);if(anchor.dataset.gameServer)params.set('server',anchor.dataset.gameServer);
  if(handoff&&query().has('context')&&!anchor.dataset.gameServer)params.set('context',query().get('context'));
  anchor.href=url.pathname+'?'+params;
 },{capture:true});
 document.addEventListener('astro:before-swap',()=>{rankingClient.destroy();rankingScroll.destroy();population.destroy();},{once:true});
 window.addEventListener('popstate',()=>{generation++;initialViewHandled=false;if(referenceDialog.open){restoreReferenceFocus=false;referenceDialog.close();}render();});
 async function refresh(manual=false){
  if(!check)return;
  const request=++generation;const result=await check();
  if(request!==generation)return;
  freshness=result.status;
  if(result.status==='changed'){feedback.replaceChildren(document.createTextNode(clockNotice+updateNotice+t('有新资料，重新载入后使用。','New data is available. Reload to use it.')));const reload=document.createElement('button');reload.textContent=t('重新载入','Reload');reload.dataset.action='reload';feedback.append(reload);}
  else feedback.textContent=clockNotice+updateNotice+(result.status==='current'?(manual?t('已检查，暂无新资料','Checked; no new data'):''):t('当前展示已保存资料，未能检查更新。','Showing saved data; could not check for updates.'));
  if(handoff)render(true);
 }
 try {
  // Read only public content. No scoring rules, inventory, team or worker input.
  const [value,pinned]=await Promise.all([artifact('projection/arena.json',{optional:true}),snapshot()]);
  data=validateArena(value,{region,sourceReleaseId:pinned.contentReleaseId});
  let stored;try{stored=localStorage;}catch{}
  if(!query().has('server')){const server=resolveServer(region,'',stored);if(server){const p=query();p.set('server',server);history.replaceState({},'',location.pathname+'?'+p);}}
  check=createContentUpdateCheck({region,pinned,pointer:await pinnedContentPointer()});
 }catch(e){error=t('舞台资料读取或校验失败，请重试。','Arena data could not be read or verified. Retry.');}
 let lastBoundary=clock();
 loading=false;render();
 installArenaUpdates({
  checkInterval:60000,
  getNextBoundary:()=>Math.min(nextArenaDailyCheck(lastBoundary),...[arenaTime(rankingClient.getState().data?.expiresAt)].filter(n=>n>lastBoundary),...[...(data?.seasons??[]),...(data?.regulations??[]),...(data?.leagues??[]),...(data?.ranks??[]),...(data?.activityPeriods??[])].flatMap(r=>[arenaTime(r.validFrom),arenaTime(r.validUntil),arenaTime(r.opensAt)]).filter(n=>n>lastBoundary)),
  onBoundary:()=>{
   const before=context&&arenaIdentity(data,context),status=context?.status;
   lastBoundary=clock();render(true);
   if(before!==(context&&arenaIdentity(data,context))||status!==context?.status){
    updateNotice=t('舞台条件已更新，请核对当前时段。 ','Stage conditions have changed. Review the current period. ');
    feedback.textContent=clockNotice+updateNotice;
   }
  },
  onCheck:()=>{if(!personal.isOpen()&&!root.querySelector('.arena-ranking-player[open]')&&!document.activeElement?.closest?.('.arena-rank-search'))void rankingClient.check();return refresh();},
  onClockJump:()=>{clockNotice=t('设备时间发生变化，请检查时间设置。 ','Device time changed. Check your time settings. ');feedback.textContent=clockNotice+updateNotice;},clock
 });
 if(check)void refresh();
}
