import { findStoryLines, stepStoryMatch } from './story-reader-search.mjs';

class StoryReaderTools extends HTMLElement {
  connectedCallback() {
    this.events?.abort();
    this.events = new AbortController();
    const { signal } = this.events;
    const reader = this.closest('[data-text-reader]');
    const en = this.dataset.locale === 'en';
    const form = this.querySelector('form');
    const query = form.elements.namedItem('find');
    const speaker = form.elements.namedItem('speaker');
    const toggle = reader.querySelector('[data-find-toggle]');
    const lines = [...reader.querySelectorAll('[data-story-line]')];
    const records = lines.map(line => ({
      speaker: line.dataset.storySpeaker || '',
      text: line.querySelector('.st-line-text, .st-message > p, .st-system-message > p, h2')?.textContent ?? '',
    }));
    const status = this.querySelector('[data-story-find-status]');
    const previous = this.querySelector('[data-story-find-prev]');
    const next = this.querySelector('[data-story-find-next]');
    const link = this.querySelector('[data-story-find-link]');
    let matches = [], selected = -1;

    const setOpen = (open, focusInput = false) => {
      this.hidden = !open;
      if (toggle) toggle.setAttribute('aria-expanded', String(open));
      if (open && focusInput) query.focus({ preventScroll: true });
    };

    const save = () => {
      const url = new URL(location.href);
      for (const [key, value] of [['find', query.value.trim()], ['speaker', speaker.value]]) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
      }
      history.replaceState(history.state, '', url);
    };
    const show = (scroll = false) => {
      const active = lines[matches[selected]];
      lines.forEach((line, index) => {
        line.classList.toggle('st-find-match', matches.includes(index));
        line.classList.toggle('st-find-current', line === active);
      });
      previous.disabled = next.disabled = !matches.length;
      link.hidden = !active;
      const filtering = query.value.trim() || speaker.value;
      status.textContent = !filtering ? '' : matches.length ? `${selected + 1} / ${matches.length}` : (en ? 'No match' : '无匹配');
      if (active) {
        const url = new URL(location.href); url.hash = active.id;
        link.href = url.href;
        if (scroll) {
          history.replaceState(history.state, '', url);
          active.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
      }
    };
    const search = () => {
      matches = findStoryLines(records, query.value, speaker.value);
      selected = matches.length ? 0 : -1;
      save(); show();
    };
    const restore = () => {
      const params = new URLSearchParams(location.search);
      query.value = params.get('find') || '';
      speaker.value = [...speaker.options].some(option => option.value === params.get('speaker')) ? params.get('speaker') : '';
      matches = findStoryLines(records, query.value, speaker.value);
      const hashIndex = matches.findIndex(index => `#${encodeURIComponent(lines[index].id)}` === location.hash || `#${lines[index].id}` === location.hash);
      selected = matches.length ? Math.max(0, hashIndex) : -1;
      const hasActiveFilter = Boolean(query.value.trim() || speaker.value);
      setOpen(hasActiveFilter, false);
      show();
    };

    if (toggle) {
      toggle.hidden = false;
      toggle.addEventListener('click', () => {
        const nextOpen = this.hidden;
        setOpen(nextOpen, nextOpen);
      }, { signal });
    }
    form.addEventListener('input', search, { signal });
    form.addEventListener('submit', event => { event.preventDefault(); search(); show(true); }, { signal });
    form.addEventListener('reset', event => {
      event.preventDefault(); query.value = ''; speaker.value = ''; search(); query.focus();
    }, { signal });
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (query.value || speaker.value) {
          query.value = ''; speaker.value = ''; search();
        } else {
          setOpen(false);
          toggle?.focus({ preventScroll: true });
        }
      }
    }, { signal });
    for (const [button, direction] of [[previous, -1], [next, 1]]) button.addEventListener('click', () => {
      selected = stepStoryMatch(selected, direction, matches.length); show(true);
    }, { signal });
    window.addEventListener('popstate', restore, { signal });
    window.addEventListener('hashchange', restore, { signal });
    restore();
  }
  disconnectedCallback() { this.events?.abort(); }
}
if (!customElements.get('story-reader-tools')) customElements.define('story-reader-tools', StoryReaderTools);
