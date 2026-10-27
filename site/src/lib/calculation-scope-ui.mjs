import {createPlaylistStore, entriesFromCharts, normalizePlaylistEntries} from './playlist-store.mjs';
import {resolveCalculationScope, requireCalculationScope, scopeSummary, chartKey} from './calculation-scope.mjs';
import {recommendedPlaylists} from './recommended-playlists.mjs';
import {createPlaylistEditor} from './playlist-editor.mjs';
import {createPlaylistLibrary} from './playlist-library.mjs';
import {playlistPresentation} from './playlist-song-view.mjs';

const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const button=(label,fn)=>{const n=el('button',label);n.type='button';n.addEventListener('click',fn);return n;};
const option=(value,label)=>{const o=el('option',label);o.value=value;return o;};
/** One reusable control for all tool stages. Results keep their own immutable
 * scope snapshot; refreshing this control never relabels old results. */
export function createCalculationScopeControl({host,mount,data,toolKey,getFilters=()=>({}),onChange=()=>{},getInheritedSelection=undefined,getMode=()=>'',getEnabled=()=>true,getFixedTitle=()=>'工具指定曲目',standalone=false}) {
  data=playlistPresentation(data,host);
  const store=createPlaylistStore(),recommended=recommendedPlaylists(data),root=el('section');root.className='calculation-scope task-condition-group';
  const label=el('label',getInheritedSelection?'后续挑战范围':'计算范围'),select=el('select'),summary=el('p'),issues=el('details'),issueTitle=el('summary'),issueList=el('ul'),note=el('p'),actions=el('div');
  select.setAttribute('aria-label',getInheritedSelection?'后续挑战范围':'计算范围');select.dataset.quickNative='';root.setAttribute('aria-label',getInheritedSelection?'后续挑战范围':'计算范围');actions.className='calculation-scope-actions';summary.setAttribute('role','status');note.className='playlist-help';summary.className='calculation-scope-summary';label.append(select);issues.append(issueTitle,issueList);root.append(label,summary,issues,note,actions);mount.append(root);
  const selectionKey=()=>`${store.key}:selection:${toolKey}:${getMode()}`;let key=selectionKey();const recentKey=`${store.key}:recent`;
  let state={kind:getInheritedSelection?'inherit':'all'},playlists=[],last=null,error='',revision=0,renderSignature='';
  const manager=createPlaylistLibrary({data,store,recommended,getFilters,getSelection:()=>effectiveSelection(),standalone,onUse:selection=>{state=selection;persist();},onEdit:options=>edit(options),onNavigate:link=>api.carry(link),onChange:()=>changed()});
  const editor=createPlaylistEditor({host,data,store,getFilters,onSave:(p,{created})=>{changed();manager.showDetail(p,`${created?'已创建':'已保存'}。可以继续编辑，或用于计算。`);},onApply:entries=>{state={...effectiveSelection(),entries};if(state.kind==='all')state.kind='temporary';persist();},onBack:p=>p?manager.showDetail(p):manager.showList()});
  function edit(options){manager.close();editor.open(options);}
  try {
    const incoming=new URLSearchParams(location.hash.slice(1)).get('calculation-range');
    const handed=incoming&&sessionStorage.getItem(`${store.key}:handoff:${incoming}`);
    const saved=sessionStorage.getItem(key)??localStorage.getItem(key)??(!getInheritedSelection?localStorage.getItem(recentKey):null);
    if(incoming&&!getInheritedSelection){
      state=handed?JSON.parse(handed):{kind:'invalid'};
      if(!handed)error='携带的计算范围已失效，请重新选择；不会自动改为全曲。';
      sessionStorage.setItem(key,JSON.stringify(state));
      const url=new URL(location.href);const hash=new URLSearchParams(url.hash.slice(1));hash.delete('calculation-range');url.hash=hash.toString();history.replaceState(history.state,'',url);
    }else if(saved)state=JSON.parse(saved);
  } catch {state={kind:'invalid'};error='上次范围无法恢复，请重新选择。';}
  function effectiveSelection(){return state.kind==='inherit'?getInheritedSelection():state;}
  function read(){const s=store.read();playlists=s.playlists;revision=s.revision;}
  function resolve(filters=getFilters()){return resolveCalculationScope({...data,...filters,selection:effectiveSelection(),playlists,recommendations:recommended,context:store.context,fixedRangeTitle:getEnabled()?undefined:getFixedTitle()});}
  function refresh(){
    root.hidden=!getEnabled();
    if(key!==selectionKey()){key=selectionKey();try{state=JSON.parse(sessionStorage.getItem(key)??localStorage.getItem(key)??JSON.stringify({kind:getInheritedSelection?'inherit':'all'}));error='';}catch{state={kind:'invalid'};error='上次范围无法恢复，请重新选择。';}}
    try {read();}catch(e){error=e.message;playlists=[];}
    if(!state||typeof state!=='object')state={kind:'invalid'};
    const signature=JSON.stringify([getEnabled(),getFixedTitle(),state,revision,getFilters(),error,data.sourceReleaseId,data.charts.length,getInheritedSelection?.()]);if(signature===renderSignature)return;renderSignature=signature;
    const value=state.kind==='playlist'||state.kind==='recommended'?`${state.kind}:${state.id}`:state.kind;
    select.replaceChildren(option('all','全部可用谱面'));
    if(getInheritedSelection)select.append(option('inherit','同一歌单（与主阶段一致）'));
    const mine=el('optgroup');mine.label='我的歌单';for(const p of playlists)mine.append(option(`playlist:${p.id}`,p.name));select.append(mine);
    const rec=el('optgroup');rec.label='站点推荐候选';for(const p of recommended)rec.append(option(`recommended:${p.id}`,p.name));select.append(rec);
    if(state.kind==='temporary')select.append(option('temporary','本次临时范围'));
    if(![...select.options].some(o=>o.value===value))select.append(option(value,'所选歌单已删除，请重新选择'));
    select.value=value;issueList.replaceChildren();
    try {last=resolve();summary.textContent=`${last.songCount} 首 / ${last.chartCount} 张谱面${last.adjusted?' · 本次已调整':state.kind==='inherit'?' · 跟随主阶段':''}`;root.dataset.scopeState=last.chartCount?'ready':'empty';for(const i of last.excluded){const title=data.tracks.find(t=>t.id===i.trackId)?.title??i.trackId;issueList.append(el('li',`${title}${i.difficulty?' · '+i.difficulty.toUpperCase():''}：${i.message}`));}issueTitle.textContent=`${last.excluded.length} 个条目未参与`;issues.hidden=!last.excluded.length;
      const selection=effectiveSelection();note.textContent=error||(recommended.find(p=>selection.kind==='recommended'&&p.id===selection.id)?.note??(last.adjusted?'临时调整尚未写入歌单，可恢复原范围。':'歌单在各工具共用；快速／完整比较仍独立设置。'));if(!last.chartCount)note.textContent='当前条件下没有可计算谱面，请调整范围或筛选条件。';
    }catch(e){last=null;root.dataset.scopeState='empty';summary.textContent=e.message;issues.hidden=true;note.textContent=error||'请重新选择歌单，或使用全部可用谱面。';}
    restore.hidden=!effectiveSelection()?.entries;expand.hidden=state.kind==='all'&&!state.entries&&Boolean(last?.chartCount);
  }
  function changed(){refresh();onChange();}
  function persist(){
    try {sessionStorage.setItem(key,JSON.stringify(state));const base={...state};delete base.entries;if(base.kind!=='temporary'){localStorage.setItem(key,JSON.stringify(base));if(base.kind!=='inherit')localStorage.setItem(recentKey,JSON.stringify(base));}error='';}catch{error='范围仅用于本次页面，浏览器未能保存选择。';}
    changed();
  }
  select.addEventListener('change',()=>{const [kind,id]=select.value.split(':');state={kind,...(id?{id}:{})};persist();});
  const attempt=fn=>async()=>{try{await fn();error='';refresh();}catch(e){error=e.message;refresh();}};
  const manage=()=>manager.showList();
  const restore=button('恢复原范围',()=>{delete state.entries;if(state.kind==='temporary')state={kind:'all'};persist();});
  const expand=button('扩大到全部可用谱面',()=>{state={kind:'all'};persist();});
  actions.append(button('管理歌单',attempt(manage)),button('调整本次范围',attempt(()=>{const s=effectiveSelection(),p=playlists.find(p=>s.kind==='playlist'&&p.id===s.id);const source=p??recommended.find(p=>s.kind==='recommended'&&p.id===s.id);edit({playlist:p,entries:s.entries??source?.entries??entriesFromCharts(data.charts),temporary:true});})),restore,expand);
  const notify=e=>{if(e.type==='storage'&&e.key!==store.key||e.type!=='storage'&&e.detail?.key!==store.key)return;changed();manager.refresh();};
  globalThis.addEventListener('storage',notify);globalThis.addEventListener('playlists:changed',notify);
  refresh();
  const api={root,store,refresh,openManager:manage,get enabled(){return getEnabled();},get selection(){return structuredClone(effectiveSelection());},get snapshot(){return last;},get summary(){return last?`${last.title}${last.adjusted?'（临时调整）':''} · ${last.songCount} 首 / ${last.chartCount} 张`: '范围不可用，请重新选择';},
    resolve(filters){if(getEnabled())read();return resolve(filters);},require(filters){return requireCalculationScope(this.resolve(filters));},
    saveCharts(charts){edit({entries:entriesFromCharts(charts)});},
    addCharts(charts){read();if(!playlists.length){edit({entries:entriesFromCharts(charts)});return;}const choose=document.createElement('dialog');choose.className='playlist-dialog';const body=el('div');body.className='task-dialog-body';body.append(el('h2','加入已有歌单'));choose.setAttribute('aria-label','加入已有歌单');const close=()=>{choose.close();choose.remove();};for(const p of playlists)body.append(button(p.name,()=>{close();edit({playlist:p,entries:normalizePlaylistEntries([...p.entries,...entriesFromCharts(charts)])});}));body.append(button('取消',close));choose.append(body);document.body.append(choose);choose.addEventListener('close',()=>choose.remove());choose.showModal();},
    carry(link){try{const token=crypto.randomUUID();sessionStorage.setItem(`${store.key}:handoff:${token}`,JSON.stringify(effectiveSelection()));const url=new URL(link.href,location.href),hash=new URLSearchParams(url.hash.slice(1));hash.set('calculation-range',token);url.hash=hash.toString();link.href=url.href;}catch{note.textContent='未能携带临时范围，请在目标工具重新选择歌单。';}},
    destroy(){delete root.playlistController;globalThis.removeEventListener('storage',notify);globalThis.removeEventListener('playlists:changed',notify);manager.close();editor.destroy();manager.destroy();root.remove();}
  };
  root.playlistController=api;return api;
}
