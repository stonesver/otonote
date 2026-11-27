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
  const assets = catalog.assets ?? [];
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const byPath = new Map(assets.map(asset => [asset.containerPath, asset]));
  const mediaUrl = asset => asset?.thumbnailUrl || asset?.previewUrl || null;
  const bandById = new Map((catalog.bands ?? []).map(band => [band.id, band]));
  const entries = bandAnniversariesForYear(catalog.bands, year).map(entry => {
    const band = bandById.get(entry.id);
    const icon = mediaUrl(byId.get(band?.logoAssetId));
    return { ...entry, ...(icon ? { icon } : {}), ...(band?.mainColor ? { color: band.mainColor } : {}) };
  });
  for (const character of catalog.characters) {
    const date = birthdayInYear(character.birthday.month, character.birthday.day, year);
    if (!date) continue;
    const portrait = (character.portraitAssetIds ?? []).map(id => byId.get(id))
      .find(asset => asset?.containerPath?.endsWith('/character_face_icon.png'))
      ?? byId.get(character.profileAssetId);
    const icon = mediaUrl(portrait);
    entries.push({ kind: 'birthday', id: character.id, name: character.displayName,
      startDate: date, endDate: date, ...(icon ? { icon } : {}), ...(character.mainColor ? { color: character.mainColor } : {}) });
  }
  function addPeriod(kind, row, startAt, until, extra = {}) {
    const startDate = calendarDate(startAt, region), endDate = calendarDate(until - 1, region);
    if (startDate > year + '-12-31' || endDate < year + '-01-01') return;
    entries.push({ kind, id: row.id, name: row.name, startDate, endDate, startAt, until, ...extra });
  }
  for (const event of events) {
    const { startAt, endAt, timeZone } = event.schedule;
    const start = eventTimestamp(startAt, region, timeZone), end = eventTimestamp(endAt, region, timeZone);
    if (start !== null && end !== null && end >= start) {
      const logo = event.assets?.logo ? byPath.get(`Assets/AddressableResources/Image/Event/${event.assets.logo}.png`) : null;
      const bg = event.assets?.background ? byPath.get(`Assets/AddressableResources/Image/Event/${event.assets.background}.png`) : null;
      const icon = mediaUrl(logo) || mediaUrl(bg);
      addPeriod('event', event, start, end + 1000, icon ? { icon } : {});
    }
  }
  const seasonScopes = arena?.capabilities.conditions ? arena.serverScopes : [];
  const arenaIcon = [...(arena?.rankIcons ?? [])].sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0))[0]?.image ?? null;
  if (seasonScopes.length && (!serverId || seasonScopes.includes(serverId))) {
    for (const season of arena.seasons) addPeriod('arena-season', season, Date.parse(season.validFrom), Date.parse(season.validUntil), arenaIcon ? { icon: arenaIcon } : {});
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
