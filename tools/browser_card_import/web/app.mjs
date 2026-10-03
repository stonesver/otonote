import {MODES, regions, numericValue, mergeObservations} from './model.mjs';
import {isolateGlyphs} from './numeric.mjs';
const $=id=>document.getElementById(id),escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let catalog, queue=[], rows=[], working=false, generation=0, recognitionWorker, ocrWorker, readyPromise, readyReject, pending, timings=[], rowURLs=[];
const catalogPromise=fetch('catalog.json').then(r=>{if(!r.ok)throw Error('卡库加载失败');return r.json();}).then(c=>catalog=c);
const modeOptions=value=>Object.entries(MODES).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${v.label}</option>`).join('');
const setStatus=text=>$('status').textContent=text;
function renderQueue(){
  $('queue').innerHTML=queue.map(q=>`<article><img src="${q.url}" alt="待识别截图"><div><p>${escape(q.name)}</p><select aria-label="${escape(q.name)} 的截图类型" data-queue="${q.id}" ${working?'disabled':''}>${modeOptions(q.mode)}</select></div></article>`).join('');
  $('run').disabled=working||queue.length===0;$('files').disabled=working;$('samples').disabled=working;$('clear').disabled=working;
  $('cancel').hidden=!working;$('progress').hidden=!working;
}
async function addFiles(files,modes=[]){
  if(working)return;
  for(const [i,file] of Array.from(files).entries()){
    if(queue.length>=12){setStatus('一次最多处理 12 张截图');break;}
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024){setStatus('请使用 12 MB 以内的 PNG、JPEG 或 WebP 图片');continue;}
    queue.push({id:crypto.randomUUID(),name:file.name,blob:file,url:URL.createObjectURL(file),mode:modes[i]??$('mode').value});
  }
  renderQueue();
}
$('files').addEventListener('change',e=>{addFiles(e.target.files);e.target.value='';});
$('queue').addEventListener('change',e=>{const q=queue.find(x=>x.id===e.target.dataset.queue);if(q)q.mode=e.target.value;});
$('samples').addEventListener('click',async()=>{
  try{
    await catalogPromise;
    if(!catalog.samples.length){setStatus('当前资源包未包含示例，请选择自己的截图');return;}
    const blobs=await Promise.all(catalog.samples.map(async s=>new File([await fetch(s.url).then(r=>r.blob())],s.name+'.jpg',{type:'image/jpeg'})));
    await addFiles(blobs,catalog.samples.map(s=>s.mode));setStatus('三张示例已加入，点击开始识别。');
  }catch(e){setStatus(e.message);}
});

function bootRecognition(){
  if(!window.isSecureContext||!window.Worker||!window.OffscreenCanvas||!window.createImageBitmap||!window.DecompressionStream)throw Error('浏览器缺少识别所需能力，请使用新版浏览器，并通过 HTTPS 或本地预览访问');
  if(readyPromise)return readyPromise;
  recognitionWorker=new Worker('worker.js');
  readyPromise=new Promise((resolve,reject)=>{
    readyReject=reject;
    recognitionWorker.onerror=e=>{reject(Error(e.message||'识别引擎启动失败'));pending?.reject(Error('识别引擎异常'));};
    recognitionWorker.onmessage=({data})=>{
      if(data.type==='progress')setStatus(data.message);
      if(data.type==='ready'){timings.push(`匹配引擎初始化 ${(data.initMs/1000).toFixed(2)} 秒；索引 ${(data.indexBytes/1048576).toFixed(2)} MiB`);resolve();}
      if(data.type==='row'&&pending?.id===data.id)pending.rows.push(data);
      if(data.type==='complete'&&pending?.id===data.id){const current=pending;pending=null;current.resolve({rows:current.rows,matchMs:data.matchMs});}
      if(data.type==='error'){reject(Error(data.message));pending?.reject(Error(data.message));pending=null;}
    };
    recognitionWorker.postMessage({type:'init'});
  });
  return readyPromise;
}
async function bootOCR(token){
  if(ocrWorker)return;
  const start=performance.now(),base=new URL('.',location.href).href;
  const created=await Tesseract.createWorker('eng',1,{workerPath:base+'vendor/worker.min.js',corePath:base+'vendor/core',langPath:base+'vendor/lang',workerBlobURL:false,logger:m=>{if(token===generation&&m.status==='loading language traineddata')setStatus('首次加载数字识别模型…');}});
  if(token!==generation){await created.terminate();throw Error('已取消');}
  ocrWorker=created;
  await ocrWorker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7',user_defined_dpi:'300'});
  timings.push(`数字引擎初始化 ${((performance.now()-start)/1000).toFixed(2)} 秒`);
}
async function readNumber(blob,mode){
  const bitmap=await createImageBitmap(blob),training=mode==='member-training';
  const sx=training?35:29,sw=training?17:48,sh=28;
  const source=document.createElement('canvas');source.width=sw;source.height=sh;
  const sourceCtx=source.getContext('2d',{willReadFrequently:true});sourceCtx.drawImage(bitmap,sx,bitmap.height-30,sw,sh,0,0,sw,sh);bitmap.close();
  const pixels=sourceCtx.getImageData(0,0,sw,sh).data;
  const attempts=[];
  for(const threshold of [185,205,165]){
    const glyphs=isolateGlyphs(pixels,sw,sh,mode,threshold);
    if(!glyphs){attempts.push({value:null,text:'',confidence:0});continue;}
    const small=document.createElement('canvas');small.width=glyphs.width;small.height=glyphs.height;
    small.getContext('2d').putImageData(new ImageData(glyphs.data,glyphs.width,glyphs.height),0,0);
    const canvas=document.createElement('canvas');canvas.width=small.width*5+40;canvas.height=small.height*5+40;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(small,20,20,small.width*5,small.height*5);
    const result=await ocrWorker.recognize(canvas),text=result.data.text.trim(),confidence=result.data.confidence;
    const value=text.length===glyphs.count?numericValue(text,mode,confidence):null;
    attempts.push({value,text,confidence});
    if(threshold===185&&value!==null&&confidence>=80)return {value,text,confidence};
  }
  const reliable=attempts.filter(a=>a.value!==null&&a.confidence>=80);
  const agreed=reliable.filter(a=>attempts.filter(b=>b.value===a.value).length>=2);
  if(agreed.length&&new Set(reliable.map(a=>a.value)).size===1)return agreed[0];
  const best=attempts.sort((a,b)=>b.confidence-a.confidence)[0];return {...best,value:null};
}
function cleanupRows(){rowURLs.forEach(URL.revokeObjectURL);rowURLs=[];rows=[];$('results').replaceChildren();}
async function run(){
  if(working||!queue.length)return;
  working=true;const token=++generation;cleanupRows();timings=[];$('progress').value=0;renderQueue();$('results-section').hidden=true;
  const started=performance.now();
  try{
    await catalogPromise;
    await bootRecognition();if(token!==generation)return;
    await bootOCR(token);if(token!==generation)return;
    for(const [imageIndex,item] of queue.entries()){
      if(token!==generation)return;
      const bitmap=await createImageBitmap(item.blob);
      if(bitmap.width*bitmap.height>20_000_000){bitmap.close();throw Error('图片超过 2000 万像素，请缩小后重试');}
      let boxes;
      try{boxes=regions(bitmap.width,bitmap.height,item.mode);}catch(e){bitmap.close();throw e;}
      const result=await new Promise((resolve,reject)=>{
        pending={id:item.id,resolve,reject,rows:[]};recognitionWorker.postMessage({type:'recognize',id:item.id,bitmap,regions:boxes,kind:MODES[item.mode].kind},[bitmap]);
      });
      const ocrStart=performance.now();
      for(const [i,resultRow] of result.rows.entries()){
        if(token!==generation)return;
        setStatus(`${item.name}：读取数字 ${i+1} / ${result.rows.length}`);
        const number=await readNumber(resultRow.crop,item.mode);if(token!==generation)return;
        const url=URL.createObjectURL(resultRow.crop);rowURLs.push(url);
        const kind=MODES[item.mode].kind,best=resultRow.match.candidates[0];
        rows.push({key:`${item.id}:${i}`,imageName:item.name,index:i,kind,mode:item.mode,crop:url,
          cardId:resultRow.match.accepted?best.id:'',selected:resultRow.match.accepted,candidates:resultRow.match.candidates,
          observations:{[kind==='member'?'awakeningStars':'supportPetals']:resultRow.badge,[item.mode==='member-training'?'training':'level']:number.value},ocr:number});
        $('progress').value=((imageIndex+(i+1)/result.rows.length)/queue.length)*100;
      }
      timings.push(`${item.name}：${result.rows.length} 格；匹配 ${(result.matchMs/1000).toFixed(2)} 秒；数字 ${((performance.now()-ocrStart)/1000).toFixed(2)} 秒`);
      renderResults();
    }
    timings.push(`本批总计 ${((performance.now()-started)/1000).toFixed(2)} 秒`);setStatus('识别完成。请核对卡面与养成数字，再导出草稿。');
  }catch(e){if(token===generation){stopEngines(e.message);setStatus(`识别未完成：${e.message}`);}}
  finally{if(token===generation){working=false;renderQueue();renderResults();updateMetrics();}}
}
function fieldInputs(row){
  const fields=row.kind==='support'?[['level','等级'],['supportPetals','突破花瓣']]:[['level','等级'],['training','特训'],['awakeningStars','觉醒星数']];
  return fields.map(([field,label])=>`<label>${label}<input type="number" inputmode="numeric" min="1" max="${field==='level'?100:5}" data-field="${field}" value="${row.observations[field]??''}" placeholder="未读取" aria-label="${escape(row.imageName)} 第 ${row.index+1} 格 ${label}"></label>`).join('');
}
function renderResults(){
  $('results-section').hidden=!rows.length;
  $('results').innerHTML=rows.map(row=>{
    const card=catalog.cards.find(c=>c.id===row.cardId),options=catalog.cards.filter(c=>c.kind===row.kind);
    return `<article class="card ${card?'':'review'}" data-key="${row.key}"><div class="card-header"><label><input type="checkbox" data-select ${row.selected?'checked':''}>加入草稿</label><span>${escape(row.imageName)} · ${row.index+1}</span></div><div class="pictures"><figure><img src="${row.crop}" alt="截图卡面"><figcaption>截图</figcaption></figure><figure>${card?`<img src="${card.thumbnail}" alt="${escape(card.name)}">`:'<div class="unknown">未找到可靠匹配</div>'}<figcaption>卡库</figcaption></figure></div><label>对应卡牌<select data-card><option value="">待确认，请选择</option>${options.map(c=>`<option value="${c.id}" ${c.id===row.cardId?'selected':''}>${escape(c.name)}</option>`).join('')}</select></label><div class="fields">${fieldInputs(row)}</div><small>${row.cardId?'已匹配，可手动更正。':'低置信度未采用；可能缺少该卡资源。'} 数字识别：${escape(row.ocr.text||'未读出')}（${row.ocr.confidence}）</small><details><summary>匹配依据</summary>${row.candidates.map(c=>`${escape(c.name)}：${c.inliers} 个一致特征点`).join('<br>')}</details></article>`;
  }).join('');updateSummary();
}
function updateSummary(){
  try{
    const draft=mergeObservations(rows,catalog),matched=rows.filter(r=>r.cardId).length;
    $('summary').textContent=`${rows.length} 个卡片区域 · ${matched} 个已匹配或已选择 · 合并后 ${draft.cards.length} 张卡`;
    $('conflicts').textContent=draft.conflicts.length?`有 ${draft.conflicts.length} 个养成字段冲突，请修改数字或取消勾选冲突截图后导出。`:'';
    $('export').disabled=working||draft.cards.length===0||draft.conflicts.length>0;
  }catch(e){$('conflicts').textContent=e.message;$('export').disabled=true;}
}
function editRow(e){
  const article=e.target.closest('[data-key]'),row=rows.find(r=>r.key===article?.dataset.key);if(!row)return;
  if(e.target.hasAttribute('data-select'))row.selected=e.target.checked;
  if(e.target.hasAttribute('data-card')){row.cardId=e.target.value;row.selected=!!row.cardId;renderResults();return;}
  if(e.target.dataset.field)row.observations[e.target.dataset.field]=e.target.value===''?null:Number(e.target.value);
  updateSummary();
}
$('results').addEventListener('change',editRow);
$('results').addEventListener('input',e=>{if(e.target.dataset.field)editRow(e);});
function updateMetrics(){
  const resources=performance.getEntriesByType('resource').filter(r=>r.name.startsWith(location.origin));
  const knownBytes=resources.reduce((n,r)=>n+(r.transferSize||0),0);
  $('metrics').textContent=timings.join('\n')+`\n主页面可见传输量 ${(knownBytes/1048576).toFixed(2)} MiB（不含 Worker 内部请求；完整体积见构建清单）`;
}
$('run').addEventListener('click',run);
function stopEngines(reason){
  readyReject?.(Error(reason));readyReject=null;pending?.reject(Error(reason));pending=null;
  recognitionWorker?.terminate();recognitionWorker=null;readyPromise=null;
  const old=ocrWorker;ocrWorker=null;old?.terminate().catch(()=>{});
}
$('cancel').addEventListener('click',()=>{
  generation++;stopEngines('已取消');working=false;renderQueue();renderResults();setStatus('已取消。已经完成的结果保留，可以重新识别。');
});
$('clear').addEventListener('click',()=>{queue.forEach(q=>URL.revokeObjectURL(q.url));queue=[];cleanupRows();renderQueue();$('results-section').hidden=true;setStatus('已清空，可选择新的截图。');});
$('export').addEventListener('click',()=>{
  try{
    const draft=mergeObservations(rows,catalog);if(!draft.cards.length||draft.conflicts.length)throw Error('请先处理冲突并选择卡牌');
    const blob=new Blob([JSON.stringify(draft,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='otonote-image-observations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus('已导出观察草稿，原有卡库没有改变。');
  }catch(e){setStatus(e.message);}
});
catalogPromise.catch(e=>setStatus(e.message));
