// Inline in both entry shells so browser chrome follows the same canvas palette.
(() => {
  const root = document.documentElement;
  const sync = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', getComputedStyle(root).backgroundColor);
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, {attributes:true, attributeFilter:['style', 'class', 'data-theme', 'data-site-theme']});
  document.addEventListener('ournotes:shell-dispose', () => observer.disconnect(), {once:true});
  sync();
  document.addEventListener('DOMContentLoaded', sync, {once:true});
  document.addEventListener('astro:page-load', sync);
})();
