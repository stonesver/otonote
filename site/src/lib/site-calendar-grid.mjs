// Pure month-grid helpers for the floating site calendar. Dates are 'YYYY-MM-DD' strings in the server's local calendar.
const pad = n => String(n).padStart(2, '0');
const key = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

export function shiftMonth(year, month, delta) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Six Sunday-first weeks covering the month, including padding days from adjacent months or years. */
export function monthGrid(year, month) {
  const first = Date.UTC(year, month - 1, 1);
  const start = first - new Date(first).getUTCDay() * 86_400_000;
  const days = Array.from({ length: 42 }, (_, i) => {
    const date = key(start + i * 86_400_000);
    return { date, inMonth: date.startsWith(`${year}-${pad(month)}-`) };
  });
  return { year, month, days };
}

export const gridYears = grid => [...new Set([grid.days[0].date, grid.days[41].date, `${grid.year}-01-01`].map(date => Number(date.slice(0, 4))))];

export const entriesOn = (entries, date) => entries.filter(entry => entry.startDate <= date && date <= entry.endDate);

/** Slice multi-day entries of a given kind into 1-based CSS grid columns for one 7-day week row. */
export function weekSpans(weekDays, entries, kind) {
  const first = weekDays[0].date, last = weekDays[weekDays.length - 1].date;
  const spans = [];
  for (const entry of entries) {
    if (entry.kind !== kind || entry.endDate < first || entry.startDate > last) continue;
    const startIdx = Math.max(0, weekDays.findIndex(d => d.date >= entry.startDate));
    let endIdx = weekDays.length - 1;
    for (let i = weekDays.length - 1; i >= 0; i--) {
      if (weekDays[i].date <= entry.endDate) { endIdx = i; break; }
    }
    if (endIdx < startIdx) continue;
    spans.push({
      entry,
      colStart: startIdx + 1,
      colSpan: endIdx - startIdx + 1,
      startsHere: entry.startDate >= first,
      endsHere: entry.endDate <= last,
      anchorDate: weekDays[startIdx].date,
    });
  }
  return spans;
}
