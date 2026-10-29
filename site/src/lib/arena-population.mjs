import {arenaRankIcon} from './arena-ranking-decks.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const abs=v=>typeof v==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const num=v=>Number.isSafeInteger(v)&&v>=0;
export function validatePopulation(value,scope){
 if(value?.schemaVersion!==1||['serverId','seasonId','bandId'].some(k=>value[k]!==scope[k])||!['available','stale','unavailable'].includes(value.status))throw Error('Invalid population');
 if(value.status==='unavailable'){if(value.observation!==null)throw Error('Invalid population');return value;}
 const o=value.observation;
 if(o?.schemaVersion!==1||['serverId','seasonId','bandId'].some(k=>o[k]!==scope[k])||o.method!=='rank_boundary_probe'||o.accuracy!=='estimate'
  ||!['startedAt','observedAt','expiresAt'].every(k=>abs(o[k]))||Date.parse(o.startedAt)>Date.parse(o.observedAt)||Date.parse(o.observedAt)>=Date.parse(o.expiresAt)
  ||Date.parse(o.observedAt)-Date.parse(o.startedAt)>210000||Date.parse(o.expiresAt)-Date.parse(o.observedAt)>21600000
  ||!num(o.totalEstimate)||!num(o.sampleReads)||o.sampleReads<1||o.sampleReads>96||typeof o.sourceReleaseId!=='string'||!o.sourceReleaseId
  ||typeof o.masterVersion!=='string'||!/^[a-f0-9]{32}$/.test(o.masterVersion)||!Array.isArray(o.tiers)||o.tiers.length<1||o.tiers.length>7)throw Error('Invalid population');
 let previous=-1;const seen=new Set();let total=0;
 for(const r of o.tiers){if(!Number.isInteger(r.tier)||r.tier<1||r.tier>7||seen.has(r.tier)||!num(r.threshold)||r.threshold<=previous||!num(r.count))throw Error('Invalid population');seen.add(r.tier);previous=r.threshold;total+=r.count;}
 if(o.tiers[0].threshold!==0||total!==o.totalEstimate)throw Error('Invalid population');return value;
}
export function createPopulationClient({fetcher=fetch,now=()=>Date.now(),onChange=()=>{}}={}){
 let scope={},key='',generation=0,abort,state={status:'idle',data:null};
 const getState=()=>({...state,scope,status:state.data?.observation&&Date.parse(state.data.observation.expiresAt)<=now()?'stale':state.status});
 const notify=()=>onChange(getState());
 async function reload(){
  if(!scope.serverId||!scope.seasonId||!scope.bandId)return;
  const stamp=++generation;abort?.abort();const controller=abort=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  state={status:'loading',data:null};notify();
  try{const params=new URLSearchParams({server:scope.serverId,season:scope.seasonId,band:scope.bandId});
   const response=await fetcher('/api/v1/arena-population?'+params,{signal:controller.signal,cache:'no-store',credentials:'omit'});
   if(!response.ok)throw Error('Unavailable');const data=validatePopulation(await response.json(),scope);
   if(stamp!==generation)return;state={status:data.status,data};notify();
  }catch(e){if(stamp===generation){state={status:'error',data:null};notify();}}
  finally{clearTimeout(timer);}
 }
 return {getState,reload,select(next){const identity=JSON.stringify(next);if(identity===key){notify();return;}scope=next;key=identity;generation++;abort?.abort();state={status:'idle',data:null};notify();void reload();},destroy(){generation++;abort?.abort();state={status:'idle',data:null};}};
}
export function populationView({state,rankData,context,ranking,t,time}){
 const observedTime=Date.parse(state.data?.observation?.observedAt??'')||Date.now();
 const band=context?.league?.bandId,rows=(rankData?.ranks??[]).filter(r=>r.bandId===band&&(!r.opensAt?r.openingSourceText==='':Date.parse(r.opensAt)<=observedTime)),tiers=[...new Set(rows.map(r=>r.tier))].sort((a,b)=>a-b);
 const observation=state.data?.observation;
 const matched=observation&&rankData?.sourceMasterVersion===observation.masterVersion&&rankData.sourceReleaseId===observation.sourceReleaseId
  &&rankData.completeRankBands?.includes(band)&&context?.season?.id===observation.seasonId&&context.serverId===observation.serverId&&band===observation.bandId
  &&Date.parse(context.season.validFrom)<=Date.parse(observation.observedAt)&&Date.parse(observation.observedAt)<Date.parse(context.season.validUntil)
  &&observation.tiers.length===tiers.length&&observation.tiers.every(r=>r.threshold===Math.min(...rows.filter(v=>v.tier===r.tier).map(v=>v.threshold)));
 const observed=matched?observation:null,publicTotal=ranking?.serverId===context?.serverId&&ranking?.seasonId===context?.season?.id&&ranking?.bandId===band&&num(ranking?.maxRank)?ranking:null;
 const total=observed?.totalEstimate??publicTotal?.maxRank;
 const message=observation&&!matched?t('统计与当前配置未匹配，暂不展示段位人数。','The observation does not match the current configuration. Tier counts are unavailable.')
  :state.status==='loading'?t('正在读取服务器探测汇总…','Loading server probe summary…'):state.status==='error'?t('探测统计暂时无法读取。','The probe summary could not be loaded.')
  :!observed?t('各段位人数尚未完成服务器探测。','Tier counts have not been probed yet.'):state.status==='stale'?t('探测已过期，以下为上次估算。','This probe has expired. Showing the previous estimate.'):t('后台低频探测 · 榜内人数估算','Low-frequency background probe · Ranked population estimate');
 const label=tier=>rows.find(r=>r.tier===tier)?.name.replace(/\s*[1-4１-４]+$/,'')??t(`段位 ${tier}`,`Tier ${tier}`);
 return `<div class="arena-population-heading"><h2>${t('段位人数','Tier population')}</h2><p>${observed?t('榜内总人数估算','Estimated ranked total'):t('榜单最大名次','Maximum ranking position')} <strong>${total===undefined?'—':(observed?'≈ ':'')+esc(total.toLocaleString())}</strong></p></div>
 <p class="arena-meta" role="status">${esc(message)}</p><div class="arena-population-tiers">${tiers.map(tier=>{const row=observed?.tiers.find(r=>r.tier===tier);return `<div>${arenaRankIcon(rankData,tier)}<span>${esc(label(tier))}</span><strong>${row?esc(row.count.toLocaleString()):'—'}</strong></div>`;}).join('')}</div>
 <p class="arena-meta">${esc(observed?t('探测时段：','Probe interval: ')+time(observed.startedAt)+' → '+time(observed.observedAt):publicTotal?t('榜单快照时间：','Ranking captured: ')+time(publicTotal.observedAt):t('选择已收录赛季和乐队后查询。','Choose a recorded season and band.'))}</p>
 <details class="arena-population-note"><summary>${t('人数说明','About these counts')}</summary><p>${t('人数按该乐队榜内名次估算，不含未上榜玩家；各乐队可能包含同一玩家，不能相加作为全服独立人数。段位人数来自积分边界探测，并非官方人数统计。浏览页面不会启动探测。','Counts are estimated from this band’s ranking positions and exclude unranked players. Players may appear in multiple bands; totals cannot be summed into unique server users. Tier counts are probed from score boundaries, not official population statistics. Browsing does not trigger a probe.')}</p></details>`;
}
