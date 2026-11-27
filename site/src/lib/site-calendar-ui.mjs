import { calendarDate } from './birthday-calendar.mjs';
import { loadSiteCalendar } from './site-calendar.mjs';
import { entriesOn, gridYears, monthGrid, shiftMonth } from './site-calendar-grid.mjs';

const KINDS = {
  event: ['活动', 'Event'], 'arena-season': ['激奏赛季', 'Arena season'],
  birthday: ['生日', 'Birthday'], 'band-anniversary': ['乐队纪念日', 'Band anniversary']
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    .filter((entry, i, all) => all.findIndex(other => other.kind === entry.kind && other.id === entry.id && other.startDate === entry.startDate) === i);

  async function ensure() {
    const grid = monthGrid(state.year, state.month);
    const missing = gridYears(grid).filter(year => !state.data.has(year));
    if (!missing.length) return;
    state.status = 'loading'; draw();
    try {
      const loaded = await Promise.all(missing.map(year => loadSiteCalendar(year)));
      missing.forEach((year, i) => state.data.set(year, loaded[i]));
      state.status = 'ready';
    } catch (error) {
      state.status = 'error';
    }
  }

  function dots(date) {
    const kinds = [...new Set(entriesFor(date).map(entry => entry.kind))];
    return kinds.map(kind => `<i class="cal-dot" data-kind="${kind}"></i>`).join('');
  }

  function detail() {
    const list = entriesFor(state.selected);
    if (state.status === 'error') return `<p class="cal-note" role="alert">${t('日历数据暂时无法加载，请稍后重试。', 'Calendar data could not be loaded. Try again later.')} <button type="button" data-cal-retry>${t('重试', 'Retry')}</button></p>`;
    if (state.status === 'loading' && !list.length) return `<p class="cal-note" role="status">${t('正在加载…', 'Loading…')}</p>`;
    if (!list.length) return `<p class="cal-note">${t('这一天没有已收录的条目。', 'Nothing listed for this day.')}</p>`;
    return `<ul class="cal-list">${list.map(entry => {
      const url = link(entry), name = escape(entry.name);
      const range = entry.startDate === entry.endDate ? entry.startDate : `${entry.startDate} – ${entry.endDate}`;
      return `<li data-kind="${entry.kind}"><span class="cal-kind">${KINDS[entry.kind][en ? 1 : 0]}</span>${url ? `<a href="${escape(url)}">${name}</a>` : `<strong>${name}</strong>`}<small>${range}</small></li>`;
    }).join('')}</ul>`;
  }

  function draw() {
    const grid = monthGrid(state.year, state.month);
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
        ${grid.days.map(day => `<button type="button" role="gridcell" class="cal-day${day.inMonth ? '' : ' is-out'}${day.date === now ? ' is-today' : ''}${day.date === state.selected ? ' is-selected' : ''}" data-cal-date="${day.date}" aria-label="${day.date}" aria-pressed="${day.date === state.selected}"><span>${Number(day.date.slice(8))}</span><em>${dots(day.date)}</em></button>`).join('')}
      </div>
      <ul class="cal-legend">${Object.entries(KINDS).map(([kind, label]) => `<li><i class="cal-dot" data-kind="${kind}"></i>${label[en ? 1 : 0]}</li>`).join('')}</ul>
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
