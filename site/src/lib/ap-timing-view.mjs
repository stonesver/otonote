import { normalizeAutoTimeline } from './auto-timeline.mjs';
import { createAutoScene } from './auto-stage-scene.mjs';
import { createAutoStageFrame } from './auto-stage-layout.mjs';
import { createTimingPlayback, exportTimingPlayback, timingPlaybackDuration } from './ap-timing-playback.mjs';
import { hasApTimingInstructions } from './ap-timing-presentation.mjs';

const en=()=>document.documentElement.lang.startsWith('en');
const say=(zh,english)=>en()?english:zh;
const el=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
const fmt=value=>Number(value).toLocaleString();
const seconds=value=>(value/1000).toFixed(3);
const action=value=>value<0?say(`提前 ${-value} ms`,`Early ${-value} ms`):say(`延后 ${value} ms`,`Late ${value} ms`);
const conditionLabel=condition=>say(`对齐 ${Number(condition.phaseMs.toFixed(3))} ms，统一偏移 ${condition.biasMs>0?'+':''}${condition.biasMs} ms`,
  `Phase ${Number(condition.phaseMs.toFixed(3))} ms, uniform offset ${condition.biasMs>0?'+':''}${condition.biasMs} ms`);

// Groups are practice cues; every individual input remains in the note list.
export function timingPracticeGroups(adjustments) {
  const groups=[];
  for(const row of adjustments){
    const last=groups.at(-1);
    if(last&&last.offset===row.timingOffsetMs&&row.timeMs-last.endMs<=800){last.endMs=row.timeMs;last.count++;}
    else groups.push({startMs:row.timeMs,endMs:row.timeMs,offset:row.timingOffsetMs,count:1});
  }
  return groups;
}
const spanLabel=group=>group.startMs===group.endMs?`${seconds(group.startMs)} s`:`${seconds(group.startMs)}–${seconds(group.endMs)} s`;
const practiceText=adjustments=>{
  if(!adjustments.length)return say('无需调整，照常演奏。','No adjustments needed.');
  const offsets=new Set(adjustments.map(row=>row.timingOffsetMs));
  return offsets.size===1?say(`标记的 ${adjustments.length} 个音符${action(adjustments[0].timingOffsetMs)}，其余照常。`,
    `${action(adjustments[0].timingOffsetMs)} on the ${adjustments.length} marked notes. Play the rest normally.`):
    say(`调整标记的 ${adjustments.length} 个音符，其余照常。`,`Adjust the ${adjustments.length} marked notes. Play the rest normally.`);
};
export function apTimingSummary(plan) {
  const root=el('section');root.className='ap-timing-summary';
  const heading=el('div');heading.className='ap-timing-score';
  const score=el('div');score.append(el('span',say('微操预计分','Estimated timing score')),el('strong',fmt(plan.score)));
  const gainScore=plan.score-plan.onTimeMinimumScore;
  const signed=value=>`${value>0?'+':''}${fmt(value)}`;
  const gain=el('span',say(`比同顺序正拍 ${signed(gainScore)} 分`,
    `${signed(gainScore)} vs. the same order on time`));gain.className='ap-timing-gain';
  heading.append(score,gain);root.append(heading,el('p',practiceText(plan.adjustments)));
  const foot=el('p',say('60 / 120 帧通用','Works at 60 / 120 FPS'));foot.className='ap-timing-muted';root.append(foot);
  const details=el('details');details.className='ap-timing-details';details.append(el('summary',say('分数说明与额外加分','Score details and extra points')));
  for(const rate of plan.rates){
    details.append(el('p',say(`${rate.frameRate} 帧：正拍 ${fmt(rate.baselineScore)} → 推荐操作 ${fmt(rate.referenceScore)}。`,
      `${rate.frameRate} FPS: on time ${fmt(rate.baselineScore)} → recommended inputs ${fmt(rate.referenceScore)}.`)),
      el('p',say(`帧对齐额外 +${fmt(rate.favorable.score-rate.referenceScore)} 分（未计入推荐分）。`,`Frame alignment: +${fmt(rate.favorable.score-rate.referenceScore)} points (excluded from the recommendation).`)),
      el('small',say(`本方案已检查范围 ${fmt(rate.minimumScore)}–${fmt(rate.maximumScore)}。最低：${conditionLabel(rate.minimumCondition)}；最高：${conditionLabel(rate.maximumCondition)}。`,
        `Checked range for this plan: ${fmt(rate.minimumScore)}–${fmt(rate.maximumScore)}. Minimum: ${conditionLabel(rate.minimumCondition)}; maximum: ${conditionLabel(rate.maximumCondition)}.`)));
  }
  details.append(el('p',say(`调整后的音符距 AP 判定边界至少 ${plan.apMarginMs} ms；这不是保持同分的误差范围。`,
    `Adjusted notes stay at least ${plan.apMarginMs} ms inside the AP window. This is not an equal-score tolerance.`)),
    el('small',say('推荐分取已检查时钟及统一早／晚 5 ms 中的较低分；增分与同顺序正拍在相同时钟下的较低分比较。仅比较已搜索方案，不代表全局最高分或实机保底。',
      'The headline uses the lowest checked score, including uniform ±5 ms offsets; the gain compares on-time inputs in the same order across the same clocks. This is not a global optimum or guaranteed score.')));
  root.append(details);return root;
}

export async function renderApTimingReplay(root,result,data) {
  const generation=Symbol();root.timingGeneration=generation;root.stopReplay=()=>{root.timingGeneration=null;};
  root.classList.add('ap-timing-replay');
  const chart=data.chart;
  const timing=hasApTimingInstructions(result.apTimingPlan);
  if(timing)root.append(apTimingSummary(result.apTimingPlan));
  const rangePanel=el('div'),rangeDetails=el('details');rangeDetails.className='ap-timing-details ap-timing-range';
  rangeDetails.append(el('summary',say('同队 AP 的最低 / 最高分','Lowest / highest AP score with this team')),rangePanel);
  let rangeWorker=null;
  if(!chart){root.append(el('p',say('缺少谱面，无法播放微操演示。','Chart data is required for timing playback.')));return;}
  const {createAutoStageRenderer}=await import('./auto-stage-renderer.ts');
  if(!root.isConnected||root.timingGeneration!==generation)return;
  const timeline=normalizeAutoTimeline(chart),plan=result.apTimingPlan;
  let duration=timingPlaybackDuration(timeline,result.skillPlayback);
  const controls=el('div');controls.className='task-replay-controls';controls.style.flexWrap='wrap';
  const variants=el('select'),speed=el('select'),seek=el('input'),play=el('button',say('播放','Play')),loop=el('button',say('循环练习','Loop practice'));
  variants.setAttribute('aria-label',say('演示方案','Playback plan'));
  variants.className='ap-timing-variant';
  speed.setAttribute('aria-label',say('播放速度','Playback speed'));seek.setAttribute('aria-label',say('播放进度','Playback position'));
  const addVariantOption=(variant,index)=>{const c=variant.timingCondition,option=el('option',`${c.frameRate} ${say('帧','FPS')} · ${c.kind==='ap_minimum'?say('AP 最低分','AP minimum'):c.kind==='ap_maximum'?say('AP 最高分','AP maximum'):c.kind==='alignment'?say('额外加分（需帧对齐）','Extra points (frame alignment)'):timing?say('推荐操作','Recommended inputs'):say('正拍','On time')}`);option.value=index;variants.append(option);};
  result.skillPlayback.variants.forEach(addVariantOption);
  for(const value of [.25,.5,1]){const option=el('option',`${value}×`);option.value=value;speed.append(option);}speed.value='0.5';
  seek.type='range';seek.min='0';seek.max=String(duration);seek.step='.001';seek.value='0';seek.style.flex='1';seek.style.minWidth='150px';
  play.type=loop.type='button';play.setAttribute('aria-pressed','false');loop.setAttribute('aria-pressed','false');
  const practice=el('button',say('跳到练习片段','Jump to practice'));practice.type='button';
  controls.append(play,variants,speed,loop,practice,seek);root.append(controls);
  const status=el('p');status.className='ap-timing-live';root.append(status);
  const canvas=el('canvas');canvas.style.cssText='display:block;width:100%;height:320px;border-radius:12px;background:#0a152d';
  canvas.setAttribute('aria-label',timing?say('AP 微操演奏演示','AP timing plan playback'):say('演奏回放','Performance replay'));root.append(canvas);
  const context=canvas.getContext('2d');if(!context){status.textContent=say('浏览器不支持 Canvas。','Canvas is unavailable.');return;}
  const renderer=createAutoStageRenderer({images:new Map(),comboSkin:{capability:'unavailable',digitUrls:[],labelUrl:null},onSkinStateChange(){},labels:{}});
  const theme={palette:{top:'#0a152d',middle:'#142d4b',bottom:'#080e21',track:'10, 18, 42',lane:'110, 199, 242'},backgroundUrl:null,laneSkin:null,noteSkin:null,effectTextures:null};
  let variant=result.skillPlayback.variants[0],performance=createTimingPlayback(result.skillPlayback,variant),time=0,playing=false,request=0,previous=0,looping=false;
  let start=Math.max(0,(plan.adjustments[0]?.timeMs??0)/1000-1),end=Math.min(duration,(plan.adjustments.at(-1)?.timeMs??duration*1000)/1000+1);
  function draw(){
    const width=Math.max(280,canvas.getBoundingClientRect().width),height=320,scale=Math.min(devicePixelRatio||1,2);
    if(canvas.width!==Math.round(width*scale)||canvas.height!==height*scale){canvas.width=Math.round(width*scale);canvas.height=height*scale;}
    context.setTransform(scale,0,0,scale,0,0);
    const frame=createAutoStageFrame({width,height},{gutter:20,topWidthRatio:.25,horizonRatio:.08,judgementRatio:.88,perspective:true});
    const scene=createAutoScene(timeline,frame,time,{performance,lookAheadSeconds:2,en:en()});
    renderer.render({context,frame,profile:{mode:'full',effects:true,laneGuides:true},stageTheme:theme,gameSettings:{backgroundBrightness:75,laneOpacity:78,guidelineOpacity:50,slideOpacity:75},scene});
    for(const marker of scene.markers.filter(m=>m.timingOffsetMs&&m.y>height*.5)){
      context.font='bold 12px sans-serif';context.textAlign='center';context.fillStyle='#fff';context.fillText(action(marker.timingOffsetMs),marker.centerX,marker.y-14);
    }
    const layers=performance.stacksAt(time*1000).map(step=>`${step.slotIndex+1}: ${step.count}`).join(' / ')||'0';
    status.textContent=say(`${time.toFixed(2)} s · 当前得分 ${fmt(scene.score??0)}`,`${time.toFixed(2)} s · Score ${fmt(scene.score??0)}`);
    status.title=say(`倍率 ${(scene.scoreUpFactor??1).toFixed(2)}× · 累计层数（位置: 层）${layers}`,`${(scene.scoreUpFactor??1).toFixed(2)}× · Stacks (slot: count) ${layers}`);
    seek.value=String(time);
  }
  function stop(){playing=false;cancelAnimationFrame(request);play.textContent=say('播放','Play');play.setAttribute('aria-pressed','false');}
  function tick(now){if(!playing)return;time+=Math.max(0,now-previous)/1000*Number(speed.value);previous=now;if(looping&&time>=end)time=start;if(time>=duration){time=duration;stop();}draw();if(playing)request=requestAnimationFrame(tick);}
  play.addEventListener('click',()=>{if(playing){stop();return;}if(time>=duration)time=looping?start:0;playing=true;previous=performanceNow();play.textContent=say('暂停','Pause');play.setAttribute('aria-pressed','true');request=requestAnimationFrame(tick);});
  seek.addEventListener('input',()=>{time=Number(seek.value);draw();});
  function selectVariant(index){variants.value=String(index);variant=result.skillPlayback.variants[index];performance=createTimingPlayback(result.skillPlayback,variant);renderAdjustments(variant.apAdjustments??plan.adjustments);draw();}
  variants.addEventListener('change',()=>selectVariant(Number(variants.value)));
  practice.addEventListener('click',()=>{time=start;draw();});
  loop.addEventListener('click',()=>{looping=!looping;loop.setAttribute('aria-pressed',String(looping));if(looping){time=start;draw();}});
  const resize=new ResizeObserver(draw);resize.observe(canvas);root.stopReplay=()=>{root.timingGeneration=null;stop();resize.disconnect();rangeWorker?.terminate();rangeWorker=null;};
  const note=el('p',say('无音频演示','Silent demo'));note.className='ap-timing-muted';root.append(note);
  const cues=el('section');cues.className='ap-timing-practice';root.append(cues);
  const noteDetails=el('details');noteDetails.className='ap-timing-details';const noteHeading=el('summary');noteDetails.append(noteHeading);
  const wrap=el('div');wrap.className='calculator-table-scroll';const table=el('table');table.className='ap-timing-notes';wrap.append(table);noteDetails.append(wrap);root.append(noteDetails);
  function renderAdjustments(adjustments){
    cues.replaceChildren();cues.hidden=!adjustments.length;
    noteDetails.hidden=practice.hidden=loop.hidden=!adjustments.length;
    if(!adjustments.length){looping=false;loop.setAttribute('aria-pressed','false');}
    for(const group of timingPracticeGroups(adjustments)){
      const cue=el('div');cue.className='ap-timing-cue';
      const copy=el('div');copy.append(el('small',spanLabel(group)),el('strong',`${action(group.offset)} · ${group.count} ${say('个标记音符','marked notes')}`));
      const jump=el('button',say('练这一段','Practice section'));jump.type='button';jump.setAttribute('aria-label',say(`练习 ${spanLabel(group)}`,`Practice ${spanLabel(group)}`));
      jump.addEventListener('click',()=>{stop();start=Math.max(0,group.startMs/1000-1);end=Math.min(duration,group.endMs/1000+1);time=start;looping=true;loop.setAttribute('aria-pressed','true');draw();play.click();});
      cue.append(copy,jump);cues.append(cue);
    }
    noteHeading.textContent=say(`逐键位置与时间 · ${adjustments.length} 个音符`,`Note positions and timing · ${adjustments.length} notes`);
    table.replaceChildren();const head=el('tr');for(const title of [say('歌曲时间','Song time'),say('按哪里','Where'),say('怎么按','Input')])head.append(el('th',title));table.append(head);
    for(const row of adjustments){
      const tr=el('tr'),cell=el('td'),jump=el('button',`${seconds(row.timeMs)} s`);jump.type='button';jump.addEventListener('click',()=>{time=Math.max(0,row.timeMs/1000-.8);start=time;end=Math.min(duration,row.timeMs/1000+.8);draw();});cell.append(jump);
      const laneCell=el('td'),lane=el('span');lane.className='ap-timing-lane';lane.setAttribute('role','img');
      lane.setAttribute('aria-label',say(`从左数 ${row.position}–${row.position+row.size}，全宽 24`,`Lane ${row.position}–${row.position+row.size} of 24 from the left`));
      const mark=el('i');mark.style.left=`${row.position/24*100}%`;mark.style.width=`${row.size/24*100}%`;lane.append(mark);laneCell.append(lane);
      const input=el('td',action(row.timingOffsetMs));input.title=say(`距 AP 判定边界 ${row.apMarginMs} ms；不保证同分`,`AP window margin ${row.apMarginMs} ms; not an equal-score guarantee`);
      tr.append(cell,laneCell,input);table.append(tr);
    }
    start=Math.max(0,(adjustments[0]?.timeMs??0)/1000-1);end=Math.min(duration,(adjustments.at(-1)?.timeMs??duration*1000)/1000+1);
  }
  renderAdjustments(plan.adjustments);
  function paintRange(){
    rangePanel.replaceChildren();
    rangePanel.append(el('p',say('固定队伍与技能顺序，各键可在 AP 窗口内早按或晚按。两端对应不同操作，不代表推荐方案的保底。',
      'Same team and skill order; each input may vary within AP. Endpoints use different inputs, not a guaranteed range for the recommended plan.')));
    const model=el('details');model.append(el('summary',say('计算条件','Calculation conditions')),el('p',say('按整数毫秒和参考帧时钟计算；自动长条与轨迹判定保持正拍，同条判定保持先后顺序，不包含触屏命中误差。','Uses integer milliseconds and reference frame clocks. Automatic hold / trace events stay on time and in order; touch hit testing is excluded.')));rangePanel.append(model);
    if(result.apWindowRange){
      const replayButton=(witness,label)=>{const button=el('button',label);button.type='button';button.addEventListener('click',()=>{
        let index=result.skillPlayback.variants.findIndex(v=>v===witness.variant);
        if(index<0){index=result.skillPlayback.variants.length;witness.variant.apAdjustments=witness.adjustments;result.skillPlayback.variants.push(witness.variant);addVariantOption(witness.variant,index);duration=timingPlaybackDuration(timeline,result.skillPlayback);seek.max=String(duration);}
        stop();selectVariant(index);time=start;draw();
      });return button;};
      for(const rate of result.apWindowRange.rates){
        rangePanel.append(el('p',say(`${rate.frameRate} 帧 · 参考情况：最低 ${fmt(rate.reference.minimum.score)}，最高 ${fmt(rate.reference.maximum.score)}`,
          `${rate.frameRate} FPS · Reference: minimum ${fmt(rate.reference.minimum.score)}, maximum ${fmt(rate.reference.maximum.score)}`)));
        rangePanel.append(replayButton(rate.reference.minimum,say('回放最低分','Replay minimum')),replayButton(rate.reference.maximum,say('回放最高分','Replay maximum')));
        const details=el('details');details.append(el('summary',say(`其他帧对齐：最低 ${fmt(rate.minimum.score)}，最高 ${fmt(rate.maximum.score)}`,
          `Other clock alignments: minimum ${fmt(rate.minimum.score)}, maximum ${fmt(rate.maximum.score)}`)),
          el('p',say(`最低分对齐 ${Number(rate.minimum.phaseMs.toFixed(3))} ms；最高分对齐 ${Number(rate.maximum.phaseMs.toFixed(3))} ms。`,
            `Minimum phase ${Number(rate.minimum.phaseMs.toFixed(3))} ms; maximum phase ${Number(rate.maximum.phaseMs.toFixed(3))} ms.`)),
          replayButton(rate.minimum,say('回放对齐最低分','Replay aligned minimum')),replayButton(rate.maximum,say('回放对齐最高分','Replay aligned maximum')));rangePanel.append(details);
      }
      return;
    }
    const button=el('button',say('计算分数范围','Calculate score range'));button.type='button';button.disabled=!data.rangePayload;
    const message=el('p');message.setAttribute('role','status');rangePanel.append(button,message);
    button.addEventListener('click',()=>{
      button.disabled=true;message.textContent=say('正在计算两种帧率下的分数范围…','Calculating the score range at both frame rates…');
      const finish=()=>{rangeWorker?.terminate();rangeWorker=null;button.disabled=false;};
      try{rangeWorker=new Worker(new URL('./skill-activation-worker.mjs',import.meta.url),{type:'module'});
        rangeWorker.onmessage=({data:reply})=>{
          if(reply.rangeProgress){message.textContent=say(`已完成 ${reply.rangeProgress.completed} / ${reply.rangeProgress.total} 项计算`,`${reply.rangeProgress.completed} / ${reply.rangeProgress.total} checks complete`);return;}
          finish();if(reply.error){message.textContent=reply.error;return;}result.apWindowRange=reply.range;paintRange();
        };
        rangeWorker.onerror=()=>{finish();message.textContent=say('范围计算失败，请重试。','Range calculation failed. Please retry.');};
        rangeWorker.postMessage({...data.rangePayload,chart,apWindowOrder:plan.order});
      }catch(error){finish();message.textContent=error.message;}
    });
  }
  paintRange();root.append(rangeDetails);
  const download=el('button',say('导出演示到歌曲页','Export playback for the song page'));download.type='button';download.addEventListener('click',()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(exportTimingPlayback(chart,result))],{type:'application/json'}));const link=el('a');link.href=url;link.download=`${chart.id}-ap-timing.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
  });root.append(download);time=start;draw();
}
const performanceNow=()=>globalThis.performance.now();
