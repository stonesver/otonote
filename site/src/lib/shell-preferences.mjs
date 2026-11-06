// Inline in both shells: restore before paint, then use one delegated listener.
(() => {
  const root = document.documentElement;
  const key = 'otonote-sidebar-collapsed';
  try { root.dataset.sidebarCollapsed = String(localStorage.getItem(key) === 'true'); } catch { /* Storage is optional. */ }
  const sync = () => {
    const collapsed = root.dataset.sidebarCollapsed === 'true';
    const button = document.querySelector('[data-sidebar-collapse]');
    button?.setAttribute('aria-expanded', String(!collapsed));
    const label = root.lang === 'en'
      ? (collapsed ? 'Expand sidebar' : 'Collapse sidebar') : (collapsed ? '展开侧栏' : '收起侧栏');
    button?.setAttribute('aria-label', label);
    button?.setAttribute('title', label);
    // Cold HTML is localized before readiness; the tooltip follows the rendered name.
    for (const link of document.querySelectorAll('[data-site-nav] .nav-primary, [data-site-nav] .nav-home')) {
      link.setAttribute('title', link.textContent.trim());
    }
  };
  if (!window.__otonoteSidebarBound) {
    window.__otonoteSidebarBound = true;
    document.addEventListener('click', event => {
      if (!event.target.closest?.('[data-sidebar-collapse]')) return;
      root.dataset.sidebarCollapsed = String(root.dataset.sidebarCollapsed !== 'true');
      try { localStorage.setItem(key, root.dataset.sidebarCollapsed); } catch { /* Keep working without persistence. */ }
      sync();
    });
    document.addEventListener('astro:page-load', sync);
    document.addEventListener('DOMContentLoaded', sync);
  }
  sync();
})();
