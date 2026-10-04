import {currentEventDraft,eventTeamSaveButton} from './event-team-view.mjs';
import {assertToolTeamCompatible} from './shared-team-context.mjs';
import {skillActivation} from './skill-activation-view.mjs';
const fmt=n=>Math.round(n).toLocaleString('zh-CN');
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};

export function setupChallengeOptimizer(tool){
  const root=tool.q('challenge-optimizer'),q=s=>root.querySelector(`[data-challenge-opt-${s}]`);
  let worker=null,key='',results=null;
  const cards=Object.fromEntries(['member','support'].map(kind=>[kind,new Map(tool.data[`${kind}Cards`].map(c=>[c.id,c]))]));
  const stop=()=>{worker?.terminate();worker=null;q('cancel').hidden=true;q('run').disabled=false;root.setAttribute('aria-busy','false');};
  const currentDraft=()=>currentEventDraft(tool);
  const fingerprint=()=>JSON.stringify({mode:tool.q('mode').value,event:tool.q('event').value,draft:currentDraft(),scope:q('scope').value,objective:q('objective').value});
  function sync(){
    root.hidden=tool.q('mode').value!=='challenge';
    if(key!==fingerprint()){
      stop();key=fingerprint();results=null;q('results').replaceChildren();
      q('status').textContent=tool.draft.selectedSongId?'选择搜索范围，开始比较挑战出分。':'先在上方选择本期挑战歌曲和难度。';
    }
    const track=tool.data.tracks.find(t=>t.id===tool.draft.selectedSongId);
    q('song').textContent=track?`${track.title} · ${(tool.draft.selectedDifficulty??'expert').toUpperCase()}`:'尚未选择挑战歌曲';
    q('run').disabled=!!worker||root.hidden||!track;
  }
  function render(){
    q('results').replaceChildren();
    const maximum=results.objective==='maximum_song_score';
    for(const [index,row] of results.results.entries()){
      const card=el('article',null,'challenge-opt-result');
      card.append(el('h4',`候选 ${index+1} · ${maximum?'最高':'平均'}估计分 ${fmt(row.value)}`));
      card.append(el('p',`最高 ${fmt(row.maximumScore)} · 平均 ${fmt(row.expectedScore)} · 最低 ${fmt(row.minimumScore)}`,'event-hint'));
      card.append(el('p',`活动内综合力 ${fmt(row.power)}${row.delta==null?' · 当前队伍不完整或不在所选卡库，未作对比':` · 比当前队伍${row.delta>=0?'提高':'降低'} ${fmt(Math.abs(row.delta))} 分`}`));
      const list=el('ol',null,'challenge-opt-pairs');
      for(const [i,slot] of row.draft.slots.entries()){
        const item=el('li');item.append(el('strong',i===2?'队长':`位置 ${i+1}`));
        for(const kind of ['member','support']){
          const id=slot[`${kind}CardId`],c=cards[kind].get(id),growth=row.draft.modifiers.growth?.[id]??{};
          const pair=el('div',null,'challenge-opt-card');
          if(c?.imageUrl){const image=el('img');image.src=c.imageUrl;image.alt='';image.loading='lazy';image.addEventListener('error',()=>image.remove(),{once:true});pair.append(image);}
          pair.append(el('span',`${c?.displayName??id}（Lv.${growth.level??'默认上限'} / 突破 ${growth.rank??1}${kind==='member'?` / 技能 ${growth.skillLevel??1}`:''}）`));item.append(pair);
        }
        list.append(item);
      }
      card.append(list,skillActivation(tool,row.draft,{mode:'challenge',eventId:Number(tool.q('event').value)}));
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
      const profile=scope==='owned'?tool.personalGrowthStore.read():null;
      if(scope==='owned'&&!profile)throw Error('请先在卡库中导入并保存实际养成，或切换为当前十张卡');
      draft.selectedDifficulty=chart.difficulty;
      // Retain explicit scenario/account overrides while filling saved account values.
      draft.modifiers={...profile?.account,...draft.modifiers};
      results=null;q('results').replaceChildren();
      worker=new Worker(new URL('./challenge-optimizer-worker.mjs',import.meta.url),{type:'module'});
      const active=worker;q('cancel').hidden=false;q('run').disabled=true;root.setAttribute('aria-busy','true');q('status').textContent='正在载入谱面与实际养成…';
      worker.addEventListener('message',({data})=>{
        if(worker!==active)return;
        if(data.type==='progress'){q('status').textContent=`${data.stage} · ${data.completed} / ${data.total??'…'}`;return;}
        stop();if(data.type==='result'){
          results=data.result;render();q('status').textContent=`已完整复算 ${results.practical.finalists} 支候选，每支比较 120 种技能顺序。展示搜索到的前三名，不保证全卡库最优。`;
        }else q('status').textContent=`计算失败：${data.message}`;
      });
      worker.addEventListener('error',()=>{if(worker!==active)return;stop();q('status').textContent='计算服务加载失败，请重试。';});
      worker.postMessage({rules:tool.data.rules,eventId:Number(tool.q('event').value),draft,scope,inventory:profile?.inventory,objective:q('objective').value,analysisDataUrl:chart.analysisDataUrl});
    }catch(error){stop();q('status').textContent=error.message;}
  });
  q('cancel').addEventListener('click',()=>{stop();q('status').textContent='已停止。可调整条件后重新计算。';});
  root.addEventListener('change',event=>{event.stopPropagation();sync();});
  return {sync,invalidate:()=>{key='';stop();sync();},destroy:stop};
}
