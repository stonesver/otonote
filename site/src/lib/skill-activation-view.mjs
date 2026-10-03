import {activationRows, playbackDuration, noteDensity} from './skill-activation-model.mjs';
const say = (zh,en) => document.documentElement.lang.startsWith('en') ? en : zh;
const el = (tag,text,cls) => {const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt = n => Number.isFinite(n) ? n.toLocaleString(undefined,{maximumFractionDigits:2}) : '—';
const seconds = n => `${fmt(n/1000)} s`;
const effectNames = {2000:['得分提升','Score boost'],2004:['指定判定加分','Judgement score boost'],15000:['技能延长','Skill extension'],3001:['生命恢复','Life recovery'],12006:['判定转换','Judgement conversion'],13000:['JUST 计数加成','JUST count bonus'],12000:['COMBO 计数加成','COMBO count bonus'],11001:['LUCK 槽增益','LUCK gauge gain'],13002:['JUST 累计加成','Cumulative JUST bonus'],11002:['LUCK 点数追加','Extra LUCK points'],11003:['LUCK 槽追加','Extra LUCK gauge'],2001:['得分提升','Score boost'],4004:['JUST 判定扩大','JUST window'],11005:['LUCK 抽奖保底','LUCK minimum result'],13005:['Perfect 转 JUST','Perfect to JUST'],12004:['判定辅助','Judgement assistance']};
const effectName = type => effectNames[type] ? say(...effectNames[type]) : say('技能效果','Skill effect');
const label = (variant,random) => variant.kind==='explicit' ? say('指定判定回放','Entered performance') : variant.kind==='best' ? (random?say('最高分样本','Highest sample'):say('最高分顺序','Highest order')) : (random?say('最低分样本','Lowest sample'):say('最低分顺序','Lowest order'));
function cardFor(data,kind,id){return data?.[`${kind}Cards`]?.find(c=>c.id===id);}
function portrait(card){if(!card?.imageUrl)return null;const img=el('img');img.src=card.imageUrl;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.remove(),{once:true});return img;}
function skillName(data,skill,slot){return cardFor(data,'member',skill.memberCardId)?.displayName ?? say(`技能 ${slot+1}`,`Skill ${slot+1}`);}
function effectsList(data,skill,events=[]){
  const list=el('ul',null,'activation-effects');
  for(const [kind,effects] of [['member',skill.liveEffects??[]],['support',skill.supportEffects??[]]])for(const effect of effects){
    const traced=events.find(e=>e.effectId===effect.id),active=traced?.active??effect.active;
    const item=el('li');item.dataset.active=String(Boolean(active));
    const name=kind==='support'?cardFor(data,kind,skill.supportCardId)?.displayName:null;
    const state=active?say('生效','Active'):say('条件未满足','Condition unmet');
    let value=effect.rate!=null?` +${fmt(effect.rate*100)}%`:effect.type===15000?` +${seconds(effect.value)}`:'';
    item.append(el('strong',`${effectName(effect.type)}${value}`),el('span',state,'activation-state'));
    if(name)item.append(el('small',name));
    if(effect.durationMs!=null)item.append(el('small',say(`持续 ${seconds(effect.durationMs)}`,`Duration ${seconds(effect.durationMs)}`)));
    if(active&&effect.contribution?.startsWith('no_score_change'))item.append(el('small',say('当前 AP／满生命条件下不增加分数','No score gain under the current AP / full-life assumptions')));
    if(traced?.currentLife!=null)item.append(el('small',say(`判定条件时生命 ${fmt(traced.currentLife)}`,`Life at condition check: ${fmt(traced.currentLife)}`)));
    list.append(item);
  }
  return list;
}
export function renderSkillActivation(root,result,data={}){
  root.replaceChildren();const playback=result.skillPlayback;
  if(!playback){
    root.append(el('p',say('尚未指定歌曲，以下为 AP／满生命条件下的配对效果；选歌后可查看发动时间。','No chart selected. Pair effects below assume AP and full life; select a song for timing.')));
    for(const skill of result.skills??[]){root.append(el('h4',skillName(data,skill,skill.slotIndex)),effectsList(data,skill));}return;
  }
  const heading=el('div',null,'activation-heading');heading.append(el('div',say('技能发动时间轴','Skill activation timeline'),'activation-title'));
  const power=result.power;heading.append(el('small',say(`本次综合力 ${fmt(power)}`,`Power ${fmt(power)}`)));root.append(heading);
  const controls=el('div',null,'activation-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label',say('回放顺序','Replay order'));root.append(controls);
  const canvas=el('div');root.append(canvas);
  function draw(index){
    canvas.replaceChildren();[...controls.children].forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
    const variant=playback.variants[index],rows=activationRows(playback,variant),duration=playbackDuration(playback,variant);
    const summary=el('div',null,'activation-score');summary.append(el('strong',fmt(variant.score)),el('span',label(variant,playback.randomSampling)));
    if(playback.randomSampling&&variant.seed!=null)summary.append(el('small',`Seed ${variant.seed}`));canvas.append(summary);
    canvas.append(el('p',variant.kind==='explicit'?say('按导入的判定与指定顺序回放。点击时间条查看当时的技能条件。','Replayed from the entered judgements and skill order. Select an activation to inspect its conditions.'):say('平均分来自多种顺序，不对应单次发动。点击下方时间条，查看这一次的技能与音符。','The mean combines multiple orders. Select a timeline row to inspect one activation.'),'activation-caption'));
    if(data.ranking)canvas.append(el('p',say('此处按当前技能逐谱精算；快速参考值可能与本次回放分数不同。','This view replays the current skills exactly; quick estimates may differ.'),'activation-caption'));
    const scale=el('div',null,'activation-scale');for(let i=0;i<=4;i++)scale.append(el('span',seconds(duration*i/4)));canvas.append(scale);
    const density=el('div',null,'activation-density');density.setAttribute('aria-label',say('音符密度','Note density'));
    const bins=noteDensity(variant.notes,duration),max=Math.max(1,...bins);for(const n of bins){const bar=el('i');bar.style.height=`${Math.max(2,n/max*100)}%`;density.append(bar);}canvas.append(density);
    const lanes=el('div',null,'activation-lanes'),inspection=el('div',null,'activation-inspection');canvas.append(lanes,inspection);
    function select(row){
      for(const button of lanes.children)button.setAttribute('aria-pressed',String(Number(button.dataset.position)===row.position));
      inspection.replaceChildren();inspection.style.setProperty('--activation-color',`var(--activation-${row.slotIndex})`);
      inspection.append(el('h4',`${say('第','Activation ')}${row.position+1}${say('次发动 · ',' · ')}${skillName(data,row.skill,row.slotIndex)}`));
      const stats=el('dl',null,'activation-stats');
      for(const [name,value] of [[say('发动时刻','Start'),seconds(row.startMs)],[say('得分效果结束','Score effect ends'),row.windows.length?seconds(row.endMs):'—'],[say('留影延长','Extension'),seconds(row.skill.extensionMs??0)],[say('窗口内音符','Notes in windows'),fmt(row.covered.length)]]){const cell=el('div');cell.append(el('dt',name),el('dd',value));stats.append(cell);}inspection.append(stats,effectsList(data,row.skill,row.skillTrace));
      if(!row.windows.length)inspection.append(el('p',say('本次没有生效的得分窗口；其他技能效果见上方。','No active score window for this activation. Other effects are listed above.')));
      const detail=el('details',null,'activation-notes');detail.append(el('summary',say(`查看覆盖音符 · ${row.covered.length} 个`,`Inspect covered notes · ${row.covered.length}`)));
      detail.append(el('p',say('按技能生效时间段统计，结束时刻不计入。音符分数包含当时所有效果，不是这张卡独立贡献；重叠窗口不能相加。','Coverage uses active time windows, excluding the end timestamp. Note scores include all effects, not an additive contribution from this card.')));
      const table=el('table'),thead=el('thead'),tr=el('tr');for(const text of [say('时间','Time'),say('总加分倍率','Combined score factor'),say('音符得分','Note score')])tr.append(el('th',text));thead.append(tr);table.append(thead);
      const body=el('tbody');table.append(body);detail.append(table);let page=0;const pager=el('div',null,'activation-pager'),prev=el('button',say('上一页','Previous')),next=el('button',say('下一页','Next')),status=el('span');prev.type=next.type='button';
      const paint=()=>{body.replaceChildren();for(const n of row.covered.slice(page*20,page*20+20)){const line=el('tr');line.append(el('td',seconds(n.timeMs)),el('td',`${fmt(n.scoreUpFactor)}×`),el('td',fmt(n.score)));body.append(line);}prev.disabled=!page;next.disabled=(page+1)*20>=row.covered.length;status.textContent=`${page+1} / ${Math.max(1,Math.ceil(row.covered.length/20))}`;};
      prev.addEventListener('click',()=>{page--;paint();});next.addEventListener('click',()=>{page++;paint();});pager.append(prev,status,next);detail.append(pager);paint();inspection.append(detail);
    }
    for(const row of rows){
      const button=el('button',null,'activation-lane');button.type='button';button.dataset.position=row.position;button.style.setProperty('--activation-color',`var(--activation-${row.slotIndex})`);
      const identity=el('span',null,'activation-identity');const img=portrait(cardFor(data,'member',row.skill.memberCardId));if(img)identity.append(img);identity.append(el('b',String(row.position+1)),el('span',skillName(data,row.skill,row.slotIndex)));
      const track=el('span',null,'activation-track');for(const w of row.windows){const bar=el('span',null,'activation-window');bar.style.left=`${w.startMs/duration*100}%`;bar.style.width=`${Math.max(.25,(w.endMs-w.startMs)/duration*100)}%`;track.append(bar);}const pin=el('span',null,'activation-pin');pin.style.left=`${row.startMs/duration*100}%`;track.append(pin);
      button.append(identity,track,el('span',seconds(row.startMs),'activation-time'));button.setAttribute('aria-label',`${skillName(data,row.skill,row.slotIndex)} · ${seconds(row.startMs)}`);button.addEventListener('click',()=>select(row));lanes.append(button);
    }
    if(rows.length)select(rows[0]);
    if(playback.effects?.length){
      const details=el('details',null,'activation-gekisou');details.append(el('summary',say('激奏技能 · 发动记录','Gekisou skills · Activation log')));
      details.append(el('p',say('仅对应当前回放。记录发动、结束和加分变化；未出现记录可能是条件、区段或概率未满足。随机样本的极值不是理论极值。','This log belongs to the current replay, including starts, ends and score changes. Conditions, sections or chance can prevent events. Random sample extremes are not theoretical bounds.')));
      for(const effect of playback.effects){const events=(variant.skillTransitions??[]).filter(e=>e.source===effect.source);const item=el('details');item.append(el('summary',`${cardFor(data,'member',effect.sourceCardId)?.displayName??cardFor(data,'support',effect.sourceCardId)?.displayName??say(`位置 ${effect.slotIndex+1}`,`Slot ${effect.slotIndex+1}`)} · ${effectName(effect.type)} · ${events.length} ${say('条记录','events')}`));
        if(!events.length)item.append(el('p',effect.active?say('本次没有记录到发动或效果变化','No activation or effect change recorded in this replay'):say('条件未满足','Condition unmet')));
        for(const e of events)item.append(el('p',`${seconds(e.timeMs)} · ${say('第','Section ')}${e.sectionIndex}${say('段','')} · ${e.action==='start'?say('发动','Start'):e.action==='factor'?say(`加分效果更新为 +${fmt(e.value*100)}%`,`Score effect updated to +${fmt(e.value*100)}%`):e.action==='bonus'?say(`追加 ${fmt(e.value)} LUCK 点数`,`Add ${fmt(e.value)} LUCK points`):e.action==='gauge'?say('追加 LUCK 槽','Add LUCK gauge'):say('结束','End')}`));details.append(item);}canvas.append(details);
    }
  }
  playback.variants.forEach((v,i)=>{const b=el('button',label(v,playback.randomSampling));b.type='button';b.addEventListener('click',()=>draw(i));controls.append(b);});draw(0);
}
class SkillActivation extends HTMLElement {
  connectedCallback(){if(this.initialized)return;this.initialized=true;const details=el('details',null,'skill-activation');details.append(el('summary',say('查看技能发动','View skill activations')));const body=el('div',null,'activation-body');details.append(body);this.append(details);
    details.addEventListener('change',event=>event.stopPropagation());
    details.addEventListener('toggle',()=>{if(!details.open){this.stop();return;}if(this.result){renderSkillActivation(body,this.result,this.data);return;}this.load(body);});
  }
  stop(){this.worker?.terminate();this.worker=null;}
  disconnectedCallback(){this.stop();}
  load(body){
    this.stop();body.replaceChildren(el('p',say('正在重放这支队伍的技能…','Replaying skill activations…')));body.setAttribute('aria-busy','true');
    const fail=message=>{this.stop();body.removeAttribute('aria-busy');body.replaceChildren(el('p',message));const retry=el('button',say('重试','Retry'));retry.type='button';retry.addEventListener('click',()=>this.load(body));body.append(retry);};
    try{const worker=new Worker(new URL('./skill-activation-worker.mjs',import.meta.url),{type:'module'});this.worker=worker;
      worker.onmessage=({data})=>{if(this.worker!==worker)return;if(data.error){fail(data.error);return;}this.stop();body.removeAttribute('aria-busy');this.result=data.result;renderSkillActivation(body,this.result,this.data);};
      worker.onerror=()=>{if(this.worker===worker)fail(say('技能记录加载失败，请重试','Could not load skill records. Try again.'));};worker.postMessage(this.payload);
    }catch(error){fail(error.message);}
  }
}
if(!customElements.get('skill-activation'))customElements.define('skill-activation',SkillActivation);
export function skillActivation(tool,draft,options={}){
  const data=tool.data??tool,view=document.createElement('skill-activation');view.data={memberCards:data.memberCards,supportCards:data.supportCards,ranking:Boolean(options.ranking)};
  const copy=draft?structuredClone(draft):null;
  const chart=options.chart??data.charts?.find(c=>c.trackId===copy?.selectedSongId&&c.difficulty===copy?.selectedDifficulty);
  view.payload={rules:data.formalRules??data.rules,draft:copy,chart:options.conditionsOnly?null:chart,mode:options.mode??'ordinary',scenario:options.scenario,eventId:options.eventId,ranking:options.ranking,conditionsOnly:options.conditionsOnly};
  view.result=options.result;return view;
}
