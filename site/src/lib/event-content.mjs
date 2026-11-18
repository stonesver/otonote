import { eventTimestamp } from './event-time.mjs';

/** Keep event identifiers inside their source server and release. */
export function validatedEvents(archive, context) {
  const records = archive.records ?? [];
  if (records.length && (archive.edition !== context.region || archive.sourceReleaseId !== context.contentReleaseId
    || records.some(event => event.edition !== archive.edition || event.sourceReleaseId !== archive.sourceReleaseId))) {
    throw new Error("Event archive does not belong to the selected edition/release");
  }
  // Older published archives joined shops by currency alone. Reused currency
  // must not leak another event's rewards into pages or reward-card selection.
  return records.map(event => ({...event, exchanges:event.exchanges.filter(shop => {
    const start = eventTimestamp(event.schedule.startAt, event.edition, event.schedule.timeZone);
    return start !== null && eventTimestamp(shop.startAt, event.edition, event.schedule.timeZone) === start;
  })}));
}
export const eventStoryEntryId = episode => `story-entry-main-${episode.id}`;
/** Match exact episode IDs as Another chapters share chapter IDs with main stories. */
export function decorateEventStories(entries, events) {
  const byId = new Map(events.flatMap(event => event.story.episodes.map(episode => [eventStoryEntryId(episode), { event, episode }])));
  const result = entries.map(entry => {
    const match = byId.get(entry.id);
    if (!match || entry.chapterId !== match.event.story.chapterId) return { ...entry };
    const section = match.episode.isAnotherEpisode ? "another" : match.episode.isExtraEpisode ? "extra" : "main";
    return { ...entry, eventId: match.event.id, eventSection: section,
      group: `event-${match.event.id}-${section}` };
  });
  const groups = new Map();
  for (const entry of result.filter(entry => entry.eventId != null)) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  for (const entries of groups.values()) {
    entries.sort((a,b) => a.episodeNumber - b.episodeNumber);
    entries.forEach((entry,index) => {
      entry.previousId = entries[index - 1]?.id ?? null;
      entry.nextId = entries[index + 1]?.id ?? null;
    });
  }
  return result;
}
