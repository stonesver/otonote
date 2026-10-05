import {chart} from './charts.mjs';
const $ = id => document.getElementById(id);
const number = value => value == null ? '—' : new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1}).format(value);
const bytes = value => value == null ? '—' : value < 1e6 ? `${number(value / 1e3)} KB` : value < 1e9 ? `${number(value / 1e6)} MB` : `${number(value / 1e9)} GB`;
const time = value => value ? new Date(value * 1000).toLocaleTimeString('zh-CN', {hour12:false}) : '尚无数据';
const words = {page:'页面',image:'图片',audio:'音频',video:'视频',live2d:'Live2D',static:'脚本与样式',data:'数据',download:'文件',other:'其他',queued:'等待执行',running:'正在执行',succeeded:'已完成',failed:'失败',interrupted:'已中断',passed:'已完成',not_run:'尚未运行',unknown:'状态未知',unavailable:'不可用',success:'生成成功',cancelled:'已取消'};
let config, currentView = 'overview', generation = 0, loadData = [], inFlight = false;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function empty(container, title, detail='') {
  const node = el('div', null, 'empty'); node.append(el('span', title));
  if (detail) node.append(el('small', detail)); container.replaceChildren(node);
}
function metrics(container, rows) {
  container.replaceChildren(...rows.map(([label,value,detail]) => {
    const card = el('div', null, 'metric'); card.append(el('span',label,'metric-label'),el('strong',value),el('small',detail)); return card;
  }));
}
function rows(container, items, title='尚无记录', detail='开始采集后会在这里显示。') {
  if (!items.length) return empty(container,title,detail);
  container.replaceChildren(...items.map(([label,value,hint]) => {
    const row = el('div',null,'data-row'), name=el('span',label);
    if(hint) name.append(el('small',hint)); row.append(name,el('strong',value)); return row;
  }));
}
async function api(path,options={}) {
  const response=await fetch(path,{...options,cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw new Error(response.status===401?'认证已失效，请重新登录管理入口。':response.status===403?'当前入口不允许执行此操作。':response.status===409?'已有任务执行中或请求冲突，请查看任务列表。':response.status===400?'日期或任务参数无效，请重新选择。':'请求未完成，请检查节点状态。');
  return response.json();
}
function status(message,error=false){$('health').textContent=message;$('health').parentElement.classList.toggle('error',error);}
function siteId(){return $('site').value;}
function summaryWindow(){return $('window').value==='date'?'date:'+$('summary-date').value:$('window').value;}
function loadQuery(){const value=$('load-window').value;return /^\d+$/.test(value)?`seconds=${value}`:`window=${encodeURIComponent(value==='date'?'date:'+$('load-date').value:value)}`;}
function renderSummary(result) {
  const d=result.data, ok=result.status==='ok'&&d, hasEvents=ok&&d.events.lastEvent;
  metrics($('visit-metrics'),[
    ['浏览量',hasEvents?number(d.totals.page_view||0):'—','页面浏览事件'],
    ['日访客累计',hasEvents?number(d.dailyVisitorsSum):'—','每日去重 · 非区间独立人数'],
    ['下载点击',hasEvents?number(d.totals.download_click||0):'—','不代表文件已保存'],
    ['导出成功',hasEvents&&d.exportResultsEnabled!==false?number(d.totals['export_result:success']||0):'—',d?.exportResultsEnabled===false?'当前线上前端尚未接入结果上报':'浏览器文件生成完成']]);
  if(!ok){for(const id of ['pages','downloads','referrers','traffic','visits-chart'])empty($(id),'统计来源暂不可用','检查采集服务或服务器间 SSH 隧道。');status('统计来源离线 · 当前值不可用',true);return;}
  status(d.samplingError?'部分采集失败，请检查采集服务':!hasEvents?'尚未收到网页事件 · 请检查网站采集配置':d.coverage==='partial'?'当前窗口尚未完整覆盖 · 从开始采集后累计':'统计服务已连接 · 网页事件可能受浏览器拦截',Boolean(d.samplingError));
  $('updated').textContent=`查询于 ${time(result.fetchedAt)} · 最近事件 ${time(d.events.lastEvent)}`;
  const points=d.timeline.map(p=>({...p,ts:p.ts??Date.parse(p.day+'T00:00:00+08:00')/1000,label:p.label??p.day?.slice(5)}));
  chart($('visits-chart'),points,['views','downloads'],'浏览量与下载点击趋势',86400*1.5,`/api/export/${encodeURIComponent(siteId())}?kind=visits&window=${encodeURIComponent(summaryWindow())}`);
  rows($('pages'),d.pages.map(r=>[r.label,number(r.count)]));
  rows($('downloads'),d.resources.map(r=>[r.label,number(r.count),r.kind==='download_click'?'下载点击':words[r.result]||r.result]));
  rows($('referrers'),d.referrers.map(r=>[r.label==='direct'?'直接或来源未知':r.label==='internal'?'站内跳转':r.label,number(r.count)]));
  rows($('traffic'),d.traffic.map(r=>[words[r.category]||r.category,bytes(r.bytes),`${number(r.requests)} 次请求 · ${number(r.errors)} 次错误`]),d.log.status==='ok'?'窗口内尚无请求':'尚未接入网站日志','请配置站点日志路径；网页事件不会被算成网站传输量。');
}
function renderLoads() {
  const source=loadData.find(s=>s.source===$('load-source').value), latest=source?.latest;
  const fresh=latest && Date.now()/1000-latest.ts<=(source.resolution||5)*3;
  const historical=Boolean(source?.historical);
  const sample=historical?source.points.at(-1):fresh?latest:null;
  const points=source?.points||[], valid=points.filter(p=>p.txMbps!=null);
  metrics($('load-metrics'),[
    [historical?'窗口末次连接数':'当前连接数',number(sample?.active),'共享 Nginx 实例 · 含空闲连接'],
    [historical?'窗口末次请求数':'每秒请求数',number(sample?.rps),'采样窗口平均 RPS'],
    [historical?'窗口末次出站带宽':'当前出站带宽',sample?.txMbps!=null?`${number(sample.txMbps)}`:'—','Mbps · 服务器选定网卡'],
    [historical?'窗口末次入站带宽':'当前入站带宽',sample?.rxMbps!=null?`${number(sample.rxMbps)}`:'—','Mbps · 服务器选定网卡']]);
  const exportUrl=`/api/export/${encodeURIComponent(siteId())}?kind=loads&${loadQuery()}&source=${encodeURIComponent(source?.source||'')}`;
  chart($('bandwidth-chart'),points,['txMbps','rxMbps'],'服务器收发带宽曲线',(source?.resolution||5)*3,exportUrl);
  chart($('connections-chart'),points,['active'],'Nginx 连接数曲线',(source?.resolution||5)*3,exportUrl);
  chart($('requests-chart'),points,['rps'],'Nginx 请求速率曲线',(source?.resolution||5)*3,exportUrl);
  const peak=valid.length?valid.reduce((a,b)=>(a.txPeakMbps??a.txMbps)>(b.txPeakMbps??b.txMbps)?a:b):null;
  const rate=sample?.txMbps!=null&&sample.txLimitMbps?sample.txMbps/sample.txLimitMbps*100:null;
  rows($('bandwidth-detail'),[
    ['采样出站峰值',peak?`${number(peak.txPeakMbps??peak.txMbps)} Mbps · ${time(peak.txPeakAt??peak.ts)}`:'—'],
    ['配置上限占用',rate==null?'未配置上限或暂无有效采样':`${number(rate)}% / ${number(sample.txLimitMbps)} Mbps`],
    ['本窗口已采集出站量',valid.length?bytes(valid.reduce((n,p)=>n+(p.txBytes||0),0)):'—'],
    ['今日 / 本月出站量',source?.totals?`${bytes(source.totals.today.txBytes)} / ${bytes(source.totals.month.txBytes)}`:'未提供','仅采集覆盖范围，整机网卡口径']]);
  rows($('connection-detail'),[['读取 / 写入 / 空闲',sample?`${number(sample.reading)} / ${number(sample.writing)} / ${number(sample.waiting)}`:'—']]);
  if(currentView==='load'){status(historical?'正在查看历史负载 · 北京时间 · 缺口表示未采集':!latest?'负载来源尚无采样':!fresh?'采样已延迟 · 保留历史曲线，当前值不可用':'负载每 5 秒刷新 · 连接和网卡指标属于服务器范围',!historical&&!fresh);$('updated').textContent=historical?`历史窗口截至 ${new Date(source.until*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`:`最后采样 ${time(latest?.ts)}`;}
}
async function refreshLoads(gen=generation){
  const selected=$('load-window').value, window=selected==='date'?'date:'+$('load-date').value:selected;
  const query=/^\d+$/.test(selected)?`seconds=${selected}`:`window=${encodeURIComponent(window)}`;
  const result=await api(`/api/loads/${encodeURIComponent(siteId())}?${query}`);
  if(gen!==generation)return;
  loadData=result.data?.sources||[];const previous=$('load-source').value;
  $('load-source').replaceChildren(...loadData.map(s=>new Option(s.name,s.source)));
  if(loadData.some(s=>s.source===previous))$('load-source').value=previous;
  renderLoads();
}
function renderContentDelivery(profile){
  const section=el('section',null,'content-delivery');
  section.append(el('h3','Global / JP 内容发布'));
  const flow=el('ol',null,'delivery-flow');
  for(const [title,detail] of [
    ['游戏资源生产','GitHub Actions 检查版本、采集资源并生成快照'],
    ['发布到 R2','校验通过后切换区服内容指针，媒体由 Worker 提供'],
    ['网站交付','现有服务器同步内容并生成页面，下方显示本机交付结果']]){
    const step=el('li');step.append(el('strong',title),el('small',detail));flow.append(step);
  }
  section.append(flow);
  const actions=el('div',null,'toolbar');
  const workflow=el('a','打开 Actions：运行更新 / 查看进度','action-link');
  workflow.href='https://github.com/stonesver/otonote/actions/workflows/content-r2.yml';
  workflow.target='_blank';workflow.rel='noopener noreferrer';actions.append(workflow);section.append(actions);
  const guide=el('details',null,'delivery-guide');
  guide.dataset.disclosure=`${profile.id}:guide`;
  guide.append(el('summary','手动更新怎么操作？'));
  const steps=el('ol');
  for(const text of [
    '打开上方 Actions 页面，在 GitHub 登录后选择 Run workflow。',
    'Branch 选择 main，region 选择 global 或 jp；更新两服需分别运行。',
    '正式更新选择 mode = promote，然后提交。仅验证生产和上传时选择 shadow，它不会更新网站。',
    '在该次 Actions 运行中查看进度和结果；promote 完成后等待服务器同步、生成页面，再回到此页刷新。'])steps.append(el('li',text));
  guide.append(steps,el('p','日常追新由 Actions 定时执行。只修改网站功能时走代码发布流程，无需手动运行游戏资源生产。','caption'));
  section.append(guide,el('p','Actions 的运行状态与远端 R2 最新版本请在 GitHub 查看。本页读取服务器交付回执，不会将历史成功显示为正在运行或最新生产成功。','caption'));
  section.append(el('p',profile.updatedAt?`本机采样：${new Date(profile.updatedAt*1000).toLocaleString('zh-CN',{hour12:false})} · 每两分钟采样，超过六分钟失效`:'本机状态尚无采样','caption'));
  const cards=el('div',null,'delivery-regions');
  for(const region of ['global','jp']){
    const item=profile.delivery?.status==='ready'?profile.delivery.regions?.[region]:null;
    const card=el('section',null,'delivery-region'),heading=el('div',null,'node-header');
    heading.append(el('h4',region==='global'?'Global 国际服':'JP 日服'),el('span',item?'本机交付已核对':'状态待核对',item?'badge':'badge warning'));card.append(heading);
    if(item){
      card.append(el('p',item.contentReleaseId,'delivery-version'),el('small','本机内容与已生成页面的版本一致。'));
      const details=el('details');details.append(el('summary','版本核对信息'));
      details.dataset.disclosure=`${profile.id}:${region}`;
      const list=el('dl');
      for(const [label,value] of [['内容版本',item.releaseId],['页面代码版本',item.renderPair.slice(0,24)],['HTML 组合',item.renderPair],['清单 SHA-256',item.manifestSha256]])list.append(el('dt',label),el('dd',value));
      details.append(list);card.append(details);
    }else card.append(el('p','交付回执缺失、过期或两服版本尚未对齐。更新中可稍后刷新；若持续如此，请检查服务器预渲染服务。','caption'));
    cards.append(card);
  }
  section.append(cards);return section;
}
function renderTask(task){
  const row=el('div',null,'task'),name=el('div',task.message);
  name.append(el('small',`${({check:'检查版本',fetch:'拉取资源',build:'构建候选',publish:'发布候选'})[task.action]||'资源任务'} · ${task.profile} · ${task.id.slice(0,8)}`));
  row.append(el('span',words[task.status]||task.status),name,el('time',time(task.updated)));return row;
}
async function refreshNodes(gen=generation){
  const allowed=config.sites.find(s=>s.id===siteId())?.nodes||[];
  const nodes=config.nodes.filter(n=>allowed.includes(n.id));
  if(!nodes.length)return empty($('nodes'),'还没有绑定资源节点','配置节点后可以查看运行状态、步骤和任务记录。');
  const results=await Promise.all(nodes.map(async n=>({node:n,result:await api(`/api/nodes/${encodeURIComponent(n.id)}`)})));
  if(gen!==generation)return;
  const offline=results.filter(x=>x.result.status!=='ok').length;
  const hasActions=results.some(x=>x.result.data?.profiles.some(p=>p.productionOwner==='github-actions-r2'));
  status(offline?`${offline} 个节点暂不可用 · 不据此判断任务结果`:hasActions?'交付状态已更新 · Actions 生产进度请在 GitHub 查看':'节点状态已更新 · 仅显示实际开放的操作',Boolean(offline));
  $('updated').textContent=`查询于 ${time(Date.now()/1000)}`;
  const openDisclosures=new Set([...$('nodes').querySelectorAll('details[open][data-disclosure]')].map(item=>item.dataset.disclosure));
  $('nodes').replaceChildren(...results.map(({node,result})=>{
    const panel=el('div',null,'panel'),header=el('div',null,'node-header');
    header.append(el('h3',node.name),el('span',result.status==='ok'?'节点已连接':'节点不可用',result.status==='ok'?'badge':'badge warning'));panel.append(header);
    if(!result.data){panel.append(el('p','检查节点服务与 SSH 隧道，未连接不代表任务失败。','caption'));return panel;}
    for(const profile of result.data.profiles){
      const row=el('div',null,'node-profile'),description=el('div');
      if(profile.productionOwner==='github-actions-r2'){
        panel.append(renderContentDelivery(profile));continue;
      }
      description.append(el('p',profile.name),el('small',`最近运行：${words[profile.status]||profile.status} · ${profile.publication==='enabled'?'已开放授权发布':'发布权限未开放'}`));
      if(profile.currentRelease)description.append(el('small',`当前内容：${profile.currentRelease}`));
      if(profile.candidate)description.append(el('small',`候选：${profile.candidate.id.slice(0,12)} · ${profile.candidate.contentReleaseId} · ${profile.candidate.stale?'线上版本已改变，请重新构建':'已校验，等待发布'}`));
      const actions=el('div',null,'toolbar'),busy=result.data.tasks.some(t=>t.profile===profile.id&&['queued','running'].includes(t.status));
      for(const [action,title] of Object.entries({check:'检查版本',fetch:'拉取资源',build:'构建候选',publish:'发布候选'})){
        const button=el('button',title),available=(profile.capabilities||['check']).includes(action);
        button.disabled=!node.writable||!available||busy||(action==='build'&&!profile.inputsReady)||(action==='publish'&&(!node.canPublish||!profile.candidate||profile.candidate.stale));
        button.title=busy?'已有任务排队或执行中':!available?'节点未开放此操作':action==='build'?'使用已拉取的输入构建，不改变线上内容':action==='publish'?'发布选中的已验证候选':'后台执行，关闭页面也会继续';
        button.addEventListener('click',async()=>{
          if(action==='publish'&&!await confirmPublish(profile))return;
          button.disabled=true;const payload={profile:profile.id,action,key:crypto.randomUUID()};
          if(action==='publish')payload.candidate=profile.candidate.id;
          try{await api(`/api/nodes/${node.id}/tasks`,{method:'POST',headers:{'Content-Type':'application/json','X-OurNotes-Request':'1'},body:JSON.stringify(payload)});status(`${title}任务已提交，关闭页面也会继续执行。`);}
          catch(error){status(`${error.message} 请先查看任务列表，避免重复提交。`,true);}
          await refreshNodes();
        });actions.append(button);
      }
      row.append(description,actions);panel.append(row);
      if(profile.steps?.length) rows(panel.appendChild(el('div')),profile.steps.map(s=>[s.name,words[s.status]||s.status]));
    }
    const migrated=new Set(result.data.profiles.filter(p=>p.productionOwner==='github-actions-r2').map(p=>p.id));
    const history=result.data.tasks.filter(task=>migrated.has(task.profile));
    for(const task of result.data.tasks.filter(task=>!migrated.has(task.profile)))panel.append(renderTask(task));
    if(history.length){
      const archive=el('details',null,'delivery-guide');archive.append(el('summary',`旧服务器任务记录（${history.length}）`),el('p','迁移前的本机记录，仅供查阅；与当前 Actions 运行无关。','caption'));
      archive.dataset.disclosure=`${node.id}:history`;
      for(const task of history)archive.append(renderTask(task));panel.append(archive);
    }
    if(!result.data.tasks.length&&result.data.profiles.some(p=>!migrated.has(p.id)))panel.append(el('p','尚未提交任务。','caption'));return panel;
  }));
  for(const disclosure of $('nodes').querySelectorAll('details[data-disclosure]'))disclosure.open=openDisclosures.has(disclosure.dataset.disclosure);
}
function confirmPublish(profile){
  const dialog=$('publish-confirm');$('publish-description').textContent=`将发布候选 ${profile.candidate.id.slice(0,12)}（${profile.candidate.contentReleaseId}）。发布后网站使用该内容，上一版保留用于回退。`;
  return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='publish'),{once:true});dialog.returnValue='cancel';dialog.showModal();});
}
function settings(){rows($('settings'),[
  ['连接方式',config.connection],['运行模式',config.preview?'本地只读预览':'认证代理保护'],
  ...config.sites.map(s=>[s.name,s.id,`统计时区 ${s.timezone||'Asia/Shanghai'} · ${s.nodes?.length||0} 个资源节点`]),
  ...config.nodes.map(n=>[n.name,n.writable?'可提交已开放的资源任务':'只读节点'])]);}
async function refresh(){
  if(!config||!siteId()||inFlight)return;inFlight=true;$('refresh').disabled=true;const gen=generation;
  try{
    if(currentView==='overview'){const result=await api(`/api/summary/${encodeURIComponent(siteId())}?window=${encodeURIComponent($('window').value==='date'?'date:'+$('summary-date').value:$('window').value)}`);if(gen===generation)renderSummary(result);}
    else if(currentView==='load')await refreshLoads(gen);
    else if(currentView==='tasks')await refreshNodes(gen);
    else{settings();status('配置仅在后端维护 · 页面不显示密钥');}
  }catch(error){status(error.message,true);}finally{inFlight=false;$('refresh').disabled=false;if(gen!==generation)queueMicrotask(refresh);}
}
function navigate(){
  const key=location.hash.slice(1);currentView=['overview','load','tasks','settings'].includes(key)?key:'overview';generation++;
  const titles={overview:['访问与下载','了解内容如何被访问，以及资源如何被使用。'],load:['并发与带宽','观察服务器负载，保留来源和采样缺口。'],tasks:['内容发布','运行内容更新，查看服务器已交付的版本。'],settings:['节点与配置','站点、统计和资源节点可以独立部署。']};
  for(const view of document.querySelectorAll('.view'))view.hidden=view.id!==`view-${currentView}`;
  for(const a of document.querySelectorAll('[data-view]')){if(a.dataset.view===currentView)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
  status('正在读取对应数据…');$('updated').textContent='等待更新';
  $('title').textContent=titles[currentView][0];$('subtitle').textContent=titles[currentView][1];$('breadcrumb').textContent='网站运行 / '+titles[currentView][0];refresh();
}
$('refresh').addEventListener('click',refresh);for(const id of ['site','window','load-window','summary-date','load-date'])$(id).addEventListener('change',()=>{$('summary-date').hidden=$('window').value!=='date';$('load-date').hidden=$('load-window').value!=='date';generation++;refresh();});
$('load-source').addEventListener('change',renderLoads);addEventListener('hashchange',navigate);
const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});for(const id of ['summary-date','load-date']){$(id).value=today;$(id).max=today;$(id).min=new Date(Date.now()-29*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});}
try{config=await api('/api/config');$('preview').hidden=!config.preview;$('site').replaceChildren(...config.sites.map(s=>new Option(s.name||s.id,s.id)));navigate();if(!config.sites.length)status('尚未配置站点');}
catch(error){status(error.message,true);}
let tick=0;setInterval(()=>{tick++;if(!document.hidden&&(currentView!=='overview'||tick%12===0))refresh();},5000);
