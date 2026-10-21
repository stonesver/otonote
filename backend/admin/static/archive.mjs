const labels={pending:'等待自动保存',deferred_auto:'自动待续',waiting_manual:'等待手动选择',saved:'已保存',failed:'保存失败',removed:'官方已移除',metadata_only:'仅目录变化',expired:'已到期',evicted_fifo:'已 FIFO 汰换',cleaned_manual:'已手动清理',queued:'等待下次检测',running:'执行中',partial:'部分完成',complete:'已完成',cancelled:'已取消',proposed:'待确认'};
const bytes=n=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(1)} KiB`:`${(n/1024/1024).toFixed(2)} MiB`;
const date=n=>new Date(n*1000).toLocaleString('zh-CN');
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,fn,disabled=false){const b=el('button',text,'secondary');b.type='button';b.disabled=disabled;b.addEventListener('click',()=>Promise.resolve().then(fn).catch(showError));return b;}
let root,api,summary,region='global',offset=0,filter='',selected=new Set(),query='',batch='',group='',status='',busy=false,pendingReload=false,initialized=false,last=0,detailSequence=0;
function showError(e){let n=root.querySelector('[data-message]');if(!n){n=el('p');n.dataset.message='';root.append(n);}n.textContent=e.message||'归档请求失败';}
async function get(path){return api('/api/archive'+path);}
async function post(path,data){return api('/api/archive'+path,{method:'POST',headers:{'Content-Type':'application/json','X-OurNotes-Request':'1'},body:JSON.stringify(data)});}
function select(values,value,change,label){const box=el('label',label,'compact'),s=el('select');s.setAttribute('aria-label',label);for(const [v,t] of values)s.append(new Option(t,v));s.value=value;s.addEventListener('change',()=>{change(s.value);offset=0;selected.clear();reload().catch(showError);});box.append(s);return box;}
function message(text){root.querySelector('[data-message]').textContent=text;}
async function save(){if(!selected.size)return message('请先选择文件。');const n=Number(root.querySelector('[data-budget]').value);if(!Number.isFinite(n)||n<1||n>2048)throw new Error('补存预算须为 1–2048 MiB。');await post('/requests',{entries:[...selected],key:crypto.randomUUID(),maxBytes:Math.floor(n*1024*1024)});message('补存已排队，下次既有检测处理；预算包含接收与校验读回。');await history();}
async function clean(scope){
 const data=scope==='selected'?{entries:[...selected]}:{scope,region,batch,group};
 const plan=await post('/cleanup/plans',data),box=root.querySelector('[data-confirm]');box.replaceChildren(el('h3','确认清理'),el('p',`冻结选择 ${plan.entries.length} 项，预计实际释放 ${bytes(plan.estimatedBytes)}。下次检测执行；届时原件及其预览会删除。`));
 box.append(button('确认并排队',async()=>{await post(`/cleanup/${plan.id}/confirm`,{digest:plan.digest});box.replaceChildren();message('清理已排队，尚未释放空间。');await history();}),button('取消',()=>box.replaceChildren()));box.scrollIntoView({block:'nearest'});
}
async function history(){const d=await get('/requests'),box=root.querySelector('[data-history]');box.replaceChildren();for(const row of [...d.requests.map(r=>({...r,kind:'补存'})),...d.cleanup.map(r=>({...r,kind:'清理'}))].sort((a,b)=>b.createdAt-a.createdAt).slice(0,20)){
 const line=el('div',null,'data-row');line.append(el('span',`${row.kind} · ${row.entries.length} 项 · ${labels[row.status]||row.status}`),el('small',row.kind==='清理'?`已实际释放 ${bytes(row.releasedBytes)}`:`预算已计入 ${bytes(row.spentBytes)} / ${bytes(row.maxBytes)}`));if(row.kind==='补存'&&['queued','partial','running'].includes(row.status))line.append(button('取消请求',async()=>{await post(`/requests/${row.id}/cancel`,{});await history();},!summary.writable));box.append(line);
 }if(!box.children.length)box.append(el('p','尚无手动请求。','caption'));
}
async function detail(entry){
 const sequence=++detailSequence,box=root.querySelector('[data-detail]');
 box.replaceChildren(el('h3',entry.key),el('p','正在读取历史记录…','caption'));
 entry=await get(`/entries/${entry.id}`);if(sequence!==detailSequence)return;
 box.replaceChildren(el('h3',entry.key),el('p',`${entry.region.toUpperCase()} · ${bytes(entry.size)} · ${labels[entry.status]||entry.status}`),el('p',`首次检测 ${date(entry.observedAt)} · 按容量 FIFO，无时间到期`));
 box.append(el('p','原件由本地工具直接从 R2 同步。历史内容、解包和版本比较在本地历史库查看。','caption'));
 if(entry.previousEntryId)box.append(button('查看前一版本记录',()=>detail({id:entry.previousEntryId})));
 if(entry.change==='removed')box.append(el('p',entry.previousEntryId?'移除前内容关联到前一版本；能否查看取决于本地是否已接收原件。':'此前原件未建立版本关联，保留目录证据。','caption'));
 if(entry.error)box.append(el('p','捕获状态：'+entry.error));
 const history=await get(`/history/${entry.id}`);if(sequence!==detailSequence)return;
 box.append(el('h4','历史版本'));
 for(const row of history.entries)box.append(button(`${date(row.observedAt)} · ${row.change||'基线'} · ${labels[row.status]||row.status}`,()=>detail(row)));
}
async function reload(){
 if(busy){pendingReload=true;return;}busy=true;
 try{summary=await get('/summary');last=Date.now();if(summary.status==='disabled'){root.replaceChildren(el('div','官方更新档案尚未启用。既有网站定时更新照常运行。','notice'));initialized=false;return;}
 if(!initialized){build();initialized=true;}
 root.querySelector('[data-capacity]').textContent=`R2 暂存：${bytes(summary.storedBytes)} · 控制预留 ${bytes(summary.controlReservedBytes)} · 总额度 ${bytes(summary.capacityBytes)} · 按容量 FIFO · 不等待本地接收`;
 const checks=summary.checks.slice(-6).reverse();root.querySelector('[data-checks]').textContent=checks.length?checks.map(c=>`${c.region.toUpperCase()} ${date(c.finishedAt)} · ${c.status}${c.error?' · '+c.error:''}`).join('； '):'尚无检查记录。';
 root.querySelectorAll('[data-write]').forEach(b=>b.disabled=!summary.writable);
 const b=await get(`/batches?region=${region}&limit=100`),qs=new URLSearchParams({region,offset:String(offset),limit:'50',query,status,source:filter,batch,group});
 const d=await get('/entries?'+qs),box=root.querySelector('[data-files]');box.replaceChildren();
 for(const e of d.entries){const row=el('div',null,'archive-file'),check=el('input');check.type='checkbox';check.setAttribute('aria-label',`选择 ${e.key}`);check.checked=selected.has(e.id);check.addEventListener('change',()=>check.checked?selected.add(e.id):selected.delete(e.id));const name=button(e.key,()=>detail(e));name.className='archive-name';row.append(check,name,el('span',labels[e.status]||e.status),el('small',`${bytes(e.size)}`));box.append(row);}
 if(!d.entries.length)box.append(el('p','当前筛选下没有文件。','caption'));
 root.querySelector('[data-page]').replaceChildren(button('上一页',()=>{offset=Math.max(0,offset-50);return reload();},!offset),el('span',` ${d.total?offset+1:0}–${Math.min(offset+50,d.total)} / ${d.total} `),button('下一页',()=>{offset=d.nextOffset;return reload();},d.nextOffset==null));
 const batchSelect=root.querySelector('[data-batch]'),groupSelect=root.querySelector('[data-group]');batchSelect.replaceChildren(new Option('全部批次',''),...b.batches.map(x=>new Option(`${date(x.observedAt)} · ${x.source}`,x.id)));batchSelect.value=batch;
 groupSelect.replaceChildren(new Option('全部活动分组',''),...b.groups.filter(g=>g.region===region).map(g=>new Option(g.name,g.id)));groupSelect.value=group;
 root.querySelector('[data-mode]').value=summary.regions[region].mode;
 await history();
 }finally{busy=false;if(pendingReload){pendingReload=false;await reload();}}
}
function build(){
 root.replaceChildren();const cap=el('div',null,'notice');cap.dataset.capacity='';const msg=el('p',null,'caption');msg.dataset.message='';msg.setAttribute('role','status');const checks=el('p',null,'caption');checks.dataset.checks='';
 const bar=el('div',null,'toolbar');bar.append(select([['global','国际服'],['jp','日服']],region,v=>{region=v;batch='';group='';},'区服'),select([['','全部来源'],['remote_asset','热资源'],['master','Master 数据'],['client_entry','客户端文件']],filter,v=>filter=v,'来源'),select([['','全部状态'],...Object.entries(labels).filter(([k])=>!['queued','running','partial','complete','cancelled','proposed'].includes(k))],status,v=>status=v,'状态'));
 const search=el('input');search.placeholder='搜索文件路径';search.setAttribute('aria-label','搜索文件路径');search.value=query;search.addEventListener('change',()=>{query=search.value;offset=0;reload().catch(showError);});bar.append(search);
 const b=el('select'),g=el('select');b.dataset.batch='';g.dataset.group='';b.setAttribute('aria-label','批次');g.setAttribute('aria-label','活动分组');b.addEventListener('change',()=>{batch=b.value;offset=0;reload().catch(showError);});g.addEventListener('change',()=>{group=g.value;offset=0;reload().catch(showError);});bar.append(b,g);
 const modes=el('select');modes.dataset.mode='';modes.setAttribute('aria-label','归档模式');for(const [v,t] of [['auto','自动保存'],['record','仅记录'],['manual','手动选择']])modes.append(new Option(t,v));const mb=button('更新模式',async()=>{await post('/mode',{region,mode:modes.value,revision:(await get('/summary')).revision});await reload();});mb.dataset.write='';bar.append(modes,mb);
 const ops=el('div',null,'toolbar'),budget=el('input');budget.type='number';budget.min='1';budget.max='2048';budget.value='256';budget.setAttribute('aria-label','补存流量预算 MiB');budget.dataset.budget='';ops.append(el('span','补存预算 MiB'),budget);
 for(const [text,fn] of [['补存选中',save],['清理选中',()=>clean('selected')],['清理本批',()=>clean('batch')],['清理本分组',()=>clean('group')],['清空本服',()=>clean('region')],['清空双服',()=>clean('all')]]){const btn=button(text,fn);btn.dataset.write='';ops.append(btn);}
 const groupForm=el('div',null,'toolbar'),name=el('input');name.placeholder='活动分组名称';name.setAttribute('aria-label','活动分组名称');groupForm.append(name);const create=button('创建并设为当前分组',async()=>{await post('/groups',{region,name:name.value,revision:(await get('/summary')).revision});await reload();});create.dataset.write='';const move=button('将本批移入分组',async()=>{if(!batch)throw new Error('请先选择批次。');await post(`/batches/${batch}/group`,{group:group||null,revision:(await get('/summary')).revision});await reload();});move.dataset.write='';groupForm.append(create,move);
 const confirm=el('div',null,'panel');confirm.dataset.confirm='';const files=el('div',null,'panel');files.dataset.files='';const page=el('div',null,'toolbar');page.dataset.page='';const detail=el('div',null,'panel archive-detail');detail.dataset.detail='';const historyBox=el('div',null,'panel');historyBox.dataset.history='';root.append(cap,checks,bar,groupForm,ops,msg,confirm,files,page,detail,el('h3','补存与清理队列'),el('p','请求等待已启用归档任务的下次检测；归档停用期间不会自动释放空间。','caption'),historyBox);
}
export async function mount(container,request,{force=false}={}){root=container;api=request;if(initialized&&!force&&(Date.now()-last<30000||['INPUT','SELECT'].includes(document.activeElement?.tagName)||root.querySelector('[data-confirm]')?.children.length))return;try{await reload();}catch(e){if(!initialized){root.replaceChildren(el('p','档案暂不可用；其他工作台模块可继续使用。','notice'));const msg=el('p');msg.dataset.message='';root.append(msg);}showError(e);}}
