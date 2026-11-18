import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEventArtwork } from '../src/lib/event-artwork.mjs';
import { collectEventCards } from '../src/lib/event-card-model.mjs';

const release = 'global-release';
const asset = (id, sourceReleaseId = release) => ({ sourceReleaseId, previewUrl: `/content/${sourceReleaseId}/${id}.webp` });
const fixture = () => {
  // Event 4's card relations: two SSR snapshots and one SR snapshot, each with two bonus effects.
  const event = {
    id: 4, sourceReleaseId: release, assets: { background: null },
    pickupCards: [], achievements: [], exchanges: [], ranking: { rewards: [] }, challengeSongs: [],
    effects: [75, 76, 77].flatMap(supportCardId => [1, 2].map(bonusType => ({ bonusType, constraints: { supportCardId } }))),
  };
  const cards = collectEventCards(event, (resourceType, resourceId) => ({
    resourceType, resourceId, rarity: resourceId === 77 ? 3 : 4,
  }));
  const supportArtworks = new Map([74, 75, 76, 77].map(id => [id, asset(`snapshot-${id}`)]));
  return { event, cards, supportArtworks };
};

test('missing event background uses a stable same-event SSR snapshot', () => {
  const { event, cards, supportArtworks } = fixture();
  cards.reverse();
  const before = structuredClone(cards);
  const artwork = resolveEventArtwork(event, { cards, supportArtworks });
  assert.equal(artwork.cover, supportArtworks.get(75).previewUrl);
  assert.equal(artwork.logo, undefined);
  assert.deepEqual(cards, before);
});

test('official event background and logo keep priority over snapshots', () => {
  const { event, ...context } = fixture();
  const background = asset('event-background');
  const logo = asset('event-logo');
  assert.deepEqual(resolveEventArtwork(event, { ...context, background, logo }), {
    cover: background.previewUrl, logo: logo.previewUrl,
  });
});

test('an unavailable first SSR image advances to the next same-event SSR', () => {
  const { event, cards, supportArtworks } = fixture();
  supportArtworks.delete(75);
  assert.equal(resolveEventArtwork(event, { cards, supportArtworks }).cover, supportArtworks.get(76).previewUrl);
  supportArtworks.set(75, { sourceReleaseId: release });
  assert.equal(resolveEventArtwork(event, { cards, supportArtworks }).cover, supportArtworks.get(76).previewUrl);
});

test('artwork from another content release is never used, including background and logo', () => {
  const { event, cards, supportArtworks } = fixture();
  supportArtworks.set(75, asset('snapshot-75', 'jp-release'));
  const background = asset('background', 'jp-release');
  const logo = asset('logo', 'jp-release');
  assert.deepEqual(resolveEventArtwork(event, { cards, supportArtworks, background, logo }), {
    cover: supportArtworks.get(76).previewUrl, logo: undefined,
  });
  supportArtworks.set(76, asset('snapshot-76', 'older-global-release'));
  assert.equal(resolveEventArtwork(event, { cards, supportArtworks, background, logo }).cover, undefined);
});

test('SR, member cards and unrelated snapshots cannot become event covers', () => {
  const { event, supportArtworks } = fixture();
  const cards = [{ resourceType: 3, resourceId: 77, rarity: 3 }, { resourceType: 2, resourceId: 75, rarity: 4 }];
  assert.equal(resolveEventArtwork(event, { cards, supportArtworks }).cover, undefined);
  assert.equal(resolveEventArtwork(event, { cards: [], supportArtworks }).cover, undefined);
});
