/** Resolve artwork within the event's content release. */
export function resolveEventArtwork(event, { background, logo, cards, supportArtworks }) {
  const preview = asset => asset?.sourceReleaseId === event.sourceReleaseId ? asset.previewUrl : undefined;
  // Keep one stable cover across the home page, archives and event details.
  const cover = preview(background) || cards
    .filter(card => card.resourceType === 3 && card.rarity === 4)
    .sort((a, b) => a.resourceId - b.resourceId)
    .map(card => preview(supportArtworks.get(card.resourceId)))
    .find(Boolean);
  return { cover, logo: preview(logo) };
}
