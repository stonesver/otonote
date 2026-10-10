/** Presentation only: timestamps and note values come from the scoring replay. */
const fields = ['general', 'perfect', 'just', 'great', 'good'];
export function partitionActivationEffects(skill,events=[]) {
 const active=[],inactive=[];
 for(const [kind,effects] of [['member',skill.liveEffects??[]],['support',skill.supportEffects??[]]])for(const effect of effects){
  const traced=events.find(e=>e.effectId===effect.id);
  ((traced?.active??effect.active)?active:inactive).push({kind,effect,traced});
 }
 return {active,inactive};
}
export function activationRows(playback, variant) {
  const used = new Set(), commands = variant.commands ?? [];
  return variant.order.map((slotIndex, position) => {
    const skill = playback.skills[slotIndex], startMs = playback.skillTimes[position];
    const windows = [];
    for (const [i, command] of commands.entries()) {
      if (command.ownerId !== slotIndex * 100 + 1 || !fields.some(k => command[k] > 0)) continue;
      const endIndex = commands.findIndex((end, j) => j !== i && !used.has(j) && end.ownerId === command.ownerId
        && end.timeMs >= command.timeMs && fields.every(k => (end[k] ?? 0) === -(command[k] ?? 0)));
      if (endIndex < 0) continue;
      used.add(endIndex);
      windows.push({ startMs: command.timeMs, endMs: commands[endIndex].timeMs,
        rates: Object.fromEntries(fields.filter(k => command[k]).map(k => [k, command[k]])) });
    }
    const covered = (variant.notes ?? []).filter(n => windows.some(w => n.timeMs >= w.startMs && n.timeMs < w.endMs));
    return { slotIndex, position, skill, startMs, endMs: Math.max(startMs, ...windows.map(w => w.endMs)), windows,
      covered, skillTrace: (variant.skillTrace ?? []).filter(e => e.slotIndex === slotIndex) };
  });
}
export function playbackDuration(playback, variant) {
  return Math.max(1000, ...(variant.notes ?? []).map(n => n.timeMs), ...activationRows(playback, variant).map(r => r.endMs),
    ...(playback.ranges ?? []).map(r => r.endMs), ...(variant.skillTransitions ?? []).map(e => e.timeMs));
}

/** Read the same scored sample at any time. Seeking never runs another calculation. */
export function createReplayClock(playback, variant, {stateTrace=[]}={}) {
  const rows=activationRows(playback,variant),duration=playbackDuration(playback,variant);
  const notes=[...(variant.notes??[])].sort((a,b)=>a.timeMs-b.timeMs),prefix=[0];
  for(const note of notes)prefix.push(prefix.at(-1)+(note.score??0));
  const states=[...stateTrace].sort((a,b)=>a.timeMs-b.timeMs);
  const sections=(playback.ranges??[]).map(range=>({...range,...variant.sections?.find(s=>s.index===range.index)}));
  const rewardTotal=sections.reduce((sum,s)=>sum+(s.rankingBonus??0),0),adjustment=(variant.score??prefix.at(-1))-prefix.at(-1)-rewardTotal;
  const nextTimes=[...new Set([...rows.map(r=>r.startMs),...sections.map(s=>s.startMs),...(variant.skillTransitions??[]).filter(e=>e.action==='start').map(e=>e.timeMs),duration])].sort((a,b)=>a-b);
  const upper=(items,time)=>{let lo=0,hi=items.length;while(lo<hi){const mid=(lo+hi)>>>1;if(items[mid].timeMs<=time)lo=mid+1;else hi=mid;}return lo;};
  return {rows,duration,next(time){return nextTimes.find(t=>t>time)??duration;},at(time){
    const timeMs=Math.max(0,Math.min(duration,time)),count=upper(notes,timeMs),note=notes[count-1],state=states[upper(states,timeMs)-1];
    const rewards=sections.filter(s=>s.endMs<=timeMs).reduce((sum,s)=>sum+(s.rankingBonus??0),0),fixed=timeMs===duration?adjustment:0;
    const active=rows.filter(r=>r.windows.some(w=>w.startMs<=timeMs&&timeMs<w.endMs));
    const last=rows.filter(r=>r.startMs<=timeMs).at(-1);
    return {timeMs,count,note,noteScore:prefix[count],rewards,fixed,score:prefix[count]+rewards+fixed,
      life:state?.life??note?.currentLife??note?.lifeAtInput,combo:state?.combo??note?.combo,
      active,last,section:sections.find(s=>s.startMs<=timeMs&&timeMs<s.endMs)};
  }};
}
export function noteDensity(notes, duration, count = 72) {
  const bins = Array(count).fill(0);
  for (const n of notes ?? []) bins[Math.max(0, Math.min(count - 1, Math.floor(n.timeMs / duration * count)))]++;
  return bins;
}
