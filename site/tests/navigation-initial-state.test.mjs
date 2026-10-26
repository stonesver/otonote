import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const layout = readFileSync(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');

function initialNavigation({ stored = 'false', active = false, blocked = false } = {}) {
  const icon = { textContent: '−' };
  const submenu = { hidden: false, inert: false };
  const attributes = new Map([
    ['data-nav-group-id', 'catalog'], ['aria-controls', 'nav-submenu-catalog'],
    ['aria-expanded', 'true']
  ]);
  const button = {
    getAttribute: key => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    querySelector: () => icon,
    closest: selector => selector === '[data-active]' ? (active ? {} : null) : {
      querySelector: () => ({ textContent: '资料' })
    }
  };
  const script = layout.match(/<script is:inline data-nav-state-init>([\s\S]*?)<\/script>/);
  assert.ok(script, 'restore saved navigation synchronously, before deferred page scripts');
  assert.ok(layout.indexOf(script[0]) < layout.indexOf('</nav>'), 'initialize before navigation finishes parsing');
  vm.runInNewContext(script[1], {
    document: {
      documentElement: { lang: 'zh-CN' },
      querySelectorAll: () => [button],
      getElementById: () => submenu
    },
    window: { sessionStorage: { getItem() {
      if (blocked) throw new Error('Storage unavailable');
      return stored;
    } } }
  });
  return { submenu, expanded: attributes.get('aria-expanded'), label: attributes.get('aria-label'), icon: icon.textContent };
}

test('a saved collapsed catalog is hidden before the music page first paints', () => {
  const state = initialNavigation();
  assert.equal(state.submenu.hidden, true);
  assert.equal(state.submenu.inert, true);
  assert.equal(state.expanded, 'false');
  assert.equal(state.icon, '+');
  assert.equal(state.label, '展开导航分组：资料');
});

test('only the active group expands on first visits', () => {
  assert.equal(initialNavigation({ active: true }).submenu.hidden, false);
  assert.equal(initialNavigation({ stored: 'true' }).expanded, 'true');
  assert.equal(initialNavigation({ stored: null }).expanded, 'false');
});

test('blocked storage leaves the navigation usable', () => {
  assert.equal(initialNavigation({ blocked: true }).expanded, 'false');
});
