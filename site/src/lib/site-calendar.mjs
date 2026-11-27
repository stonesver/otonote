import { birthdayInYear, calendarDate } from './birthday-calendar.mjs';
import { eventTimestamp } from './event-time.mjs';
import { validateArena } from './arena-context.mjs';
import { validatedEvents } from './event-content.mjs';
import { artifact, pageContext, snapshot } from '../runtime/content.mjs';
import { currentServerContext } from './game-servers.mjs';

// Annual local calendar dates. Campaign rewards have separate operating periods.
const anniversaries = [
  { bandId: 'band-3', firstYear: 2026, start: '11-18', end: '11-20',
    source: 'https://x.com/bangdreamon_EN/status/2120454622473261454' }
];

export function bandAnniversariesForYear(bands, year) {
  return anniversaries.flatMap(({ bandId, firstYear, start, end, source }) => {
    const band = bands.find(item => item.id === bandId);
    if (!band || year < firstYear) return [];
    return [{ kind: 'band-anniversary', id: bandId, name: band.displayName,
      startDate: year + '-' + start, endDate: year + '-' + end, source }];
  });
}

export function nextBandAnniversary(catalog, now = Date.now()) {
  const today = calendarDate(now, catalog.projectionContext.region);
  const year = Number(today.slice(0, 4));
  const entries = [year, year + 1].flatMap(y => bandAnniversariesForYear(catalog.bands, y));
  return entries.filter(entry => entry.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null;
}

/** Dates include both calendar days. Timed entries additionally carry a
 * half-open interval in epoch milliseconds, independent of the browser zone. */
export function siteCalendarForYear({ catalog, events, arena, serverId, year }) {
  const { region } = catalog.projectionContext;
  const entries = bandAnniversariesForYear(catalog.bands, year);
  for (const character of catalog.characters) {
    const date = birthdayInYear(character.birthday.month, character.birthday.day, year);
    if (date) entries.push({ kind: 'birthday', id: character.id, name: character.displayName,
      startDate: date, endDate: date });
  }
  function addPeriod(kind, row, startAt, until) {
    const startDate = calendarDate(startAt, region), endDate = calendarDate(until - 1, region);
    if (startDate > year + '-12-31' || endDate < year + '-01-01') return;
    entries.push({ kind, id: row.id, name: row.name, startDate, endDate, startAt, until });
  }
  for (const event of events) {
    const { startAt, endAt, timeZone } = event.schedule;
    const start = eventTimestamp(startAt, region, timeZone), end = eventTimestamp(endAt, region, timeZone);
    if (start !== null && end !== null && end >= start) addPeriod('event', event, start, end + 1000);
  }
  const seasonScopes = arena?.capabilities.conditions ? arena.serverScopes : [];
  if (seasonScopes.length && (!serverId || seasonScopes.includes(serverId))) {
    for (const season of arena.seasons) addPeriod('arena-season', season, Date.parse(season.validFrom), Date.parse(season.validUntil));
  }
  entries.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));
  return { region, year, seasonScopes, entries };
}

export async function loadSiteCalendar(year, { serverId = currentServerContext().serverId } = {}) {
  const [release, catalog, modes, rawArena] = await Promise.all([snapshot(), artifact('projection/catalog.json'),
    artifact('projection/game-modes.json'), artifact('projection/arena.json', { optional: true })]);
  const { region, contentReleaseId } = catalog.projectionContext;
  if (contentReleaseId !== release.contentReleaseId || region !== pageContext().region) throw Error('日历目录与当前内容版本不一致');
  const events = validatedEvents(modes.events, { region, contentReleaseId });
  const arena = validateArena(rawArena, { region, sourceReleaseId: contentReleaseId });
  return siteCalendarForYear({ catalog, events, arena, serverId, year });
}
