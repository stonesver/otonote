import { releaseTimestamp } from './recent-releases.mjs';

const DAY = 86_400_000;
export const calendarOffsetHours = region => region === 'jp' ? 9 : 8;
const birthdayText = /生日|birthday|バースデー|誕生日/i;

export function calendarDate(now = Date.now(), region = 'global') {
  return new Date(now + calendarOffsetHours(region) * 3_600_000).toISOString().slice(0, 10);
}

export function birthdayInYear(month, day, year) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

export function nextBirthday(month, day, now = Date.now(), region = 'global') {
  const today = calendarDate(now, region);
  const year = Number(today.slice(0, 4));
  // February 29 uses its next actual occurrence, including across non-leap centuries.
  for (let nextYear = year; nextYear <= year + 8; nextYear++) {
    const date = birthdayInYear(month, day, nextYear);
    if (date && date >= today) return { date, days: (Date.parse(date) - Date.parse(today)) / DAY };
  }
  return null;
}

/** @template {{birthday: {month: number, day: number}}} T @param {T[]} characters */
export function upcomingBirthdays(characters, now = Date.now(), region = 'global') {
  return characters.flatMap(character => {
    const next = nextBirthday(character.birthday.month, character.birthday.day, now, region);
    return next ? [{ character, ...next }] : [];
  }).sort((a, b) => a.days - b.days);
}

export function birthdayCountdown(days, en = false) {
  if (days === 0) return en ? 'Happy birthday!' : '生日快乐';
  if (days === 1) return en ? 'Tomorrow' : '明天生日';
  return en ? `In ${days} days` : `还有 ${days} 天`;
}

export function birthdayProximity(days) {
  return days === 0 ? 'today' : days > 0 && days <= 7 ? 'soon' : 'later';
}

/** Match birthday pools through UP member cards, never the entire prize list. */
export function birthdayContent(characterId, memberCards, pools) {
  const characterCards = memberCards.filter(card => card.characterId === characterId);
  const memberIds = new Set(characterCards.map(card => card.masterId));
  const birthdayPools = pools.filter(pool => pool.categories?.includes('birthday')
    && pool.pickupMemberCardIds?.some(id => memberIds.has(id)));
  const pickupIds = new Set(birthdayPools.flatMap(pool => pool.pickupMemberCardIds));
  const cards = characterCards.filter(card => pickupIds.has(card.masterId)
    || birthdayText.test([card.subtitle, card.displayName, ...Object.values(card.localizedText ?? {})].join(' ')))
    .sort((a, b) => (releaseTimestamp(b.startAt) ?? 0) - (releaseTimestamp(a.startAt) ?? 0));
  return { cards, pools: birthdayPools };
}

export function birthdayPoolState(pool, now = Date.now()) {
  const start = releaseTimestamp(pool.startAt);
  const end = releaseTimestamp(pool.endAt);
  if (start !== null && end !== null && end < start) return 'unknown';
  if (end !== null && now > end) return 'ended';
  if (start !== null && now < start) return 'upcoming';
  if (start !== null && end !== null && now >= start && now <= end) return 'active';
  return 'unknown';
}

export function preferredBirthdayPool(pools, now = Date.now()) {
  const priority = { active: 0, upcoming: 1, unknown: 2, ended: 3 };
  return [...pools].sort((a, b) => {
    const stateA = birthdayPoolState(a, now);
    const stateB = birthdayPoolState(b, now);
    const order = priority[stateA] - priority[stateB];
    if (order) return order;
    const dateA = releaseTimestamp(a.startAt) ?? 0;
    const dateB = releaseTimestamp(b.startAt) ?? 0;
    return stateA === 'upcoming' ? dateA - dateB : dateB - dateA;
  })[0];
}

/** Keep the card shortcut aligned with the selected pool when multiple years exist. */
export function preferredBirthdayCard(cards, pool) {
  return cards.find(card => pool?.pickupMemberCardIds?.includes(card.masterId)) ?? cards[0];
}

export function birthdayPoolLabel(pool, now = Date.now(), en = false) {
  const state = birthdayPoolState(pool, now);
  const labels = en
    ? { active: 'Birthday pool · Live', upcoming: 'Birthday pool · Soon', ended: 'Birthday pool · Ended', unknown: 'Birthday pool · Schedule unconfirmed' }
    : { active: '生日招募 · 进行中', upcoming: '生日招募 · 待开放', ended: '生日招募 · 已结束', unknown: '生日招募 · 时间待确认' };
  return labels[state];
}

const dayNumber = date => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY;

/** Status of one anniversary (inclusive startDate..endDate, both local dates) on a local date. */
export function anniversaryStatus(entry, today) {
  const start = dayNumber(entry.startDate), end = dayNumber(entry.endDate), day = dayNumber(today);
  if (day < start) return { state: 'upcoming', days: start - day };
  if (day > end) return { state: 'ended', days: 0 };
  return { state: 'celebrating', days: 0, day: day - start + 1, total: end - start + 1 };
}

export function anniversaryText(entry, status, en = false) {
  const range = `${entry.startDate.slice(5).replace('-', '.')}–${entry.endDate.slice(5).replace('-', '.')}`;
  if (status.state === 'celebrating') return { label: en ? 'Celebrating' : '庆祝中', note: en ? `Day ${status.day} of ${status.total}` : `第 ${status.day} 天 / 共 ${status.total} 天`, range };
  return { label: en ? 'Coming up' : '即将到来', note: en ? `In ${status.days} days` : `还有 ${status.days} 天`, range };
}
