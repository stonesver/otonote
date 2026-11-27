// Defines <site-calendar>. The data and month-grid UI are loaded the first time the panel opens.
class SiteCalendar extends HTMLElement {
  private loaded = false;
  connectedCallback() {
    const button = this.querySelector<HTMLButtonElement>('[data-calendar-open]');
    const panel = this.querySelector<HTMLElement>('[data-calendar-panel]');
    if (!button || !panel) return;
    const set = (open: boolean) => {
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open && !this.loaded) {
        this.loaded = true;
        import('./site-calendar-ui.mjs').then(module => module.mountSiteCalendar(this, panel, () => set(false)));
      }
      if (open) panel.querySelector<HTMLElement>('[data-calendar-focus]')?.focus({ preventScroll: true });
    };
    button.addEventListener('click', () => set(panel.hidden));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) { set(false); button.focus(); }
    });
    document.addEventListener('pointerdown', event => {
      if (!panel.hidden && !this.contains(event.target as Node)) set(false);
    });
  }
}
if (!customElements.get('site-calendar')) customElements.define('site-calendar', SiteCalendar);
