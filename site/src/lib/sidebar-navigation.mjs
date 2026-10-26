import { NAVIGATION_GROUPS, activeNavigationGroup, activeNavigationChild } from './navigation.mjs';
import { navIcons } from './navigation-icons.mjs';

const tools = NAVIGATION_GROUPS.find(group => group.id === 'tools');
const primaryPaths = ['/tools/deck-builder/', '/tools/song-calculator/', '/tools/event-efficiency/'];
const toolTitles = [['配队推荐', 'Team builder'], ['估分与选曲', 'Score & songs'], ['活动收益', 'Event planner']];
export const SIDEBAR_TOOLS = primaryPaths.map((href, index) => ({...tools.children.find(item => item.href === href), title: toolTitles[index]}));
const browseIds = ['catalog', 'music', 'immersive', 'comics', 'stamps', 'decorations', 'stories'];
const browse = NAVIGATION_GROUPS.filter(group => browseIds.includes(group.id));
const uniqueRoutes = items => [...new Map(items.map(item => [item.href, item])).values()];
export const SIDEBAR_GROUPS = [
  {...NAVIGATION_GROUPS.find(group => group.id === 'events'), title: ['活动信息', 'Events']},
  {id: 'library', href: '/catalog/', title: ['资料浏览', 'Browse library'], children: uniqueRoutes(browse.flatMap(group => [group, ...group.children]))},
  {id: 'more-tools', href: '/tools/', title: ['更多工具', 'More tools'], children: [
    ...tools.children.filter(item => !primaryPaths.includes(item.href)),
    NAVIGATION_GROUPS.find(group => group.id === 'my-growth')
  ]}
];

/** Canonical routes still own breadcrumbs; this is their compact sidebar presentation. */
export function sidebarSelection(pathname) {
  const group = NAVIGATION_GROUPS.find(item => item.id === activeNavigationGroup(pathname));
  const route = activeNavigationChild(pathname, group?.children ?? [])?.href ?? group?.href ?? pathname;
  const browseGroup = SIDEBAR_GROUPS.find(item => item.href === route || item.children.some(child => child.href === route));
  return {route, groupId: browseGroup?.id};
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icons = {
  ...navIcons,
  '/tools/deck-builder/': 'M3 4h7v7H3z M14 4h7v7h-7z M3 15h7v6H3z M14 15h7v6h-7z',
  '/tools/song-calculator/': navIcons.music,
  '/tools/event-efficiency/': 'M4 20V11h4v9 M10 20V7h4v13 M16 20V3h4v17',
  workspace: 'M4 5h13v15H4z M8 2h13v15 M8 9h5 M8 13h5',
  library: navIcons.stories, 'more-tools': navIcons.tools,
  home: 'M3 10l9-7 9 7 M5 9v12h5v-7h4v7h5V9'
};
const svg = id => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[id]}"/></svg>`;

/** Shared HTML for Astro pages and the content-independent cold entry. */
export function renderSidebarNavigation({ui, englishUi = ui, locale = 'zh-CN', pathname = '/', href = path => path}) {
  const english = locale === 'en';
  const selected = sidebarSelection(pathname);
  const text = (zh, en) => `<span data-loading-en="${escape(en)}">${escape(english ? en : zh)}</span>`;
  const label = key => text(ui[key], englishUi[key]);
  const link = (path, content, classes = '', extra = '') => `<a class="${classes}" href="${escape(href(path))}" data-loading-route="${escape(path)}"${selected.route === path ? ' aria-current="page"' : ''}${extra}>${content}</a>`;
  return `<div class="nav-section nav-my-tools" aria-label="${english ? 'My tools' : '我的工具'}">
    <p class="nav-caption">${text('我的工具', 'MY TOOLS')}</p>
    ${SIDEBAR_TOOLS.map(item => link(item.href, svg(item.href) + text(...item.title), 'nav-primary nav-tool')).join('')}
    ${link('/tools/deck-builder/?workspace=1', svg('workspace') + text('卡库与队伍', 'Cards & teams'), 'nav-primary nav-workspace', ' data-nav-workspace aria-haspopup="dialog"')}
  </div>
  <div class="nav-section nav-browse" aria-label="${english ? 'Browse' : '浏览'}">
    <p class="nav-caption">${text('浏览', 'BROWSE')}</p>
    ${link('/', svg('home') + text('首页概览', 'Overview'), 'nav-home')}
    ${SIDEBAR_GROUPS.map(group => {
      const active = selected.groupId === group.id;
      return `<div class="nav-group" data-loading-group="${group.id}"${active ? ' data-active' : ''}>
        ${link(group.href, svg(group.id) + text(...group.title), 'nav-primary')}
        <button class="nav-submenu-toggle" type="button" aria-expanded="${active}" aria-controls="nav-submenu-${group.id}" aria-label="${escape((active ? ui.collapseNavigationGroup : ui.expandNavigationGroup) + group.title[english ? 1 : 0])}" data-nav-submenu-toggle data-nav-group-id="${group.id}" data-loading-toggle="${group.id}"><span aria-hidden="true">${active ? '−' : '+'}</span></button>
        <div class="nav-submenu" id="nav-submenu-${group.id}" data-nav-submenu${active ? '' : ' hidden inert'}>${group.children.filter(child => child.href !== group.href).map(child => link(child.href, label(child.labelKey))).join('')}</div>
      </div>`;
    }).join('')}
  </div>`;
}
