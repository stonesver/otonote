import { anniversaryStatus, anniversaryText, nextBirthday, calendarDate, calendarOffsetHours, birthdayCountdown, birthdayProximity, preferredBirthdayPool, preferredBirthdayCard, birthdayPoolLabel } from './birthday-calendar.mjs';

class HomeBirthdays extends HTMLElement {
  private timer?: ReturnType<typeof setTimeout>;
  private refresh = () => {
    const now = Date.now();
    const region = this.dataset.region;
    const en = this.dataset.language === 'en';
    const list = this.querySelector<HTMLElement>('[data-birthday-list]');
    if (!list) return;
    const localToday = calendarDate(now, region);
    let shown = false;
    for (const node of this.querySelectorAll<HTMLElement>('[data-anniversary]')) {
      const entry = { startDate: node.dataset.start!, endDate: node.dataset.end! };
      const status = anniversaryStatus(entry, localToday);
      node.hidden = shown || status.state === 'ended';
      if (node.hidden) continue;
      shown = true;
      const text = anniversaryText(entry, status, en);
      node.dataset.anniversaryState = status.state;
      node.querySelector('[data-anniversary-label]')!.textContent = text.label;
      node.querySelector('[data-anniversary-note]')!.textContent = text.note;
    }
    const rows = [...list.querySelectorAll<HTMLElement>('[data-birthday-card]')].map(node => ({
      node, next: nextBirthday(Number(node.dataset.month), Number(node.dataset.day), now, region)
    })).filter(row => row.next !== null).sort((a, b) => a.next!.days - b.next!.days);
    rows.forEach(({node, next}, index) => {
      node.hidden = index >= 4;
      node.dataset.birthdayState = birthdayProximity(next!.days);
      const countdown = node.querySelector('[data-birthday-countdown]');
      if (countdown) countdown.textContent = birthdayCountdown(next!.days, en);
      node.querySelector('time')?.setAttribute('datetime', next!.date);
      const links = [...node.querySelectorAll<HTMLAnchorElement>('[data-birthday-pool]')];
      const pools = links.map(link => ({ id: link.dataset.poolId, startAt: link.dataset.start, endAt: link.dataset.end,
        pickupMemberCardIds: (link.dataset.pickups ?? '').split(',').filter(Boolean).map(Number) }));
      const preferred = preferredBirthdayPool(pools, now);
      links.forEach((link, i) => {
        link.hidden = pools[i].id !== preferred?.id;
        link.textContent = `${birthdayPoolLabel(pools[i], now, en)}`;
      });
      const cardLinks = [...node.querySelectorAll<HTMLAnchorElement>('[data-birthday-card-link]')];
      const cards = cardLinks.map(link => ({ id: link.dataset.cardId, masterId: Number(link.dataset.masterId) }));
      const card = preferredBirthdayCard(cards, preferred);
      cardLinks.forEach(link => { link.hidden = link.dataset.cardId !== card?.id; });
    });
    // Reorder only when dates change, preserving focus during periodic refreshes.
    if (rows.some((row, index) => list.children[index] !== row.node)) {
      rows.forEach(({node}) => list.append(node));
    }
    const today = this.querySelector<HTMLTimeElement>('[data-calendar-today]');
    if (today) {
      today.dateTime = calendarDate(now, region);
      today.textContent = today.dateTime.slice(5).replace('-', '.');
    }
    clearTimeout(this.timer);
    // Refresh at midnight precisely; also keep recruitment states within a minute.
    const untilMidnight = 86_400_000 - ((now + calendarOffsetHours(region) * 3_600_000) % 86_400_000);
    this.timer = setTimeout(this.refresh, Math.min(untilMidnight + 50, 60_000));
  };
  connectedCallback() {
    this.refresh();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pageshow', this.refresh);
  }
  disconnectedCallback() {
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pageshow', this.refresh);
  }
  private onVisibility = () => { if (!document.hidden) this.refresh(); };
}
if (!customElements.get('home-birthdays')) customElements.define('home-birthdays', HomeBirthdays);
