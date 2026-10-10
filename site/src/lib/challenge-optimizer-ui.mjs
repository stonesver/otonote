import {currentEventDraft,eventTeamSaveButton} from './event-team-view.mjs';
import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {createWorkbenchTeamView} from './workbench-team-view.mjs';
import {skillActivation} from './skill-activation-view.mjs';
import {createCalculationProgress} from './calculation-progress.mjs';
const fmt=n=>Math.round(n).toLocaleString('zh-CN');
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};

export function setupChallengeOptimizer(tool){
  const root=tool.q('challenge-optimizer'),q=s=>tool.querySelector(`[data-challenge-opt-${s}]`);
  const feedback=createCalculationProgress(q('status'),'challenge');
  let worker=null,key='',results=null;
  const stop=()=>{worker?.terminate();worker=null;q('cancel').hidden=true;q('run').disabled=false;root.setAttribute('aria-busy','false');};
  const currentDraft=()=>currentEventDraft(tool);
  const fingerprint=()=>JSON.stringify({mode:tool.q('mode').value,event:tool.q('event').value,draft:currentDraft(),scope:q('scope').value,objective:q('objective').value,rewards:q('rewards')?.checked??false,rewardGrowth:q('reward-growth')?.value??'level'});
  function sync(){
    root.hidden=tool.q('mode').value!=='challenge'||Boolean(tool.classList?.contains('task-workbench')&&tool.dataset.task!=='challenge');
    if(key!==fingerprint()){
      stop();feedback.reset();key=fingerprint();results=null;q('results').replaceChildren();
      q('status').textContent=tool.draft.selectedSongId?'选择搜索范围，开始比较挑战出分。':'先在上方选择本期挑战歌曲和难度。';
    }
    const track=tool.data.tracks.find(t=>t.id===tool.draft.selectedSongId);
    q('song').textContent=track?`${track.title} · ${(tool.draft.selectedDifficulty??'expert').toUpperCase()}`:'尚未选择挑战歌曲';
    q('run').disabled=!!worker||root.hidden||!track;
  }
  function render(){
    q('results').replaceChildren();
    if(q('rewards')?.checked&&q('scope').value!=='reference')q('results').append(el('p',`已临时纳入本期兑换 / pt 奖励卡。新增卡按${q('reward-growth').value==='maximum'?'全满养成假设':'满等级、初始突破 / 觉醒、技能 1'}计算；已持有卡保留实际养成。`,'task-event-reward-result-note'));
    const tabs=el('div',null,'task-event-result-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','冲榜候选队伍');q('results').append(tabs);
    const maximum=results.objective==='maximum_song_score';
    const reference=results.searchScope==='reference';
    if(reference)q('results').prepend(el('p','全卡库参考 · 卡片按满等级、满突破、满觉醒与满技能比较；账号加成沿用当前设置。','event-hint'));
    for(const [index,row] of results.results.entries()){
      const card=el('article',null,'challenge-opt-result');
      const label=reference?(index===0?'最佳配对':`备选 ${index}`):`候选 ${index+1}`;
      card.hidden=index!==0;const tab=el('button',label);tab.type='button';tab.setAttribute('aria-pressed',String(index===0));tab.addEventListener('click',()=>{for(const n of q('results').querySelectorAll('.challenge-opt-result'))n.hidden=n!==card;for(const b of tabs.children)b.setAttribute('aria-pressed',String(b===tab));});tabs.append(tab);
      card.append(el('h4',`${label} · ${maximum?'最高':'平均'}估计分 ${fmt(row.value)}`));
      card.append(el('p',`最高 ${fmt(row.maximumScore)} · 平均 ${fmt(row.expectedScore)} · 最低 ${fmt(row.minimumScore)}`,'event-hint'));
      card.append(el('p',`活动内综合力 ${fmt(row.power)}${reference?' · 满养成参考，不代表实际持有':row.delta==null?' · 当前队伍不完整或不在所选卡库，未作对比':` · 比当前队伍${row.delta>=0?'提高':'降低'} ${fmt(Math.abs(row.delta))} 分`}`));
      card.append(createWorkbenchTeamView(tool,row.draft),skillActivation(tool,row.draft,{mode:'challenge',eventId:Number(tool.q('event').value)}));
      const apply=el('button','应用这支挑战队伍');apply.type='button';apply.addEventListener('click',()=>{
        tool.teamWorkspaceContext.applyDraft(row.draft);
        tool.q('bonus-source').value='team';
        tool.q('team-status').textContent='已应用挑战出分候选（含队长、配对与养成）；奖励加成已按新队伍重算。稳定评分仍请按实打填写。';
        // Recompute the baseline after application; old deltas must not remain actionable.
        tool.render();q('status').textContent='队伍已应用到上方；可重新计算与新队伍比较。';
      });card.append(apply,eventTeamSaveButton(row.draft,`挑战队伍 ${index+1}`));q('results').append(card);
    }
  }
  q('run').addEventListener('click',()=>{
    if(worker)return;
    try{
      const draft=currentDraft();
      assertToolTeamCompatible(tool.teamWorkspaceContext,draft);
      const chart=tool.data.charts.find(c=>c.trackId===draft.selectedSongId&&c.difficulty===(draft.selectedDifficulty??'expert'));
      if(!chart?.analysisDataUrl)throw Error('该难度没有可计算谱面，请重新选歌');
      const scope=q('scope').value;
      const profile=scope==='owned'||q('rewards')?.checked?tool.personalGrowthStore.read():null;
      if(scope==='owned'&&!profile)throw Error('请先在卡库中导入并保存实际养成，或切换为当前十张卡');
      draft.selectedDifficulty=chart.difficulty;
      // Retain explicit scenario/account overrides while filling saved account values.
      draft.modifiers={...profile?.account,...draft.modifiers};
      results=null;q('results').replaceChildren();
      worker=new Worker(new URL('./challenge-optimizer-worker.mjs',import.meta.url),{type:'module'});
      feedback.update({label:'准备冲榜配队',detail:'正在读取谱面与实际养成'});
      const active=worker;q('cancel').hidden=false;q('run').disabled=true;root.setAttribute('aria-busy','true');q('status').textContent='正在载入谱面与实际养成…';
      worker.addEventListener('message',({data})=>{
        if(worker!==active)return;
        if(data.type==='progress'){feedback.update({label:data.stage,completed:data.completed,total:data.total,detail:'当前阶段进度 · 按所选范围比较出分'});q('status').textContent=`${data.stage} · ${data.completed} / ${data.total??'…'}`;return;}
        stop();if(data.type==='result'){
          results=data.result;render();feedback.finish('冲榜配队比较完成',`完整复算 ${results.practical.finalists} 支候选，每支比较 120 种技能顺序`);q('status').textContent=`${results.searchScope==='reference'?'已从全卡库生成并比较配对，':''}已完整复算 ${results.practical.finalists} 支候选，每支比较 120 种技能顺序。展示搜索到的前三名，不保证全卡库最优。`;
        }else {q('status').textContent=`计算失败：${data.message}`;feedback.finish('计算失败',data.message,'error');}
      });
      worker.addEventListener('error',()=>{if(worker!==active)return;stop();q('status').textContent='计算服务加载失败，请重试。';feedback.finish('计算服务加载失败','请重试','error');});
      worker.postMessage({rules:tool.data.rules,eventId:Number(tool.q('event').value),draft,scope,inventory:profile?.inventory,objective:q('objective').value,analysisDataUrl:chart.analysisDataUrl,rewardCards:q('rewards')?.checked&&scope!=='reference'?tool.data.eventRewardCards?.[Number(tool.q('event').value)]??[]:[],rewardGrowth:q('reward-growth')?.value??'level'});
    }catch(error){stop();feedback.finish('无法开始计算',error.message,'error');q('status').textContent=error.message;}
  });
  q('cancel').addEventListener('click',()=>{stop();feedback.finish('已停止','可调整条件后重新计算','stopped');q('status').textContent='已停止。可调整条件后重新计算。';});
  root.addEventListener('change',event=>{event.stopPropagation();sync();});
  return {sync,invalidate:()=>{key='';stop();sync();},destroy:stop};
}
