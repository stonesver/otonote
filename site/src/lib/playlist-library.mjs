import {createWorkbenchDialog} from './workbench-dialog.mjs';
import {resolveCalculationScope} from './calculation-scope.mjs';
import {node as el,playlistArtwork,songArtwork,songIdentity} from './playlist-song-view.mjs';

const SVG_NS='http://www.w3.org/2000/svg';
function svgIcon(paths,size=16){
 const svg=document.createElementNS(SVG_NS,'svg');
 svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('width',String(size));svg.setAttribute('height',String(size));
 svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
 svg.setAttribute('stroke-width','1.5');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
 svg.setAttribute('aria-hidden','true');
 for(const d of paths){const p=document.createElementNS(SVG_NS,'path');p.setAttribute('d',d);svg.append(p);}
 return svg;
}
function dotsIcon(){
 const svg=document.createElementNS(SVG_NS,'svg');
 svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('width','16');svg.setAttribute('height','16');
 svg.setAttribute('fill','currentColor');svg.setAttribute('aria-hidden','true');
 for(const cx of [3.5,8,12.5]){const c=document.createElementNS(SVG_NS,'circle');c.setAttribute('cx',String(cx));c.setAttribute('cy','8');c.setAttribute('r','1.25');svg.append(c);}
 return svg;
}

const button=(label,fn,cls)=>{const b=el('button',label,cls);b.type='button';if(label)b.setAttribute('aria-label',label);b.addEventListener('click',fn);return b;};
const download=value=>{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download='otonote-playlists.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
/** Personal collection navigation never changes a tool's range until explicit use. */
export function createPlaylistLibrary({data,store,recommended,getFilters,getSelection,onUse,onEdit,onChange,onNavigate,standalone=false}) {
 const panel=createWorkbenchDialog(document.body,'我的歌单',{className:'playlist-dialog playlist-manager'});
 panel.dialog.classList.remove('task-dialog');
 const header=panel.dialog.querySelector('header');
 const closeButton=header.querySelector('button');
 closeButton.setAttribute('aria-label','关闭');
 const headingEl=header.querySelector('h2');
 const headingMain=el('div',null,'ws-heading-main');
 headingEl.replaceWith(headingMain);
 const sheetSwitch=el('div',null,'ws-sheet-switch');
 sheetSwitch.setAttribute('role','tablist');
 sheetSwitch.setAttribute('aria-label','切换个人面板');
 const switchToAccount=button('账号同步',()=>{
  document.dispatchEvent(new CustomEvent('account-hub:open'));
 });
 switchToAccount.setAttribute('role','tab');
 switchToAccount.setAttribute('aria-selected','false');
 const switchToTeam=button('养成与队伍',()=>{
  document.dispatchEvent(new CustomEvent('team-workspace:open',{detail:{tab:'inventory'}}));
 });
 switchToTeam.setAttribute('role','tab');
 switchToTeam.setAttribute('aria-selected','false');
 const stayPlaylists=button('我的歌单',()=>{if(current)showList();});
 stayPlaylists.setAttribute('role','tab');
 stayPlaylists.setAttribute('aria-selected','true');
 sheetSwitch.append(switchToAccount,switchToTeam,stayPlaylists);
 headingMain.append(headingEl,sheetSwitch);
 let tab='mine',query='',undo=null,current=null;
 const status=el('p',null,'playlist-feedback');status.setAttribute('role','status');
 const report=message=>{status.textContent=message;};
 const attempt=fn=>async()=>{try{await fn();}catch(e){report(e.message);}};
 const counts=p=>resolveCalculationScope({...data,...getFilters(),selection:{kind:'temporary',entries:p.entries}});
 const apply=p=>{onUse({kind:recommended.includes(p)?'recommended':'playlist',id:p.id});if(!standalone){panel.close();return;}
  showDetail(p);const navigation=el('nav',null,'playlist-tool-links');navigation.setAttribute('aria-label','用歌单计算');
  const prefix=location.pathname.match(/^\/(global|jp)\/[^/]+/)?.[0]??'';
  for(const [path,label] of [['deck-builder','配队推荐'],['song-calculator','估分与选曲'],['event-efficiency','活动收益']]){const a=el('a',label);a.href=`${prefix}/tools/${path}/${location.search}`;if(path==='song-calculator'){const url=new URL(a.href);url.searchParams.set('view','songs');a.href=url.href;}a.addEventListener('click',()=>onNavigate(a));navigation.append(a);}
  panel.body.querySelector('.playlist-detail-actions').after(navigation);report('选择工具后将带入这份歌单，不会自动开始计算。');navigation.querySelector('a').focus();};
 const useLabel=standalone?'选择计算工具':'用于当前计算';
 let menuTrigger=null;
 const menu=el('div',null,'playlist-action-menu');menu.hidden=true;menu.setAttribute('role','group');menu.setAttribute('aria-label','歌单操作');panel.dialog.append(menu);
 function closeMenu(restore=false){menu.hidden=true;const trigger=menuTrigger;menuTrigger=null;trigger?.setAttribute('aria-expanded','false');if(restore&&trigger?.isConnected)trigger.focus();}
 panel.dialog.addEventListener('pointerdown',e=>{if(!menu.hidden&&!menu.contains(e.target)&&!menuTrigger?.contains(e.target))closeMenu();});
 panel.dialog.addEventListener('focusin',e=>{if(!menu.hidden&&!menu.contains(e.target)&&e.target!==menuTrigger)closeMenu();});
 panel.dialog.addEventListener('keydown',e=>{if(menu.hidden)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeMenu(true);return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const items=[...menu.querySelectorAll('button')],index=items.indexOf(document.activeElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();},true);
 panel.body.addEventListener('scroll',()=>closeMenu(),{passive:true});panel.dialog.addEventListener('close',()=>closeMenu());
 function more(p){
  const trigger=button('',()=>{
   if(menuTrigger===trigger){closeMenu();return;}closeMenu();menuTrigger=trigger;trigger.setAttribute('aria-expanded','true');
   const item=(label,path,run,cls)=>{const b=button(label,()=>{closeMenu(true);run();},cls);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),shape=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');shape.setAttribute('d',path);svg.append(shape);b.prepend(svg);return b;};
   menu.replaceChildren(
    item('编辑／重命名','m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z',()=>{panel.close();onEdit({playlist:p});}),
    item('复制歌单','M9 9h11v11H9ZM4 15H3V3h12v1',()=>{panel.close();onEdit({entries:p.entries});}),
    item('导出歌单','M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5',()=>download({...store.exportWorkspace(),playlists:[p]})),
    item('删除歌单','M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',attempt(async()=>{
     const before=store.read(),after=await store.remove(p.id,{expectedRevision:before.revision});undo={state:before,revision:after.revision};onChange();showList();report(`已删除“${p.name}”，可撤销。`);
    }),'playlist-danger'));
   menu.hidden=false;
   const anchor=trigger.getBoundingClientRect(),bounds=panel.dialog.getBoundingClientRect(),size=menu.getBoundingClientRect();
   menu.style.left=`${Math.max(bounds.left+8,Math.min(anchor.right-size.width,bounds.right-size.width-8))}px`;
   const below=anchor.bottom+6,above=anchor.top-size.height-6;
   menu.style.top=`${below+size.height<=bounds.bottom-8?below:above>=bounds.top+8?above:Math.max(bounds.top+8,bounds.bottom-size.height-8)}px`;
   menu.querySelector('button').focus({preventScroll:true});
  },'playlist-more');trigger.append(dotsIcon());trigger.setAttribute('aria-label','更多操作');trigger.setAttribute('aria-expanded','false');trigger.title='更多操作';return trigger;
 }
 function start(title){closeMenu();panel.dialog.querySelector('h2').textContent=title;panel.body.replaceChildren();status.textContent='';panel.body.append(status);}
 function showList(){
  current=null;start('我的歌单');
  const mineCount=store.read().playlists.length;
  const toolbar=el('div',null,'playlist-toolbar-row');
  const tabs=el('div',null,'playlist-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','歌单来源');
  for(const [id,label,count] of [['mine','我的歌单',mineCount],['recommended','站点推荐',recommended.length]]){
   const b=button('',()=>{tab=id;query='';showList();});
   b.setAttribute('aria-pressed',String(tab===id));
   b.append(document.createTextNode(label),el('span',String(count),'playlist-tab-count'));
   tabs.append(b);
  }
  const search=el('input');search.type='search';search.value=query;search.placeholder='搜索歌单名称或备注';search.setAttribute('aria-label','搜索我的歌单');
  const createBtn=button('新建歌单',()=>{panel.close();onEdit();},'playlist-primary playlist-create-btn');
  createBtn.prepend(svgIcon(['M8 3.5v9','M3.5 8h9'],14));
  toolbar.append(tabs,search,createBtn);
  panel.body.append(toolbar);
  const list=el('div',null,'playlist-library');panel.body.append(list);
  function render(){
   const playlists=tab==='mine'?store.read().playlists:recommended,found=playlists.filter(p=>`${p.name} ${p.note??''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));closeMenu();list.replaceChildren();
   if(!found.length){
    const empty=el('div',null,'playlist-empty-card');
    empty.append(svgIcon(['M3 4.5h6.5','M3 8.5h6.5','M3 12.5h4.2','M13.5 4.2v7.2','M11.5 11.4a1.6 1.6 0 1 0 3.2 0'],34));
    if(query.trim()){
     empty.append(el('h3','没有找到匹配的歌单'),el('p','试试其他歌单名称或备注关键词，或清除搜索条件。'));
     const emptyActions=el('div',null,'playlist-empty-actions');
     emptyActions.append(button('清空搜索',()=>{query='';search.value='';render();},'playlist-primary'));
     empty.append(emptyActions);
    }else{
     empty.append(el('h3','还没有自定义歌单'),el('p','将常打的歌曲与指定难度收藏成歌单，可在配队推荐、估分选曲与活动收益之间一键复用。'));
     const emptyActions=el('div',null,'playlist-empty-actions');
     const firstBtn=button('新建第一份歌单',()=>{panel.close();onEdit();},'playlist-primary');
     firstBtn.prepend(svgIcon(['M8 3.5v9','M3.5 8h9'],14));
     emptyActions.append(firstBtn,button('查看站点推荐',()=>{tab='recommended';query='';showList();}));
     empty.append(emptyActions);
    }
    list.append(empty);
   }
   for(const p of found){
    const card=el('article',null,'playlist-library-item');card.setAttribute('aria-label',p.name);
    const view=button('',()=>showDetail(p),'playlist-card-open'),copy=el('div',null,'playlist-card-copy'),selected=getSelection();
    const titleRow=el('div',null,'playlist-card-title');titleRow.append(el('strong',p.name));
    if(selected.id===p.id)titleRow.append(el('span',selected.entries?'使用中 · 已调整':'当前使用','playlist-current'));
    copy.append(titleRow);
    const total=resolveCalculationScope({...data,selection:{kind:'temporary',entries:p.entries}});
    const stats=el('span',null,'playlist-card-stats');stats.append(document.createTextNode(`${p.entries.length} 首 · ${total.requestedChartCount} 张谱面`));copy.append(stats);
    const preview=p.entries.slice(0,3).map(e=>data.tracks.find(t=>t.id===e.trackId)?.title??e.trackId).join('、');copy.append(el('small',preview?`${preview}${p.entries.length>3?` 等 ${p.entries.length} 首`:''}`:'尚未添加歌曲'));
    view.setAttribute('aria-label',`查看 ${p.name}`);view.append(playlistArtwork(p,data.tracks),copy);
    const actions=el('div',null,'playlist-item-actions');actions.append(button(useLabel,()=>apply(p),'playlist-primary'));if(tab==='mine')actions.append(more(p));else actions.append(button('保存副本',()=>{panel.close();onEdit({entries:p.entries});}));card.append(view,actions);list.append(card);
   }
  }
  search.addEventListener('input',()=>{query=search.value;render();});render();
  if(undo)panel.body.append(button('撤销上次删除',attempt(async()=>{await store.restore(undo.state,{expectedRevision:undo.revision});undo=null;onChange();showList();report('已恢复删除的歌单。');}),'playlist-undo-btn'));
  if(tab==='mine')backup();
  panel.open();
 }
 function showDetail(p,message=''){
  current=p;start(p.name);const isRecommended=recommended.includes(p),total=resolveCalculationScope({...data,selection:{kind:'temporary',entries:p.entries}}),effective=counts(p);
  const backBtn=button('返回歌单列表',showList,'playlist-back');
  backBtn.prepend(svgIcon(['M10 3.5 5.5 8 10 12.5'],14));
  panel.body.append(backBtn);
  const hero=el('section',null,'playlist-detail-heading'),copy=el('div');copy.append(el('h3',p.name),el('p',`${p.entries.length} 首歌曲 · ${total.requestedChartCount} 张谱面`));if(p.note)copy.append(el('p',p.note,'playlist-detail-note'));
  const heroActions=el('div',null,'playlist-detail-actions');heroActions.append(button(useLabel,()=>apply(p),'playlist-primary'),button(isRecommended?'保存副本':'编辑歌单',()=>{panel.close();onEdit(isRecommended?{entries:p.entries}:{playlist:p});}));
  hero.append(playlistArtwork(p,data.tracks),copy,heroActions);panel.body.append(hero);
  if(!standalone)panel.body.append(el('p',`当前条件可计算 ${effective.songCount} 首 / ${effective.chartCount} 张谱面`,'playlist-detail-count'));
  if(effective.excluded.length){const issues=el('details',null,'playlist-excluded');issues.append(el('summary',`${effective.excluded.length} 个条目本次不可用`));for(const e of effective.excluded)issues.append(el('p',`${data.tracks.find(t=>t.id===e.trackId)?.title??e.trackId} ${e.difficulty?.toUpperCase()??''}：${e.message}`));panel.body.append(issues);}
  const list=el('div',null,'playlist-detail-songs');
  for(const entry of p.entries){const t=data.tracks.find(t=>t.id===entry.trackId)??{id:entry.trackId,title:entry.trackId},row=el('article',null,'playlist-detail-song');row.append(songArtwork(t),songIdentity(t,data));const ds=el('div',null,'playlist-saved-difficulties');const chartRows=data.charts.filter(c=>c.trackId===entry.trackId&&(entry.difficulties==='all'||entry.difficulties.includes(c.difficulty)));
   for(const c of chartRows){const badge=el('span',`${c.difficulty.toUpperCase()} ${c.level??'—'}`);badge.dataset.difficulty=c.difficulty;ds.append(badge);}if(entry.difficulties==='all')ds.append(el('small','含以后新增难度'));row.append(ds);list.append(row);}
  if(!p.entries.length)list.append(el('p','歌单已创建。点击“编辑歌单”添加歌曲。','playlist-empty'));panel.body.append(list);report(message);panel.open();
 }
 function backup(){
  const box=el('details',null,'playlist-backup');
  box.append(el('summary','备份与存储说明'),el('p','歌单保存在当前浏览器与对应区服本地；导出与卡库互相独立，导入备份时只追加不覆盖。'));
  const backupActions=el('div',null,'playlist-backup-actions');
  const exportBtn=button('导出全部歌单',attempt(()=>download(store.exportWorkspace())));
  const fileLabel=el('label',null,'playlist-file-btn');fileLabel.append(el('span','选择备份 JSON'));
  const file=el('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','导入歌单备份');
  fileLabel.append(file);
  backupActions.append(exportBtn,fileLabel);
  const preview=el('div',null,'playlist-backup-preview');box.append(backupActions,preview);panel.body.append(box);
  file.addEventListener('change',async()=>{try{const f=file.files?.[0];if(!f)return;if(f.size>4*1024*1024)throw Error('歌单备份不能超过 4 MiB');const value=store.validate(JSON.parse(await f.text())),expectedRevision=store.read().revision;
   preview.replaceChildren(el('p',`将追加 ${value.playlists.length} 份歌单，保留现有歌单。`));for(const p of value.playlists){const c=counts(p);preview.append(el('p',`${p.name}：${c.songCount} 首本次可用，${c.excluded.length} 个条目不可用或资料暂缺`));}
   preview.append(button('确认追加导入',attempt(async()=>{await store.importWorkspace(value,{expectedRevision});onChange();showList();report('已追加导入歌单。');}),'playlist-primary'));
  }catch(e){preview.replaceChildren(el('p',e.message));}});
 }
 return {showList,showDetail,close:()=>panel.close(),refresh(){if(!panel.dialog.open)return;if(current){const latest=store.read().playlists.find(p=>p.id===current.id)??recommended.find(p=>p.id===current.id);latest?showDetail(latest):showList();}else showList();},destroy(){panel.close();panel.dialog.remove();}};
}
