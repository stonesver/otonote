/** View models derived only from the selected replay; never from averaged sections. */
export function gekisouSections(playback, variant) {
  return (playback.ranges ?? []).map(range => {
    const score = variant.sections.find(s => s.index === range.index);
    const events = (variant.skillTransitions ?? []).filter(e => e.sectionIndex === range.index);
    const luckEvents = (variant.luckEvents ?? []).filter(e => e.sectionIndex === range.index);
    return { ...range, ...score, events, luckEvents,
      displayStartMs: Math.min(range.startMs, ...events.map(e => e.timeMs)),
      displayEndMs: Math.max(range.endMs, ...events.map(e => e.timeMs), ...luckEvents.map(e => e.timeMs)),
      contribution: score.finalNoteScore + score.rankingBonus,
      peakRush: Math.max(0, ...luckEvents.map(e => e.rushCombo)) };
  });
}
export function gekisouEffectTrack(effect, section) {
  const events = section.events.filter(e => e.source === effect.source)
    .sort((a,b) => a.timeMs - b.timeMs || a.frame - b.frame);
  const factors = events.filter(e => e.action === 'factor');
  const windows = [];
  if ([2000,2001].includes(effect.type)) {
    for (let i=0;i<factors.length-1;i++) if (factors[i].value>0 && factors[i+1].timeMs>factors[i].timeMs) {
      windows.push({startMs:factors[i].timeMs,endMs:factors[i+1].timeMs,value:factors[i].value});
    }
  } else if (effect.type !== 13005) {
    // Converters consume charges between updates; their start records do not
    // establish a continuous lifetime. Display those as event markers instead.
    let start;
    for (const event of events) {
      if (event.action === 'start') start = event;
      if (event.action === 'end' && start) {
        if (event.timeMs>start.timeMs) windows.push({startMs:start.timeMs,endMs:event.timeMs});
        start = null;
      }
    }
  }
  return {effect,events,windows,starts:events.filter(e=>e.action==='start').length,
    changes:factors.filter(e=>e.value>0).length,peakFactor:Math.max(0,...factors.map(e=>e.value)),
    status:!effect.active?'condition_unmet':events.length?'recorded':'not_triggered'};
}
