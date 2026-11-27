import { calendarDate } from './birthday-calendar.mjs';
import { loadSiteCalendar } from './site-calendar.mjs';
import { entriesOn, gridYears, monthGrid, shiftMonth, weekSpans } from './site-calendar-grid.mjs';

const KINDS = {
  birthday: ['生日', 'Birthday'],
  'band-anniversary': ['乐队纪念日', 'Band anniversary'],
  event: ['活动', 'Event'],
  'arena-season': ['激奏赛季', 'Arena season'],
};
const FILTERS = [
  ['all', ['全部', 'All']],
  ['event', ['活动', 'Events']],
  ['arena-season', ['激奏', 'Arena']],
  ['birthday', ['生日', 'Birthdays']],
  ['band-anniversary', ['纪念日', 'Anniv.']],
];
const KIND_ORDER = { birthday: 0, 'band-anniversary': 1, event: 2, 'arena-season': 3 };

// Crisp site-native glyphs: lightning stage bolt for Gekisou Arena, cake for birthday, star for band anniversary.
const GLYPH = {
  birthday: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5h10v3H3zM4.5 7.5h7v3h-7zM8 3v2.5"/></svg>',
  'band-anniversary': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l1.6 3.7 3.9.4-3 2.6.9 3.8L8 10.7l-3.4 2 .9-3.8-3-2.6 3.9-.4z"/></svg>',
  event: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h10v6.5L8 13l-5-3.5z"/></svg>',
  'arena-season': '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.4 1.6 3.4 9h4l-.8 5.4L12.6 7h-4z"/></svg>',
  prev: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5"/></svg>',
  next: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4 12 12M12 4 4 12"/></svg>',
};

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = color => (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color) ? color : '');

export function mountSiteCalendar(host, panel, close) {
  const en = host.dataset.language === 'en';
  const region = host.dataset.region;
  const base = host.dataset.base ?? '/';
  const t = (zh, eng) => (en ? eng : zh);
  const today = () => calendarDate(Date.now(), region);
  const state = {
    year: Number(today().slice(0, 4)),
    month: Number(today().slice(5, 7)),
    selected: today(),
    filter: 'all',
    data: new Map(),
    status: 'loading',
  };

  const link = entry => {
    if (entry.kind === 'event') return `${base}events/${entry.id}/`;
    if (entry.kind === 'birthday') return `${base}characters/${entry.id}/`;
    if (entry.kind === 'arena-season') return `${base}arena/`;
    return null;
  };

  const allEntries = () => {
    const raw = [...state.data.values()].flatMap(year => year.entries);
    const deduped = raw.filter((entry, i, all) =>
      all.findIndex(other => other.kind === entry.kind && other.id === entry.id && other.startDate === entry.startDate) === i);
    return state.filter === 'all' ? deduped : deduped.filter(entry => entry.kind === state.filter);
  };

  const entriesFor = (date, pool) => entriesOn(pool, date)
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));

  async function ensure() {
    const grid = monthGrid(state.year, state.month);
    const missing = gridYears(grid).filter(year => !state.data.has(year));
    if (!missing.length) return;
    state.status = 'loading'; draw();
    try {
      const loaded = await Promise.all(missing.map(year => loadSiteCalendar(year)));
      missing.forEach((year, i) => state.data.set(year, loaded[i]));
      state.status = 'ready';
    } catch {
      state.status = 'error';
    }
  }

  // Day-cell icon for point/celebration entries (character avatar or circular band icon).
  function cellBadge(entry) {
    const ring = safeColor(entry.color);
    const style = ring ? ` style="--cal-accent:${ring}"` : '';
    const title = escape(entry.name);
    if (entry.icon) {
      return `<span class="cal-avatar cal-avatar--${entry.kind}"${style} title="${title}"><img src="${escape(entry.icon)}" alt="" loading="lazy" decoding="async"></span>`;
    }
    return `<span class="cal-avatar cal-avatar--${entry.kind} is-fallback"${style} title="${title}">${GLYPH[entry.kind] ?? ''}</span>`;
  }

  function renderWeek(weekDays, pool, now) {
    const dayCells = weekDays.map(day => {
      const list = entriesFor(day.date, pool).filter(e => e.kind === 'birthday' || e.kind === 'band-anniversary');
      const shown = list.slice(0, 2);
      const icons = shown.length
        ? `<span class="cal-avatars${shown.length > 1 ? ' is-multi' : ''}">${shown.map(cellBadge).join('')}</span>`
        : '<span class="cal-avatars"></span>';
      const cls = [
        'cal-day',
        day.inMonth ? '' : 'is-out',
        day.date === now ? 'is-today' : '',
        day.date === state.selected ? 'is-selected' : '',
      ].filter(Boolean).join(' ');
      return `<button type="button" role="gridcell" class="${cls}" data-cal-date="${day.date}" aria-label="${day.date}" aria-pressed="${day.date === state.selected}"><span class="cal-num">${Number(day.date.slice(8))}</span>${icons}</button>`;
    }).join('');

    const eventBars = weekSpans(weekDays, pool, 'event').map(span => {
      const cls = ['cal-bar', 'cal-bar--event', span.startsHere ? 'is-start' : '', span.endsHere ? 'is-end' : ''].filter(Boolean).join(' ');
      const logo = span.entry.icon ? `<img class="cal-bar-logo" src="${escape(span.entry.icon)}" alt="" loading="lazy" decoding="async">` : '';
      return `<button type="button" class="${cls}" data-cal-date="${span.anchorDate}" style="grid-column:${span.colStart} / span ${span.colSpan}" title="${escape(span.entry.name)} (${span.entry.startDate} – ${span.entry.endDate})">${logo}<span>${escape(span.entry.name)}</span></button>`;
    }).join('');

    const arenaBars = weekSpans(weekDays, pool, 'arena-season').map(span => {
      const cls = ['cal-bar', 'cal-bar--arena', span.startsHere ? 'is-start' : '', span.endsHere ? 'is-end' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-cal-date="${span.anchorDate}" style="grid-column:${span.colStart} / span ${span.colSpan}" title="${escape(span.entry.name)} (${span.entry.startDate} – ${span.entry.endDate})"><i class="cal-bar-ico" aria-hidden="true">${GLYPH['arena-season']}</i><span>${escape(span.entry.name)}</span></button>`;
    }).join('');

    const tracks = (eventBars || arenaBars)
      ? `<div class="cal-tracks">${eventBars ? `<div class="cal-lane">${eventBars}</div>` : ''}${arenaBars ? `<div class="cal-lane">${arenaBars}</div>` : ''}</div>`
      : '';

    return `<div class="cal-week" role="row"><div class="cal-week-days">${dayCells}</div>${tracks}</div>`;
  }

  function detailMedia(entry) {
    // Band anniversary in detail list uses text only (no icon box).
    if (entry.kind === 'band-anniversary') return '';
    if (entry.kind === 'birthday') {
      const ring = safeColor(entry.color);
      const style = ring ? ` style="--cal-accent:${ring}"` : '';
      return entry.icon
        ? `<span class="cal-detail-avatar"${style}><img src="${escape(entry.icon)}" alt="" loading="lazy" decoding="async"></span>`
        : `<span class="cal-detail-glyph" data-kind="birthday">${GLYPH.birthday}</span>`;
    }
    if (entry.kind === 'event') {
      return entry.icon
        ? `<img class="cal-detail-logo" src="${escape(entry.icon)}" alt="" loading="lazy" decoding="async">`
        : `<span class="cal-detail-glyph" data-kind="event">${GLYPH.event}</span>`;
    }
    if (entry.kind === 'arena-season') {
      return `<span class="cal-detail-glyph" data-kind="arena-season">${GLYPH['arena-season']}</span>`;
    }
    return '';
  }

  function detail(pool) {
    const list = entriesFor(state.selected, pool);
    if (state.status === 'error') return `<p class="cal-note" role="alert">${t('日历数据暂时无法加载，请稍后重试。', 'Calendar data could not be loaded. Try again later.')} <button type="button" data-cal-retry>${t('重试', 'Retry')}</button></p>`;
    if (state.status === 'loading' && !list.length) return `<p class="cal-note" role="status">${t('正在加载…', 'Loading…')}</p>`;
    if (!list.length) return `<p class="cal-note">${t('这一天没有符合条件的条目。', 'Nothing listed for this day.')}</p>`;
    return `<ul class="cal-list">${list.map(entry => {
      const url = link(entry), name = escape(entry.name);
      const range = entry.startDate === entry.endDate ? entry.startDate : `${entry.startDate} – ${entry.endDate}`;
      const media = detailMedia(entry);
      return `<li data-kind="${entry.kind}">
        ${media}
        <div class="cal-item-copy">
          <div class="cal-item-top"><span class="cal-kind" data-kind="${entry.kind}">${KINDS[entry.kind][en ? 1 : 0]}</span>${url ? `<a href="${escape(url)}">${name}</a>` : `<strong>${name}</strong>`}</div>
          <small>${range}</small>
        </div>
      </li>`;
    }).join('')}</ul>`;
  }

  function draw() {
    const grid = monthGrid(state.year, state.month);
    const pool = allEntries();
    const names = en ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['日', '一', '二', '三', '四', '五', '六'];
    const title = en ? new Date(Date.UTC(state.year, state.month - 1, 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : `${state.year} 年 ${state.month} 月`;
    const now = today();
    const weeks = Array.from({ length: 6 }, (_, i) => renderWeek(grid.days.slice(i * 7, i * 7 + 7), pool, now)).join('');

    panel.innerHTML = `<div class="cal-top">
        <header class="cal-head">
          <div class="cal-stepper">
            <button type="button" class="cal-nav" data-cal-shift="-1" aria-label="${t('上个月', 'Previous month')}">${GLYPH.prev}</button>
            <h2 aria-live="polite" tabindex="-1" data-calendar-focus>${title}</h2>
            <button type="button" class="cal-nav" data-cal-shift="1" aria-label="${t('下个月', 'Next month')}">${GLYPH.next}</button>
          </div>
          <div class="cal-head-actions">
            <span class="cal-zone">UTC+${region === 'jp' ? 9 : 8}</span>
            <button type="button" class="cal-today" data-cal-today>${t('今天', 'Today')}</button>
            <button type="button" class="cal-close" data-cal-close aria-label="${t('关闭日历', 'Close calendar')}">${GLYPH.close}</button>
          </div>
        </header>
        <div class="cal-controls">
          <div class="cal-filters" role="group" aria-label="${t('筛选日程类型', 'Filter calendar entries')}">
            ${FILTERS.map(([id, label]) => `<button type="button" class="cal-chip${state.filter === id ? ' is-active' : ''}" data-cal-filter="${id}" aria-pressed="${state.filter === id}">${label[en ? 1 : 0]}</button>`).join('')}
          </div>
          <label class="cal-date-picker">
            <span class="cal-sr-only">${t('跳转日期', 'Jump to date')}</span>
            <input type="date" data-cal-jump value="${state.selected}" aria-label="${t('选择日期', 'Select date')}">
          </label>
        </div>
      </div>
      <div class="cal-body">
        <div class="cal-grid" role="grid" aria-label="${title}">
          <div class="cal-dow-row" role="row">${names.map(name => `<span class="cal-dow" role="columnheader">${name}</span>`).join('')}</div>
          ${weeks}
        </div>
      </div>
      <div class="cal-detail" aria-live="polite"><h3>${state.selected}</h3>${detail(pool)}</div>`;
  }

  const go = async (year, month, selected) => {
    state.year = year; state.month = month;
    if (selected) state.selected = selected;
    draw(); await ensure(); draw();
  };

  panel.addEventListener('change', event => {
    const input = event.target.closest?.('[data-cal-jump]');
    if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input.value)) return;
    const date = input.value;
    go(Number(date.slice(0, 4)), Number(date.slice(5, 7)), date);
  });

  panel.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if ('calClose' in target.dataset) { close(); return; }
    if ('calRetry' in target.dataset) { state.status = 'loading'; go(state.year, state.month); return; }
    if ('calToday' in target.dataset) { const d = today(); go(Number(d.slice(0, 4)), Number(d.slice(5, 7)), d); return; }
    if (target.dataset.calShift) { const next = shiftMonth(state.year, state.month, Number(target.dataset.calShift)); go(next.year, next.month); return; }
    if (target.dataset.calFilter) { state.filter = target.dataset.calFilter; draw(); return; }
    if (target.dataset.calDate) {
      const date = target.dataset.calDate;
      state.selected = date;
      if (!date.startsWith(`${state.year}-${String(state.month).padStart(2, '0')}-`)) { go(Number(date.slice(0, 4)), Number(date.slice(5, 7)), date); return; }
      draw();
      panel.querySelector(`[data-cal-date="${date}"]`)?.focus({ preventScroll: true });
    }
  });
  go(state.year, state.month);
}
