import {artifact,snapshot} from '../../runtime/content.mjs';
import {currentServerContext,gameServer} from '../game-servers.mjs';
import {MODES} from './observations.mjs';
import {createRecognitionEngine} from './engine.mjs';
import {assertRecognitionContext,recognitionDraft,previewRecognitionImport,fieldsFor,labels} from './inventory.mjs';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const options=(items,value)=>items.map(([id,label])=>`<option value="${escape(id)}" ${id===value?'selected':''}>${escape(label)}</option>`).join('');

export function setupScreenshotImport(workbench,{manager,getInventory,commit}){
  const dialog=workbench.querySelector('[data-screenshot-dialog]'),q=s=>dialog.querySelector(`[data-shot-${s}]`);
  let manifest,featuresUrl,context,queue=[],observations=[],draft=[],engine,generation=0,working=false,preparing,prepared=false,detecting=false;
  const sourceReleaseId=workbench.data.formalRules.sourceReleaseId;
  const status=text=>q('status').textContent=text;
  function guard(){
    const current=currentServerContext();
    if(current.region!==context.region||current.serverId!==context.serverId)throw Error('当前区服已变化，请关闭后重新导入');
    assertRecognitionContext(manifest,current,sourceReleaseId);
  }
  function controls(){
    q('run').disabled=working||detecting||!prepared||!queue.length||queue.some(i=>!i.mode);q('files').disabled=working;
    q('run').textContent=working?'正在识别…':detecting?'正在判断截图类型…':prepared?'开始识别':'等待工具准备';
    q('clear').disabled=working||detecting;q('stop').hidden=!working;
    q('max').disabled=working;q('reset-skills').disabled=working;
    for(const select of q('queue').querySelectorAll('select'))select.disabled=working;
  }
  function renderQueue(){
    q('queue').innerHTML=queue.map(item=>`<article><img src="${item.url}" alt="待识别截图"><span>${escape(item.file.name)}</span><label>截图类型<select data-quick-native data-queue="${item.id}" aria-label="${escape(item.file.name)} 的截图类型"><option value="">${item.detecting?'正在自动判断…':'未确定，请选择'}</option>${options(Object.entries(MODES).map(([id,m])=>[id,m.label]),item.mode)}</select></label><small>${escape(item.note??'等待自动识别类型')}</small></article>`).join('');controls();
  }
  function preview(){
    try{guard();return previewRecognitionImport({manager,inventory:getInventory(),rows:draft,manifest,context,sourceReleaseId});}
    catch(error){return {errors:[error.message],changes:[],inventory:null};}
  }
  function validate(){
    const result=preview();q('apply').disabled=working||!result.inventory;
    q('errors').textContent=result.errors.slice(0,8).join('\n')+(result.errors.length>8?`\n另有 ${result.errors.length-8} 项需确认`:'');
    q('apply').textContent=`确认合并 ${result.changes.length} 张卡到卡库`;
  }
  function renderDraft(){
    const inventory=getInventory(),cards=new Map(manifest.cards.map(c=>[c.id,c]));
    q('merged').innerHTML=draft.map(row=>{
      const old=inventory.growth[row.id],name=cards.get(row.id)?.name??row.id;
      return `<article data-id="${escape(row.id)}"><label><input type="checkbox" data-selected ${row.selected?'checked':''}>${escape(name)} · ${old?'更新已有卡':'新增'} · ${row.sources.length} 处截图</label><div class="screenshot-fields">${fieldsFor(row.kind).map(field=>{
        const conflict=row.conflicts.find(c=>c.field===field),isSkill=field==='skillLevel'||field==='gekisouSkillLevel';
        const fallback=old?.[field]??(isSkill?1:'');
        const label=row.kind==='support'&&field==='rank'?'突破花瓣':labels[field];
        return `<label data-conflict="${!!conflict}">${label}<input type="number" inputmode="numeric" min="1" max="${field==='level'?100:5}" data-field="${field}" value="${row.patch[field]??(isSkill?fallback:'')}" placeholder="${conflict?'请选择':fallback===''?'待补齐':`保留 ${fallback}`}" aria-label="${escape(name)} ${label}"><small>${conflict?`截图冲突：${[...new Set(conflict.values)].join(' / ')}，请填写确认值`:old?`原值 ${old[field]}`:isSkill?'默认 1 级':'识别结果，可修改'}</small></label>`;
      }).join('')}</div></article>`;
    }).join('');validate();
  }
  function merge(){
    const previous=new Map(draft.map(r=>[r.id,r]));
    draft=recognitionDraft(observations,manifest);
    for(const row of draft){const old=previous.get(row.id);if(old){row.selected=old.selected;row.edits=old.edits;for(const f of new Set([...(old.edits??[]),'skillLevel','gekisouSkillLevel'])){if(old.patch[f]!==undefined)row.patch[f]=old.patch[f];else if(old.edits?.has(f))delete row.patch[f];}}}
    renderDraft();
  }
  function renderObservations(){
    const cards=[...new Map(manifest.cards.map(c=>[c.id,c])).values()];
    q('review').hidden=!observations.length;
    q('observations').innerHTML=observations.map(row=>`<article data-key="${row.key}"><img src="${row.url}" alt="${escape(row.imageName)} 第 ${row.index+1} 格">${row.cardId?`<img src="${escape(cards.find(c=>c.id===row.cardId)?.thumbnail??'')}" alt="匹配的卡库卡面" loading="lazy">`:''}<small>${row.cardId?'已匹配，可更正':'未可靠匹配，默认不导入'}</small><label>对应卡牌<select data-card><option value="">不导入 / 待确认</option>${options(cards.filter(c=>c.kind===row.kind).map(c=>[c.id,c.name]),row.cardId)}</select></label></article>`).join('');
    merge();
  }
  function clearResults(){observations.forEach(r=>URL.revokeObjectURL(r.url));observations=[];draft=[];q('observations').replaceChildren();q('merged').replaceChildren();q('review').hidden=true;q('apply').disabled=true;}
  function stop(){generation++;engine?.dispose();engine=null;preparing=null;prepared=false;detecting=false;working=false;controls();if(manifest&&draft.length)validate();}
  function clear(){stop();queue.forEach(i=>URL.revokeObjectURL(i.url));queue=[];clearResults();renderQueue();}
  function preparation(update){
    const step=dialog.querySelector(`[data-shot-stage="${update.stage}"]`);
    if(step){step.dataset.ready=String(!!update.complete);step.querySelector('small').textContent=update.complete?'已就绪':'准备中';}
    q('preparation-label').textContent=update.label??'正在准备下一项…';
    if(Number.isFinite(update.progress))q('progress').value=update.progress;else q('progress').removeAttribute('value');
  }
  function prepare(){
    if(preparing)return preparing;
    const token=generation;prepared=false;q('retry').hidden=true;q('progress').hidden=false;
    q('preparation-title').textContent='正在准备识别工具';
    for(const step of dialog.querySelectorAll('[data-shot-stage]')){step.dataset.ready='false';step.querySelector('small').textContent='等待准备';}
    engine=createRecognitionEngine({manifest,featuresUrl,onProgress:text=>{if(token===generation&&working)status(text);},onPreparation:update=>{if(token===generation&&!prepared)preparation(update);}});
    preparing=engine.initialize().then(()=>{
      if(token!==generation)return;
      prepared=true;q('preparation-title').textContent='识别工具已就绪';q('progress').hidden=true;
      q('preparation-label').textContent='图片在本机处理；可以开始识别。';controls();
    }).catch(error=>{
      if(token===generation){engine?.dispose();engine=null;preparing=null;prepared=false;q('retry').hidden=false;q('progress').hidden=true;q('preparation-title').textContent='准备未完成';q('preparation-label').textContent=error.message;controls();}
      throw error;
    });
    return preparing;
  }
  async function detectQueue(){
    if(detecting||working||!manifest)return;
    const token=generation;detecting=true;controls();
    try{
      await prepare();
      for(const item of queue){
        if(token!==generation)return;
        if(item.mode||item.checked)continue;
        item.detecting=true;renderQueue();
        try{const mode=await engine.detect(item.file,item.id);if(token!==generation)return;
          if(!item.mode){item.mode=mode??'';item.note=mode?'已自动识别，可手动更正':'无法可靠判断，请选择截图类型';}
        }catch(error){if(token!==generation)return;item.note=`无法判断：${error.message}，请手动选择`;}
        item.checked=true;item.detecting=false;renderQueue();
      }
    }catch{}finally{if(token===generation){detecting=false;controls();}}
  }
  async function open(){
    clear();manifest=null;q('retry').hidden=true;q('progress').hidden=false;q('progress').removeAttribute('value');q('preparation-title').textContent='正在检查识别资源';context=currentServerContext();dialog.showModal();q('context').textContent=`目标卡库：${gameServer(context.serverId)?.label??'尚未选择区服'}`;
    dialog.querySelector('h2').focus();status('正在检查当前卡库识别资源…');controls();
    const token=++generation;
    try{
      const [index,content]=await Promise.all([artifact('supplemental/card-recognition.json',{optional:true}),snapshot()]);
      if(token!==generation)return;
      if(!index)throw Error('当前内容版本尚未提供截图识别索引');
      assertRecognitionContext(index,context,sourceReleaseId);
      if(index.featuresPath!=='recognition/features.bin.gz'||!Number.isInteger(index.decodedBytes)||index.decodedBytes>128*1024*1024)throw Error('识别索引格式无效');
      manifest=index;featuresUrl=new URL(content.root+index.featuresPath,location.origin).href;
      status('选择截图后自动判断类型；判断不确定时，可在每张图下方更正。');controls();prepare().then(detectQueue).catch(()=>{});
    }catch(error){if(token===generation){status(error.message);q('preparation-title').textContent='识别资源暂不可用';q('progress').hidden=true;q('preparation-label').textContent='请刷新页面后重试';controls();}}
  }
  q('files').addEventListener('change',event=>{
    if(working)return;
    for(const file of event.target.files){
      if(queue.length>=12){status('一次最多识别 12 张截图');break;}
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024){status('请使用 12 MB 以内的 PNG、JPEG 或 WebP 图片');continue;}
      queue.push({id:crypto.randomUUID(),file,url:URL.createObjectURL(file),mode:'',checked:false});
    }
    event.target.value='';renderQueue();detectQueue();
  });
  q('queue').addEventListener('change',e=>{if(!working){const row=queue.find(i=>i.id===e.target.dataset.queue);if(row){row.mode=e.target.value;row.note='手动选择';controls();}}});
  q('run').addEventListener('click',async()=>{
    if(working)return;
    if(!prepared||detecting||queue.some(i=>!i.mode))return;
    clearResults();working=true;controls();const token=generation;
    try{
      guard();await prepare();
      for(const item of queue){
        if(token!==generation)return;
        await engine.recognize(item.file,item.mode,item.id,row=>{if(token===generation)observations.push({...row,url:URL.createObjectURL(row.crop)});});
      }
      if(token===generation){renderObservations();status(`识别完成：${observations.length} 个完整区域，合并为 ${draft.length} 张卡。请核对后确认导入。`);q('matches').open=observations.some(r=>!r.cardId);}
    }catch(error){if(token===generation){clearResults();engine?.dispose();engine=null;preparing=null;prepared=false;q('retry').hidden=false;q('preparation-title').textContent='需要重新准备';status(`识别未完成：${error.message}。请重新准备后重试。`);}}
    finally{if(token===generation){working=false;controls();if(draft.length)validate();}}
  });
  q('stop').addEventListener('click',()=>{stop();clearResults();status('已取消，卡库未修改。正在重新准备…');prepare().catch(()=>{});});
  q('clear').addEventListener('click',()=>{queue.forEach(i=>URL.revokeObjectURL(i.url));queue=[];clearResults();renderQueue();status('已清空，可以选择新的截图。');});
  q('retry').addEventListener('click',()=>{prepare().then(detectQueue).catch(()=>{});});
  q('observations').addEventListener('change',e=>{
    const row=observations.find(r=>r.key===e.target.closest('[data-key]')?.dataset.key);
    if(row&&e.target.hasAttribute('data-card')){row.cardId=e.target.value;row.selected=!!row.cardId;renderObservations();}
  });
  q('merged').addEventListener('input',e=>{
    const row=draft.find(r=>r.id===e.target.closest('[data-id]')?.dataset.id);if(!row)return;
    if(e.target.hasAttribute('data-selected'))row.selected=e.target.checked;
    if(e.target.dataset.field){(row.edits??=new Set()).add(e.target.dataset.field);if(e.target.value==='')delete row.patch[e.target.dataset.field];else row.patch[e.target.dataset.field]=Number(e.target.value);}
    validate();
  });
  q('max').addEventListener('click',()=>{for(const row of draft)if(row.selected&&row.kind==='member')Object.assign(row.patch,{skillLevel:5,gekisouSkillLevel:5});renderDraft();});
  q('reset-skills').addEventListener('click',()=>{for(const row of draft)if(row.selected&&row.kind==='member'){delete row.patch.skillLevel;delete row.patch.gekisouSkillLevel;}renderDraft();});
  q('apply').addEventListener('click',()=>{
    if(working)return;
    const result=preview();if(!result.inventory){validate();return;}
    try{commit(result.inventory,`已从截图合并 ${result.changes.length} 张卡，可撤销上次修改。`);dialog.close();}
    catch(error){status(`未保存：${error.message}`);}
  });
  dialog.querySelectorAll('[data-shot-close]').forEach(b=>b.addEventListener('click',()=>dialog.close()));
  dialog.addEventListener('close',clear);
  const observer=new MutationObserver(()=>{if(!workbench.isConnected){clear();observer.disconnect();}});
  observer.observe(document.body,{childList:true,subtree:true});
  return {open};
}
