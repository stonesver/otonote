import { queryAutoTimeline, getCurrentCombo } from './auto-timeline.mjs';
import { projectAutoMarker, projectAutoLongPath, projectAutoHitEffect } from './auto-stage-layout.mjs';

export const HIT_EFFECT_SECONDS = 0.3;

export function lastComboEvent(timeline, time) {
  const events = timeline.comboEvents;
  let low = 0, high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return events[low - 1] ?? null;
}

// Derive every transient from chart time so seeking never replays stale effects.
export function createAutoScene(timeline, frame, time, { lookAheadSeconds = 2.5, missions = [], en = false, performance = null } = {}) {
  const visible = queryAutoTimeline(timeline, { time, pastSeconds: 1.2, futureSeconds: lookAheadSeconds });
  const longPaths = visible.longPaths.map(path => projectAutoLongPath(path, frame, time, { lookAheadSeconds })).filter(Boolean);
  const sectionIndex = performance ? -1 : (timeline.gekisouRanges ?? []).findIndex(range => time >= range.start && time < range.end);
  const range = timeline.gekisouRanges?.[sectionIndex];
  const mission = missions[sectionIndex];
  const lastHit = lastComboEvent(timeline, time);
  const input = marker => performance?.notes.get(marker.id);
  const hitTime = marker => input(marker)?.inputTimeMs == null ? marker.time : input(marker).inputTimeMs / 1000;
  const snapshot = performance?.clock.at(time * 1000);
  const cue = visible.cues.filter(cue => (!performance || !cue.kind.startsWith('fever-')) && cue.time <= time && time - cue.time < 1.2).at(-1);
  const cueLabels = en
    ? { skill: 'SKILL', 'fever-start': 'GEKISOU START', 'fever-end': 'GEKISOU END', call: 'RHYTHM CALL' }
    : { skill: '技能发动', 'fever-start': '激奏开始', 'fever-end': '激奏结束', call: '节奏应援' };
  return {
    time,
    longPaths,
    // Distant notes are painted first so they cannot cover closer notes.
    markers: visible.markers.filter(marker => !performance || time <= hitTime(marker)).map(marker => {
      const projected=projectAutoMarker(marker, frame, performance?Math.min(time,marker.time):time, { lookAheadSeconds });
      return projected ? {...projected,timingOffsetMs:input(marker)?.timingOffsetMs??0} : null;
    }).filter(Boolean).sort((a, b) => b.depth - a.depth),
    hitEffects: visible.markers.map(marker => projectAutoHitEffect(performance?{...marker,time:hitTime(marker)}:marker, frame, time, { postHitSeconds: HIT_EFFECT_SECONDS })).filter(Boolean),
    heldNotes: longPaths.filter(path => path.kind === 'long' && hitTime({id:`${path.id}:0`,time:path.startTime}) <= time && path.endTime > time).map(path => path.points[0]),
    activeCue: cue ? { ...cue, label: cueLabels[cue.kind], progress: (time - cue.time) / 1.2 } : null,
    activeGekisou: range ? { index: sectionIndex + 1, label: mission?.label ?? 'GEKISOU', type: mission?.type ?? 'combo', progress: (time - range.start) / Math.max(0.001, range.end - range.start) } : null,
    judgementProgress: performance ? (snapshot.note&&time-snapshot.note.timeMs/1000<.45?(time-snapshot.note.timeMs/1000)/.45:null) : lastHit && time - lastHit.time < 0.45 ? (time - lastHit.time) / 0.45 : null,
    combo: snapshot?.combo ?? getCurrentCombo(timeline, time),
    score: snapshot?.score,
    scoreUpFactor: snapshot?.scoreUpFactor
  };
}
