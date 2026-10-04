import {skillActivation} from './skill-activation-view.mjs';
import {registerToolTeamContext, notifyToolTeamChanged, assertToolTeamCompatible} from './shared-team-context.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';
import {createTeamDraft,parseTeamDraftSearch,serializeTeamDraftSearch} from './team-draft.mjs';
import {createPersonalGrowthStore,applyPersonalGrowth} from './personal-growth-store.mjs';
import {preparePresetDraft} from './preset-portfolio.mjs';
import {eventSongCandidates} from './event-song-ranking.mjs';
import {applyAPBasis,eventToolSearch,AP_BASES} from './ap-grade.mjs';
import {toolRoute} from './tool-route.mjs';
const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:0}),grade=r=>['D','C','B','A','S','SS'][r-2];
class APGradeTool extends HTMLElement{
 connectedCallback(){
  if(this.ready)return;this.ready=true;this.q=s=>this.querySelector(`[data-ap-${s}]`);this.data=JSON.parse(this.q('inputs').textContent);
  const d=this.data,params=new URLSearchParams(location.search);
  const parsed=parseTeamDraftSearch(location.search,{memberCardIds:new Set(d.memberCards.map(c=>c.id)),supportCardIds:new Set(d.supportCards.map(c=>c.id)),musicTrackIds:new Set(d.tracks.map(c=>c.id))});
  this.draft=createTeamDraft(parsed.draft);delete this.draft.modifiers.event;this.rows=null;this.page=0;
  try{this.profile=createPersonalGrowthStore({rules:d.rules,vipRanks:d.vipRanks}).read();applyPersonalGrowth(this.draft,this.profile);}
  catch(e){this.q('status').textContent=`个人养成未载入：${e.message}`;}
  if(params.get('eventMode')==='challenge'&&this.q('event').options.length)this.q('mode').value='challenge';
  if([...this.q('event').options].some(o=>o.value===params.get('eventId')))this.q('event').value=params.get('eventId');
  if(AP_BASES.includes(params.get('apBasis')))this.q('basis').value=params.get('apBasis');
  this.eventContext={boost:params.get('boost')??1,cost:params.get('cost')??200};
  for(const k of ['mode','event','difficulty','level','eco'])this.q(k).addEventListener('change',()=>this.invalidate());
  for(const k of ['basis','sort'])this.q(k).addEventListener('change',()=>{this.page=0;this.renderRows();});
  this.q('query').addEventListener('input',()=>{this.page=0;this.renderRows();});
  this.q('run').addEventListener('click',()=>this.run());this.q('cancel').addEventListener('click',()=>{this.stop();this.q('status').textContent='已停止判档计算。';});
  for(const [k,delta] of [['prev',-1],['next',1]])this.q(k).addEventListener('click',()=>{this.page+=delta;this.renderRows();});
  this.shortcuts=setupQuickOptions(this);
  this.renderTeam();this.renderRows();this.q('event-wrap').hidden=this.q('mode').value!=='challenge';
  this.teamWorkspaceCleanup=registerToolTeamContext(this,{
   data:this.data,rules:this.data.rules,label:'AP 达档',getDraft:()=>this.draft,
   getRestrictions:()=>({}),invalidate:()=>this.invalidate(),
   applyDraft:draft=>{this.draft=createTeamDraft(draft);this.renderTeam();},
   onInventoryChange:profile=>{this.profile=profile;}
  });
 }
 disconnectedCallback(){this.teamWorkspaceCleanup?.();this.stop();this.shortcuts?.destroy();}
 stop(){this.worker?.terminate();this.worker=null;this.q('cancel').hidden=true;this.q('run').disabled=false;this.removeAttribute('aria-busy');}
 invalidate(){this.stop();this.rows=null;this.page=0;this.q('failures').replaceChildren();this.q('status').textContent='队伍或谱面范围改变，请重新计算。';this.q('event-wrap').hidden=this.q('mode').value!=='challenge';this.renderRows();}
 renderTeam(){
  const root=this.q('team');root.replaceChildren();
  for(const [i,slot] of this.draft.slots.entries()){
   const row=el('div');row.className='ap-team-row';row.append(el('strong',i===2?'队长':`位置 ${i+1}`));
   for(const kind of ['member','support']){
    const label=el('label',kind==='member'?'成员':'留影'),id=slot[`${kind}CardId`];
    const preview=this.data[`${kind}Cards`].find(c=>c.id===id),button=el('button');button.type='button';button.className='ap-card-choice';button.dataset.chooseSlot=String(i);button.dataset.chooseKind=kind;
    button.setAttribute('aria-label',`位置 ${i+1} ${kind==='member'?'成员':'留影'}：${preview?.displayName??'未选择'}`);
    if(preview?.imageUrl){const img=el('img');img.src=preview.imageUrl;img.alt='';img.loading='lazy';button.append(img);}
    button.append(el('span',preview?.displayName??`＋ 选择${kind==='member'?'成员':'留影'}`));button.dataset.openTeamWorkspace='teams';
    const g=this.draft.modifiers.growth?.[id]??{},meta=el('span',id?`Lv.${g.level??'默认上限'} · 突破 ${g.rank??1}${kind==='member'?` · 技能 ${g.skillLevel??1}`:''}`:'');meta.className='ap-card-meta';label.append(button,meta);row.append(label);
   }root.append(row);
  }
  this.q('growth').textContent=this.profile?'已读取本区服保存的卡库与账号加成。上方显示此次计算采用的等级、突破和技能。':'尚未导入养成；未设置的卡片使用计算器默认值。可在“卡库与队伍”中导入或补全养成。';
  notifyToolTeamChanged(this.teamWorkspaceContext);
 }
 run(){
  if(this.worker)return;
  try{
   assertToolTeamCompatible(this.teamWorkspaceContext);
   preparePresetDraft(this.data.rules,this.draft,{maximizeTrainable:false});
   const mode=this.q('mode').value,eventId=Number(this.q('event').value),level=Number(this.q('level').value);
   if(!Number.isInteger(level)||level<1||level>40)throw Error('最高等级需为 1–40 的整数');
   const allowed=mode==='challenge'?this.data.rules.tables.ChallengeMusic.filter(r=>r._eventId===eventId).map(r=>'music-'+r._liveMusicId):null;
   const candidates=eventSongCandidates({...this.data,allowedTrackIds:allowed,difficulty:this.q('difficulty').value,maxLevel:level});
   if(!candidates.length)throw Error('没有符合条件的谱面');
   this.rows=null;this.page=0;this.renderRows();this.q('failures').replaceChildren();this.q('run').disabled=true;this.q('cancel').hidden=false;this.setAttribute('aria-busy','true');
   const worker=this.worker=new Worker(new URL('./ap-grade-worker.mjs',import.meta.url),{type:'module'});
   worker.addEventListener('message',({data})=>{
    if(this.worker!==worker)return;
    if(data.type==='progress'){this.q('status').textContent=`正在预测 ${data.done} / ${data.total} 张谱面…`;return;}
    this.stop();if(data.type==='result'){
     this.rows=data.rows;this.q('status').textContent=`已预测 ${data.rows.length} 张谱面${data.failures.length?`，${data.failures.length} 张失败，结果不完整`:''}。切换判档依据或排序无需重新计算。`;this.renderRows();
     if(data.failures.length){const details=el('details');details.append(el('summary','查看未成功的谱面'));for(const f of data.failures)details.append(el('p',`${f.title} ${f.difficulty}：${f.message}`));this.q('failures').append(details);}
    }else this.q('status').textContent=data.message;
   });
   worker.addEventListener('error',()=>{if(this.worker!==worker)return;this.stop();this.q('status').textContent='判档服务加载失败，请重试。';});
   this.q('status').textContent=`正在准备 ${candidates.length} 张谱面…`;
   worker.postMessage({rules:this.data.rules,draft:this.draft,candidates,mode,eventId,eco:this.q('eco').checked});
  }catch(e){this.stop();this.q('status').textContent=e.message;}
 }
 renderRows(){
  const root=this.q('results');root.replaceChildren();const basis=this.q('basis').value,sort=this.q('sort').value,query=this.q('query').value.trim().toLocaleLowerCase();
  const rows=(this.rows??[]).filter(r=>r.title.toLocaleLowerCase().includes(query)).map(r=>applyAPBasis(r,basis));
  rows.sort((a,b)=>(sort==='grade'?b.scoreRank-a.scoreRank:sort==='score'?b.estimatedScore-a.estimatedScore:0)||(a.seconds??Infinity)-(b.seconds??Infinity)||a.level-b.level);
  const pages=Math.max(1,Math.ceil(rows.length/8));this.page=Math.min(this.page,pages-1);
  for(const r of rows.slice(this.page*8,this.page*8+8)){
   const card=el('article');card.className='event-rec-row';card.append(el('h3',`${r.title} · ${r.difficulty.toUpperCase()}`),el('p',`Lv.${r.level} · ${r.seconds==null?'时长未知':fmt(r.seconds)+' 秒'} · 综合力 ${fmt(r.power)}`),el('strong',`${grade(r.scoreRank)} 档 · AP ${fmt(r.estimatedScore)} 分`));
   const range=el('p',`估计范围 ${grade(r.minimumRank)}–${grade(r.maximumRank)} · ${fmt(r.minimumScore)}–${fmt(r.maximumScore)} 分`);range.className='ap-threshold';card.append(range,el('p',r.nextRank==null?'已达到最高档位':`距 ${grade(r.nextRank)} 档还差 ${fmt(r.nextRankGap)} 分`));
   if(r.gradeProbabilities){
     card.append(el('p',`P10 ${fmt(r.scoreDistribution.p10)} 分 · 顺序达档比例：${r.gradeProbabilities.filter(g=>g.rank>2).map(g=>`${grade(g.rank)} 及以上 ${fmt(g.atLeastProbability*100)}%`).join(' / ')}`));
     card.append(el('small','假定 120 种技能顺序等可能，均按 AP、满生命估算；比例不代表实战成功率。'));
   }
   const draft={...this.draft,selectedSongId:r.trackId,selectedDifficulty:r.difficulty};
   const links=el('div');links.className='ap-result-actions';const use=el('a','带入活动收益 →');use.href=toolRoute('/tools/event-efficiency/',location.pathname)+eventToolSearch(draft,{mode:r.mode,eventId:r.eventId||undefined,scoreRank:r.scoreRank,basis,...this.eventContext});links.append(use);
   if(r.mode==='ordinary'){const detail=el('a','查看分数明细');detail.href=toolRoute('/tools/song-calculator/',location.pathname)+serializeTeamDraftSearch(draft);links.append(detail);}
   card.append(links,skillActivation(this,draft,{mode:r.mode,eventId:r.eventId}));root.append(card);
  }
  if(!rows.length)root.append(el('p',this.rows?'没有符合搜索的歌曲。':'完成队伍后，点击计算查看各首歌的预估档位。'));
  this.q('page').textContent=`${this.page+1} / ${pages}`;this.q('prev').disabled=this.page===0;this.q('next').disabled=this.page===pages-1;
 }
}
if(!customElements.get('ap-grade-tool'))customElements.define('ap-grade-tool',APGradeTool);
