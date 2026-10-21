const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const labels = {added:'新增', modified:'修改', removed:'移除', metadata_changed:'目录变化', baseline:'基线'};
const states = {complete:'分析完成', pending:'待分析', running:'正在分析', partial:'分析不完整', failed:'需重试', unavailable:'本地无原件'};
const regions = {global:'国际服', jp:'日服'};
const date = n => new Date(n * 1000).toLocaleString('zh-CN');
const shortName = name => name.replace(/[_-][a-f0-9]{32}(?=\.|$)/g, '');
let offset = 0, selected = null, comparison = null, sequence = 0, listSequence = 0, loading = false;
let detailStamp = null;
async function api(path, options = {}) {
 const r = await fetch('/api' + path, options), d = await r.json();
 if (!r.ok) throw new Error(d.error || d.detail || '请求失败');
 return d;
}
function error(e) { $('message').textContent = e.message === 'local_library_busy' ? '后台正在同步或分析，请稍后重试。' : e.message; }
function button(text, fn) {
 const b = el('button', text); b.type = 'button';
 b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { error(e); } finally { b.disabled = false; } };
 return b;
}
function previewUrl(id, path) { return `/api/entries/${id}/preview/${encodeURIComponent(path)}`; }
function markSelected() { for (const b of $('entries').children) { b.classList.toggle('selected', b.dataset.id === selected); b.setAttribute('aria-pressed', String(b.dataset.id === selected)); } }
async function load() {
 const ticket = ++listSequence, local = $('scope').value === 'local', pageOffset = offset;
 const qs = new URLSearchParams({query:$('query').value, region:$('region').value, removed:String($('removed').checked), local:String(local), offset:String(pageOffset)});
 loading = true;
 try {
  const d = await api('/entries?' + qs); if (ticket !== listSequence) return;
  const stats = d.summary;
  $('saved-count').textContent = stats.saved; $('complete-count').textContent = stats.complete;
  $('pending-count').textContent = stats.pending + stats.running + stats.partial + stats.failed;
  $('pending-label').textContent = stats.running ? '后台分析中' : '待处理 / 需重试';
  $('sync-state').textContent = stats.lastSync ? '最近同步 ' + date(stats.lastSync) : '等待首次同步';
  $('result-count').textContent = d.total.toLocaleString() + ' 条';
  $('entries').replaceChildren();
  for (const e of d.entries) {
   const b = button(null, () => detail(e.id)); b.className = 'entry'; b.dataset.id = e.id; b.title = e.key;
   const icon = el('span', null, 'entry-icon');
   if (e.thumbnail) { const img = el('img'); img.src = previewUrl(e.id, e.thumbnail); img.alt = ''; img.loading = 'lazy'; icon.append(img); }
   else icon.textContent = e.key.endsWith('.bundle') ? 'BNDL' : 'FILE';
   const copy = el('span', null, 'entry-copy'), meta = el('span', null, 'entry-meta');
   meta.append(el('span', regions[e.region] || e.region), el('span', labels[e.change] || '基线'), el('span', states[e.analysisStatus], 'badge ' + e.analysisStatus));
   copy.append(el('span', shortName(e.key), 'entry-name'), meta); b.append(icon, copy); $('entries').append(b);
  }
  markSelected();
  if (!d.entries.length) $('entries').append(el('p', '当前条件下没有记录。可调整筛选，或等待下次同步。', 'note'));
  $('pages').replaceChildren();
  if (pageOffset) $('pages').append(button('上一页', () => { offset -= 100; return load(); }));
  $('pages').append(el('span', `${d.total ? pageOffset + 1 : 0}–${Math.min(pageOffset + 100, d.total)} / ${d.total} 条${local ? '本地记录' : '索引记录'}`));
  if (pageOffset + 100 < d.total) $('pages').append(button('下一页', () => { offset += 100; return load(); }));
 } finally { if (ticket === listSequence) loading = false; }
}
async function detail(id, quiet = false) {
 const ticket = ++sequence; selected = id; markSelected();
 const d = await api('/entries/' + id); if (ticket !== sequence) return;
 const stamp = JSON.stringify([id, d.analysis?.directory, d.analysisJob, d.localAvailable]);
 if (quiet && stamp === detailStamp) return;
 detailStamp = stamp;
 const e = d.entry, box = $('detail');
 const status = !d.localAvailable ? 'unavailable' : d.analysisJob?.status || (d.analysis ? (d.analysis.inventoryComplete && !d.analysis.previewError ? 'complete' : 'partial') : 'pending');
 const meta = el('div', null, 'detail-meta');
 meta.append(el('span', regions[e.region]), el('span', labels[e.change] || '基线'), el('span', date(e.observedAt)), el('span', states[status], 'badge ' + status));
 box.replaceChildren(meta, el('h2', shortName(e.key)));
 const path = el('details'); path.append(el('summary', '完整文件名'), el('div', e.key, 'full-path')); box.append(path);
 box.append(el('p', d.localAvailable ? (e.change === 'removed' ? '移除前的原件已留存在本机。' : '此版本原件已留存在本机。') : '本地缺少此版本原件。若 R2 已淘汰，只能查看索引记录。', 'note'));
 if (status === 'pending') box.append(el('p', '下次同步后会自动解包分析，无需逐个操作。', 'note'));
 if (status === 'running') box.append(el('p', '正在后台解包，完成后预览会自动更新。', 'note'));
 if (status === 'failed') box.append(el('p', '分析失败，后台稍后重试。也可以立即重试；原件和已有分析仍然保留。', 'note'));
 if (status === 'partial') box.append(el('p', '部分内容未能解析。解码材料补齐后自动重试，也可手动重新分析。', 'note'));
 const actions = el('div', null, 'actions'); box.append(actions);
 if (d.localAvailable) {
  const a = el('a', e.change === 'removed' ? '下载移除前原件' : '下载原件'); a.href = '/api/entries/' + id + '/raw'; actions.append(a);
  const retry = button(d.analysis || status === 'failed' ? '重新分析' : '立即分析', async () => {
   $('message').textContent = '正在本地分析…';
   await api('/entries/' + id + '/analyze', {method:'POST', headers:{'X-Archive-Local':'1'}});
   $('message').textContent = '分析结束，结果已更新'; await load(); if (selected === id) await detail(id);
  }); retry.disabled = status === 'running'; actions.append(retry);
 }
 actions.append(button('设为对照版本', () => { comparison = id; $('message').textContent = '已选对照：' + shortName(e.key); }));
 if (comparison && comparison !== id) actions.append(button('比较版本', async () => showComparison(box, await api(`/compare/${comparison}/${id}`))));
 if (d.analysis) {
  box.append(el('h3', '内容预览'));
  if (d.analysis.previewError) box.append(el('p', '部分预览不可用：' + d.analysis.previewError, 'note'));
  box.append(el('p', d.analysis.inventoryComplete ? '对象清单扫描完整，可用于历史版本比较。' : '对象清单不完整，不能据此判断内容移除。', 'note'));
  const grid = el('div', null, 'preview-grid'); box.append(grid);
  for (const p of d.analysis.previews) {
   const url = previewUrl(id, p.path);
   if (p.mime.startsWith('image/')) {
    const figure = el('figure', null, 'preview-card'), img = el('img'); img.src = url; img.alt = p.name || e.key; img.loading = 'lazy';
    figure.append(img, el('figcaption', p.name)); grid.append(figure);
   } else if (p.mime.startsWith('audio/')) {
    const figure = el('figure', null, 'preview-card'), audio = el('audio'); audio.controls = true; audio.preload = 'none'; audio.src = url;
    figure.append(el('figcaption', p.name), audio); grid.append(figure);
   } else {
    const section = el('details'); section.append(el('summary', `${p.name || p.path}${p.truncated ? '（已截断）' : ''}`)); let loaded = false;
    section.ontoggle = async () => { if (!section.open || loaded) return; try { const r = await fetch(url); if (!r.ok) throw new Error('读取失败'); section.append(el('pre', await r.text())); loaded = true; } catch (e) { error(e); } };
    box.append(section);
   }
  }
 }
 box.append(el('h3', '历史版本')); const history = el('div', null, 'history-list'); box.append(history);
 for (const v of d.versions) history.append(button(`${date(v.observedAt)} · ${labels[v.change] || '基线'}`, () => detail(v.id)));
}
function changeFilters() {
 offset = 0;
 $('scope-help').textContent = $('scope').value === 'local' ? '仅显示本机已有原件的记录；完整清单请切换到“全部资源索引”。' : '完整索引包含尚未下载的基线记录；搜索不会触发远端下载。';
 load().catch(error);
}
$('scope').onchange = changeFilters; $('region').onchange = changeFilters; $('removed').onchange = changeFilters;
$('filters').onsubmit = e => { e.preventDefault(); changeFilters(); };
load().catch(error);
setInterval(async () => { if (document.hidden || loading) return; try { await load(); if (selected) await detail(selected, true); } catch (e) { error(e); } }, 20000);

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
