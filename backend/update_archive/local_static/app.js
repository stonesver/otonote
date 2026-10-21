const $=id=>document.getElementById(id), el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const labels={added:'新增',modified:'修改',removed:'移除',metadata_changed:'目录变化'},date=n=>new Date(n*1000).toLocaleString('zh-CN');
let offset=0, selected=null, comparison=null, sequence=0;
async function api(path,options={}){const r=await fetch('/api'+path,options);const d=await r.json();if(!r.ok)throw new Error(d.error||d.detail||'请求失败');return d;}
function error(e){$('message').textContent=e.message;}
function button(text,fn){const b=el('button',text);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){error(e);}finally{b.disabled=false;}};return b;}
async function load(){const qs=new URLSearchParams({query:$('query').value,region:$('region').value,removed:String($('removed').checked),offset:String(offset)}),d=await api('/entries?'+qs);$('entries').replaceChildren();for(const e of d.entries){const b=button(e.key,()=>detail(e.id));b.className='entry';b.append(el('small',`${e.region} · ${labels[e.change]||'基线'} · ${date(e.observedAt)}`));$('entries').append(b);}if(!d.entries.length)$('entries').append(el('p','暂无记录。请先运行本地同步命令。'));$('pages').replaceChildren();if(offset)$('pages').append(button('上一页',()=>{offset-=100;return load();}));$('pages').append(el('span',`${d.total?offset+1:0}–${Math.min(offset+100,d.total)} / ${d.total}`));if(offset+100<d.total)$('pages').append(button('下一页',()=>{offset+=100;return load();}));}
async function detail(id){const ticket=++sequence;selected=id;const d=await api('/entries/'+id);if(ticket!==sequence)return;const e=d.entry,box=$('detail');box.replaceChildren(el('h2',e.key),el('p',`${labels[e.change]||'基线'} · 首次检测 ${date(e.observedAt)}`));
 box.append(el('p',d.localAvailable?(e.change==='removed'?'移除前的原件已保存在本地。':'此版本原件已保存在本地。'):'本地缺少此版本原件。若 R2 已淘汰，则只能查看目录记录。'));
 const actions=el('div');actions.className='actions';box.append(actions);
 if(d.localAvailable){const a=el('a',e.change==='removed'?'下载移除前原件':'下载此版本原件');a.href='/api/entries/'+id+'/raw';actions.append(a,button('解包并分析',async()=>{$('message').textContent='正在本地分析…';await api('/entries/'+id+'/analyze',{method:'POST',headers:{'X-Archive-Local':'1'}});$('message').textContent='分析完成';await detail(id);}));}
 actions.append(button('设为对照版本',()=>{comparison=id;$('message').textContent='已选对照：'+e.key;}));if(comparison&&comparison!==id)actions.append(button('与对照版本比较',async()=>{const r=await api(`/compare/${comparison}/${id}`);showComparison(box,r);}));
 if(d.analysis){if(d.analysis.previewError)box.append(el('p','预览未完成：'+d.analysis.previewError));box.append(el('p',d.analysis.inventoryComplete?'对象索引扫描完整。':'对象索引不完整，不据此判定内容移除。'));for(const p of d.analysis.previews){const url=`/api/entries/${id}/preview/${encodeURIComponent(p.path)}`;box.append(el('p',p.name));if(p.mime.startsWith('image/')){const im=el('img');im.src=url;im.alt=p.name||e.key;im.loading='lazy';box.append(im);}else if(p.mime.startsWith('audio/')){const a=el('audio');a.controls=true;a.preload='none';a.src=url;box.append(a);}else{const section=el('details');section.append(el('summary',p.truncated?'展开文本（已截断）':'展开文本'));let loaded=false;section.ontoggle=async()=>{if(!section.open||loaded)return;try{const r=await fetch(url);if(!r.ok)throw new Error('读取失败');section.append(el('pre',await r.text()));loaded=true;}catch(e){error(e);}};box.append(section);}}}
 box.append(el('h3','此资源的历史版本'));for(const v of d.versions)box.append(button(`${date(v.observedAt)} · ${labels[v.change]||'基线'}`,()=>detail(v.id)));
}
$('filters').onsubmit=e=>{e.preventDefault();offset=0;load().catch(error);};load().catch(error);

function showComparison(box,r){
 const panel=el('section');panel.append(el('h3','版本比较'));box.append(panel);
 if(!r.complete){panel.append(el('p','对象扫描不完整，无法可靠判断移除内容。'));return;}
 for(const [label,key] of [['可能移除','removedCandidates'],['可能新增','addedCandidates'],['可能修改','modifiedCandidates']]){
  const rows=r[key]||[];panel.append(el('p',`${label}：${rows.length} 项`));
  if(rows.length){const list=el('ul');for(const item of rows){const row=item.before||item;list.append(el('li',`${row.name}（${row.type}）`));}panel.append(list);}
 }
 if(r.unmatchedBefore||r.unmatchedAfter)panel.append(el('p',`尚未匹配对象：旧版 ${r.unmatchedBefore}，新版 ${r.unmatchedAfter}。`));
 if(r.note)panel.append(el('p',r.note));
 if(r.textDiff!==undefined){panel.append(el('h4',r.textTruncated?'文本差异（有截断）':'文本差异'),el('pre',r.textDiff||'文本相同'));}
}
