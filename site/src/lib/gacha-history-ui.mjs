import {currentServerContext} from './game-servers.mjs';
import {createHistoryModel, selectHistory, summarizeHistory, shareSummary, historyTime, RARITIES, HIGH_RARITIES, LUCK_RULE} from './gacha-history.mjs';
import {createGachaShareImage, GACHA_COLORS} from './gacha-share-image.mjs';

const messages = {credentials_rejected:'账号或密码校验未通过，请检查后重新登录。',
  account_not_found:'官方服务提示账号不存在。', verification_required:'需要额外验证，本次查询已停止。',
  rate_limited:'请求过于频繁，请稍后再试。'};
const node = (tag, text = '', className = '') => {
  const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el;
};
const safeUrl = value => {
  if (!value) return null;
  try { const url = new URL(value, location.href); return ['https:','http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

export class GachaHistoryTool extends (globalThis.HTMLElement ?? class {}) {
  connectedCallback() {
    if (this.started) return;
    this.started = true; this.sequence = 0; this.model = null; this.page = 0;
    this.events = new AbortController(); this.q = selector => this.querySelector(`[data-gacha-${selector}]`);
    this.catalog = JSON.parse(this.q('catalog').textContent);
    const on = (target,event,callback) => target.addEventListener(event,callback,{signal:this.events.signal});
    on(this.q('login'),'submit',event => {event.preventDefault();this.queryHistory();});
    on(this.q('retry'),'click',() => this.checkService());
    on(this.q('clear'),'click',() => this.reset());
    for (const filter of ['pool','from','to']) on(this.q(filter),'change',() => {this.page=0;this.render();});
    for (const filter of ['kind','rarity']) on(this.q(filter),'change',() => {this.page=0;this.renderRecords();});
    on(this.q('previous'),'click',() => {this.page--;this.renderRecords();});
    on(this.q('next'),'click',() => {this.page++;this.renderRecords();});
    on(this.q('share'),'click',() => this.share());
    on(this.q('share-close'),'click',() => this.q('share-dialog').close());
    on(this.q('share-dialog'),'close',() => this.clearShare());
    on(window,'pagehide',() => this.reset());
    on(document,'ournotes:shell-dispose',() => this.reset());
    this.q('luck-rule').textContent=LUCK_RULE;
    this.checkService();
  }

  disconnectedCallback() { this.reset(); this.serviceRequest?.abort(); this.events?.abort(); this.started=false; }

  async checkService() {
    if (this.busy) return;
    this.serviceRequest?.abort();
    const controller=this.serviceRequest=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
    this.nonce=null;this.q('fields').disabled=true;this.q('retry').hidden=true;
    if (currentServerContext().serverId !== 'global-hmt') {
      clearTimeout(timer);this.q('service').textContent='BHK 查询仅支持港澳台服。请在网站区服选择中切换到港澳台。';return;
    }
    this.q('service').textContent='正在检查登录服务…';
    try {
      const response=await fetch('/api/growth-export/capabilities/',{cache:'no-store',credentials:'same-origin',signal:controller.signal});
      if (!response.ok) throw Error('登录服务暂不可用，请稍后重新检查。');
      const result=await response.json();
      if (result.enabled !== true || result.gachaHistory !== true || typeof result.nonce !== 'string') {
        throw Error('登录服务尚未开放抽卡记录查询，请稍后重新检查。');
      }
      if(controller.signal.aborted)return;
      this.nonce=result.nonce;this.q('fields').disabled=false;this.q('service').textContent='BHK 登录已就绪 · 每次查询重新登录';
    } catch(error) {
      if (!this.isConnected) return;
      this.q('service').textContent=error.name==='AbortError'?'检查登录服务超时，请重试。':error.message;this.q('retry').hidden=false;
    } finally {clearTimeout(timer);}
  }

  clearShare() {
    if(this.shareUrl)URL.revokeObjectURL(this.shareUrl);
    this.shareUrl=null;this.q('share-image')?.removeAttribute('src');this.q('download')?.removeAttribute('href');
  }

  reset() {
    this.sequence=(this.sequence??0)+1;this.request?.abort();this.request=null;this.busy=false;
    this.model=null;this.records=[];this.summary=null;this.page=0;
    this.q?.('share-dialog')?.close();this.clearShare();
    if(!this.q)return;
    for(const field of ['account','password','from','to'])this.q(field).value='';
    this.q('kind').value=this.q('rarity').value='all';this.q('pool').replaceChildren(node('option','全部卡池'));
    this.q('pool').firstChild.value='all';
    this.q('result').hidden=true;this.q('empty').hidden=false;this.q('clear').hidden=true;
    this.q('fields').disabled=!this.nonce;
    this.q('status').textContent='本页不保存记录。登录后查看本次成绩单。';
    for(const target of ['record-list','distribution','pools','trend'])this.q(target).replaceChildren();
    for(const target of ['total','high','rate','pickup'])this.q(target).textContent='—';
    this.q('title').textContent='等待你的抽卡故事';this.q('caption').textContent='';this.q('range').textContent='';
    for(const target of ['high-detail','coverage','record-count','share-status','filter-status'])this.q(target).textContent='';
    this.q('share').disabled=true;
  }

  async queryHistory() {
    if(this.busy||!this.nonce)return;
    let body=JSON.stringify({account:this.q('account').value,password:this.q('password').value});
    this.reset();const sequence=this.sequence;
    this.busy=true;this.q('fields').disabled=true;this.q('clear').hidden=false;
    this.q('status').textContent='正在登录并读取抽卡记录，请稍候。不会自动重试。';
    const controller=this.request=new AbortController(),timer=setTimeout(()=>controller.abort(),150000);
    try {
      const pending=fetch('/api/growth-export/gacha-history/',{method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json','X-Growth-Nonce':this.nonce},body,signal:controller.signal});body='';
      const response=await pending;
      if(Number(response.headers.get('content-length'))>2_000_000)throw Error('返回记录过大，未载入。');
      const text=await response.text();if(text.length>2_000_000)throw Error('返回记录过大，未载入。');
      let result;try{result=JSON.parse(text);}catch{throw Error('登录服务返回异常，请稍后重新查询。');}
      if(!response.ok){
        if(response.status===403){this.nonce=null;this.q('retry').hidden=false;}
        throw Error(messages[result.reason]??(response.status===429?'服务繁忙，请稍后重新查询。':response.status===403?'页面已过期，请重新检查登录服务。':'抽卡记录读取未完成，请稍后重新查询。'));
      }
      if(sequence!==this.sequence||!this.isConnected)return;
      this.model=createHistoryModel(result.snapshot,this.catalog);
      const all=summarizeHistory(this.model.records);
      this.q('pool').replaceChildren(new Option(`全部卡池 · ${all.total} 抽`,'all'),
        ...all.pools.map(p=>new Option(`${p.name} · ${p.total} 抽`,String(p.id))));
      this.q('result').hidden=false;this.q('empty').hidden=true;
      this.q('status').textContent=all.total?`读取完成，共 ${all.total} 条抽卡记录。刷新或离开页面后清空。`:'官方当前没有返回抽卡记录。可稍后重新登录查询。';
      this.render();
    } catch(error) {
      if(sequence===this.sequence)this.q('status').textContent=error.name==='AbortError'?'读取超时，本次未载入记录。请稍后重新登录。':error.message;
    } finally {
      body='';clearTimeout(timer);
      if(sequence===this.sequence){this.busy=false;this.request=null;this.q('fields').disabled=!this.nonce;}
    }
  }

  render() {
    if(!this.model)return;
    this.clearShare();this.q('share-dialog').close();
    this.q('filter-status').textContent='';
    try {
      this.records=selectHistory(this.model,{pool:this.q('pool').value,from:this.q('from').value,to:this.q('to').value});
    } catch(error) {this.records=[];this.q('filter-status').textContent=error.message;}
    this.summary=summarizeHistory(this.records);const s=this.summary;
    this.q('title').textContent=s.title;this.q('caption').textContent=s.caption;
    this.q('total').textContent=s.total.toLocaleString();this.q('high').textContent=s.high.toLocaleString();
    this.q('rate').textContent=s.rate===null?'—':`${s.rate.toFixed(1)}%`;
    this.q('pickup').textContent=s.pickupUnknown?`${s.pickup}（部分待定）`:s.pickup;
    this.q('high-detail').textContent=`SSR ${s.ssr} · EX / BD ${s.special}`;
    this.q('rate-label').textContent=s.unknown?'已确认高稀有占比':'高稀有卡占比';
    this.q('range').textContent=(s.from?`${s.from} — ${s.to} · UTC+8`:'没有符合条件的记录')+(s.undated?` · ${s.undated} 条时间未记录`:'');
    this.q('coverage').textContent='仅统计本次官方返回的记录，保留期限未知，不代表账号完整历史。'
      +(this.model.historyKind==='legacy'?'官方返回的旧版记录没有卡池归属，单独展示。':'')
      +(s.unknown?`有 ${s.unknown} 条奖品未识别，等待资料更新；未识别奖品不计入高稀有卡数。`:'');
    this.q('share').disabled=!s.total;this.renderDistribution(s);this.renderPools(s);this.renderTrend(s);this.renderRecords();
  }

  renderDistribution(s) {
    const root=this.q('distribution');root.replaceChildren();
    if(!s.total){root.append(node('p','还没有可统计的记录。','gacha-muted'));return;}
    let end=0;const segments=s.distribution.map(row=>{const start=end;end+=row.count/s.total*100;return `${GACHA_COLORS[row.label]} ${start}% ${end}%`;});
    const ring=node('div','','gacha-ring');ring.setAttribute('aria-hidden','true');ring.style.background=`conic-gradient(${segments.join(',')})`;
    const center=node('div');center.append(node('strong',s.total),node('span','次相遇'));ring.append(center);
    const legend=node('ul','','gacha-legend');
    for(const row of s.distribution){const li=node('li'),key=node('span',row.label);key.style.setProperty('--rarity',GACHA_COLORS[row.label]);li.append(key,node('b',row.count),node('small',`${(row.count/s.total*100).toFixed(1)}%`));legend.append(li);}
    root.append(ring,legend);
  }

  renderPools(s) {
    const root=this.q('pools');root.replaceChildren();const max=Math.max(1,...s.pools.map(p=>p.total));
    for(const pool of s.pools){
      const row=node('div','','gacha-pool-bar'),head=node('div');head.append(node('span',pool.name),node('b',`${pool.total} 抽`));
      const track=node('div','','gacha-bar-track'),bar=node('i');bar.style.width=`${pool.total/max*100}%`;track.append(bar);
      row.append(head,track,node('small',`SSR / EX / BD ${pool.high} 张`));root.append(row);
    }
    if(!s.pools.length)root.append(node('p','选择有记录的卡池后查看。','gacha-muted'));
  }

  renderTrend(s) {
    const root=this.q('trend');root.replaceChildren();
    if(!s.days.length){root.append(node('p','暂无带日期的记录。','gacha-muted'));return;}
    const days=s.days.slice(-30),max=Math.max(...days.map(d=>d.total)),bars=node('div','','gacha-day-bars');
    bars.setAttribute('role','list');bars.setAttribute('aria-label','最近 30 个有记录日期的抽数');
    for(const day of days){
      const column=node('div','','gacha-day');column.setAttribute('role','listitem');column.title=`${day.day}：${day.total} 抽，高稀有 ${day.high} 张`;
      column.setAttribute('aria-label',column.title);
      const bar=node('i');bar.style.height=`${Math.max(2,day.total/max*100)}%`;
      column.append(node('span',day.total),bar);bars.append(column);
    }
    const axis=node('div','','gacha-chart-axis');axis.append(node('span',days[0].day),node('span',days.at(-1).day));
    root.append(bars,axis,node('p','最近 30 个有记录日期 · 每根柱子代表一天，悬停查看抽数','gacha-chart-note'));
  }

  renderRecords() {
    if(!this.model)return;
    const kind=this.q('kind').value,rarity=this.q('rarity').value;
    const rows=this.records.filter(r=>(kind==='all'||r.kind===kind)&&(rarity==='all'||String(r.rarity)===rarity))
      .sort((a,b)=>(b.executedAt??0)-(a.executedAt??0)||a.batchIndex-b.batchIndex);
    const pages=Math.max(1,Math.ceil(rows.length/20));this.page=Math.max(0,Math.min(this.page,pages-1));
    const list=this.q('record-list');list.replaceChildren();
    for(const r of rows.slice(this.page*20,(this.page+1)*20)){
      const row=node('li','','gacha-record'),thumb=node('div','','gacha-record-thumb');
      const url=safeUrl(r.image);if(url){const img=node('img');img.src=url;img.alt='';img.loading='lazy';thumb.append(img);}else thumb.append(node('span','♪'));
      if(HIGH_RARITIES.has(r.rarity))row.classList.add('gacha-record--high');
      const copy=node('div','','gacha-record-copy'),href=safeUrl(r.href),title=node(href?'a':'strong',r.name);if(href)title.href=href;
      const detail=node('p',`${r.kind==='member'?'成员卡':r.kind==='support'?'留影':r.kind==='item'?'道具':'未识别'} · ${RARITIES[r.rarity]??'—'}${r.pickup?' · UP':''}${r.converted?' · 已转化':''}`);
      copy.append(title,detail,node('small',r.poolName));
      const time=node('div','','gacha-record-time');time.append(node('time',historyTime(r.executedAt)),node('small',`批次 ${r.batchIndex+1} · 批内不排序`));
      row.append(thumb,copy,time);list.append(row);
    }
    if(!rows.length)list.append(node('li','没有符合筛选条件的记录。','gacha-muted'));
    this.q('record-count').textContent=`${rows.length} 条 · 明细筛选不影响上方成绩单`;
    this.q('page').textContent=`${this.page+1} / ${pages}`;
    this.q('previous').disabled=this.page===0;this.q('next').disabled=this.page+1>=pages;
  }

  async share() {
    if(!this.summary?.total)return;
    const sequence=this.sequence,summary=this.summary;
    const name=this.q('pool').value==='all'?'我的抽卡足迹':summary.pools[0]?.name??'抽卡记录';
    this.q('share').disabled=true;this.q('share-status').textContent='正在生成分享图片…';
    try{
      const {blob}=await createGachaShareImage(shareSummary(summary,name,this.model.queriedAt));
      if(sequence!==this.sequence||summary!==this.summary||!this.isConnected)return;
      this.clearShare();this.shareUrl=URL.createObjectURL(blob);
      this.q('share-image').src=this.shareUrl;this.q('download').href=this.shareUrl;
      this.q('download').download='otonote-gacha-report.png';this.q('share-dialog').showModal();
      this.q('share-status').textContent='图片已生成，可预览并保存。';
    }catch(error){if(sequence===this.sequence)this.q('share-status').textContent=error.message;}
    finally{if(sequence===this.sequence)this.q('share').disabled=!this.summary?.total;}
  }
}

if(globalThis.customElements && !customElements.get('gacha-history-tool'))customElements.define('gacha-history-tool',GachaHistoryTool);
