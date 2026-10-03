/** Presentation only: timestamps and note values come from the scoring replay. */
const fields = ['general', 'perfect', 'just', 'great', 'good'];
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
  return Math.max(1000, ...(variant.notes ?? []).map(n => n.timeMs), ...activationRows(playback, variant).map(r => r.endMs));
}
export function noteDensity(notes, duration, count = 72) {
  const bins = Array(count).fill(0);
  for (const n of notes ?? []) bins[Math.max(0, Math.min(count - 1, Math.floor(n.timeMs / duration * count)))]++;
  return bins;
}
