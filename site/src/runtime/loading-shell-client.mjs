import { SITE_NAME } from "../lib/site-brand.mjs";
import {GAME_SERVERS, currentServerContext, withServer} from '../lib/game-servers.mjs';
import {restoreServerLabels} from '../lib/server-label.mjs';
import { activeNavigationGroup, activeNavigationChild, NAVIGATION_GROUPS } from '../lib/navigation.mjs';
import {sidebarSelection} from '../lib/sidebar-navigation.mjs';
import {restoreNavigationScroll, revealCurrentNavigation} from '../lib/navigation-scroll.mjs';
import { loadingKind } from './loading-route.mjs';
import { loadingPresentation } from './loading-presentation.mjs';

// Inline in the entry HTML: runs before downloading any template or game data.
const english = /^\/(?:global|jp)\/en(?:\/|$)/.test(location.pathname);
const region = location.pathname.startsWith('/jp/') ? 'jp' : 'global';
const base = `/${region}/${english ? 'en' : 'zh-CN'}/`;
document.querySelectorAll('.context-switcher a').forEach(link => {
  const url = new URL(link.href);
  url.pathname = url.pathname.replace(/^\/global\//, `/${region}/`);
  const server = new URLSearchParams(location.search).get('server');
  if (server) url.searchParams.set('server', server);
  link.href = url.pathname + url.search;
});
const editionLabel = document.querySelector('.nav-bottom small');
if (editionLabel) editionLabel.textContent = `${SITE_NAME} · ${region.toUpperCase()}`;
const path = location.pathname.replace(/^\/(?:global|jp)\/(zh-CN|en)/, '') || '/';
const root = document.documentElement;
root.lang = english ? 'en' : 'zh-CN';
restoreServerLabels(document, GAME_SERVERS);
const serverId = currentServerContext().serverId;
if (new URLSearchParams(location.search).get('motion') === 'off') root.dataset.motion = 'off';
if (english) document.querySelectorAll('[data-loading-en]').forEach(node => { node.textContent = node.dataset.loadingEn; });
document.querySelector('[data-loading-locale]').textContent = english ? 'English' : '简体中文';
const navigation = document.querySelector('[data-site-nav]');
navigation.setAttribute('aria-label', english ? 'Main navigation' : '主导航');
navigation.querySelector('.nav-my-tools').setAttribute('aria-label', english ? 'My tools' : '我的工具');
navigation.querySelector('.nav-browse').setAttribute('aria-label', english ? 'Browse' : '浏览');
document.querySelector('.site-breadcrumb').setAttribute('aria-label', english ? 'Breadcrumb' : '当前位置');
document.querySelector('.context-switcher summary').setAttribute('aria-label', english ? 'Server and language' : '切换服务器与语言');
document.querySelector('[data-loading-retry]').href = location.href;
const group = NAVIGATION_GROUPS.find(item => item.id === activeNavigationGroup(path));
const child = activeNavigationChild(path, group?.children ?? []);
const sidebar = sidebarSelection(path);
const currentPath = child?.href ?? group?.href ?? (['/updates/', '/about/'].includes(path) ? path : '/');
let title = english ? 'Overview' : '首页概览';
document.querySelectorAll('[data-loading-route]').forEach(link => {
  const route = link.dataset.loadingRoute;
  link.href = withServer(base + route.slice(1), serverId);
  link.removeAttribute('aria-current');
  if (route === sidebar.route) link.setAttribute('aria-current', 'page');
  if (route === currentPath) title = link.textContent.trim();
});
const kind = loadingKind(location.pathname);
if (kind === 'detail' || kind === 'story') title += english ? ' · Details' : ' · 详情';
document.querySelectorAll('[data-loading-title]').forEach(node => { node.textContent = title; });
document.title = `${title} · ${SITE_NAME}`;
const skeleton = document.querySelector('[data-loading-skeleton]');
skeleton.dataset.loadingKind = kind;
skeleton.replaceChildren(document.querySelector(`[data-loading-template="${kind}"]`).content.cloneNode(true));
root.dataset.loadingKind = kind;
if (/^\/cards\/members\/?$/.test(path)) root.dataset.loadingCardFormat = 'member';
if (/^\/cards\/supports\/?$/.test(path)) root.dataset.loadingCardFormat = 'support';
const interlude = document.querySelector('[data-loading-interlude]');
const companion = document.querySelector('[data-loading-companion]');
const presentation = loadingPresentation(kind, english ? 'en' : 'zh-CN');
document.querySelector('[data-loading-caption]').textContent = presentation.caption;
// Decorative art is optional and never gates the ready page or its navigation.
companion.addEventListener('load', () => { companion.hidden = false; }, { once: true });
companion.addEventListener('error', () => { companion.hidden = true; }, { once: true });
// The image bytes arrived with this HTML, so the waiting animation never
// competes with page content for another request (even on a cold cache).
const art = JSON.parse(document.querySelector('[data-loading-art]').textContent);
if (art[presentation.art]) companion.src = art[presentation.art];

const controller = new AbortController();
const options = {signal:controller.signal};
function toggleGroup(button, expanded) {
  const submenu = document.getElementById(button.getAttribute('aria-controls'));
  button.setAttribute('aria-expanded', String(expanded));
  const name = button.closest('.nav-group').querySelector('.nav-primary').textContent.trim();
  button.setAttribute('aria-label', `${english ? (expanded ? 'Collapse navigation group: ' : 'Expand navigation group: ') : (expanded ? '收起导航分组：' : '展开导航分组：')}${name}`);
  button.querySelector('span').textContent = expanded ? '−' : '+';
  submenu.hidden = !expanded;
  submenu.inert = !expanded;
}
document.querySelectorAll('[data-loading-toggle]').forEach(button => {
  const active = button.dataset.loadingToggle === sidebar.groupId;
  let expanded = false;
  try { expanded = sessionStorage.getItem(`otonote-sidebar-v2:${button.dataset.loadingToggle}`) === 'true'; } catch { /* Storage is optional. */ }
  if (active) button.closest('.nav-group').setAttribute('data-active', '');
  toggleGroup(button, active || expanded);
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-expanded') !== 'true';
    toggleGroup(button, next);
    try { sessionStorage.setItem(`otonote-sidebar-v2:${button.dataset.loadingToggle}`, String(next)); } catch { /* Storage is optional. */ }
  }, options);
});
if (sidebar.groupId) document.querySelector(`[data-loading-group="${sidebar.groupId}"]`)?.setAttribute('data-active', '');
let navigationStorage;
try { navigationStorage = sessionStorage; } catch { /* Storage is optional. */ }
restoreNavigationScroll(navigation, navigationStorage, options);
const mobile = matchMedia('(max-width: 1100px)');
const menu = document.querySelector('[data-loading-menu]');
const backdrop = document.querySelector('[data-loading-backdrop]');
backdrop.setAttribute('aria-label', english ? 'Close navigation' : '关闭导航');
const background = document.querySelectorAll('#main-content,.site-brand,.site-breadcrumb,.global-search,.context-switcher');
function setMenu(open) {
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', english ? (open ? 'Close navigation' : 'Open navigation') : (open ? '关闭导航' : '打开导航'));
  navigation.toggleAttribute('data-open', open);
  navigation.inert = mobile.matches && !open;
  document.body.toggleAttribute('data-nav-open', open);
  backdrop.hidden = !open;
  background.forEach(node => { node.inert = open; });
  if (open) revealCurrentNavigation(navigation);
}
setMenu(false);
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  setMenu(open);
  if (open) (navigation.querySelector('a[aria-current="page"]') ?? navigation.querySelector('a'))?.focus({preventScroll:true});
}, options);
backdrop.addEventListener('click', () => { setMenu(false); menu.focus(); }, options);
mobile.addEventListener('change', () => {setMenu(false); revealCurrentNavigation(navigation);}, options);
document.addEventListener('keydown', event => {
  if (menu.getAttribute('aria-expanded') !== 'true') return;
  if (event.key === 'Escape') { setMenu(false); menu.focus(); }
  if (event.key === 'Tab') {
    const nodes = [...navigation.querySelectorAll('a,button'),menu].filter(node => node.getClientRects().length && !node.closest('[inert]'));
    const index = nodes.indexOf(document.activeElement);
    if (event.shiftKey ? index <= 0 : index < 0 || index === nodes.length - 1) {
      event.preventDefault(); nodes[event.shiftKey ? nodes.length - 1 : 0]?.focus();
    }
  }
}, options);

const errorKey = Symbol.for('ournotes.loading-error.v1');
function showError() {
  const status = document.querySelector('[data-content-status]');
  if (!status || !root.hasAttribute('data-loading')) return;
  status.querySelector('[data-loading-message]').textContent = english ? 'Content could not be loaded' : '内容暂时无法加载';
  status.setAttribute('role', 'alert');
  interlude.dataset.failed = 'true';
  document.querySelector('[data-loading-caption]').textContent = english ? 'Let’s try that again.' : '稍作停顿，再试一次。';
  status.querySelector('.loading-dot').hidden = true;
  document.querySelector('#main-content').setAttribute('aria-busy', 'false');
  skeleton.hidden = true;
  document.querySelector('[data-loading-error]').hidden = false;
}
globalThis[errorKey] = showError;
// This also recovers when the boot module itself fails to download.
const timer = setTimeout(showError, 20000);
window.addEventListener('error', event => {
  if (event.target instanceof HTMLScriptElement && /\/boot-[^/]+\.js$/.test(event.target.src)) showError();
}, {...options,capture:true});
document.addEventListener('ournotes:shell-dispose', () => {
  clearTimeout(timer); controller.abort(); setMenu(false); delete globalThis[errorKey];
}, {once:true});
