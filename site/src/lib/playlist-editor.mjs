import {normalizePlaylistEntries} from './playlist-store.mjs';
import {resolveCalculationScope} from './calculation-scope.mjs';
import {songArtwork,songIdentity} from './playlist-song-view.mjs';
import {matchesSongChart,matchesSongMission} from './calculator-song-picker.mjs';
import {createWorkbenchDialog} from './workbench-dialog.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const button=(text,fn,cls)=>{const n=el('button',text,cls);n.type='button';n.addEventListener('click',fn);return n;};
const field=(text,input)=>{const l=el('label',text);l.append(input);return l;};
/** Bounded song pages keep selection responsive; saved data changes only on save. */
export function createPlaylistEditor({host,data,store,getFilters,onSave,onApply,onClose,onBack}) {
 const panel=createWorkbenchDialog(document.body,'编辑歌单',{className:'playlist-dialog playlist-editor',onClose});
 panel.dialog.classList.remove('task-dialog');
 const closeButton=panel.dialog.querySelector('header button');closeButton.textContent='×';closeButton.setAttribute('aria-label','关闭 ×');
 const tracks=new Map(data.tracks.map(t=>[t.id,t])),charts=new Map();
 for(const c of data.charts){if(!charts.has(c.trackId))charts.set(c.trackId,[]);charts.get(c.trackId).push(c);}
 let dirty=false,busy=false,discard;
 const heading=panel.dialog.querySelector('h2');
 const guard=e=>{if(dirty&&!busy){e.preventDefault();e.stopImmediatePropagation();discard.hidden=false;discard.querySelector('button').focus();}};
 panel.dialog.addEventListener('cancel',guard);
 panel.dialog.querySelector('header button').addEventListener('click',guard,true);
 panel.dialog.addEventListener('click',e=>{if(e.target===panel.dialog&&dirty)guard(e);},true);
 function open({playlist,entries,temporary=false}={}){
  const expectedRevision=store.read().revision;let chosen=normalizePlaylistEntries(entries??playlist?.entries??[]),page=0,onlySelected=temporary&&Boolean(chosen.length);
  dirty=false;busy=false;heading.textContent=temporary?'调整本次范围':playlist?'编辑歌单':'新建歌单';
  const name=el('input');name.maxLength=80;name.value=playlist?.name??'我的歌单';name.setAttribute('aria-label','歌单名称');
  const memo=el('textarea');memo.rows=1;memo.maxLength=500;memo.value=playlist?.note??'';memo.setAttribute('aria-label','歌单备注');
  const metadata=el('div',null,'playlist-metadata');metadata.append(field('歌单名称',name),field('备注（选填）',memo));
  const saveDetails=el('details',null,'playlist-save-copy');saveDetails.append(el('summary','将调整保存为歌单'),metadata);
  const query=el('input');query.type='search';query.placeholder='搜索歌名或乐队，支持多个关键词';query.setAttribute('aria-label','搜索歌单歌曲');
  const selected=button('只看已选',()=>{onlySelected=!onlySelected;selected.setAttribute('aria-pressed',String(onlySelected));page=0;render();});selected.setAttribute('aria-pressed',String(onlySelected));
  const filters=el('div',null,'playlist-editor-filters');filters.append(query,selected);
  const filterDetails=el('details',null,'playlist-catalog-filters'),filterTitle=el('summary','筛选歌曲'),filterGrid=el('div',null,'playlist-filter-grid');
  const controls={};
  const selectFilter=(key,label,options)=>{const input=el('select');input.setAttribute('aria-label',label);input.append(new Option('不限',''));for(const [value,text] of options)input.append(new Option(text,String(value)));controls[key]=input;filterGrid.append(field(label,input));input.addEventListener('change',()=>{page=0;render();});};
  const bands=new Map();for(const t of data.tracks)for(const [i,id] of (t.bandIds??[]).entries())bands.set(id,t.bandLabels?.[i]??id);
  const attributes=new Map(data.tracks.filter(t=>t.musicType!=null).map(t=>[String(t.musicType),data.attributeVisuals?.find(a=>String(a.code)===String(t.musicType))?.name??t.attributeLabel??t.musicTypeLabel??`属性 ${t.musicType}`]));
  selectFilter('attribute','歌曲属性',[...attributes]);selectFilter('band','演奏乐队',[...bands]);
  selectFilter('difficulty','谱面难度',[...new Set(data.charts.map(c=>c.difficulty))].map(d=>[d,d.toUpperCase()]));
  selectFilter('mission','激奏段落',[['1','含 COMBO'],['2','含 LUCK'],['3','含 JUST'],['1-only','三段 COMBO'],['2-only','三段 LUCK'],['3-only','三段 JUST'],['mixed','混合类型']]);
  selectFilter('sort','排序',[['name','歌曲名称'],['level','谱面等级从高到低']]);
  for(const [key,label] of [['min','最低等级'],['max','最高等级']]){const input=el('input');input.type='number';input.min='1';input.max='50';input.placeholder='不限';input.setAttribute('aria-label',label);controls[key]=input;filterGrid.append(field(label,input));input.addEventListener('input',()=>{page=0;render();});}
  filterDetails.append(filterTitle,filterGrid,button('重置筛选',()=>{for(const c of Object.values(controls))c.value='';query.value='';page=0;render();}));
  const list=el('div',null,'playlist-song-list'),count=el('p',null,'playlist-editor-count'),status=el('p',null,'playlist-status'),footer=el('footer',null,'playlist-editor-footer'),actions=el('div',null,'playlist-editor-actions');status.setAttribute('role','status');count.setAttribute('aria-live','polite');
  const pageLabel=el('span'),prev=button('上一页歌曲',()=>{page--;render();list.scrollIntoView({block:'start'});}),next=button('下一页歌曲',()=>{page++;render();list.scrollIntoView({block:'start'});}),pager=el('nav',null,'playlist-pager');pager.setAttribute('aria-label','歌单歌曲分页');pager.append(prev,pageLabel,next);
  discard=el('div',null,'playlist-discard');discard.hidden=true;discard.setAttribute('role','alert');discard.append(el('p','还有未应用的修改。离开将丢弃这些修改。'),button('继续编辑',()=>{discard.hidden=true;query.focus();}),button('放弃修改并关闭',()=>{dirty=false;panel.close();}));
  const markDirty=()=>{dirty=true;status.textContent='';};name.addEventListener('input',markDirty);memo.addEventListener('input',markDirty);
  function render(){
   const focused=document.activeElement?.dataset?.playlistChoice,scroll=list.scrollTop;
   const preview=resolveCalculationScope({...data,...getFilters(),selection:{kind:'temporary',entries:chosen}});
   count.textContent=`已选 ${chosen.length} 首 / ${resolveCalculationScope({...data,selection:{kind:'temporary',entries:chosen}}).requestedChartCount} 张谱面 · 本次可计算 ${preview.songCount} 首 / ${preview.chartCount} 张`;
   const selectedMap=new Map(chosen.map(e=>[e.trackId,e]));
   const f=Object.fromEntries(Object.entries(controls).map(([k,n])=>[k,n.value]));filterTitle.textContent=`筛选歌曲${Object.values(f).filter(Boolean).length?' · 已设置 '+Object.values(f).filter(Boolean).length+' 项':''}`;
   const words=query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),rows=[...data.tracks,...chosen.filter(e=>!tracks.has(e.trackId)).map(e=>({id:e.trackId,title:e.trackId}))].filter(t=>(!onlySelected||selectedMap.has(t.id))&&words.every(w=>`${t.title} ${t.id} ${(t.bandLabels??[]).join(' ')}`.toLocaleLowerCase().includes(w))&&(!f.band||t.bandIds?.includes(f.band))&&(!f.attribute||String(t.musicType)===f.attribute)&&(!f.mission||(t.missions?.length&&matchesSongMission(t.missions,f.mission)))&&(!(f.difficulty||f.min||f.max)||(charts.get(t.id)??[]).some(c=>matchesSongChart({...c,disabled:false},f))));
   if(f.sort==='name')rows.sort((a,b)=>(a.title??a.id).localeCompare(b.title??b.id,'zh-CN'));if(f.sort==='level')rows.sort((a,b)=>Math.max(0,...(charts.get(b.id)??[]).map(c=>c.level??0))-Math.max(0,...(charts.get(a.id)??[]).map(c=>c.level??0)));
   const total=Math.max(1,Math.ceil(rows.length/30));page=Math.min(page,total-1);list.replaceChildren();
   for(const t of rows.slice(page*30,page*30+30)){
    const row=el('article',null,'playlist-song song-picker-row'),identity=el('div',null,'playlist-song-identity'),current=selectedMap.get(t.id),ds=[...new Set((charts.get(t.id)??[]).map(c=>c.difficulty))];row.dataset.selected=String(Boolean(current));row.setAttribute('role','group');row.setAttribute('aria-label',t.title??t.id);identity.append(songArtwork(t),songIdentity(t,data));row.append(identity);
    if(!tracks.has(t.id)){row.append(el('p','当前区服不可用，保留原条目'),button('移除此歌曲',()=>{chosen=chosen.filter(e=>e.trackId!==t.id);markDirty();render();}));list.append(row);continue;}
    const choices=el('div',null,'playlist-difficulties song-picker-difficulties');choices.setAttribute('role','group');choices.setAttribute('aria-label','选择难度');
    for(const d of ['all',...ds]){
     if(d!=='all'&&!matchesSongChart({...charts.get(t.id).find(c=>c.difficulty===d),disabled:false},f))continue;
     const input=el('button');input.type='button';input.className=d==='all'?'playlist-all-difficulties':`song-difficulty song-difficulty--${d}`;input.dataset.playlistChoice=`${t.id}:${d}`;input.checked=d==='all'?current?.difficulties==='all':current?.difficulties==='all'||current?.difficulties.includes(d)||false;
     const level=(charts.get(t.id)??[]).find(c=>c.difficulty===d)?.level;const text=d==='all'?'全部难度':d.toUpperCase();input.setAttribute('aria-label',text);
     input.setAttribute('aria-pressed',String(input.checked));input.append(el('span',text),el('strong',d==='all'?(input.checked?'✓':'＋'):level??'—'));if(input.checked&&d!=='all')input.append(el('i','✓','playlist-selection-check'));
     input.addEventListener('click',()=>{input.checked=!input.checked;const old=current?.difficulties==='all'?ds:current?.difficulties??[];const next=d==='all'?(input.checked?'all':[]):input.checked?[...new Set([...old,d])]:old.filter(x=>x!==d);chosen=chosen.filter(e=>e.trackId!==t.id);if(next==='all'||next.length)chosen.push({trackId:t.id,difficulties:next});markDirty();render();});choices.append(input);
    }
    row.append(choices);
    if(current&&current.difficulties!=='all')for(const missing of current.difficulties.filter(d=>!ds.includes(d))){const warning=el('p',`${missing}：当前资料没有此难度 `);warning.append(button('移除此难度',()=>{current.difficulties=current.difficulties.filter(d=>d!==missing);if(!current.difficulties.length)chosen=chosen.filter(e=>e!==current);markDirty();render();}));row.append(warning);}
    const excluded=preview.excluded.filter(e=>e.trackId===t.id);if(excluded.length)row.append(el('p',`本次排除：${[...new Set(excluded.map(e=>e.message))].join('、')}`,'playlist-exclusion'));
    list.append(row);
   }
   if(!rows.length)list.append(el('p',onlySelected?'没有符合搜索条件的已选歌曲。可切回全部歌曲继续添加。':'没有找到歌曲，试试其他名称或 ID。','playlist-empty'));
   pageLabel.textContent=`${rows.length} 首 · ${page+1} / ${total}`;prev.disabled=page===0;next.disabled=page===total-1;pager.hidden=total===1;
   list.scrollTop=scroll;if(focused){const input=[...list.querySelectorAll('[data-playlist-choice]')].find(n=>n.dataset.playlistChoice===focused);(input??selected).focus({preventScroll:true});}
  }
  const save=id=>async()=>{
   if(busy)return;if(!name.value.trim()){if(temporary)saveDetails.open=true;status.textContent='请填写歌单名称。';name.focus();return;}
   busy=true;for(const b of actions.querySelectorAll('button'))b.disabled=true;
   try{const result=await store.save({id,name:name.value,note:memo.value,entries:chosen,expectedRevision:id?expectedRevision:store.read().revision});dirty=false;panel.close();onSave(id?result.playlists.find(p=>p.id===id):result.playlists.at(-1),{created:!id});}
   catch(e){status.textContent=`尚未保存：${e.message}`;}finally{busy=false;for(const b of actions.querySelectorAll('button'))b.disabled=false;}
  };
  if(temporary){actions.append(button('应用本次调整',()=>{dirty=false;panel.close();onApply(chosen);},'playlist-primary'));const copies=el('div',null,'playlist-copy-actions');copies.append(button('保存为新歌单',save(undefined)));if(playlist)copies.append(button('更新原歌单',save(playlist.id)));saveDetails.append(copies);}
  else {actions.append(button(playlist?'保存修改':'创建歌单',save(playlist?.id),'playlist-primary'));if(playlist)actions.append(button('另存为新歌单',save(undefined)));}
  actions.append(button(temporary?'取消':'返回歌单',e=>{if(dirty){discard.hidden=false;discard.querySelector('button').focus();}else {panel.close();if(!temporary)onBack?.(playlist);}}));
  const clear=button('清空已选',()=>{chosen=[];markDirty();render();});const help=el('details',null,'playlist-selection-help');help.append(el('summary','难度选择说明'),el('p','“全部难度”也包含以后新增的难度；单独勾选只保存这些难度。'));const selectionTools=el('div',null,'playlist-selection-tools');selectionTools.append(help,clear);
  footer.append(count,status,actions);panel.body.replaceChildren(discard,el('p',temporary?'仅调整本次计算，已保存歌单保持不变。':'选择常打歌曲和难度，在各计算工具中共用。','playlist-help'),...(temporary?[]:[metadata]),filters,filterDetails,selectionTools,list,pager,...(temporary?[saveDetails]:[]));
  panel.dialog.querySelector(':scope > footer')?.remove();panel.dialog.append(footer);
  query.addEventListener('input',()=>{page=0;render();});render();panel.open();(temporary?query:name).focus();
 }
 return {open,close:()=>{dirty=false;panel.close();},destroy:()=>{dirty=false;panel.close();panel.dialog.remove();}};
}
