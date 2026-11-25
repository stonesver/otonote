import {loadingKind} from '../runtime/loading-route.mjs';
import {loadingPresentation} from '../runtime/loading-presentation.mjs';

export function documentNavigationTarget(event, link, current) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !link) return null;
  if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return null;
  const url = new URL(link.href, current), here = new URL(current);
  if (url.origin !== here.origin || !/^\/(global|jp)\/(zh-CN|en)(\/|$)/.test(url.pathname) || /\.[^/]+$/.test(url.pathname)) return null;
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return url;
}

export function documentNavigationLabel(link) {
  const normalize = value => (value ?? '').replace(/\s+/g, ' ').trim();
  // A card link contains metadata as well as its title. Never promote all of it
  // into the waiting page's heading and breadcrumb.
  const candidates = [link.getAttribute('data-navigation-title'),
    link.querySelector('h1,h2,h3,h4,h5,h6')?.textContent,
    link.getAttribute('aria-label'), link.textContent];
  return candidates.map(normalize).find(value => value && value.length <= 80) || '';
}

/** Keep real document navigation and component lifecycles; change only its waiting frame. */
export function installNavigationFeedback({css, art}) {
  const key = Symbol.for('ournotes.navigation-feedback.v1');
  if (globalThis[key]) return;
  globalThis[key] = true;
  const root = document.documentElement;
  let active;
  const ensureStyle = () => {
    if (document.querySelector('style[data-navigation-feedback]')) return;
    const style = document.createElement('style'); style.dataset.navigationFeedback = '';
    style.textContent = css; document.head.append(style);
  };
  ensureStyle();
  // Small, immutable original stamps. Warm once without blocking the page body.
  const warm = Object.values(art).map(src => {
    const img = new Image(); img.decoding = 'async'; img.fetchPriority = 'low'; img.src = src; return img;
  });
  // Prefetch internal document HTML on pointer hover/focus so clicks hit HTTP cache.
  const prefetched = new Set();
  const prefetchLink = event => {
    if (globalThis.navigator?.connection?.saveData || prefetched.size >= 16) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    const url = documentNavigationTarget({defaultPrevented: false, button: 0}, link, location.href);
    if (!url || prefetched.has(url.href)) return;
    prefetched.add(url.href);
    const hint = document.createElement('link');
    hint.rel = 'prefetch';
    hint.as = 'document';
    hint.href = url.href;
    document.head?.append(hint);
  };
  window.addEventListener('pointerover', prefetchLink, {passive: true});
  window.addEventListener('focusin', prefetchLink, {passive: true});
  window.addEventListener('pointerdown', prefetchLink, {passive: true});
  function restore() {
    const job = active; if (!job) return;
    active = null; clearTimeout(job.showTimer); clearTimeout(job.timer); job.transition?.skipTransition(); job.observer?.disconnect();
    job.overlay?.remove(); job.disableNative?.remove();
    job.main.style.visibility = job.visibility; job.main.inert = job.inert;
    if (job.busy === null) job.main.removeAttribute('aria-busy'); else job.main.setAttribute('aria-busy',job.busy);
    delete root.dataset.navigationPhase;
    for (const [node,value] of job.navState ?? []) {
      if (value===null) node.removeAttribute('aria-current'); else node.setAttribute('aria-current',value);
    }
    if (job.crumb) job.crumb.textContent=job.crumbText;
    if (job.focus?.isConnected) job.focus.focus({preventScroll:true});
  }
  function fill(job) {
    const en = /^\/(global|jp)\/en\//.test(job.url.pathname);
    const presentation = loadingPresentation(loadingKind(job.url.pathname),en?'en':'zh-CN');
    job.overlay.querySelector('h1').textContent = job.label || (en?'Loading…':'正在加载…');
    job.overlay.querySelector('.loading-cue').textContent = en?'BEFORE THE SHOW':'开演之前';
    job.overlay.querySelector('.loading-caption').textContent = presentation.caption;
    job.overlay.querySelector('[data-navigation-message]').textContent = en?'Loading content…':'正在加载内容…';
    const img = job.overlay.querySelector('img'); img.hidden = false; img.src = art[presentation.art];
    img.onerror = () => {img.hidden=true;};
    job.overlay.querySelector('[data-navigation-retry]').textContent = en?'Try again':'重试';
    job.overlay.querySelector('[data-navigation-cancel]').textContent = en?'Stay on this page':'留在当前页面';
    job.overlay.querySelector('[data-navigation-actions]').hidden = true;
    job.english = en;
    const logical = path => path.replace(/^\/(global|jp)\/(zh-CN|en)/,'');
    const targetPath=logical(job.url.pathname);
    const currentLink=(job.navState??[]).map(([node])=>node).filter(node=>{
      const path=logical(new URL(node.href,location.href).pathname);
      return path===targetPath || (path!=='/' && targetPath.startsWith(path));
    }).sort((a,b)=>b.pathname.length-a.pathname.length)[0];
    for(const [node] of job.navState??[])node.removeAttribute('aria-current');
    currentLink?.setAttribute('aria-current','page');
    if(job.crumb)job.crumb.textContent=job.label;
  }
  function captureChrome(job) {
    job.navState=[...document.querySelectorAll('.site-nav a')].map(node=>[node,node.getAttribute('aria-current')]);
    job.crumb=document.querySelector('.site-breadcrumb [aria-current="page"]');
    job.crumbText=job.crumb?.textContent;
  }
  function show(job) {
    if (active !== job || job.overlay) return;
    const overlay = document.createElement('main'); overlay.dataset.navigationWait = '';
    overlay.tabIndex = -1; overlay.setAttribute('aria-busy','true');
    overlay.innerHTML = `<section class="loading-page"><div class="loading-heading"><h1></h1></div>
      <div class="loading-interlude" data-loading-interlude><div class="loading-mini-stage" aria-hidden="true">
      <span class="loading-stage-orbit"></span><span class="loading-stage-star">✦</span><span class="loading-stage-note">♪</span>
      <img class="loading-companion" width="128" height="128" alt=""><span class="loading-stage-shadow"></span></div>
      <div class="loading-interlude-copy"><span class="loading-cue"></span><p class="loading-caption"></p>
      <p role="status"><span class="loading-dot" aria-hidden="true"></span><span data-navigation-message></span></p></div>
      <div class="loading-beat" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div></div>
      <div data-loading-skeleton aria-hidden="true"><div class="loading-panel"><span class="loading-line"></span><span class="loading-line short"></span></div><div class="loading-panel"><span class="loading-line"></span><span class="loading-line short"></span></div></div>
      <p data-navigation-actions hidden><button type="button" data-navigation-retry></button><button type="button" data-navigation-cancel></button></p></section>`;
    job.overlay=overlay; captureChrome(job); fill(job); job.main.inert=true; job.main.style.visibility='hidden';
    job.main.setAttribute('aria-busy','true'); document.body.append(overlay); overlay.focus({preventScroll:true});
    // Once the slow-network waiting screen is visible, skip the cross-document
    // arrival transition so the destination does not double-animate.
    if (!job.disableNative) {
      job.disableNative=document.createElement('style');
      job.disableNative.textContent='@view-transition { navigation: none; }'; document.head.append(job.disableNative);
    }
    overlay.querySelector('[data-navigation-retry]').onclick=()=>{window.stop();job.navigating=false;begin(job);};
    overlay.querySelector('[data-navigation-cancel]').onclick=()=>{window.stop();restore();};
  }
  function begin(job) {
    if (active!==job || job.navigating) return;
    job.navigating=true; root.dataset.navigationPhase='loading';
    clearTimeout(job.showTimer);
    if (!job.overlay) {
      // Show only the top luminous progress rail immediately; defer the full-page
      // waiting overlay so fast/prefetched navigations and tools never flash twice.
      job.showTimer=setTimeout(()=>{if(active===job && !job.overlay)show(job);},300);
    }
    clearTimeout(job.timer);
    job.timer=setTimeout(()=>{
      if(active!==job)return;
      if(!job.overlay)show(job);
      job.overlay.querySelector('[data-navigation-message]').textContent=job.english?'This is taking longer than expected.':'加载时间较长，可以重试或留在当前页面。';
      job.overlay.querySelector('[data-navigation-actions]').hidden=false;
      job.overlay.setAttribute('aria-busy','false');
    },20000);
    location.assign(job.url.href);
  }
  // Window bubbling runs after component/document handlers, so dialogs and filters
  // that preventDefault retain their behavior. Modified/new-tab/download clicks pass through.
  window.addEventListener('click',event=>{
    const link=event.target instanceof Element?event.target.closest('a[href]'):null;
    const url=documentNavigationTarget(event,link,location.href);
    const main=document.querySelector('#main-content');
    if(!url||!main)return;
    event.preventDefault(); ensureStyle();
    const label=documentNavigationLabel(link);
    if(active){
      const job=active;
      if(job.navigating){window.stop();job.navigating=false;}
      job.url=url;job.label=label;if(job.overlay)fill(job);
      begin(job);
      return;
    }
    // Remove top-layer UI before navigating so open dialogs do not linger.
    for (const dialog of [...document.querySelectorAll('dialog[open]')].reverse()) dialog.close();
    const job={url,label,main,visibility:main.style.visibility,inert:main.inert,busy:main.getAttribute('aria-busy'),focus:document.activeElement};
    active=job;delete root.dataset.navigationPending;
    // If a client-rendered source page finishes while its navigation is pending,
    // keep the waiting frame across its head/body replacement as well.
    job.observer=new MutationObserver(()=>{
      if(active!==job || !job.overlay || job.overlay.isConnected)return;
      const next=document.querySelector('#main-content');if(!next)return;
      job.main=next;job.visibility=next.style.visibility;job.inert=next.inert;job.busy=next.getAttribute('aria-busy');
      captureChrome(job);fill(job);next.inert=true;next.style.visibility='hidden';next.setAttribute('aria-busy','true');
      ensureStyle();document.body.append(job.overlay);
      if(job.disableNative)document.head.append(job.disableNative);
      root.dataset.navigationPhase='loading';
    });
    job.observer.observe(document,{childList:true,subtree:true});
    begin(job);
  });
  window.addEventListener('pageswap',event=>{if(active?.overlay)event.viewTransition?.skipTransition();});
  window.addEventListener('pageshow',event=>{if(event.persisted)restore();});
  // The client fallback replaces head/body after its data arrives.
  document.addEventListener('astro:page-load',ensureStyle);
}
