import {costumeCopy, costumeState, readCostumeFilters, costumeFilterSearch, matchesCostume} from './costume-library.mjs';

class CostumeLibrary extends HTMLElement {
  connectedCallback() {
    if (this.events) return;
    this.events = new AbortController();
    const {signal} = this.events;
    this.form = this.querySelector('form');
    this.copy = costumeCopy(this.dataset.locale === 'en');
    this.rows = [...this.querySelectorAll('[data-costume]')];
    this.choices = [...this.form.querySelectorAll('[data-filter]')];
    const render = () => {
      const filters = Object.fromEntries(new FormData(this.form));
      let count = 0;
      for (const row of this.rows) {
        row.hidden = !matchesCostume({bandId:row.dataset.band, characterId:row.dataset.character, searchText:row.dataset.search}, filters);
        if (!row.hidden) count++;
      }
      this.querySelector('[data-count]').textContent = count;
      this.querySelector('[data-no-match]').hidden = count > 0 || this.rows.length === 0;
      for (const choice of this.choices) {
        choice.setAttribute('aria-pressed', String(filters[choice.dataset.filter] === choice.dataset.value));
        choice.hidden = Boolean(choice.dataset.filter === 'character' && filters.band && choice.dataset.value && choice.dataset.band !== filters.band);
      }
      this.refreshDates();
    };
    const restore = () => {
      const filters = readCostumeFilters(location.search);
      for (const key of ['band','character']) {
        if (!this.choices.some(c => c.dataset.filter === key && c.dataset.value === filters[key])) filters[key] = '';
      }
      const selected = this.choices.find(c => c.dataset.filter === 'character' && c.dataset.value === filters.character);
      if (filters.band && selected?.dataset.value && selected.dataset.band !== filters.band) filters.character = '';
      for (const key of ['q','band','character']) this.form.elements[key].value = filters[key];
      render();
    };
    const update = (push) => {
      const search = costumeFilterSearch(location.search, Object.fromEntries(new FormData(this.form)));
      const next = location.pathname + (search ? '?' + search : '') + location.hash;
      if (next !== location.pathname + location.search + location.hash) history[push ? 'pushState' : 'replaceState'](null, '', next);
      render();
    };
    this.form.addEventListener('submit', event => event.preventDefault(), {signal});
    this.form.addEventListener('input', event => { if (event.target.name === 'q') update(false); }, {signal});
    this.form.addEventListener('click', event => {
      const choice = event.target.closest('[data-filter]');
      if (!choice) return;
      const key = choice.dataset.filter;
      const input = this.form.elements[key];
      input.value = input.value === choice.dataset.value ? '' : choice.dataset.value;
      if (key === 'band') {
        const selected = this.choices.find(c => c.dataset.filter === 'character' && c.dataset.value === this.form.elements.character.value);
        if (input.value && selected?.dataset.value && selected.dataset.band !== input.value) this.form.elements.character.value = '';
      }
      update(true);
    }, {signal});
    this.form.addEventListener('reset', event => {
      event.preventDefault();
      for (const key of ['q','band','character']) this.form.elements[key].value = '';
      update(true);
    }, {signal});
    window.addEventListener('popstate', restore, {signal});
    document.addEventListener('visibilitychange', () => this.refreshDates(), {signal});
    this.timer = setInterval(() => this.refreshDates(), 60000);
    restore();
  }
  refreshDates() {
    for (const badge of this.querySelectorAll('[data-start]')) {
      const state = costumeState(badge.dataset.start, this.dataset.region);
      badge.textContent = state === 'upcoming' ? this.copy.upcoming : state === 'released' ? this.copy.released : '';
      badge.hidden = state === 'unknown';
      badge.dataset.state = state;
    }
  }
  disconnectedCallback() { this.events?.abort(); this.events = null; clearInterval(this.timer); }
}
if (!customElements.get('costume-library')) customElements.define('costume-library', CostumeLibrary);
