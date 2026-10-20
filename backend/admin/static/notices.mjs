import {installNoticeControls, noticePlacement, noticeTimestamp as timestamp, noticeDatetime as datetime} from './notice-controls.mjs';
const fields = ['kind','region','title','body','titleEn','bodyEn','href','startsAt','endsAt'];
const empty = () => ({kind:'info',region:'all',title:'',body:'',titleEn:'',bodyEn:'',href:'',startsAt:null,endsAt:null});
const make = (tag,text) => {const node=document.createElement(tag);node.textContent=text;return node;};

export function noticeManager({api,status,siteId}) {
  const form=document.getElementById('notice-form'), list=document.getElementById('notice-list');
  const message=document.getElementById('notice-editor-status'), preview=document.getElementById('notice-preview');
  let site='', selected=null, identity='', canWrite=false, busy=false, dirty=false, serial=0;
  const input=name=>form.elements.namedItem(name);
  const controls=installNoticeControls(form);
  const values=()=>({...Object.fromEntries(fields.map(name=>[name,['startsAt','endsAt'].includes(name)?timestamp(input(name).value):input(name).value])),paths:controls.getPaths()});
  const buttons=()=>{
    for(const node of form.querySelectorAll('input,select,textarea'))node.disabled=!canWrite||busy;
    controls.setDisabled(!canWrite||busy);
    document.getElementById('notice-save').disabled=!canWrite||busy;
    document.getElementById('notice-publish').disabled=!canWrite||busy||!selected||dirty;
    document.getElementById('notice-withdraw').disabled=!canWrite||busy||!selected?.published;
    document.getElementById('notice-delete').disabled=!canWrite||busy||!selected||!!selected.published;
    document.getElementById('notice-new').disabled=!canWrite||busy;
    for(const button of list.querySelectorAll('button'))button.disabled=busy;
  };
  function showPreview(){
    const value=values(), heading=make('div','');heading.className='notice-preview-heading';
    form.querySelector('[data-notice-placement]').textContent=noticePlacement(value);
    heading.append(make('span',{info:'公告',maintenance:'维护',incident:'服务异常'}[value.kind]),make('strong',value.title||'公告标题'));
    preview.replaceChildren(heading,make('p',value.body||'正文预览'));
    if(value.href)preview.append(make('small','详情链接：'+value.href));
    preview.dataset.kind=value.kind;
  }
  function edit(row){
    selected=row;identity=row?.id??crypto.randomUUID().replaceAll('-','');dirty=false;
    const value=row??empty();
    for(const name of fields)input(name).value=['startsAt','endsAt'].includes(name)?datetime(value[name]):value[name];
    controls.setPaths(row?.paths??[row?.path??'/']);
    controls.sync();
    message.textContent=row?`草稿修订 ${row.revision}${row.published?' · 公开修订 '+row.published.revision:' · 尚未发布'}`:'新公告 · 保存后可发布';
    buttons();showPreview();
  }
  function discard(){return !dirty||window.confirm('当前公告有未保存的修改，放弃这些修改？');}
  function render(rows){
    list.replaceChildren(...rows.map(row=>{
      const item=make('article','');item.className='notice-management-row';
      const content=make('div','');const published=row.published;
      let state=!published?'草稿':published.endsAt!==null&&published.endsAt<=Date.now()/1000?'已结束':published.startsAt!==null&&published.startsAt>Date.now()/1000?'待生效':'已发布';
      if(published&&published.revision!==row.revision)state+=' · 有未发布修改';
      const scopes=row.paths??[row.path];
      content.append(make('strong',row.title),make('small',`${state} · ${row.region==='all'?'全部区服':row.region.toUpperCase()} · ${scopes.includes('/')?'全站':scopes.join('、')}`));
      const button=make('button','编辑');button.type='button';button.addEventListener('click',()=>{if(discard())edit(row);});
      item.append(content,button);return item;
    }));
    if(!rows.length)list.append(make('p','还没有公告。'));
    buttons();
  }
  async function load(){
    const target=siteId(), attempt=++serial;
    if(target!==site){site=target;canWrite=false;edit(null);}
    try{
      const result=await api('/api/notices/'+encodeURIComponent(target));
      if(attempt!==serial||target!==siteId())return;
      canWrite=result.canWrite;render(result.notices);
      if(!dirty)edit(result.notices.find(row=>row.id===identity)??null);
      status(canWrite?'公告管理已连接 · 保存草稿不会自动发布':'公告只读 · 当前用户没有发布权限');
    }catch(error){
      if(attempt!==serial)return;
      canWrite=false;list.replaceChildren(make('p','公告管理不可用。请检查站点是否配置公告节点，以及节点连接和权限。'));buttons();status(error.message,true);
    }
  }
  async function change(action){
    if(busy||!canWrite)return;
    if(['withdraw','delete'].includes(action)&&!discard())return;
    if(action==='save'&&!form.reportValidity())return;
    const target=site, payload={action,id:identity,expectedRevision:action==='withdraw'?selected.published.revision:selected?.revision??0};
    if(action==='save'){
      payload.notice=values();
      if(payload.notice.endsAt!==null&&payload.notice.startsAt!==null&&payload.notice.endsAt<=payload.notice.startsAt){message.textContent='结束时间必须晚于开始时间。';return;}
    }
    busy=true;buttons();
    try{
      const result=await api('/api/notices/'+encodeURIComponent(target),{method:'POST',headers:{'Content-Type':'application/json','X-OurNotes-Request':'1'},body:JSON.stringify(payload)});
      if(target!==siteId())return;
      render(result.notices);edit(result.notices.find(row=>row.id===identity)??null);
      message.textContent={save:'草稿已保存，网站上的公告未改变。',publish:'已发布。网站会在下一次通知检查时显示，通常不超过三分钟。',withdraw:'已撤回。网站会在下一次通知检查时移除。',delete:'未发布草稿已删除。'}[action];
      status('公告操作完成');
    }catch(error){message.textContent=error.message+' 操作结果可能未返回，请先刷新列表核对；当前编辑内容仍然保留。';status('公告操作未确认',true);}
    finally{busy=false;buttons();}
  }
  form.addEventListener('input',()=>{dirty=true;buttons();showPreview();});
  form.addEventListener('submit',event=>{event.preventDefault();void change('save');});
  for(const action of ['publish','withdraw','delete'])document.getElementById('notice-'+action).addEventListener('click',()=>void change(action));
  document.getElementById('notice-new').addEventListener('click',()=>{if(discard())edit(null);});
  document.getElementById('site').addEventListener('change',event=>{
    if((busy||!discard())&&site){event.target.value=site;event.stopImmediatePropagation();}
  },true);
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  return {load};
}
