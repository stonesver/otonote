import {scopeSummary,selectedChartScope} from './calculation-scope.mjs';
import {eventRewardGrowthNote} from './event-reward-options.mjs';
import {currentEventDraft,eventTeamSaveButton,createEventTeamView} from './event-team-view.mjs';
import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {createCalculationProgress} from './calculation-progress.mjs';
import {createCalculationLiveUpdates,reconcileCalculationView} from './calculation-live-updates.mjs';
const fmt=n=>Math.round(n).toLocaleString('zh-CN');
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};

export function setupChallengeOptimizer(tool){
  const root=tool.q('challenge-optimizer'),q=s=>tool.querySelector(`[data-challenge-opt-${s}]`);
  const feedback=createCalculationProgress(q('status'),'challenge');
  let calculationScope=null;
  let worker=null,key='',results=null,paused=false,pausing=false,selectedTeam=null,resultTabs=null,articleCache=new Map(),tabCache=new Map();
  const updates=createCalculationLiveUpdates({hasResults:()=>Boolean(results?.results.length),onResult:result=>{results=result;render();},onProgress:showProgress});
  const stop=(publish=false)=>{worker?.terminate();worker=null;paused=false;pausing=false;updates.stop({flushResult:publish});q('cancel').hidden=true;q('run').disabled=false;q('run').textContent='推荐冲榜队伍';root.setAttribute('aria-busy','false');};
  const currentDraft=()=>currentEventDraft(tool);
  const fingerprint=()=>JSON.stringify({calculationScope:tool.calculationScope?.snapshot?.fingerprint,mode:tool.q('mode').value,event:tool.q('event').value,draft:currentDraft(),scope:q('scope').value,objective:q('objective').value,rewards:q('rewards')?.checked??false,rewardGrowth:q('reward-growth')?.value??'level',rewardGrowthOverride:q('rewards')?.checked??false});
  function sync(){
    root.hidden=tool.q('mode').value!=='challenge'||Boolean(tool.classList?.contains('task-workbench')&&tool.dataset.task!=='challenge');
    if(key!==fingerprint()){
      stop();feedback.reset();key=fingerprint();results=null;selectedTeam=null;resultTabs=null;articleCache.clear();tabCache.clear();q('results').replaceChildren();
      q('status').textContent=tool.draft.selectedSongId?'选择搜索范围，开始比较挑战出分。':'先在上方选择本期挑战歌曲和难度。';
    }
    const track=tool.data.tracks.find(t=>t.id===tool.draft.selectedSongId);
    q('song').textContent=track?`${track.title} · ${(tool.draft.selectedDifficulty??'expert').toUpperCase()}`:'尚未选择挑战歌曲';
    q('run').disabled=!!worker&&!paused||root.hidden||!track;
  }
  function summary(result,ongoing){
    const certificate=result.certifiedSearch;
    const counts=`候选阶段完整复算 ${result.practical?.finalists??0} 支队伍${certificate?`，上界搜索已展开 ${certificate.expanded??certificate.evaluated} 个分支、完整评估 ${certificate.evaluated} 次；${certificate.candidateBoundPruned??0} 个候选经上界排除，待检查 ${certificate.frontier??'未知'} 个分支`:''}。完整评分比较全部 120 种技能顺序。`;
    const proof=certificate?.bestProven?'已证明所选范围、当前模型内的最佳出分。备选仅供参考，未证明排名。':'尚未证明所选范围、当前模型内的最优。';
    const label=ongoing?'正在搜索最佳配队':result.status==='budget_exhausted'?'已达本轮搜索预算，可继续搜索':result.status==='paused'?'搜索已暂停，可继续搜索':['cancelled','aborted'].includes(result.status)?'搜索已停止':'冲榜配队比较结束';
    const bound=!certificate?.bestProven&&Number.isFinite(certificate?.upperBound)&&Number.isFinite(certificate?.optimalityGap)?`未排除的分数上界 ${fmt(certificate.upperBound)}，与当前最佳相差至多 ${fmt(certificate.optimalityGap)} 分。`:'';
    return {label,detail:`${counts}${proof}${bound}`};
  }
  function showProgress(data){
    if(pausing)return;
    const text=data.type==='snapshot'?summary(data.result,true):{
      label:'正在搜索最佳配队',
      detail:data.phase==='event-exact'
        ?`已检查 ${fmt(data.expanded??data.completed??0)} 个分支，完整评估 ${fmt(data.evaluated??0)} 次${Number.isFinite(data.frontier)?`，待检查 ${fmt(data.frontier)} 个分支`:''}。分支总数动态变化。`
        :`${data.stage} · ${data.completed??0} / ${data.total??'…'}`
    };
    if(Number.isFinite(data.elapsedMs))text.detail+=` 已用时 ${Math.floor(data.elapsedMs/1000)} 秒。`;
    feedback.update({...text,completed:data.completed,total:data.total});q('status').textContent=`${text.label}。${text.detail}`;
  }
  function render(){
    const view=[],nextArticles=new Map(),nextTabs=new Map(),focused=document.activeElement?.dataset?.challengeTeamKey;
    if(q('rewards')?.checked&&q('scope').value!=='reference')view.push(el('p',`本期兑换 / pt 奖励卡已纳入候选，并不保证入选队伍。${eventRewardGrowthNote(q('reward-growth').value,q('rewards')?.checked??false)}`,'task-event-reward-result-note'));
    if(results.searchScope==='reference')view.push(el('p','全卡库参考 · 卡片按满等级、满突破、满觉醒与满技能比较；账号加成沿用当前设置。','event-hint'));
    if(calculationScope)view.push(el('p',scopeSummary(calculationScope)));
    const tabs=resultTabs??=el('div',null,'task-event-result-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','冲榜候选队伍');view.push(tabs);
    const maximum=results.objective==='maximum_song_score',reference=results.searchScope==='reference';
    const identity=row=>row.draft.slots.map(slot=>`${slot.memberCardId}|${slot.supportCardId}`).join(';');
    const selected=results.results.find(row=>identity(row)===selectedTeam)??results.results[0];
    const buttons=[];
    for(const [index,row] of results.results.entries()){
      const id=identity(row),signature=JSON.stringify(row),cached=articleCache.get(id),reuse=cached?.signature===signature;
      const card=reuse?cached.card:el('article',null,'challenge-opt-result task-event-plan-enter');
      const heading=reuse?cached.heading:el('h4'),alternative=reuse?cached.alternative:el('p','备选仅供参考，未证明其排名。','event-hint');
      const label=index===0?(results.certifiedSearch?.bestProven?'最佳配队':'当前最佳候选'):`备选 ${index}`;
      card.hidden=row!==selected;alternative.hidden=index===0;
      const title=`${label} · ${maximum?'最高':'平均'}估计分 ${fmt(row.value)}`;if(heading.textContent!==title)heading.textContent=title;
      let tab=tabCache.get(id);if(!tab){tab=el('button');tab.type='button';tab.dataset.challengeTeamKey=id;tab.addEventListener('click',()=>{selectedTeam=id;render();});}
      if(tab.textContent!==label)tab.textContent=label;tab.setAttribute('aria-pressed',String(row===selected));buttons.push(tab);nextTabs.set(id,tab);
      if(!reuse){
        card.append(heading,el('p',`最高 ${fmt(row.maximumScore)} · 平均 ${fmt(row.expectedScore)} · 最低 ${fmt(row.minimumScore)}`,'event-hint'),alternative);
        card.append(el('p',`活动内综合力 ${fmt(row.power)}${reference?' · 满养成参考，不代表实际持有':row.delta==null?' · 当前队伍不完整或不在所选卡库，未作对比':` · 比当前队伍${row.delta>=0?'提高':'降低'} ${fmt(Math.abs(row.delta))} 分`}`));
        card.append(createEventTeamView(tool,row.draft,{mode:'challenge',eventId:Number(tool.q('event').value),summary:row}));
        const apply=el('button','应用这支挑战队伍');apply.type='button';apply.addEventListener('click',()=>{
          tool.teamWorkspaceContext.applyDraft(row.draft);tool.q('bonus-source').value='team';
          tool.q('team-status').textContent='已应用挑战出分候选（含队长、配对与养成）；奖励加成已按新队伍重算。稳定评分仍请按实打填写。';
          tool.render();q('status').textContent='队伍已应用到上方；可重新计算与新队伍比较。';
        });card.append(apply,eventTeamSaveButton(row.draft,'挑战出分队伍'));
      }
      nextArticles.set(id,{signature,card,heading,alternative});view.push(card);
    }
    reconcileCalculationView(tabs,buttons);reconcileCalculationView(q('results'),view);
    if(focused)nextTabs.get(focused)?.focus?.({preventScroll:true});articleCache=nextArticles;tabCache=nextTabs;
  }
  q('run').addEventListener('click',()=>{
    if(worker&&paused){paused=false;pausing=false;feedback.update({label:'正在搜索最佳配队',detail:'继续验证剩余分支，保留已找到的队伍'});q('run').disabled=true;q('cancel').hidden=false;root.setAttribute('aria-busy','true');worker.postMessage({type:'resume'});return;}
    if(worker)return;
    try{
      const draft=currentDraft();
      assertToolTeamCompatible(tool.teamWorkspaceContext,draft);
      calculationScope=tool.calculationScope?.require({allowedTrackIds:tool.data.rules.tables.ChallengeMusic.filter(r=>r._eventId===Number(tool.q('event').value)).map(r=>`music-${r._liveMusicId}`)});
      if(calculationScope)calculationScope=selectedChartScope(calculationScope,{...draft,selectedDifficulty:draft.selectedDifficulty??'expert'});
      const chart=tool.data.charts.find(c=>c.trackId===draft.selectedSongId&&c.difficulty===(draft.selectedDifficulty??'expert'));
      if(!chart?.analysisDataUrl)throw Error('该难度没有可计算谱面，请重新选歌');
      const scope=q('scope').value;
      const profile=scope==='owned'||q('rewards')?.checked?tool.personalGrowthStore.read():null;
      if(scope==='owned'&&!profile)throw Error('请先在卡库中导入并保存实际养成，或切换为当前十张卡');
      draft.selectedDifficulty=chart.difficulty;
      // Retain explicit scenario/account overrides while filling saved account values.
      draft.modifiers={...profile?.account,...draft.modifiers};
      results=null;selectedTeam=null;resultTabs=null;articleCache.clear();tabCache.clear();q('results').replaceChildren();
      worker=new Worker(new URL('./challenge-optimizer-worker.mjs',import.meta.url),{type:'module'});
      feedback.update({label:'准备冲榜配队',detail:'正在读取谱面与实际养成'});
      const active=worker;q('cancel').hidden=false;q('run').disabled=true;root.setAttribute('aria-busy','true');q('status').textContent='正在载入谱面与实际养成…';
      worker.addEventListener('message',({data})=>{
        if(worker!==active)return;
        if(data.type==='progress'){updates.progress(data);return;}
        if(data.type==='snapshot'){updates.result(data.result);updates.progress(data);return;}
        if(data.type==='result'){
          updates.stop();pausing=false;
          if(['paused','budget_exhausted'].includes(data.result.status)){
            paused=true;q('cancel').hidden=true;q('run').disabled=false;q('run').textContent='继续搜索';root.setAttribute('aria-busy','false');
          }else stop();
          results=data.result;render();const text=summary(results,false);
          feedback.finish(text.label,text.detail,results.certifiedSearch?.bestProven?'complete':'stopped');q('status').textContent=`${text.label}。${text.detail}`;
        }else {stop(true);q('status').textContent=`计算失败：${data.message}`;feedback.finish('计算失败',data.message,'error');}
      });
      worker.addEventListener('error',()=>{if(worker!==active)return;stop(true);q('status').textContent='计算服务加载失败，请重试。';feedback.finish('计算服务加载失败','请重试','error');});
      worker.postMessage({rules:tool.data.rules,eventId:Number(tool.q('event').value),draft,scope,inventory:profile?.inventory,objective:q('objective').value,analysisDataUrl:chart.analysisDataUrl,rewardCards:q('rewards')?.checked&&scope!=='reference'?tool.data.eventRewardCards?.[Number(tool.q('event').value)]??[]:[],rewardGrowth:q('reward-growth')?.value??'level',rewardGrowthOverride:q('rewards')?.checked??false});
    }catch(error){stop();feedback.finish('无法开始计算',error.message,'error');q('status').textContent=error.message;}
  });
  q('cancel').addEventListener('click',()=>{if(!worker||paused)return;pausing=true;updates.stop({flushResult:true});feedback.update({label:'正在暂停',detail:'保留当前队伍与搜索进度'});worker.postMessage({type:'pause'});q('cancel').hidden=true;q('status').textContent='正在暂停，保留当前搜索进度…';});
  root.addEventListener('change',event=>{event.stopPropagation();sync();});
  return {sync,invalidate:()=>{key='';stop();sync();},destroy:()=>{stop();feedback.destroy();}};
}
