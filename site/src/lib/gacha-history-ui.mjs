import {currentServerContext} from './game-servers.mjs';
import {createHistoryModel, selectHistory, summarizeHistory, shareSummary, historyTime, RARITIES, HIGH_RARITIES, CARD_KINDS, STATISTICS_NOTE} from './gacha-history.mjs';
import {createGachaShareImage} from './gacha-share-image.mjs';

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
const cardImage = (card, parent, artwork = false) => {
  const primary=safeUrl(artwork ? card.artwork : card.image),fallback=safeUrl(card.image);
  if(!primary&&!fallback)return;
  const img=node('img');img.alt='';img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';
  img.addEventListener('error',()=>{if(fallback&&img.src!==fallback)img.src=fallback;else img.remove();});
  img.src=primary??fallback;parent.append(img);
};

export class GachaHistoryTool extends (globalThis.HTMLElement ?? class {}) {
  connectedCallback() {
    if (this.started) return;
    this.started = true; this.sequence = 0; this.model = null; this.page = 0;this.albumKind='all';this.albumLimit=6;
    this.events = new AbortController(); this.q = selector => this.querySelector(`[data-gacha-${selector}]`);
    this.catalog = JSON.parse(this.q('catalog').textContent);
    const on = (target,event,callback) => target.addEventListener(event,callback,{signal:this.events.signal});
    on(this.q('login'),'submit',event => {event.preventDefault();this.queryHistory();});
    on(this.q('retry'),'click',() => this.checkService());
    on(this.q('clear'),'click',() => this.reset());
    for (const filter of ['pool','from','to']) on(this.q(filter),'change',() => {this.page=0;this.render();});
    for (const filter of ['kind','rarity','up']) on(this.q(filter),'change',() => {this.page=0;this.renderRecords();});
    for(const button of this.querySelectorAll('[data-gacha-album-kind]'))on(button,'click',()=>{
      this.albumKind=button.dataset.gachaAlbumKind;this.albumLimit=6;this.renderAlbum();
    });
    on(this.q('album-up'),'change',()=>{this.albumLimit=6;this.renderAlbum();});
    on(this.q('album-more'),'click',()=>{this.albumLimit+=6;this.renderAlbum();});
    on(this.q('previous'),'click',() => {this.page--;this.renderRecords();});
    on(this.q('next'),'click',() => {this.page++;this.renderRecords();});
    on(this.q('share'),'click',() => this.share());
    on(this.q('share-close'),'click',() => this.q('share-dialog').close());
    on(this.q('share-dialog'),'close',() => this.clearShare());
    on(window,'pagehide',() => this.reset());
    on(document,'ournotes:shell-dispose',() => this.reset());
    this.q('statistics-note').textContent=STATISTICS_NOTE;
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
    this.shareRequest?.abort();this.shareRequest=null;
    if(this.shareUrl)URL.revokeObjectURL(this.shareUrl);
    this.shareUrl=null;this.q('share-image')?.removeAttribute('src');this.q('download')?.removeAttribute('href');
  }

  reset() {
    this.sequence=(this.sequence??0)+1;this.request?.abort();this.request=null;this.busy=false;
    this.model=null;this.records=[];this.summary=null;this.page=0;this.albumKind='all';this.albumLimit=6;
    this.q?.('share-dialog')?.close();this.clearShare();
    if(!this.q)return;
    for(const field of ['account','password','from','to'])this.q(field).value='';
    this.q('kind').value=this.q('rarity').value=this.q('up').value='all';this.q('album-up').checked=false;
    this.q('pool').replaceChildren(node('option','全部卡池'));
    this.q('pool').firstChild.value='all';
    this.q('result').hidden=true;this.q('empty').hidden=false;this.q('clear').hidden=true;
    this.q('fields').disabled=!this.nonce;
    this.q('login-panel').open=true;this.q('status').textContent='登录后查看抽卡记录。';
    for(const target of ['record-list','distribution','pools','trend','album'])this.q(target).replaceChildren();
    for(const target of ['total','member-ssr','support-ssr','pickup'])this.q(target).textContent='—';
    for(const target of ['total-detail','member-detail','support-detail','pickup-detail','range','coverage','record-count','album-count','share-status','filter-status'])this.q(target).textContent='';
    this.q('album-more').hidden=true;
    this.q('share').disabled=true;
  }

  async queryHistory() {
    if(this.busy||!this.nonce)return;
    let body=JSON.stringify({account:this.q('account').value,password:this.q('password').value});
    this.reset();const sequence=this.sequence;
    this.busy=true;this.q('fields').disabled=true;this.q('clear').hidden=false;
    this.q('status').textContent='正在登录并读取抽卡记录…';
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
      this.q('login-panel').open=false;
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
    this.q('filter-status').textContent='';this.q('share-status').textContent='';this.albumLimit=6;
    try {
      this.records=selectHistory(this.model,{pool:this.q('pool').value,from:this.q('from').value,to:this.q('to').value});
    } catch(error) {this.records=[];this.q('filter-status').textContent=error.message;}
    this.summary=summarizeHistory(this.records);const s=this.summary;
    this.q('total').textContent=s.total.toLocaleString();this.q('pickup').textContent=s.pickup.toLocaleString();
    this.q('total-detail').textContent=s.other?`含道具 / 未识别 ${s.other} 条`:`角色卡 ${s.kinds[0].total} · 留影 ${s.kinds[1].total}`;
    for(const k of s.kinds){
      this.q(`${k.kind}-ssr`).textContent=k.ssr.toLocaleString();
      this.q(`${k.kind}-detail`).textContent=`共 ${k.total} 张${k.special?` · EX / BD ${k.special}`:''}`;
    }
    this.q('pickup-detail').textContent=s.pickupUnknown?`另有 ${s.pickupUnknown} 条未判定`:'按抽取时所属卡池判定';
    this.q('range').textContent=(s.from?`${s.from} — ${s.to} · UTC+8`:s.total?'记录时间未提供':'当前范围内没有记录')+(s.undated?` · ${s.undated} 条时间未知`:'');
    this.q('coverage').textContent='仅含本次官方返回的记录。'
      +(this.model.historyKind==='legacy'?'旧版记录未提供卡池归属，UP 无法判定。':'')
      +(s.unknown?` ${s.unknown} 条奖品未识别，未计入 SSR / EX / BD 数量。`:'')
      +(s.other?` 另有 ${s.other} 条道具或类型未识别的记录，未并入角色卡与留影图表。`:'');
    this.q('share').disabled=!s.total;
    this.renderDistribution(s);this.renderAlbum();this.renderPools(s);this.renderTrend(s);this.renderRecords();
  }

  renderDistribution(s) {
    const root=this.q('distribution');root.replaceChildren();
    for(const k of s.kinds){
      const panel=node('section','',`gacha-kind-chart gacha-kind--${k.kind}`),head=node('header');
      const title=node('div'),total=node('p',k.total.toLocaleString(),'gacha-kind-total');total.append(node('small','张'));
      title.append(node('h3',k.label),total);
      const rate=node('div','','gacha-kind-rate');rate.append(node('strong',`SSR ${k.ssr}`),
        node('span',k.rate===null?'暂无记录':`${k.unknown?'已确认 SSR 占比':'SSR 占比'} ${k.rate.toFixed(2)}%`));
      head.append(title,rate);panel.append(head);
      const rows=node('div','','gacha-rarity-bars');
      for(const row of k.distribution){
        const li=node('div','','gacha-rarity-row'),track=node('div','','gacha-bar-track');
        track.setAttribute('role','img');track.setAttribute('aria-label',`${k.label} ${row.label} ${row.count} 张，其中当期 UP ${row.pickup} 张，UP 未判定 ${row.pickupUnknown} 张`);
        for(const [key,css] of [['nonPickup','kind'],['pickup','up'],['pickupUnknown','unknown']]){
          if(!row[key])continue;const segment=node('i','',`gacha-bar-${css}`);segment.style.width=`${row[key]/Math.max(1,k.total)*100}%`;track.append(segment);
        }
        const count=node('span','','gacha-rarity-count');count.append(node('b',row.count),node('small',k.total?`${(row.count/k.total*100).toFixed(1)}%`:'—'));
        li.append(node('span',row.label,'gacha-rarity-label'),track,count);rows.append(li);
      }
      const footer=node('footer');footer.append(node('span',`当期 UP ${k.pickup} 张`,'gacha-up-text'),
        node('small',k.pickupUnknown?`另有 ${k.pickupUnknown} 张未判定`:'已包含在上方各稀有度中'));
      panel.append(rows,footer);root.append(panel);
    }
  }

  renderAlbum() {
    if(!this.summary)return;
    const s=this.summary,root=this.q('album'),onlyUp=this.q('album-up').checked;
    root.replaceChildren();root.classList.toggle('gacha-album-grid--single',this.albumKind!=='all');
    for(const button of this.querySelectorAll('[data-gacha-album-kind]'))button.setAttribute('aria-pressed',String(button.dataset.gachaAlbumKind===this.albumKind));
    this.q('album-count').textContent=`SSR ${s.ssr} 张${s.special?` · EX / BD ${s.special} 张`:''} · 当期 UP ${s.pickup} 张`;
    let hidden=0;
    for(const [kind,label] of Object.entries(CARD_KINDS)){
      if(this.albumKind!=='all'&&this.albumKind!==kind)continue;
      const cards=s.highlights.filter(c=>c.kind===kind&&(!onlyUp||c.pickup));
      const group=node('section','',`gacha-album-kind gacha-kind--${kind}`),head=node('div','','gacha-kind-heading');
      head.append(node('h3',label),node('small',`${cards.length} 种卡牌`));group.append(head);
      const list=node('ul','','gacha-card-grid');
      for(const card of cards.slice(0,this.albumLimit)){
        const item=node('li','','gacha-pull-card'),art=node('div','','gacha-card-art');
        const fallback=node('span','暂无卡图','gacha-art-fallback');fallback.setAttribute('aria-hidden','true');
        art.append(fallback);cardImage(card,art,true);
        art.append(node('span',RARITIES[card.rarity],'gacha-rarity-badge'),node('span',`×${card.count}`,'gacha-card-count'));
        if(card.pickup)art.append(node('span',`当期 UP ×${card.pickup}`,'gacha-up-badge'));
        const href=safeUrl(card.href),name=node(href?'a':'strong',card.name,'gacha-card-name');if(href)name.href=href;
        const detail=node('small',card.pickupUnknown?`UP 未判定 ${card.pickupUnknown} 张`:card.pickup?`其中 ${card.pickup} 张为当期 UP`:'非 UP','gacha-card-detail');
        item.append(art,name,detail);list.append(item);
      }
      hidden+=Math.max(0,cards.length-this.albumLimit);
      if(!cards.length)group.append(node('p',onlyUp?'没有已确认的当期 UP。':'暂无 SSR、EX、BD 或 UP 卡牌。','gacha-album-empty'));
      else group.append(list);
      root.append(group);
    }
    this.q('album-more').hidden=!hidden;this.q('album-more').textContent=`显示更多卡牌（还有 ${hidden} 种）`;
  }

  renderPools(s) {
    const root=this.q('pools');root.replaceChildren();const max=Math.max(1,...s.pools.map(p=>p.total));
    for(const pool of s.pools){
      const row=node('div','','gacha-pool-bar'),head=node('div');head.append(node('span',pool.name),node('b',`${pool.total} 抽`));
      const track=node('div','','gacha-pool-track');track.setAttribute('aria-hidden','true');
      for(const kind of ['member','support','other']){const bar=node('i','',`gacha-segment-${kind}`);bar.style.width=`${pool[kind]/max*100}%`;track.append(bar);}
      row.append(head,track,node('small',`角色卡 ${pool.member} · 留影 ${pool.support}${pool.other?` · 其他 ${pool.other}`:''} · 当期 UP ${pool.pickup}`));root.append(row);
    }
    if(!s.pools.length)root.append(node('p','当前范围内没有卡池记录。','gacha-muted'));
  }

  renderTrend(s) {
    const root=this.q('trend');root.replaceChildren();
    if(!s.days.length){root.append(node('p','暂无带日期的记录。','gacha-muted'));return;}
    const days=s.days.slice(-30),max=Math.max(...days.map(d=>d.total)),bars=node('div','','gacha-day-bars');
    bars.setAttribute('role','list');bars.setAttribute('aria-label','最近 30 个有记录日期的抽数');
    for(const day of days){
      const column=node('div','','gacha-day');column.setAttribute('role','listitem');column.tabIndex=0;
      column.title=`${day.day}：角色卡 ${day.member}，留影 ${day.support}，其他 ${day.other}，当期 UP ${day.pickup}`;
      column.setAttribute('aria-label',column.title);
      const bar=node('div','','gacha-day-stack');bar.style.height=`${Math.max(2,day.total/max*90)}px`;
      for(const kind of ['other','support','member']){if(!day[kind])continue;const segment=node('i','',`gacha-segment-${kind}`);segment.style.flex=day[kind];bar.append(segment);}
      column.append(node('span',day.total),bar,node('small',day.day.slice(5).replace('-','/')));bars.append(column);
    }
    root.append(bars,node('p','最近 30 个有记录日期 · 横向滑动查看','gacha-chart-note'));
  }

  renderRecords() {
    if(!this.model)return;
    const kind=this.q('kind').value,rarity=this.q('rarity').value,up=this.q('up').value;
    const rows=this.records.filter(r=>(kind==='all'||r.kind===kind)&&(rarity==='all'||String(r.rarity)===rarity)
      &&(up==='all'||(r.kind!=='item'&&r.pickup===({yes:true,no:false,unknown:null})[up])))
      .sort((a,b)=>(b.executedAt??0)-(a.executedAt??0)||a.batchIndex-b.batchIndex);
    const pages=Math.max(1,Math.ceil(rows.length/20));this.page=Math.max(0,Math.min(this.page,pages-1));
    const list=this.q('record-list');list.replaceChildren();
    for(const r of rows.slice(this.page*20,(this.page+1)*20)){
      const row=node('li','','gacha-record'),thumb=node('div','','gacha-record-thumb');
      thumb.append(node('span',RARITIES[r.rarity]??'—'));cardImage(r,thumb);
      if(r.known&&HIGH_RARITIES.has(r.rarity))row.classList.add('gacha-record--high');
      const copy=node('div','','gacha-record-copy'),href=safeUrl(r.href),title=node(href?'a':'strong',r.name);if(href)title.href=href;
      const detail=node('p',`${CARD_KINDS[r.kind]??(r.kind==='item'?'道具':'未识别')} · ${r.known?RARITIES[r.rarity]??'—':'稀有度未识别'}${r.converted?' · 已转化':''}`);
      if(r.kind!=='item')detail.append(node('span',r.pickup===true?'当期 UP':r.pickup===false?'非 UP':'UP 未判定',r.pickup?'gacha-inline-up':'gacha-inline-muted'));
      copy.append(title,detail,node('small',r.poolName));
      const time=node('div','','gacha-record-time');time.append(node('time',historyTime(r.executedAt)),node('small',`批次 ${r.batchIndex+1}`));
      row.append(thumb,copy,time);list.append(row);
    }
    if(!rows.length)list.append(node('li','没有符合筛选条件的记录。','gacha-muted'));
    this.q('record-count').textContent=`${rows.length} 条 · 明细筛选不影响上方统计`;
    this.q('page').textContent=`${this.page+1} / ${pages}`;
    this.q('previous').disabled=this.page===0;this.q('next').disabled=this.page+1>=pages;
  }

  async share() {
    if(!this.summary?.total||this.shareRequest)return;
    this.clearShare();const controller=this.shareRequest=new AbortController(),summary=this.summary;
    const name=this.q('pool').value==='all'?'全部卡池':summary.pools[0]?.name??'抽卡记录';
    this.q('share').disabled=true;this.q('share-status').textContent='正在生成分享图片…';
    try{
      const {blob,missingArtwork}=await createGachaShareImage(shareSummary(summary,name,this.model.queriedAt),{signal:controller.signal});
      if(controller.signal.aborted||summary!==this.summary||!this.isConnected)return;
      this.shareUrl=URL.createObjectURL(blob);
      this.q('share-image').src=this.shareUrl;this.q('download').href=this.shareUrl;
      this.q('download').download='otonote-gacha-report.png';this.q('share-dialog').showModal();
      this.q('share-status').textContent=missingArtwork?`图片已生成，${missingArtwork} 张卡图未能加载，已保留卡名和数量。`:'图片已生成，可预览并保存。';
    }catch(error){if(!controller.signal.aborted&&summary===this.summary)this.q('share-status').textContent=error.message;}
    finally{if(this.shareRequest===controller){this.shareRequest=null;this.q('share').disabled=!this.summary?.total;}}
  }
}

if(globalThis.customElements && !customElements.get('gacha-history-tool'))customElements.define('gacha-history-tool',GachaHistoryTool);
