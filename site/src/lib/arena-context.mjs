import {gameServer} from './game-servers.mjs';

const arrays = ['seasons','leagues','regulations','ranks','basePoints','rewards','serverScopes'];
export function arenaMasterVersion(data,server){
  if(!data?.serverScopes?.includes(server))return null;
  return data.sourceMasterVersions==null?data.sourceMasterVersion??null:data.sourceMasterVersions[server]??null;
}
export function validateArena(data, {region, sourceReleaseId}) {
  if (data === null) return null;
  if (data?.schemaVersion !== 1 || data.region !== region || data.sourceReleaseId !== sourceReleaseId
      || arrays.some(key => !Array.isArray(data[key])) || !data.capabilities || typeof data.capabilities !== 'object')
    throw new Error('舞台资料与当前内容版本不兼容');
  if (['conditions','ranks','basePoints','rewards','rankings'].some(key=>typeof data.capabilities[key]!=='boolean')) throw new Error('舞台能力资料无效');
  if (data.observedAt && (typeof data.observedAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(data.observedAt)||!Number.isFinite(Date.parse(data.observedAt)))) throw new Error('舞台观察时间无效');
  if(data.sourceMasterVersion!=null&&(typeof data.sourceMasterVersion!=='string'||!/^[a-f0-9]{32}$/.test(data.sourceMasterVersion)))throw Error('舞台版本标识无效');
  const unique = rows => rows.every(row => typeof row?.id === 'string') && new Set(rows.map(row=>row.id)).size===rows.length;
  if (['seasons','leagues','regulations','ranks'].some(key=>!unique(data[key]))
      || data.serverScopes.some(id=>gameServer(id)?.region!==region)) throw new Error('舞台资料标识无效');
  const versions=data.sourceMasterVersions;
  if(versions!=null&&(typeof versions!=='object'||Array.isArray(versions)
      ||Object.keys(versions).length!==data.serverScopes.length||data.serverScopes.some(id=>typeof versions[id]!=='string'||!/^[a-f0-9]{32}$/.test(versions[id]))
      ||!Object.values(versions).includes(data.sourceMasterVersion)))throw Error('舞台区服版本标识无效');
  const absolute = value => typeof value==='string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (data.activityPeriods!==undefined && (!Array.isArray(data.activityPeriods) || !unique(data.activityPeriods)
      || data.activityPeriods.some(r=>!absolute(r.validFrom)||!absolute(r.validUntil)||Date.parse(r.validFrom)>=Date.parse(r.validUntil))))
    throw new Error('活动切换时间资料无效');
  if (data.capabilities.conditions) {
    try {new Intl.DateTimeFormat('en',{timeZone:data.timeZone}).format();} catch {throw new Error('舞台时区无效');}
    if (!data.timeZone || data.timeSemanticsVersion!=='inclusive-second-v1' || !/^[a-f0-9]{64}$/.test(data.sourceRevision??'')
        || [...data.seasons,...data.regulations].some(row=>!absolute(row.validFrom)||!absolute(row.validUntil)||Date.parse(row.validFrom)>=Date.parse(row.validUntil)))
      throw new Error('舞台时间资料无效');
  }
  if (data.regulations.some(row=>typeof row.leagueId!=='string'||![0,1,2,3,4,5,99].includes(row.attribute)
      || !Array.isArray(row.missions)||row.missions.length!==3||row.missions.some(n=>![0,1,2,3].includes(n))))
    throw new Error('舞台条件资料无效');
  if (data.basePoints.some(row=>![row.tier,row.players,row.place,row.points].every(Number.isInteger)
      ||row.players<2||row.players>5||row.place<1||row.place>row.players)) throw new Error('舞台积分资料无效');
  if (data.leagues.some(r=>typeof r.bandId!=='string'||typeof r.name!=='string')
      ||data.seasons.some(r=>typeof r.name!=='string')
      ||data.ranks.some(r=>typeof r.bandId!=='string'||typeof r.name!=='string'||![r.tier,r.division,r.threshold].every(Number.isInteger))
      ||data.rewards.some(r=>!['daily','promotion','season'].includes(r?.kind)||typeof r.label!=='string'||!Array.isArray(r.items)||r.items.some(i=>typeof i?.name!=='string'||!Number.isInteger(i.count)||i.count<=0))) throw new Error('舞台展示资料无效');
  return data;
}
export const arenaTime = value => value ? Date.parse(value) : NaN;
export function intervalState(row, now) {
  if (!row || !Number.isFinite(arenaTime(row.validFrom)) || !Number.isFinite(arenaTime(row.validUntil))) return 'unverified';
  return now < arenaTime(row.validFrom) ? 'preview' : now >= arenaTime(row.validUntil) ? 'history' : 'current';
}
export function arenaContext(data, search = '', {now = Date.now(), region = data?.region ?? 'global', requireBand = false} = {}) {
  const params = new URLSearchParams(search), view = params.get('view') ?? 'overview';
  const base = {status:'missing', view:['overview','ranks','rules'].includes(view)?view:'overview', params,
    season:null, league:null, condition:null, current:null, schedule:[], serverId:params.get('server') || null, entryReady:false};
  if (params.has('server') && gameServer(base.serverId)?.region !== region) return {...base,status:'invalid-server'};
  if (params.has('view') && !['overview','ranks','rules'].includes(view)) return {...base,status:'invalid-view'};
  if (!data) return base;
  const seasons = [...data.seasons].sort((a,b)=>arenaTime(a.validFrom)-arenaTime(b.validFrom));
  const selected = params.get('season') ?? 'current';
  const currentSeasons = seasons.filter(s=>intervalState(s,now)==='current');
  if (selected==='current' && currentSeasons.length>1) return {...base,status:'season-conflict'};
  const season = selected==='current' ? currentSeasons[0] : seasons.find(s=>s.id===selected);
  if (!season) return {...base,status:selected==='current'?(data.capabilities.conditions?'no-season':'unverified'):'unknown-season'};
  const leagues = data.leagues.filter(l=>!l.opensAt || arenaTime(l.opensAt)<=now);
  const band = params.get('band');
  if (!band && requireBand) return {...base,season,status:'select-band'};
  const chosenBand=band??leagues[0]?.bandId;
  const candidates = data.leagues.filter(l=>l.bandId===chosenBand);
  if (candidates.length!==1) return {...base,season,status:candidates.length?'league-conflict':'unknown-band'};
  const league = candidates[0];
  if (league.openingSourceText==null&&!league.opensAt) return {...base,season,league,status:'unverified-opening'};
  if (league.opensAt && arenaTime(league.opensAt)>now) return {...base,season,league,status:'not-open'};
  const schedule = data.regulations.filter(r=>r.leagueId===league.id).map(r=>{
    const validFrom = Math.max(arenaTime(r.validFrom),arenaTime(season.validFrom));
    const validUntil = Math.min(arenaTime(r.validUntil),arenaTime(season.validUntil));
    return {...r,validFrom:Number.isFinite(validFrom)?new Date(validFrom).toISOString():null,
      validUntil:Number.isFinite(validUntil)?new Date(validUntil).toISOString():null};
  }).filter(r=>!data.capabilities.conditions || arenaTime(r.validFrom)<arenaTime(r.validUntil))
    .sort((a,b)=>arenaTime(a.validFrom)-arenaTime(b.validFrom));
  const active = schedule.filter(r=>intervalState(r,now)==='current');
  const common = {...base,season,league,schedule,current:active.length===1?active[0]:null};
  if (!data.capabilities.conditions) return {...common,schedule:[],status:'unverified'};
  if (active.length>1) return {...common,status:'condition-conflict'};
  const requested = params.get('regulation');
  const condition = requested ? schedule.find(r=>r.id===requested) : active[0];
  if (!condition) return {...common,status:requested?'unknown-regulation':'no-condition',
    previous:schedule.filter(r=>intervalState(r,now)==='history').at(-1)??null};
  const overlaps = schedule.filter(r=>Math.max(arenaTime(r.validFrom),arenaTime(condition.validFrom))<Math.min(arenaTime(r.validUntil),arenaTime(condition.validUntil)));
  if (overlaps.length>1) return {...common,status:'condition-conflict'};
  const status = intervalState(condition,now);
  const scopeConfirmed = data.serverScopes.includes(base.serverId);
  return {...common,condition,status,scopeConfirmed,entryReady:status==='current'&&scopeConfirmed&&intervalState(season,now)==='current'};
}
export function arenaIdentity(data, context) {
  if (!context.condition) return null;
  const {condition:c,season:s,league:l,serverId}=context;
  return JSON.stringify({region:data.region,server:serverId,season:s.id,band:l.bandId,regulation:c.id,
    attribute:c.attribute,missions:c.missions,validFrom:c.validFrom,validUntil:c.validUntil,
    timeZone:data.timeZone,revision:data.sourceRevision});
}
export function arenaParams(context, {pin = false} = {}) {
  const params = new URLSearchParams();
  for (const key of ['server','season','band','regulation','view','music','rank','end']) if(context.params.has(key)) params.set(key,context.params.get(key));
  if (context.serverId) params.set('server',context.serverId);
  if (context.league) params.set('band',context.league.bandId);
  if (pin && context.season) params.set('season',context.season.id);
  if (pin && context.condition) params.set('regulation',context.condition.id);
  return params;
}
export function baseAP(data, tier, players) {
  if (!data?.capabilities.basePoints) return null;
  const rows = data.basePoints.filter(r=>r.tier===Number(tier)&&r.players===Number(players));
  if (rows.length!==Number(players)||new Set(rows.map(r=>r.place)).size!==rows.length) return null;
  return [...rows].sort((a,b)=>a.place-b.place);
}

/** Each band previews its own conditions, independently of the selected detail row. */
export function arenaBandPreviews(data, search='', {now=Date.now(),region=data?.region??'global'}={}) {
 return (data?.leagues??[]).map(league=>{
  const params=new URLSearchParams(search);params.set('band',league.bandId);params.delete('regulation');
  const context=arenaContext(data,params,{now,region});
  let condition=context.condition,status=context.status;
  if(status==='no-condition'&&context.season){
   const seasonState=intervalState(context.season,now);
   if(seasonState==='history'){condition=context.schedule.at(-1)??null;status=condition?'history':status;}
   else if(seasonState==='preview'){condition=context.schedule[0]??null;status=condition?'preview':status;}
  }
  return {league,condition,status};
 });
}
