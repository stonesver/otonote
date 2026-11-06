import { createReplayClock, playbackDuration } from './skill-activation-model.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { createFrameClock, skillEndFrame } from '../../../packages/scoring/scoring-rules/formal-frame-clock.mjs';

export const timingChartHash = chart => stableSnapshotHash({ id:chart.id,notes:chart.notes,bpmEvents:chart.bpmEvents,skillTimings:chart.skillTimings });
export const timingPlaybackDuration = (timeline,playback) => Math.max(timeline.duration,...playback.variants.map(variant=>playbackDuration(playback,variant)/1000));
export function createTimingPlayback(playback, variant) {
  const notes = new Map();
  for (const note of variant.notes) {
    const key=note.nodeIndex==null?note.noteId:`${note.noteId}:${note.nodeIndex}`;
    if(note.kind==='authored')notes.set(key,note);
  }
  const frameClock=createFrameClock(variant.timingCondition);
  const stacks=(variant.skillTrace??[]).filter(step=>step.action==='cumulative').map(step=>{
    const effect=playback.skills[step.slotIndex].liveEffects.find(effect=>effect.id===step.effectId&&effect.cumulative);
    const start=playback.skillTimes[variant.order.indexOf(step.slotIndex)];
    return {...step,endMs:skillEndFrame(frameClock,start,effect.durationRawMs).timeMs};
  });
  return { notes, clock:createReplayClock(playback,variant), variant, stacksAt(timeMs){
    const latest=new Map();for(const step of stacks)if(step.timeMs<=timeMs&&timeMs<step.endMs)latest.set(`${step.slotIndex}:${step.effectId}`,step);
    return [...latest.values()];
  } };
}
export function exportTimingPlayback(chart, result) {
  return {version:'ap-timing-playback-v1',chartId:chart.id,chartHash:timingChartHash(chart),
    apTimingPlan:result.apTimingPlan,skillPlayback:result.skillPlayback};
}
export function importTimingPlayback(value, chart) {
  if(value?.version!=='ap-timing-playback-v1'||value.chartId!==chart.id||value.chartHash!==timingChartHash(chart))throw Error('微操演示与当前谱面不匹配');
  if(!value.skillPlayback?.variants?.length||!value.apTimingPlan?.rates?.length)throw Error('微操演示缺少逐帧记录');
  return value;
}
