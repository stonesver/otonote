import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import { NAVIGATION_GROUPS, activeNavigationGroup, navigationRoutes } from "../src/lib/navigation.mjs";

test('tool directory and sidebar expose the same canonical tools without duplicate workbenches', () => {
  const directory = readFileSync(new URL('../src/pages/tools/index.astro',import.meta.url),'utf8');
  const links = [...directory.matchAll(/path:'([^']+)'/g)]
    .map(match=>match[1].startsWith('/')?match[1]:`/tools/${match[1]}/`)
    .filter(path=>path.startsWith('/tools/'));
  assert.deepEqual(links.sort(), NAVIGATION_GROUPS.find(group=>group.id==='tools').children.map(child=>child.href).sort());
  assert.equal(new Set(links).size,8);
  assert.ok(links.includes('/tools/gacha-history/'));
});

test("V1 includes galleries and the immersive scene while legacy media archives stay closed", () => {
  assert.deepEqual(NAVIGATION_GROUPS.map(g => g.id), ["events", "catalog", "music", "immersive", "comics", "stamps", "decorations", "stories", "my-growth", "tools"]);
  const routes = navigationRoutes();
  for (const path of ["/events/", "/characters/", "/cards/members/", "/cards/supports/", "/database/skills/", "/music/", "/tools/deck-builder/"]) assert.ok(routes.includes(path));
  assert.ok(!routes.includes("/stories/"));
  for (const kind of ["main", "extra", "viewpoint", "friendship", "events"]) assert.ok(routes.includes(`/stories/${kind}/`));
  assert.ok(routes.includes("/immersive/"));
  assert.ok(routes.includes("/tools/event-efficiency/"));
  assert.ok(!routes.includes("/tools/optimizer/"));
  assert.ok(routes.every(path => !path.includes("high-score-rating") && !path.includes("game-modes")));
  assert.ok(routes.every(path => !/^\/(resources|anontokyo)\//.test(path)));
  assert.equal(routes.length, new Set(routes).size);
});
test("nested data and tool routes retain their correct navigation context", () => {
  for (const path of ["/cards/supports/support-1/", "/database/skills/skill-1/"]) assert.equal(activeNavigationGroup(path), "catalog");
  assert.equal(activeNavigationGroup("/tools/deck-builder/"), "tools");
  assert.equal(activeNavigationGroup("/game-modes/gekisou/"), undefined);
  assert.equal(activeNavigationGroup("/events/"), "events");
  assert.equal(activeNavigationGroup("/arena/"), "events");
  assert.equal(activeNavigationGroup("/missions/"), "events");
  assert.equal(activeNavigationGroup("/immersive/"), "immersive");
  assert.equal(activeNavigationGroup("/recruitment/1/"), "events");
  assert.equal(activeNavigationGroup("/stories/episodes/story-entry-main-101/"), "stories");
  assert.equal(activeNavigationGroup("/"), "home");
});


import {SIDEBAR_TOOLS, SIDEBAR_GROUPS, sidebarSelection, renderSidebarNavigation} from '../src/lib/sidebar-navigation.mjs';

test('compact sidebar preserves every canonical destination and promotes the three workbenches', () => {
  const routes = new Set([...SIDEBAR_TOOLS, ...SIDEBAR_GROUPS.flatMap(group => [group, ...group.children])].map(item => item.href));
  assert.deepEqual([...routes].sort(), navigationRoutes().sort());
  assert.deepEqual(SIDEBAR_TOOLS.map(item => item.href), ['/tools/deck-builder/', '/tools/song-calculator/', '/tools/event-efficiency/']);
  for (const item of SIDEBAR_TOOLS) assert.equal(sidebarSelection(item.href).groupId, undefined);
  assert.deepEqual(sidebarSelection('/music/bgm/track-1/'), {route:'/music/bgm/', groupId:'library'});
  assert.equal(sidebarSelection('/stories/episodes/story-entry-main-101/').groupId, 'library');
  assert.equal(sidebarSelection('/tools/song-ranking/').groupId, 'more-tools');
  assert.equal(sidebarSelection('/rankings/').groupId, 'events');
});

test('shared sidebar HTML starts compact, keeps locale URLs and highlights deep links', () => {
  const ui = new Proxy({}, {get: (_, key) => String(key)});
  const options = {ui, href: path => `/jp/en${path}`, locale:'en'};
  const tools = renderSidebarNavigation({...options, pathname:'/tools/event-efficiency/'});
  assert.equal((tools.match(/aria-expanded="false"/g) ?? []).length, 3);
  assert.equal((tools.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(tools, /data-nav-workspace aria-haspopup="dialog"/);
  assert.match(tools, /href="\/jp\/en\/tools\/deck-builder\/\?workspace=1"/);
  assert.match(tools, /MY TOOLS/);
  const library = renderSidebarNavigation({...options, pathname:'/cards/members/card-1/'});
  assert.match(library, /data-loading-group="library" data-active/);
  assert.equal((library.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.match(library, /data-loading-route="\/cards\/members\/" aria-current="page"/);
  assert.equal((renderSidebarNavigation({...options, pathname:'/catalog/'}).match(/aria-current="page"/g) ?? []).length, 1);
});
