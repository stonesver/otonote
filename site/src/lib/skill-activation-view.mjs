import {renderGekisouPlayback} from './gekisou-playback-view.mjs';
import {createReplayClock, noteDensity,partitionActivationEffects} from './skill-activation-model.mjs';
const say = (zh,en) => document.documentElement.lang.startsWith('en') ? en : zh;
const el = (tag,text,cls) => {const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt = n => Number.isFinite(n) ? n.toLocaleString(undefined,{maximumFractionDigits:2}) : '—';
const seconds = n => `${fmt(n/1000)} s`;
const liveSeconds = n => `${Number.isFinite(n) ? (n/1000).toFixed(2) : '—'} s`;
const effectNames = {2000:['得分提升','Score boost'],2004:['指定判定加分','Judgement score boost'],15000:['技能延长','Skill extension'],3001:['生命恢复','Life recovery'],12006:['判定转换','Judgement conversion'],13000:['JUST 计数加成','JUST count bonus'],12000:['COMBO 计数加成','COMBO count bonus'],11001:['LUCK 槽增益','LUCK gauge gain'],13002:['JUST 累计加成','Cumulative JUST bonus'],11002:['LUCK 点数追加','Extra LUCK points'],11003:['LUCK 槽追加','Extra LUCK gauge'],2001:['得分提升','Score boost'],4004:['JUST 判定扩大','JUST window'],11005:['LUCK 抽奖保底','LUCK minimum result'],13005:['Perfect 转 JUST','Perfect to JUST'],12004:['判定辅助','Judgement assistance']};
const effectName = type => effectNames[type] ? say(...effectNames[type]) : say('技能效果','Skill effect');
const label = (variant,random) => variant.kind==='explicit' ? say('指定判定回放','Entered performance') : variant.kind==='best' ? (random?say('最高分样本','Highest sample'):say('最高分顺序','Highest order')) : (random?say('最低分样本','Lowest sample'):say('最低分顺序','Lowest order'));
function cardFor(data,kind,id){return data?.[`${kind}Cards`]?.find(c=>c.id===id);}
function portrait(card){if(!card?.imageUrl)return null;const img=el('img');img.src=card.imageUrl;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.remove(),{once:true});return img;}
function skillName(data,skill,slot){return cardFor(data,'member',skill.memberCardId)?.displayName ?? say(`技能 ${slot+1}`,`Skill ${slot+1}`);}
function effectsList(data,skill,events=[]){
  const root=el('div'),list=el('ul',null,'activation-effects'),{active:effective,inactive}=partitionActivationEffects(skill,events);
  function append(list,{kind,effect,traced},active){
    const item=el('li');item.dataset.active=String(Boolean(active));
    const name=kind==='support'?cardFor(data,kind,skill.supportCardId)?.displayName:null;
    const state=active?say('生效','Active'):say('条件未满足','Condition unmet');
    let value=effect.rate!=null?` +${fmt(effect.rate*100)}%`:effect.type===15000?` +${seconds(effect.value)}`:'';
    item.append(el('strong',`${effectName(effect.type)}${value}`),el('span',state,'activation-state'));
    item.append(el('small',kind==='member'?say('角色技能','Member skill'):say('留影支援','Snap support')));if(name)item.append(el('small',name));
    if(effect.durationMs!=null)item.append(el('small',say(`持续 ${seconds(effect.durationMs)}`,`Duration ${seconds(effect.durationMs)}`)));
    if(active&&effect.contribution?.startsWith('no_score_change'))item.append(el('small',say('当前 AP／满生命条件下不增加分数','No score gain under the current AP / full-life assumptions')));
    if(traced?.currentLife!=null)item.append(el('small',say(`判定条件时生命 ${fmt(traced.currentLife)}`,`Life at condition check: ${fmt(traced.currentLife)}`)));
    list.append(item);
  }
  root.append(list);for(const entry of effective)append(list,entry,true);
  if(inactive.length){const details=el('details',null,'activation-inactive-effects'),other=el('ul',null,'activation-effects');details.append(el('summary',say(`其他条件效果 · ${inactive.length} 项未生效`,`Other conditional effects · ${inactive.length} inactive`)),el('p',say('同一技能可以包含多个条件效果。以下条件本次未满足，不计入本次加成。','One skill can contain multiple conditional effects. These conditions were unmet and add no bonus.')));for(const entry of inactive)append(other,entry,false);details.append(other);root.append(details);}
  return root;
}
export function renderSkillActivation(root,result,data={}){
  root.stopReplay?.();
  root.replaceChildren();const playback=result.skillPlayback;
  if(!playback){
    root.append(el('p',say('尚未指定歌曲，以下为 AP／满生命条件下的配对效果；选歌后可查看发动时间。','No chart selected. Pair effects below assume AP and full life; select a song for timing.')));
    for(const skill of result.skills??[]){root.append(el('h4',skillName(data,skill,skill.slotIndex)),effectsList(data,skill));}return;
  }
  const heading=el('div',null,'activation-heading');heading.append(el('div',playback.ranges?say('技能与激奏回放','Skills & Gekisou replay'):say('技能发动时间轴','Skill activation timeline'),'activation-title'));
  const power=result.power;heading.append(el('small',say(`本次综合力 ${fmt(power)}`,`Power ${fmt(power)}`)));root.append(heading);let selectedSlot=null;const gekisouState={};
  const controls=el('div',null,'activation-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label',say('回放顺序','Replay order'));root.append(controls);
  const canvas=el('div',null,'activation-canvas');root.append(canvas);
  function draw(index){
    root.stopReplay?.();
    canvas.replaceChildren();[...controls.children].forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
    const variant=playback.variants[index],clock=createReplayClock(playback,variant,{stateTrace:result.stateTrace}),{rows,duration}=clock;
    const transport=el('div',null,'task-replay-controls'),play=el('button',say('播放','Play')),seek=el('input'),time=el('span',null,'task-replay-time'),speed=el('select'),liveState=el('p',null,'task-replay-state');
    time.style.setProperty('--replay-time-width',`${liveSeconds(duration).length*2+3}ch`);
    const next=el('button',say('下一次发动','Next activation')),reset=el('button',say('重置','Reset')),follow=el('button',say('跟随播放','Follow playback'));next.type=reset.type=follow.type='button';follow.setAttribute('aria-pressed','true');
    play.type='button';seek.type='range';seek.min=0;seek.max=duration;seek.step=1;seek.value=0;seek.setAttribute('aria-label',say('回放时刻','Replay time'));
    speed.setAttribute('aria-label',say('播放速度','Playback speed'));for(const value of [1,2,4]){const o=el('option',`${value}×`);o.value=value;speed.append(o);}transport.append(play,seek,time,speed,next,reset,follow);canvas.append(transport,liveState);
    let frame=null,previous=0,current=0,following=true,gekisouView,lastInspection=null;
    const nowPanel=el('section',null,'activation-now');nowPanel.setAttribute('aria-label',say('当前技能与音符','Current skills and notes'));const nowTitle=el('strong'),nowEffects=el('div',null,'activation-now-effects'),gkNow=el('div',null,'activation-now-effects');nowPanel.append(nowTitle,nowEffects,gkNow);canvas.append(nowPanel);
    const metrics=el('dl',null,'activation-live-metrics'),readings={};for(const [key,zh,en] of [['notes','已判定音符','Notes judged'],['factor','最近音符倍率','Last note score factor'],['life','LIFE','LIFE'],['rewards','已结算名次奖励','Settled rank rewards']]){const cell=el('div');cell.append(el('dt',say(zh,en)),readings[key]=el('dd','—'));metrics.append(cell);}canvas.append(metrics);
    function paintTime(){
      seek.value=String(current);time.textContent=`${liveSeconds(current)} / ${liveSeconds(duration)}`;
      const snapshot=clock.at(current),{active,note}=snapshot;
      const gkActive=gekisouView?.seek(current,{follow:following})?.activeEffects??[];
      cumulative.textContent=fmt(snapshot.score);progress.style.width=`${current/duration*100}%`;readings.notes.textContent=`${snapshot.count} / ${variant.notes?.length??0}`;readings.factor.textContent=note?`${fmt(note.scoreUpFactor)}×`:'—';readings.life.textContent=fmt(snapshot.life);readings.rewards.textContent=playback.ranges?.length?`+${fmt(snapshot.rewards)}`:say('不适用','N/A');
      for(const lane of lanes.children){const row=rows[Number(lane.dataset.position)],on=active.includes(row);lane.dataset.playing=String(on);lane.dataset.phase=current<row.startMs?'waiting':on?'active':'ended';lane.querySelector('.task-replay-cursor').style.left=`${current/duration*100}%`;lane.querySelector('.activation-time').textContent=current<row.startMs?say(`等待 ${liveSeconds(row.startMs-current)}`,`In ${liveSeconds(row.startMs-current)}`):on?say(`剩余 ${liveSeconds(row.endMs-current)}`,`${liveSeconds(row.endMs-current)} left`):say('已发动','Triggered');}
      liveState.textContent=snapshot.section?say(`第 ${snapshot.section.index} 段 · ${['','COMBO','LUCK','JUST'][snapshot.section.missionType]}`,`Section ${snapshot.section.index} · ${['','COMBO','LUCK','JUST'][snapshot.section.missionType]}`):say('普通演出区间','Ordinary live section');
      nowTitle.textContent=active.length||gkActive.length?say('正在生效的成员与留影效果','Active member and snap effects'):say('当前没有持续技能效果','No ongoing skill effects now');
      const gkKey=gkActive.map(({effect,window})=>`${effect.source}:${window.startMs}:${window.value??''}`).join(',');if(gkNow.dataset.activeKey!==gkKey){gkNow.dataset.activeKey=gkKey;gkNow.replaceChildren();for(const {effect,window} of gkActive){const cell=el('div',null,'activation-now-pair'),art=portrait(cardFor(data,effect.kind,effect.sourceCardId));if(art)cell.append(art);const copy=el('div');copy.append(el('strong',say(`激奏 · 位置 ${effect.slotIndex+1} · ${effect.kind==='support'?'留影':'成员'}`,`Gekisou · Slot ${effect.slotIndex+1} · ${effect.kind}`)),el('span',`${effectName(effect.type)}${[2000,2001].includes(effect.type)&&window.value!=null?' +'+fmt(window.value*100)+'%':''}`));cell.append(copy);gkNow.append(cell);}}
      const activeKey=active.map(r=>r.slotIndex).join(',');if(nowEffects.dataset.activeKey!==activeKey){nowEffects.dataset.activeKey=activeKey;nowEffects.replaceChildren();for(const row of active){const cell=el('div',null,'activation-now-pair');cell.dataset.slot=row.slotIndex;const art=portrait(cardFor(data,'member',row.skill.memberCardId));if(art)cell.append(art);const copy=el('div');copy.append(el('strong',say(`位置 ${row.slotIndex+1} · ${cardFor(data,'member',row.skill.memberCardId)?.relationLabel??skillName(data,row.skill,row.slotIndex)}`,`Slot ${row.slotIndex+1} · ${skillName(data,row.skill,row.slotIndex)}`)),el('span',null,'activation-now-boost'),el('span',say(`留影延长 ${seconds(row.skill.extensionMs??0)}`,`Snap extension ${seconds(row.skill.extensionMs??0)}`)),el('small',null,'activation-now-coverage'));cell.append(copy);nowEffects.append(cell);}}
      for(const cell of nowEffects.children){const row=rows.find(r=>r.slotIndex===Number(cell.dataset.slot)),covered=row.covered.filter(n=>n.timeMs<=current).length,rates={};for(const window of row.windows.filter(w=>w.startMs<=current&&current<w.endMs))for(const [key,value] of Object.entries(window.rates))rates[key]=(rates[key]??0)+value;cell.querySelector('.activation-now-boost').textContent=Object.entries(rates).map(([key,value])=>`${key==='general'?say('得分','Score'):key.toUpperCase()} +${fmt(value*100)}%`).join(' · ');cell.querySelector('.activation-now-coverage').textContent=say(`已覆盖 ${covered} / ${row.covered.length} 音符 · 剩余 ${liveSeconds(row.endMs-current)}`,`${covered} / ${row.covered.length} notes · ${liveSeconds(row.endMs-current)} left`);}
      const inspected=active.at(-1)??snapshot.last??rows[0];if(following&&inspected&&lastInspection!==inspected.slotIndex){select(inspected);lastInspection=inspected.slotIndex;}
      const info=inspection.querySelector('.activation-inspection-time');if(info)info.textContent=say(`当前回放 ${liveSeconds(current)} · ${current<rows.find(r=>r.slotIndex===selectedSlot)?.startMs?'尚未发动':active.some(r=>r.slotIndex===selectedSlot)?'得分窗口生效中':'当前无得分窗口'}`,`Replay time ${liveSeconds(current)}`);
      next.disabled=current>=duration;
    }
    function jump(value){current=Math.max(0,Math.min(duration,value));paintTime();}
    root.stopReplay=()=>{if(frame!=null)cancelAnimationFrame(frame);frame=null;play.textContent=say('播放','Play');};
    function tick(now){if(!root.isConnected){root.stopReplay();return;}current=Math.min(duration,current+(now-previous)*Number(speed.value));previous=now;paintTime();if(current>=duration)root.stopReplay();else frame=requestAnimationFrame(tick);}
    play.addEventListener('click',()=>{if(frame!=null){root.stopReplay();return;}if(current>=duration)jump(0);previous=performance.now();play.textContent=say('暂停','Pause');frame=requestAnimationFrame(tick);});seek.addEventListener('input',()=>jump(Number(seek.value)));next.addEventListener('click',()=>jump(clock.next(current)));reset.addEventListener('click',()=>{root.stopReplay();jump(0);});follow.addEventListener('click',()=>{following=!following;follow.setAttribute('aria-pressed',String(following));lastInspection=null;paintTime();});
    const summary=el('div',null,'activation-score');const scoreLabel=el('div',null,'activation-score-label');scoreLabel.append(el('span',label(variant,playback.randomSampling)),el('small',say('本次回放累计得分','Current replay score')));const cumulative=el('strong','0');cumulative.dataset.replayScore='';summary.append(scoreLabel,cumulative,el('small',say(`本样本最终 ${fmt(variant.score)} 分`,`${fmt(variant.score)} points when finished`)));
    const progressTrack=el('div',null,'activation-score-progress'),progress=el('i');progressTrack.append(progress);summary.append(progressTrack);
    if(playback.randomSampling&&variant.seed!=null)summary.append(el('small',`Seed ${variant.seed}`));canvas.insertBefore(summary,nowPanel);canvas.insertBefore(metrics,nowPanel);
    canvas.append(el('p',playback.ranges?.length?say('平均分不对应单次回放。选择段落与技能，查看本次样本的任务、奖励与发动变化。','The mean is not a single replay. Select a section and skill to inspect this sample’s missions, rewards and activations.'):variant.kind==='explicit'?say('按导入的判定与指定顺序回放。点击时间条查看当时的技能条件。','Replayed from the entered judgements and skill order. Select an activation to inspect its conditions.'):say('平均分来自多种顺序，不对应单次发动。点击下方时间条，查看这一次的技能与音符。','The mean combines multiple orders. Select a timeline row to inspect one activation.'),'activation-caption'));
    if(data.ranking)canvas.append(el('p',say('此处按当前技能逐谱精算；快速参考值可能与本次回放分数不同。','This view replays the current skills exactly; quick estimates may differ.'),'activation-caption'));
    let ordinaryRoot=canvas;
    if(playback.ranges?.length){
      gekisouView=renderGekisouPlayback(canvas,result,variant,data,{el,say,fmt,seconds,cardFor,portrait,effectName,onSeek:jump},gekisouState);
      ordinaryRoot=el('details',null,'gk-ordinary');ordinaryRoot.append(el('summary',say('普通演出技能 · 五人发动与覆盖','Ordinary live skills · Activations and coverage')));canvas.append(ordinaryRoot);
    }
    const stage=el('section',null,'activation-stage');stage.setAttribute('aria-label',say('技能发动时间谱','Skill activation tracks'));const stageHeader=el('div',null,'activation-stage-heading');stageHeader.append(el('strong',say('发动时间谱','Activation tracks')),el('span',say('点击音轨跳到发动时刻；详情跟随播放','Select a track to seek; details follow playback')));stage.append(stageHeader);ordinaryRoot.append(stage);const scale=el('div',null,'activation-scale');for(let i=0;i<=4;i++)scale.append(el('span',seconds(duration*i/4)));stage.append(scale);
    const density=el('div',null,'activation-density');density.setAttribute('aria-label',say('音符密度','Note density'));
    const bins=noteDensity(variant.notes,duration),max=Math.max(1,...bins);for(const n of bins){const bar=el('i');bar.style.height=`${Math.max(2,n/max*100)}%`;density.append(bar);}stage.append(density);
    const lanes=el('div',null,'activation-lanes'),inspection=el('div',null,'activation-inspection');stage.append(lanes);const legend=el('div',null,'activation-legend');legend.append(el('span',say('竖线 · 发动','Line · Start')),el('span',say('色块 · 得分窗口','Band · Score window')),el('span',say('上方柱形 · 音符密度','Bars above · Note density')));stage.append(legend);ordinaryRoot.append(inspection);
    function select(row){
      selectedSlot=row.slotIndex;
      for(const button of lanes.children)button.setAttribute('aria-pressed',String(Number(button.dataset.position)===row.position));
      inspection.replaceChildren();inspection.style.setProperty('--activation-color',`var(--activation-${row.slotIndex})`);
      const profile=el('div',null,'activation-profile'),art=el('div',null,'activation-pair-art');
      const memberArt=portrait(cardFor(data,'member',row.skill.memberCardId)),supportArt=portrait(cardFor(data,'support',row.skill.supportCardId));
      if(memberArt)art.append(memberArt);else art.append(el('b',String(row.position+1)));
      if(supportArt){supportArt.className='activation-support-art';art.append(supportArt);}
      const profileText=el('div');profileText.append(el('span',say(`第 ${row.position+1} 次发动 · 位置 ${row.slotIndex+1}`,`Activation ${row.position+1} · Slot ${row.slotIndex+1}`),'activation-eyebrow'),el('h4',skillName(data,row.skill,row.slotIndex)));
      const supportName=cardFor(data,'support',row.skill.supportCardId)?.displayName;
      if(supportName)profileText.append(el('p',say(`搭配留影 · ${supportName}`,`Snap · ${supportName}`)));
      profile.append(art,profileText);inspection.append(profile);
      inspection.append(el('p',null,'activation-inspection-time'));
      const stats=el('dl',null,'activation-stats');
      for(const [name,value] of [[say('发动时刻','Start'),seconds(row.startMs)],[say('得分效果结束','Score effect ends'),row.windows.length?seconds(row.endMs):'—'],[say('留影延长','Extension'),seconds(row.skill.extensionMs??0)],[say('窗口内音符','Notes in windows'),fmt(row.covered.length)]]){const cell=el('div');cell.append(el('dt',name),el('dd',value));stats.append(cell);}inspection.append(stats,el('p',say('以下为这次发动的条件记录；当前是否仍在生效见上方回放状态。','These conditions were recorded at activation. See the replay state above for effects active now.'),'activation-caption'),effectsList(data,row.skill,row.skillTrace));
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
      const cursor=el('i',null,'task-replay-cursor');track.append(cursor);button.append(identity,track,el('span',seconds(row.startMs),'activation-time'));button.title=skillName(data,row.skill,row.slotIndex);button.setAttribute('aria-label',`${skillName(data,row.skill,row.slotIndex)} · ${seconds(row.startMs)}`);button.addEventListener('click',()=>{select(row);lastInspection=row.slotIndex;jump(row.startMs);});
      button.addEventListener('keydown',event=>{const offsets={ArrowDown:1,ArrowUp:-1,ArrowRight:1,ArrowLeft:-1};let target;
        if(event.key in offsets)target=(row.position+offsets[event.key]+rows.length)%rows.length;
        else if(event.key==='Home')target=0;else if(event.key==='End')target=rows.length-1;else return;
        event.preventDefault();select(rows[target]);lastInspection=rows[target].slotIndex;jump(rows[target].startMs);lanes.children[target].focus();});lanes.append(button);
    }
    if(rows.length)select(rows.find(row=>row.slotIndex===selectedSlot)??rows[0]);
    paintTime();

  }
  playback.variants.forEach((v,i)=>{const b=el('button',label(v,playback.randomSampling));b.type='button';b.addEventListener('click',()=>draw(i));controls.append(b);});draw(0);
}
// Shared tool modules also import this file during server-side validation.
if(typeof HTMLElement!=='undefined'&&typeof customElements!=='undefined'&&!customElements.get('skill-activation')){
class SkillActivation extends HTMLElement {
  connectedCallback(){if(this.initialized)return;this.initialized=true;const details=el('details',null,'skill-activation');const summary=el('summary'),mark=el('span',null,'activation-mark');mark.setAttribute('aria-hidden','true');for(let i=0;i<5;i++)mark.append(el('i'));
    const summaryText=el('span',null,'activation-summary-text');summaryText.append(el('strong',say('查看技能发动','View skill activations')),el('small',say('发动顺序、技能条件与音符覆盖','Order, conditions and note coverage')));summary.append(mark,summaryText,el('span','⌄','activation-chevron'));details.append(summary);const body=el('div',null,'activation-body');details.append(body);this.append(details);
    details.addEventListener('change',event=>event.stopPropagation());
    details.addEventListener('toggle',()=>{if(!details.open){this.stop();return;}if(this.result){renderSkillActivation(body,this.result,this.data);return;}this.load(body);});
  }
  stop(){this.worker?.terminate();this.worker=null;this.querySelector('.activation-body')?.stopReplay?.();}
  disconnectedCallback(){this.stop();}
  load(body){
    this.stop();body.replaceChildren(el('p',say('正在重放这支队伍的技能…','Replaying skill activations…'),'activation-loading'));body.setAttribute('aria-busy','true');
    const fail=message=>{this.stop();body.removeAttribute('aria-busy');body.replaceChildren(el('p',message));const retry=el('button',say('重试','Retry'));retry.type='button';retry.addEventListener('click',()=>this.load(body));body.append(retry);};
    try{const worker=new Worker(new URL('./skill-activation-worker.mjs',import.meta.url),{type:'module'});this.worker=worker;
      worker.onmessage=({data})=>{if(this.worker!==worker)return;if(data.error){fail(data.error);return;}this.stop();body.removeAttribute('aria-busy');this.result=data.result;renderSkillActivation(body,this.result,this.data);};
      worker.onerror=()=>{if(this.worker===worker)fail(say('技能记录加载失败，请重试','Could not load skill records. Try again.'));};worker.postMessage(this.payload);
    }catch(error){fail(error.message);}
  }
}
customElements.define('skill-activation',SkillActivation);
}
export function skillActivation(tool,draft,options={}){
  const data=tool.data??tool,view=document.createElement('skill-activation');view.data={memberCards:data.memberCards,supportCards:data.supportCards,ranking:Boolean(options.ranking)};
  const copy=draft?structuredClone(draft):null;
  const chart=options.chart??data.charts?.find(c=>c.trackId===copy?.selectedSongId&&c.difficulty===copy?.selectedDifficulty);
  view.payload={rules:data.formalRules??data.rules,draft:copy,chart:options.conditionsOnly?null:chart,mode:options.mode??'ordinary',scenario:options.scenario,eventId:options.eventId,ranking:options.ranking,conditionsOnly:options.conditionsOnly};
  view.result=options.result;return view;
}
