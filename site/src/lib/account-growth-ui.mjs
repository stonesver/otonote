import {currentServerContext} from './game-servers.mjs';
import {growthModifiersForDraft} from './account-growth-import.mjs';

const messages={credentials_rejected:'官方服务提示账号或密码校验未通过。',account_not_found:'官方服务提示账号不存在。',
  verification_required:'需要额外验证，当前工具已停止。',rate_limited:'请求过于频繁，请稍后再试。'};
export function setupAccountGrowthImport(workbench,{getInventory,replaceInventory}) {
  const root=workbench.querySelector('[data-account-growth]');if(!root)return;
  const q=s=>root.querySelector(s),status=q('[data-growth-status]'),fields=q('[data-growth-login-fields]');
  const context=currentServerContext();
  const store=workbench.personalGrowthStore;
  let nonce=null,busy=false,preview=null,undo=null;
  function changed(){if(typeof workbench.commit==='function')workbench.commit();else workbench.refreshInput?.();workbench.dispatchEvent(new CustomEvent('personal-growth-changed'));}
  function clear(){preview=null;q('[data-growth-preview]').hidden=true;q('[data-growth-actions]').hidden=!undo;q('[data-growth-apply]').disabled=true;q('[data-growth-download]').disabled=true;}
  function prepare(snapshot){
    clear();preview=store.fromImport(snapshot);
    const {inventory,account}=preview,node=q('[data-growth-preview]');node.replaceChildren();node.hidden=false;
    const summary=document.createElement('p');summary.textContent=`成员卡 ${inventory.memberCardIds.length} 张 · 留影 ${inventory.supportCardIds.length} 张 · 乐器 ${account.bandItemTotals&&Object.keys(account.bandItemTotals).length ? `${Object.keys(account.bandItemTotals).length} 个乐队` : account.bandItems ? `${Object.keys(account.bandItems).length} 件` : '未记录'} · 角色评级 ${account.characterRanks ? `${Object.keys(account.characterRanks).length} 名` : '未记录'} · TGW ${account.tgwCardRank ?? '未记录'}`;
    const note=document.createElement('p');note.textContent='确认后替换当前区服的养成档案，各工具共用此档案。请核对内容；本次导入可撤销。';node.append(summary,note);
    q('[data-growth-actions]').hidden=false;q('[data-growth-apply]').disabled=false;q('[data-growth-download]').disabled=false;status.textContent='读取完成，请预览后保存。';
  }
  workbench.addEventListener('personal-growth-preview',event=>{if(busy){status.textContent='正在读取养成，请完成后再导入。';root.open=true;return;}try{prepare(event.detail);root.open=true;root.scrollIntoView({block:'start'});}catch(error){status.textContent=`未导入：${error.message}`;}});
  async function checkService() {
   const retry=q('[data-growth-retry]');retry.hidden=true;nonce=null;fields.disabled=true;
   if(context.serverId !== 'global-hmt') {
    fields.disabled=true;
    q('[data-growth-service-status]').textContent='当前网页登录仅支持港澳台；请先选择匹配区服。';
   } else await fetch('/api/growth-export/capabilities/',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)})
    .then(async r=>{if(!r.ok)throw Error();const result=await r.json();if(result.enabled!==true||typeof result.nonce!=='string')throw Error();
      nonce=result.nonce;fields.disabled=busy;q('[data-growth-service-status]').textContent='网页登录已就绪，登录请求将经过本站服务端。';})
    .catch(()=>{q('[data-growth-service-status]').textContent='暂时无法连接登录服务，可重新检查或导入 JSON。';retry.hidden=false;});
  }
  q('[data-growth-retry]').addEventListener('click',()=>{if(!busy){q('[data-growth-service-status]').textContent='正在检查网页登录服务…';checkService();}});
  checkService();
  q('[data-growth-login]').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!nonce)return;busy=true;clear();fields.disabled=true;q('[data-growth-file]').disabled=true;
    let body=JSON.stringify({account:q('[data-growth-account]').value,password:q('[data-growth-password]').value});
    q('[data-growth-password]').value='';status.textContent='正在登录并读取养成，请稍候。不会自动重试。';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),150000);
    try {
      const request=fetch('/api/growth-export/read/',{method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json','X-Growth-Nonce':nonce},body,signal:controller.signal});body='';
      const response=await request;
      if(Number(response.headers.get('content-length'))>2_000_000)throw new Error('返回文件过大，未导入。');
      const text=await response.text();if(text.length>2_000_000)throw new Error('返回文件过大，未导入。');
      let result;try{result=JSON.parse(text);}catch{throw new Error('服务暂不可用，请稍后再试。');}
      if(!response.ok){const code=typeof result.error==='string'&&/^sdk_service_-?\d+$/.test(result.error)?`（${result.error}）`:'';
        throw new Error(messages[result.reason]??(response.status===429?'服务繁忙，请稍后再试。':response.status===403?'页面已过期，请刷新后再试。':`读取未完成，请稍后再试。${code}`));}
      prepare(result.snapshot);
    }catch(error){status.textContent=error.name==='AbortError'?'读取超时，未修改卡库。':error.message;}
    finally{body='';clearTimeout(timer);busy=false;fields.disabled=false;q('[data-growth-file]').disabled=false;}
  });
  q('[data-growth-file]').addEventListener('change',async event=>{
    if(busy)return;clear();busy=true;fields.disabled=true;q('[data-growth-file]').disabled=true;
    try{const file=event.target.files[0];if(!file)return;if(file.size>2_000_000)throw new Error('文件超过 2 MB。');prepare(JSON.parse(await file.text()));}
    catch(error){status.textContent=`未导入：${error.message}`;}
    finally{event.target.value='';busy=false;fields.disabled=!nonce;q('[data-growth-file]').disabled=false;}
  });
  q('[data-growth-apply]').addEventListener('click',()=>{
    if(!preview||busy)return;
    try {
      const previous={checkpoint:store.checkpoint(),inventory:structuredClone(getInventory()),modifiers:structuredClone(workbench.draft.modifiers)};
      const saved=store.save(preview);
      replaceInventory(saved.inventory,'已保存个人养成。',{persist:false,remember:false});
      const {bandItems,bandItemTotals,characterRanks,tgwCardRank,...remaining}=workbench.draft.modifiers;
      workbench.draft.modifiers=growthModifiersForDraft({modifiers:{...saved.account,growth:saved.inventory.growth}},{...workbench.draft,modifiers:remaining});
      undo=previous;changed();q('[data-growth-undo]').disabled=false;
      q('[data-growth-apply]').disabled=true;status.textContent='已保存到当前区服的个人养成，各工具可直接使用。';
    }catch(error){status.textContent=`保存失败：${error.message}。请下载备份后重试。`;}
  });
  q('[data-growth-undo]').addEventListener('click',()=>{
    if(!undo||busy)return;
    try {
      store.restore(undo.checkpoint);replaceInventory(undo.inventory,'已撤销养成导入。',{persist:false,remember:false});workbench.draft.modifiers=undo.modifiers;undo=null;
      changed();q('[data-growth-undo]').disabled=true;q('[data-growth-apply]').disabled=!preview;status.textContent='已恢复导入前的卡库及账号加成。';
    }catch(error){status.textContent=`恢复失败：${error.message}`;}
  });
  q('[data-growth-download]').addEventListener('click',()=>{
    if(!preview)return;const url=URL.createObjectURL(new Blob([JSON.stringify(preview,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='otonote-personal-growth.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
}
