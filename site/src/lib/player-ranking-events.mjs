import {eventTimestamp} from './event-time.mjs';

export function rankingEventState(event, now = Date.now()) {
  if (event?.isFinal === true || event?.state === 'ended') return 'ended';
  const start = eventTimestamp(event?.startAt, event?.edition || 'global', event?.timeZone);
  const end = eventTimestamp(event?.endAt, event?.edition || 'global', event?.timeZone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return event?.state || 'unknown';
  return now < start ? 'upcoming' : now > end ? 'ended' : 'active';
}

export function rankingEvents(definitions, snapshots, now = Date.now()) {
  const items = new Map(definitions.map(event => [String(event.id), {...event, id:String(event.id)}]));
  for (const snapshot of snapshots) items.set(snapshot.id, {...items.get(snapshot.id), ...snapshot});
  return [...items.values()].map(event => ({...event, state:rankingEventState(event, now)}))
    .sort((a,b) => ({active:0,upcoming:1,ended:2,unknown:3}[a.state] ?? 3) - ({active:0,upcoming:1,ended:2,unknown:3}[b.state] ?? 3)
      || Number(b.id) - Number(a.id));
}

export function filterRankingEvents(events, band) {
  return !band || band === 'all' ? events : events.filter(event => event.bandIds?.map(String).includes(String(band)));
}

export function rankingEventLabel(event, en = false) {
  const state = {active:['进行中','Ongoing'], ended:['已结束','Ended'], upcoming:['未开始','Upcoming'], unknown:['时间待确认','Schedule unknown']};
  return `${event.name} · ${(state[event.state] || state.unknown)[Number(en)]}${event.isFinal ? (en ? ' · Final record' : ' · 最终记录') : ''}`;
}

export function rankingEventForBand(events, band, requested = '') {
  if (!band || band === 'all') return requested;
  const matching=filterRankingEvents(events,band);
  return matching.some(event=>event.id===requested) ? requested : matching[0]?.id || '';
}

/** Configured boards stay selectable before their first server-specific capture. */
export function availableRankingBoards(event, observed = [], selected = '') {
  const fields={'event-points':'eventPoints',music:'music','total-music':'totalMusic'};
  return [...new Set([...observed,...Object.entries(fields).filter(([,key])=>event?.rankingConfigured?.[key]===true).map(([id])=>id),selected])]
    .filter(id=>Object.hasOwn(fields,id));
}
