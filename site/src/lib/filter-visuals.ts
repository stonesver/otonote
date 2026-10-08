import { catalog, getAsset, getCardAttribute, getCardRarity } from './catalog';
import { storyAvatar } from './story-avatars';

export function filterVisual(group: string, value: string, fallback?: string, label?: string) {
  const kind = group.includes('attribute') || group === 'music-type' ? 'attribute'
    : group.includes('rarity') ? 'rarity'
    : group.includes('band') ? 'band'
    : group.includes('character') ? 'character' : group;
  if (kind === 'band' || kind === 'tag' || (kind === 'target' && value.startsWith('band-'))) {
    const band = catalog.bands.find(b => kind === "tag" ? b.displayName === label : b.id === value || String(b.masterId) === value);
    if (band) {
      const icon = getAsset(band.logoAssetId)?.previewUrl || fallback;
      return { icon, iconOnly: Boolean(icon), round: false };
    }
  }
  if (kind === 'character' || kind === 'target') {
    const character = catalog.characters.find(c => c.id === value || String(c.masterId) === value);
    const avatar = storyAvatar(character);
    if (avatar) return { icon: avatar.thumbnailUrl || avatar.previewUrl, iconOnly: true, round: true };
  }
  const attribute = kind === 'attribute' ? getCardAttribute(Number(value)) : undefined;
  const rarity = kind === 'rarity' ? getCardRarity(Number(value)) : undefined;
  const definition = attribute || rarity;
  const icon = getAsset(definition?.iconAssetId)?.previewUrl || fallback;
  return { icon, iconOnly: Boolean(icon), round: false, label: attribute?.names[catalog.release.locale] || rarity?.label };
}

// Small presentation-only map for native select filters enhanced in the browser.
export const filterVisualOptions = {
  band: catalog.bands.map(b => ({ value: String(b.masterId), id: b.id, label: b.displayName, ...filterVisual('band', b.id) })),
  character: catalog.characters.map(c => ({ value: String(c.masterId), id: c.id, label: c.displayName, ...filterVisual('character', c.id) })),
  attribute: catalog.cardTaxonomy.attributes.map(a => ({ value: String(a.code), ...filterVisual('attribute', String(a.code)) })),
  rarity: catalog.cardTaxonomy.rarities.map(r => ({ value: String(r.code), ...filterVisual('rarity', String(r.code)), label: r.label }))
};
