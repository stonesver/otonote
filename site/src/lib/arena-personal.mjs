import {accountServer,accountCapabilitiesUrl,snapshotServer} from './account-servers.mjs';
import {arenaRankingTier} from './arena-rankings.mjs';
import {arenaRankIcon} from './arena-ranking-decks.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const absolute=v=>typeof v==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
export function validateArenaPersonal(value,scope){
 if(value?.format!=='otonote-arena-personal'||value.schemaVersion!==1||snapshotServer(value.source)!==scope.serverId
  ||value.seasonId!==scope.seasonId||value.bandId!==scope.bandId||!absolute(value.queriedAt)
  ||!['ranked','unranked','unavailable'].includes(value.status)
  ||!(value.point===null||Number.isSafeInteger(value.point)&&value.point>=0)
  ||!(value.rank===null||Number.isSafeInteger(value.rank)&&value.rank>0)
  ||value.status==='ranked'&&(value.rank===null||value.point===null)
  ||value.status==='unranked'&&(value.rank!==null||value.point===null)
  ||value.status==='unavailable'&&(value.rank!==null||value.point!==null)
  ||value.source.masterVersion!=null&&(typeof value.source.masterVersion!=='string'||!/^[a-f0-9]{32}$/.test(value.source.masterVersion)))throw Error('invalid_personal_rank');
 return value;
}
export function arenaPersonalTier(value,rankData,context){
 if(value?.status==='unavailable'||!value?.source.masterVersion||value.source.masterVersion!==rankData?.sourceMasterVersion)return null;
 return arenaRankingTier(value.point,{rankData,context,observation:{serverId:value.source.serverId,
  seasonId:value.seasonId,bandId:value.bandId,observedAt:value.queriedAt,sourceReleaseId:rankData.sourceReleaseId}});
}
export function createArenaPersonalClient({fetcher=fetch,onChange=()=>{},timeout=150000}={}){
 let scope={},key='',generation=0,request=null,state={status:'idle',data:null,nonce:null};
 const getState=()=>({...state,scope}),notify=()=>onChange(getState());
 function clear(){generation++;request?.abort();request=null;state={status:'idle',data:null,nonce:null};notify();}
 function select(next){const identity=JSON.stringify(next);if(identity!==key){key=identity;scope=next;clear();}}
 async function run(kind,account='',password=''){
  if(state.status==='loading'||state.status==='checking')return;
  if(!accountServer(scope.serverId)||!scope.seasonId||!scope.bandId){clear();state.status='unsupported';notify();return;}
  const nonce=state.nonce;if(kind==='read'&&!nonce)return;
  const stamp=++generation;request?.abort();const controller=request=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  state={status:kind==='read'?'loading':'checking',nonce,data:null};notify();let body='';
  try{
   if(kind==='read')body=JSON.stringify({...scope,account,password});account=password='';
   const pending=fetcher(kind==='read'?'/api/growth-export/arena-rank/':accountCapabilitiesUrl(scope.serverId),{
    method:kind==='read'?'POST':'GET',cache:'no-store',credentials:'same-origin',signal:controller.signal,
    ...(kind==='read'?{headers:{'Content-Type':'application/json','X-Growth-Nonce':nonce},body}:{})});body='';
   const response=await pending;const text=await response.text();if(text.length>16384)throw Error('invalid_personal_rank');
   const result=JSON.parse(text);if(stamp!==generation)return;
   if(result.error==='game_maintenance'||result.gameStatus?.status==='maintenance')throw Error('maintenance');
   if(!response.ok){if(response.status===403)throw Error('expired');if(response.status===429)throw Error('busy');
    throw Error(['credentials_rejected','account_not_found','verification_required'].includes(result.reason)?result.reason:result.error==='game_client_update_required'?'update':'unavailable');}
   if(kind==='check'){
    if(result.enabled!==true||result.arenaPersonal!==true||result.serverId!==scope.serverId||typeof result.nonce!=='string'||!result.nonce||result.nonce.length>256)throw Error('unsupported');
    state={status:'ready',nonce:result.nonce,data:null};
   }else state={status:'complete',nonce:null,data:validateArenaPersonal(result.snapshot,scope)};
   notify();
  }catch(error){if(stamp===generation){state={status:'error',error:controller.signal.aborted?'timeout':error.message,nonce:null,data:null};notify();}}
  finally{body=account=password='';clearTimeout(timer);if(stamp===generation)request=null;}
 }
 return {select,getState,clear,check:()=>run('check'),query:(account,password)=>run('read',account,password)};
}
export function installArenaPersonal(root,{getData,getContext,t,time,onClose=()=>{}}){
 const dialog=root.querySelector('[data-arena-personal-dialog]'),body=dialog.querySelector('[data-arena-personal-body]');
 let opener=null;
 const client=createArenaPersonalClient({onChange:render});
 const errors={unsupported:t('该区服或赛季暂不支持个人排名查询。','Personal rankings are unavailable for this server or season.'),
  maintenance:t('官方服务维护中，请稍后手动查询。','The game service is under maintenance. Try again later.'),
  expired:t('登录服务已过期，请重新检查。','The login service has expired. Check again.'),busy:t('服务繁忙，请稍后手动查询。','The service is busy. Try again later.'),
  credentials_rejected:t('账号或密码校验未通过。','The account or password was rejected.'),account_not_found:t('官方服务未找到该账号。','The game service did not find this account.'),
  verification_required:t('需要额外验证，本次查询已停止。','Additional verification is required. This query has stopped.'),
  update:t('游戏要求更新客户端，本次查询已停止。','The game requires a client update. This query has stopped.'),
  timeout:t('查询超时，请稍后手动重试。','The query timed out. Try again later.')};
 function render(state=client.getState()){
  const ctx=getContext(),data=getData(),value=state.data,tier=value&&arenaPersonalTier(value,data,ctx);
  const label=[ctx?.season?.name,ctx?.league?.name].filter(Boolean).join(' · ');
  const ready=state.status==='ready';
  body.innerHTML=`<p class="arena-meta">${esc(label)}</p>${value?`<div class="arena-personal-result"><span>${t('我的名次','My position')}<strong>${value.status==='ranked'?esc(value.rank.toLocaleString()):value.status==='unranked'?t('未上榜','Unranked'):t('未返回记录','No record returned')}</strong></span><span>${t('积分','Points')}<strong>${value.point===null?'—':esc(value.point.toLocaleString())}</strong></span><span>${t('积分对应段位','Rank by points')}<strong class="arena-player-tier" data-tier="${tier?.tier??''}">${arenaRankIcon(data,tier?.tier)}${esc(tier?.name??t('待核验','Unverified'))}</strong></span></div><p class="arena-meta">${esc(t('查询于 ','Queried ')+time(value.queriedAt))}</p><p class="arena-meta">${tier?t('段位按同版配置的积分门槛换算。','Rank is converted using matching configuration thresholds.'):t('段位配置版本或赛季范围未匹配，暂不换算。','The configuration version or season did not match. Rank conversion is unavailable.')}</p><button type="button" data-personal-check>${t('重新登录查询','Sign in to query again')}</button>`:
   `<form data-personal-form><fieldset${ready?'':' disabled'}><legend>${t('BHK 邮箱登录','BHK email sign-in')}</legend><label>${t('账号邮箱','Email')}<input name="account" type="email" required maxlength="320" autocomplete="off"></label><label>${t('密码','Password')}<input name="password" type="password" required maxlength="4096" autocomplete="off"></label><button type="submit">${t('登录并查询我的排名','Sign in and query my rank')}</button></fieldset></form><p class="arena-ranking-status" role="status">${esc(state.status==='checking'?t('正在检查共用登录服务…','Checking the shared login service…'):state.status==='loading'?t('正在登录并读取本账号排名…','Signing in and reading this account’s rank…'):state.status==='error'?(errors[state.error]??t('个人排名读取失败，请重新检查后手动查询。','The query failed. Check the service and try again.')):state.status==='unsupported'?errors.unsupported:ready?t('共用登录服务已连接。','The shared login service is connected.'):'')}</p>${['error','unsupported'].includes(state.status)?`<button type="button" data-personal-check>${t('重新检查','Check again')}</button>`:''}`}
   <p class="arena-meta">${t('仅查询本次登录账号。每次查询重新认证；不保存密码、令牌或个人排名，关闭窗口即清空。登录可能使游戏会话失效。','Only the account signed in for this query is read. Each query authenticates again; passwords, tokens and personal rankings are not stored. Closing this dialog clears the result. Signing in may end your game session.')}</p>`;
 }
 root.addEventListener('click',event=>{
  const button=event.target.closest('[data-action="my-rank"]');if(!button)return;
  opener=button;dialog.showModal();void client.check();
 });
 dialog.addEventListener('submit',event=>{if(!event.target.matches('[data-personal-form]'))return;event.preventDefault();
  const form=event.target;if(!form.reportValidity())return;let account=form.elements.account.value,password=form.elements.password.value;
  form.reset();void client.query(account,password);account=password='';});
 dialog.addEventListener('cancel',()=>client.clear());
 dialog.addEventListener('click',event=>{if(event.target===dialog||event.target.closest('[data-personal-close]')){client.clear();dialog.close();}
  else if(event.target.closest('[data-personal-check]'))void client.check();});
 dialog.addEventListener('close',()=>{client.clear();(opener?.isConnected?opener:root.querySelector('[data-action="my-rank"]'))?.focus({preventScroll:true});onClose();});
 const dispose=()=>{if(dialog.open)dialog.close();client.clear();};
 window.addEventListener('pagehide',dispose);document.addEventListener('ournotes:shell-dispose',dispose);
 document.addEventListener('astro:before-swap',dispose,{once:true});
 return {select(scope){const old=client.getState().scope;const changed=JSON.stringify(old)!==JSON.stringify(scope);
  if(changed&&dialog.open)dialog.close();client.select(scope);},clear:dispose,isOpen:()=>dialog.open};
}
