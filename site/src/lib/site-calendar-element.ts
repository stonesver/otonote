// Defines <site-calendar>. The data and month-grid UI are loaded the first time the panel opens.
class SiteCalendar extends HTMLElement {
  private loaded = false;
  private isOpen = false;
  private closeTimer = 0;

  connectedCallback() {
    const button = this.querySelector<HTMLButtonElement>('[data-calendar-open]');
    const panel = this.querySelector<HTMLElement>('[data-calendar-panel]');
    if (!button || !panel) return;
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    const set = (open: boolean) => {
      if (open === this.isOpen) return;
      this.isOpen = open;
      clearTimeout(this.closeTimer);
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        panel.hidden = false;
        if (!this.loaded) {
          this.loaded = true;
          import('./site-calendar-ui.mjs').then(module => module.mountSiteCalendar(this, panel, () => set(false)));
        }
        // Trigger CSS open transition on the next frame after un-hiding.
        if (reduced()) {
          panel.dataset.open = 'true';
        } else {
          delete panel.dataset.open;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (this.isOpen) panel.dataset.open = 'true';
          }));
        }
        panel.querySelector<HTMLElement>('[data-calendar-focus]')?.focus({ preventScroll: true });
      } else {
        delete panel.dataset.open;
        if (reduced()) {
          panel.hidden = true;
        } else {
          this.closeTimer = window.setTimeout(() => {
            if (!this.isOpen) panel.hidden = true;
          }, 210);
        }
      }
    };

    button.addEventListener('click', () => set(!this.isOpen));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.isOpen) { set(false); button.focus(); }
    });
    document.addEventListener('pointerdown', event => {
      if (this.isOpen && !this.contains(event.target as Node)) set(false);
    });
  }
}
if (!customElements.get('site-calendar')) customElements.define('site-calendar', SiteCalendar);
