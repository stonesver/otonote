import { calendarDate } from './birthday-calendar.mjs';
import { loadSiteCalendar } from './site-calendar.mjs';
import { entriesOn, gridYears, monthGrid, shiftMonth } from './site-calendar-grid.mjs';

const KINDS = {
  birthday: ['生日', 'Birthday'],
  'band-anniversary': ['乐队纪念日', 'Band anniversary'],
  event: ['活动', 'Event'],
  'arena-season': ['激奏赛季', 'Arena season'],
};
const KIND_ORDER = { birthday: 0, 'band-anniversary': 1, event: 2, 'arena-season': 3 };
const FALLBACK_SVG = {
  birthday: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5h10v3H3zM4.5 7.5h7v3h-7zM8 3v2.5"/></svg>',
  'band-anniversary': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l1.6 3.7 3.9.4-3 2.6.9 3.8L8 10.7l-3.4 2 .9-3.8-3-2.6 3.9-.4z"/></svg>',
  event: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h10v6.5L8 13l-5-3.5z"/></svg>',
  'arena-season': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3h7v3.5a3.5 3.5 0 0 1-7 0zM4.5 4.2H2.5v1.3a2 2 0 0 0 2 2M11.5 4.2h2v1.3a2 2 0 0 1-2 2M8 10v3M5.5 13h5"/></svg>',
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = color => (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color) ? color : '');

export function mountSiteCalendar(host, panel, close) {
  const en = host.dataset.language === 'en';
  const region = host.dataset.region;
  const base = host.dataset.base ?? '/';
  const t = (zh, eng) => (en ? eng : zh);
  const today = () => calendarDate(Date.now(), region);
  const state = { year: Number(today().slice(0, 4)), month: Number(today().slice(5, 7)), selected: today(), data: new Map(), status: 'loading' };

  const link = entry => {
    if (entry.kind === 'event') return `${base}events/${entry.id}/`;
    if (entry.kind === 'birthday') return `${base}characters/${entry.id}/`;
    if (entry.kind === 'arena-season') return `${base}arena/`;
    return null;
  };
  const entriesFor = date => [...state.data.values()].flatMap(year => entriesOn(year.entries, date))
    .filter((entry, i, all) => all.findIndex(other => other.kind === entry.kind && other.id === entry.id && other.startDate === entry.startDate) === i)
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

  function badgeMarkup(entry, size = 'cell') {
    const ring = safeColor(entry.color);
    const style = ring ? ` style="--cal-accent:${ring}"` : '';
    const title = escape(entry.name);
    if (entry.icon) {
      return `<span class="cal-badge cal-badge--${entry.kind} cal-badge--${size}"${style} title="${title}"><img src="${escape(entry.icon)}" alt="" loading="lazy" decoding="async"></span>`;
    }
    return `<span class="cal-badge cal-badge--${entry.kind} cal-badge--${size} is-fallback"${style} title="${title}">${FALLBACK_SVG[entry.kind] ?? ''}</span>`;
  }

  function cellContent(date, monthPrefix) {
    const list = entriesFor(date);
    const isMonthStart = date === `${monthPrefix}-01`;
    // Show distinctive icons on milestone days rather than stamping every day of a month-long span.
    const featured = list.filter(entry => {
      if (entry.kind === 'birthday' || entry.kind === 'band-anniversary') return true;
      if (entry.kind === 'event') return entry.startDate === date || (isMonthStart && entry.startDate < date);
      if (entry.kind === 'arena-season') return entry.startDate === date || entry.endDate === date || (isMonthStart && entry.startDate < date);
      return false;
    });
    const shown = featured.slice(0, 2);
    const extra = featured.length > 2 ? `<span class="cal-more">+${featured.length - 2}</span>` : '';
    const iconsHtml = shown.length
      ? `<span class="cal-icons${shown.length > 1 ? ' is-multi' : ''}">${shown.map(entry => badgeMarkup(entry, 'cell')).join('')}${extra}</span>`
      : '<span class="cal-icons"></span>';

    const spanBar = kind => {
      const hit = list.find(entry => entry.kind === kind);
      if (!hit) return '';
      const cls = [
        'cal-span', `cal-span--${kind}`,
        hit.startDate === date ? 'is-start' : '',
        hit.endDate === date ? 'is-end' : '',
      ].filter(Boolean).join(' ');
      return `<i class="${cls}" aria-hidden="true"></i>`;
    };
    const spansHtml = `<span class="cal-spans">${spanBar('event')}${spanBar('arena-season')}</span>`;
    return `${iconsHtml}${spansHtml}`;
  }

  function detail() {
    const list = entriesFor(state.selected);
    if (state.status === 'error') return `<p class="cal-note" role="alert">${t('日历数据暂时无法加载，请稍后重试。', 'Calendar data could not be loaded. Try again later.')} <button type="button" data-cal-retry>${t('重试', 'Retry')}</button></p>`;
    if (state.status === 'loading' && !list.length) return `<p class="cal-note" role="status">${t('正在加载…', 'Loading…')}</p>`;
    if (!list.length) return `<p class="cal-note">${t('这一天没有已收录的条目。', 'Nothing listed for this day.')}</p>`;
    return `<ul class="cal-list">${list.map(entry => {
      const url = link(entry), name = escape(entry.name);
      const range = entry.startDate === entry.endDate ? entry.startDate : `${entry.startDate} – ${entry.endDate}`;
      return `<li data-kind="${entry.kind}">
        ${badgeMarkup(entry, 'detail')}
        <div class="cal-item-copy">
          <div class="cal-item-top"><span class="cal-kind" data-kind="${entry.kind}">${KINDS[entry.kind][en ? 1 : 0]}</span>${url ? `<a href="${escape(url)}">${name}</a>` : `<strong>${name}</strong>`}</div>
          <small>${range}</small>
        </div>
      </li>`;
    }).join('')}</ul>`;
  }

  function draw() {
    const grid = monthGrid(state.year, state.month);
    const monthPrefix = `${state.year}-${String(state.month).padStart(2, '0')}`;
    const names = en ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['日', '一', '二', '三', '四', '五', '六'];
    const title = en ? new Date(Date.UTC(state.year, state.month - 1, 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : `${state.year} 年 ${state.month} 月`;
    const now = today();
    panel.innerHTML = `<header class="cal-head">
        <button type="button" class="cal-nav" data-cal-shift="-1" aria-label="${t('上个月', 'Previous month')}">‹</button>
        <h2 aria-live="polite" tabindex="-1" data-calendar-focus>${title}</h2>
        <button type="button" class="cal-nav" data-cal-shift="1" aria-label="${t('下个月', 'Next month')}">›</button>
        <button type="button" class="cal-today" data-cal-today>${t('今天', 'Today')}</button>
        <button type="button" class="cal-close" data-cal-close aria-label="${t('关闭日历', 'Close calendar')}">×</button>
      </header>
      <p class="cal-zone">${en ? `Dates in server time (UTC+${region === 'jp' ? 9 : 8})` : `按当前区服日期（UTC+${region === 'jp' ? 9 : 8}）`}</p>
      <div class="cal-grid" role="grid" aria-label="${title}">
        ${names.map(name => `<span class="cal-dow" role="columnheader">${name}</span>`).join('')}
        ${grid.days.map(day => `<button type="button" role="gridcell" class="cal-day${day.inMonth ? '' : ' is-out'}${day.date === now ? ' is-today' : ''}${day.date === state.selected ? ' is-selected' : ''}" data-cal-date="${day.date}" aria-label="${day.date}" aria-pressed="${day.date === state.selected}"><span class="cal-num">${Number(day.date.slice(8))}</span>${cellContent(day.date, monthPrefix)}</button>`).join('')}
      </div>
      <ul class="cal-legend">
        <li><span class="cal-swatch cal-swatch--birthday">${FALLBACK_SVG.birthday}</span>${KINDS.birthday[en ? 1 : 0]}</li>
        <li><span class="cal-swatch cal-swatch--band-anniversary">${FALLBACK_SVG['band-anniversary']}</span>${KINDS['band-anniversary'][en ? 1 : 0]}</li>
        <li><span class="cal-swatch cal-swatch--event"></span>${KINDS.event[en ? 1 : 0]}</li>
        <li><span class="cal-swatch cal-swatch--arena-season"></span>${KINDS['arena-season'][en ? 1 : 0]}</li>
      </ul>
      <div class="cal-detail" aria-live="polite"><h3>${state.selected}</h3>${detail()}</div>`;
  }

  const go = async (year, month, selected) => {
    state.year = year; state.month = month;
    if (selected) state.selected = selected;
    draw(); await ensure(); draw();
  };

  panel.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if ('calClose' in target.dataset) { close(); return; }
    if ('calRetry' in target.dataset) { state.status = 'loading'; go(state.year, state.month); return; }
    if ('calToday' in target.dataset) { const d = today(); go(Number(d.slice(0, 4)), Number(d.slice(5, 7)), d); return; }
    if (target.dataset.calShift) { const next = shiftMonth(state.year, state.month, Number(target.dataset.calShift)); go(next.year, next.month); return; }
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
