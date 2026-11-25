import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardCatalogAccessor, createRankingInsightsClient } from '../src/lib/ranking-insights-ui.mjs';
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

test('activity teaser labels ongoing 24h trend separately from finalized closing 24h', async () => {
  const makeClient = isFinal => {
    const host = { hidden: true, innerHTML: '' };
    const client = createRankingTeaserClient({
      container: host,
      mode: 'activity',
      en: false,
      catalog: {},
      statsBaseHref: '/global/zh-CN/rankings/stats/',
      fetcher: async () => ({
        ok: true,
        async json() {
          return {
            status: 'available',
            mode: 'activity',
            musicId: '1001',
            isFinal,
            songs: [{ id: '1001' }],
            stats: { n: 100, members: { unique: 5, top: [{ key: [1, 2, 3, 4, 5], count: 50 }] } },
            closingHistory: [{ music: '1001', isFinal, changes: [{ rank: 100, pct: 3.45 }] }],
          };
        },
      }),
    });
    return { host, client };
  };

  const ongoing = makeClient(false);
  await ongoing.client.select({ serverId: 'global-hmt', eventId: '6', musicId: '1001' });
  assert.match(ongoing.host.innerHTML, /近24h百名线/);
  assert.doesNotMatch(ongoing.host.innerHTML, /最后24h百名线/);

  const finalized = makeClient(true);
  await finalized.client.select({ serverId: 'global-hmt', eventId: '5', musicId: '1001' });
  assert.match(finalized.host.innerHTML, /最后24h百名线/);
});

test('insights UI renders ongoing 24h trend labels and non-empty cross-band support matrix', async () => {
  const makeContainer = () => ({ innerHTML: '', addEventListener() {}, querySelector() { return null; } });

  // Ongoing activity 24h tab
  const actContainer = makeContainer();
  const actClient = createRankingInsightsClient({
    container: actContainer,
    mode: 'activity',
    en: false,
    catalog: { v: 2, imgBase: '', hrefBase: '/global/zh-CN/cards/', member: {}, support: {}, attributes: {}, rarities: {} },
    bands: [],
    songs: { '1001': 'Test Song' },
    initialTab: 'closing',
    serverId: 'global-hmt',
    fetcher: async () => ({
      ok: true,
      async json() {
        return {
          status: 'available',
          mode: 'activity',
          eventId: '6',
          musicId: '1001',
          isFinal: false,
          songs: [{ id: '1001', name: 'Test Song' }],
          stats: { n: 100, members: { unique: 5, top: [{ key: [1, 2, 3, 4, 5], count: 50 }] } },
          closingHistory: [{
            event: '6',
            music: '1001',
            name: 'Test Song',
            isFinal: false,
            end: 1764050400,
            checkpoints: [
              { hoursBeforeEnd: 24, observed: 1764050400 - 24 * 3600, scores: { '10': 1400000, '50': 1200000, '100': 1000000 } },
              { hoursBeforeEnd: 12, observed: 1764050400 - 12 * 3600, scores: { '10': 1450000, '50': 1240000, '100': 1050000 } },
            ],
            changes: [
              { rank: 10, before: 1400000, final: 1540000, increase: 140000, pct: 10.0 },
              { rank: 50, before: 1200000, final: 1320000, increase: 120000, pct: 10.0 },
              { rank: 100, before: 1000000, final: 1100000, increase: 100000, pct: 10.0 },
            ],
          }],
        };
      },
    }),
  });
  await actClient.select({ serverId: 'global-hmt', eventId: '6', musicId: '1001' });
  assert.match(actContainer.innerHTML, /近 24 小时涨分趋势/);
  assert.match(actContainer.innerHTML, /当前最新/);
  assert.match(actContainer.innerHTML, /近24h百名线/);
  assert.doesNotMatch(actContainer.innerHTML, /最后 24 小时冲刺曲线/);

  // Arena 5x5 support matrix with support bandIds populated
  const arenaContainer = makeContainer();
  const arenaClient = createRankingInsightsClient({
    container: arenaContainer,
    mode: 'arena',
    en: false,
    catalog: {
      v: 2,
      imgBase: '',
      hrefBase: '/global/zh-CN/cards/',
      member: { '1': ['Member A', '', '', 3, 1] },
      support: { '201': ['Cross Support', '', '', 3, 1, ['1']] },
      attributes: {},
      rarities: { '3': ['SSR', ''] },
    },
    bands: [
      { id: '1', name: 'Band 1', image: null },
      { id: '2', name: 'Band 2', image: null },
    ],
    initialTab: 'closing',
    serverId: 'global-hmt',
    fetcher: async () => ({
      ok: true,
      async json() {
        return {
          status: 'available',
          mode: 'arena',
          seasonId: '1',
          bandId: '1',
          stats: { n: 100, members: { unique: 5, top: [{ key: [1, 2, 3, 4, 5], count: 50 }] }, memberUsage: [], pairUsage: [] },
          crossBand: [{ support: 201, boards: [{ band: '1', count: 80, pct: 80 }, { band: '2', count: 25, pct: 25 }] }],
        };
      },
    }),
  });
  await arenaClient.select({ serverId: 'global-hmt', seasonId: '1', bandId: '1' });
  // Closing tab's Top 10 cross-band supports must only count outside-band (25), not own band (80)
  assert.match(arenaContainer.innerHTML, /Cross Support/);
  assert.match(arenaContainer.innerHTML, /<b>25<\/b>/);
  assert.doesNotMatch(arenaContainer.innerHTML, /<b>105<\/b>/);
});
