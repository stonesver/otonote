import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardCatalogAccessor } from '../src/lib/ranking-insights-ui.mjs';
import { createRankingTeaserClient } from '../src/lib/ranking-teaser-ui.mjs';

test('compact v2 card catalog lazily unpacks member and support tuples with prefix restoration', () => {
  const accessor = createCardCatalogAccessor({
    v: 2,
    imgBase: '/content/releases/abc123/public/media/',
    hrefBase: '/global/zh-CN/cards/',
    member: {
      '1001': ['Test Member', 'cards/m1001.webp', '', 3, 2],
      '1002': ['Custom Slug', '/other/m1002.webp', 'special-member', 2, 1],
    },
    support: {
      '2001': ['Test Support', 'cards/s2001.webp', '', 3, 4, ['1', '3']],
    },
    attributes: { '2': '/media/attr-2.webp' },
    rarities: { '2': ['SR', '/media/sr.webp'], '3': ['SSR', '/media/ssr.webp'] },
  }, 'global-hmt');

  const m1 = accessor.getCard('member', 1001);
  assert.equal(m1.name, 'Test Member');
  assert.equal(m1.image, '/content/releases/abc123/public/media/cards/m1001.webp');
  assert.equal(m1.href, '/global/zh-CN/cards/members/member-card-1001/?server=global-hmt');
  assert.equal(m1.rarityLabel, 'SSR');
  assert.equal(accessor.getAttrImg(m1.attr), '/media/attr-2.webp');
  assert.equal(accessor.getRarityImg(m1.rarity), '/media/ssr.webp');
  assert.equal(accessor.getCard('member', 1001), m1, 'reuses memoized card object');

  const m2 = accessor.getCard('member', 1002);
  assert.equal(m2.image, '/other/m1002.webp');
  assert.equal(m2.href, '/global/zh-CN/cards/members/special-member/?server=global-hmt');
  assert.equal(m2.rarityLabel, 'SR');

  const s1 = accessor.getCard('support', 2001);
  assert.equal(s1.href, '/global/zh-CN/cards/supports/support-card-2001/?server=global-hmt');
  assert.deepEqual(s1.bandIds, ['1', '3']);
});

test('teaser client requests view=teaser, caches responses, and emits lazy async images', async () => {
  const calls = [];
  const host = { hidden: true, innerHTML: '' };
  const fetcher = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      async json() {
        return {
          status: 'available',
          mode: 'arena',
          stats: {
            n: 100,
            members: { unique: 12, top: [{ key: [1, 2, 3, 4, 5], count: 40 }] },
            headCardRanks: { member: { '1': [3] }, support: {} },
          },
          crossBand: [{ support: 201, boards: [{ band: '2', count: 15 }] }],
        };
      },
    };
  };

  const client = createRankingTeaserClient({
    container: host,
    mode: 'arena',
    en: false,
    catalog: {
      member: { '1': { name: 'Low Rarity', image: '/m1.webp', rarityLabel: 'SR', bandIds: [] } },
      support: { '201': { name: 'Worker Support', image: '/s201.webp', rarityLabel: 'SSR', bandIds: ['1'] } },
    },
    statsBaseHref: '/global/zh-CN/rankings/stats/',
    fetcher,
  });

  const scope = { serverId: 'global-hmt', seasonId: '1', bandId: '1' };
  await client.select(scope);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /view=teaser/);
  assert.equal(calls[0].opts.cache, undefined, 'does not force cache: no-store');
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /loading="lazy"/);
  assert.match(host.innerHTML, /decoding="async"/);
  assert.match(host.innerHTML, /#3/);

  // Second select for the same scope hits the in-memory cache
  await client.select(scope);
  assert.equal(calls.length, 1);
});
