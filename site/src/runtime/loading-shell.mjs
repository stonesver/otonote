import { SITE_NAME } from "../lib/site-brand.mjs";
import { NAVIGATION_GROUPS } from '../lib/navigation.mjs';
import { navIcons } from '../lib/navigation-icons.mjs';
import { getUi } from '../lib/ui-i18n.ts';

const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const svg = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const line = (width = '') => `<span class="loading-line ${width}" aria-hidden="true"></span>`;
const card = () => `<div class="loading-card"><div class="loading-art"><span class="loading-card-note">♪</span></div><div class="loading-card-copy">${line()}${line('short')}</div></div>`;
const row = () => `<div class="loading-row"><div class="loading-cover"></div><div>${line()}${line('short')}</div>${line('short')}</div>`;

/** The entry is self-contained and independent of the content release. */
export function renderLoadingShell({css, clientScript, codeRoot, boot, brandSvg, appManifest, startupScript, loadingArt = {}, navigationScript = ''}) {
  const zh = getUi('zh-CN'), en = getUi('en');
  const label = key => `<span data-loading-en="${escape(en[key])}">${escape(zh[key])}</span>`;
  const link = (path, text, classes = '') => `<a class="${classes}" href="/global/zh-CN${path}" data-loading-route="${path}">${text}</a>`;
  const groups = NAVIGATION_GROUPS.map(group => `<div class="nav-group" data-loading-group="${group.id}">
    ${link(group.href, svg(navIcons[group.id]) + label(group.labelKey), 'nav-primary')}
    ${group.children.length ? `<button class="nav-submenu-toggle" type="button" aria-expanded="true" aria-controls="nav-submenu-${group.id}" aria-label="${escape(zh.collapseNavigationGroup + zh[group.labelKey])}" data-loading-toggle="${group.id}"><span aria-hidden="true">−</span></button><div class="nav-submenu" id="nav-submenu-${group.id}">${group.children.map(child => link(child.href, label(child.labelKey))).join('')}</div>` : ''}
  </div>`).join('');
  const skeletons = {
    home: `<div class="loading-hero"></div><div class="loading-grid">${Array.from({length:4},card).join('')}</div>`,
    cards: `<div class="loading-filters">${line()}${line()}${line()}</div><div class="loading-grid">${Array.from({length:10},card).join('')}</div>`,
    music: `<div class="loading-filters">${line()}${line()}${line()}</div><div class="loading-rows">${Array.from({length:7},row).join('')}</div>`,
    detail: `<div class="loading-detail"><div class="loading-art"></div><div>${line()}${line('short')}<div class="loading-panel">${line()}${line()}${line('short')}</div><div class="loading-panel">${line()}${line()}</div></div></div>`,
    story: `<div class="loading-story">${Array.from({length:8},() => `<div class="loading-paragraph">${line()}${line()}${line('short')}</div>`).join('')}</div>`,
    scene: `<div class="loading-scene"></div><div class="loading-filters">${line()}${line()}${line()}</div>`,
    tool: `<div class="loading-tool-tabs">${line('short')}${line('short')}${line('short')}</div>
      <div class="loading-workspace">
        <div class="loading-tool-rail">${line('short')}${Array.from({length:5},()=>`<div class="loading-tool-field">${line('short')}<span></span></div>`).join('')}</div>
        <div class="loading-tool-main">
          <div class="loading-tool-song"><span class="loading-tool-disc">♪</span><div>${line()}${line('short')}</div><div class="loading-beat"><span></span><span></span><span></span><span></span><span></span></div></div>
          <div class="loading-tool-roster">${Array.from({length:5},()=>`<div class="loading-tool-pair"><div class="loading-tool-member"><span>♪</span></div><div class="loading-tool-support"></div>${line('short')}</div>`).join('')}</div>
          <div class="loading-tool-footer">${line()}<span></span></div>
        </div>
      </div>`,
    list: `<div class="loading-filters">${line()}${line()}</div><div class="loading-rows">${Array.from({length:6},row).join('')}</div>`
  };
  return `<!doctype html><html lang="zh-CN" data-tone="paper" data-shell="sidebar" data-loading="true"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#11131b"><title>${SITE_NAME}</title>
    <link rel="icon" href="${codeRoot}favicon.svg" type="image/svg+xml"><link rel="modulepreload" href="${codeRoot}${boot}">
    ${startupScript ? `<script>globalThis[Symbol.for('ournotes.code-manifest.v1')]=${JSON.stringify({...appManifest,root:codeRoot}).replace(/</g,'\\u003c')};${startupScript}</script>` : ''}
    <style data-loading-style>${css}</style></head><body>
    <a class="skip-link" href="#main-content">${label('skipMain')}</a>
    <header class="site-header" data-site-header>
      ${link('/', `<span class="site-brand__mark" aria-hidden="true">${brandSvg}</span><span class="site-brand__full">${SITE_NAME}</span><span class="site-brand__compact" aria-hidden="true">${SITE_NAME}</span><small data-loading-en="Events · Data · Team tools">活动 · 资料 · 配队工具</small>`, 'site-brand')}
      <nav id="site-navigation" class="site-nav" aria-label="主导航" data-site-nav><p class="nav-caption" data-loading-en="EXPLORE">浏览目录</p>${link('/',svg('M3 10l9-7 9 7 M5 9v12h5v-7h4v7h5V9')+'<span data-loading-en="Overview">首页概览</span>','nav-home')}${groups}<div class="nav-bottom">${link('/about/','<span data-loading-en="About">关于本站</span>')}${link('/updates/','<span data-loading-en="Version history">版本记录</span>')}<small>${SITE_NAME} · GLOBAL</small></div></nav>
      <nav class="site-breadcrumb" aria-label="当前位置">${link('/','<span data-loading-en="Overview">首页概览</span>')}<span aria-hidden="true">/</span><strong data-loading-title>${SITE_NAME}</strong></nav>
      <div class="global-search"><button class="global-search-trigger" disabled type="button">${svg('M16 16l4 4 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0')}<strong>${label('globalSearch')}</strong></button></div>
      <details class="context-switcher"><summary aria-label="切换服务器与语言"><span>GLOBAL</span><strong data-loading-locale>简体中文</strong></summary><div class="context-switcher__panel"><a href="/global/zh-CN/">简体中文</a> · <a href="/global/en/">English</a></div></details>
      <button class="nav-toggle" type="button" aria-label="打开导航" aria-expanded="false" aria-controls="site-navigation" data-loading-menu><span></span><span></span></button>
    </header>
    <button class="nav-backdrop" data-loading-backdrop tabindex="-1" aria-label="关闭导航" hidden></button>
    <main id="main-content" aria-busy="true" tabindex="-1"><section class="loading-page">
      <div class="loading-heading"><h1 data-loading-title>${SITE_NAME}</h1></div>
      <div class="loading-interlude" data-loading-interlude>
        <div class="loading-mini-stage" aria-hidden="true">
          <span class="loading-stage-orbit"></span><span class="loading-stage-star">✦</span>
          <span class="loading-stage-note">♪</span>
          <img class="loading-companion" data-loading-companion width="128" height="128" alt="" hidden>
          <span class="loading-stage-shadow"></span>
        </div>
        <div class="loading-interlude-copy">
          <span class="loading-cue" data-loading-en="BEFORE THE SHOW">开演之前</span>
          <p class="loading-caption" data-loading-caption data-loading-en="A little hello before the show.">开演前，先打个招呼。</p>
          <p role="status" data-content-status><span class="loading-dot" aria-hidden="true"></span><span data-loading-message data-loading-en="Loading content…">正在加载内容…</span></p>
        </div>
        <div class="loading-beat" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
      <div data-loading-skeleton data-loading-kind="list" aria-hidden="true">${skeletons.list}</div>
      <p data-loading-error hidden><span data-loading-en="Check your connection and try again, or open another page.">请检查网络后重试，也可以前往其他页面。</span> <a href="" data-loading-retry data-loading-en="Try again">重新加载</a></p>
    </section></main>
    ${Object.entries(skeletons).map(([kind,html]) => `<template data-loading-template="${kind}">${html}</template>`).join('')}
    <noscript><style>[data-loading-skeleton],[data-loading-interlude]{display:none}</style><p class="loading-noscript">请启用 JavaScript 查看内容。Enable JavaScript to view the content.</p></noscript>
    <script type="application/json" data-loading-art>${JSON.stringify(loadingArt).replace(/</g,'\\u003c')}</script>
    <script>${clientScript}</script><script data-code-root="${codeRoot}" data-navigation-client>${navigationScript.replace(/<\/script/gi, '<\\/script')}</script><script type="module" src="${codeRoot}${boot}"></script></body></html>`;
}
