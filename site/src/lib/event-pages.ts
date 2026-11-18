import {otherEditionArtifact} from '../runtime/content.mjs';
import {annotateOperations} from './operation-editions.mjs';
import { gameModeDatabase } from "./game-modes";
import { activeReleaseContext } from "./release-context";
import { catalog, getAsset } from "./catalog";
import { siteHref } from "./site-context";
import { validatedEvents } from "./event-content.mjs";
import type { EventDefinition, EventMediaMap, EventReward, EventIdentity, EventCard } from "./event-archive";
import { collectEventCards } from "./event-card-model.mjs";
import { resolveEventArtwork } from "./event-artwork.mjs";
import { gallery } from "./gallery";
const secondaryEvents=await otherEditionArtifact(activeReleaseContext.region,'projection/game-modes.json');
export const eventRecords: EventDefinition[] = annotateOperations(validatedEvents(gameModeDatabase.events, activeReleaseContext),secondaryEvents?.events?.records??null,'events',activeReleaseContext.region,activeReleaseContext.locale);
export const eventHref = (path: string) => import.meta.env.BASE_URL === "/" ? path : siteHref(path, activeReleaseContext);
const assets = new Map(catalog.assets.map(asset => [asset.containerPath, asset]));
const supportArtworks = new Map(catalog.supportCards.map(card => [card.masterId, getAsset(card.primaryAssetId)]));
export function eventArtwork(event: EventDefinition) {
  const get = (path?: string | null) => path ? assets.get(`Assets/AddressableResources/Image/Event/${path}.png`) : undefined;
  return resolveEventArtwork(event, {
    background: get(event.assets?.background), logo: get(event.assets?.logo),
    cards: eventCards[event.id], supportArtworks,
  });
}

// Resolve only assets from the selected release; unavailable images use a neutral icon.
export const eventMedia: EventMediaMap = {};
const imageUrl = (id?: string | null, small = true) => {
  const asset = getAsset(id);
  return asset?.sourceReleaseId === activeReleaseContext.contentReleaseId
    ? (small ? asset.thumbnailUrl || asset.previewUrl : asset.previewUrl) : undefined;
};
function addRewardMedia(reward: EventReward) {
  const key = `${reward.resourceType}:${reward.resourceId}`;
  const card = reward.resourceType === 2 ? catalog.memberCards.find(card => card.masterId === reward.resourceId)
    : reward.resourceType === 3 ? catalog.supportCards.find(card => card.masterId === reward.resourceId) : undefined;
  const icon = reward.imagePath ? assets.get(`Assets/AddressableResources/${reward.imagePath}.png`) : undefined;
  const sticker = reward.resourceType === 17 ? gallery.stickers.find(item => item.id === reward.resourceId && item.status === 'available') : undefined;
  eventMedia[key] = card ? {
    image: imageUrl(card.thumbnailAssetId ?? card.primaryAssetId), artwork: imageUrl(card.primaryAssetId, false),
    href: eventHref(`/cards/${reward.resourceType === 2 ? 'members' : 'supports'}/${card.id}/`)
  } : { image: sticker?.image ?? imageUrl(icon?.id) };
}
export const eventCards: Record<number, EventCard[]> = {};
export const eventIdentities: Record<number, EventIdentity> = {};
for (const event of eventRecords) {
  eventCards[event.id] = collectEventCards(event, (type: number, id: number) => {
    const card = (type === 2 ? catalog.memberCards : catalog.supportCards).find(card => card.masterId === id);
    return card ? { resourceType: type, resourceId: id, name: card.displayName, resolved: true, rarity: card.rarity, count: null } : undefined;
  });
  const bonusBands = event.effects.map(effect => effect.constraints.bandId).filter(Boolean);
  const bandIds = [...new Set([...bonusBands, event.story.bandId].filter(Boolean))];
  const featuredBands = catalog.bands.filter(band => bandIds.includes(band.masterId));
  const characterIds = event.story.characterIds?.length ? event.story.characterIds : event.effects.map(effect => effect.constraints.characterId).filter(Boolean);
  eventIdentities[event.id] = {
    bands: featuredBands.map(band => ({ name: band.displayName, image: imageUrl(band.logoAssetId), bonus: bonusBands.includes(band.masterId) })),
    characters: catalog.characters.filter(character => characterIds.includes(character.masterId)).map(character => ({ name: character.displayName,
      image: imageUrl(assets.get(`Assets/AddressableResources/Character/Image/${character.masterId}/character_face_icon.png`)?.id) })),
    attributes: [...new Set(event.effects.map(effect => effect.constraints.cardType).filter((id): id is number => Boolean(id)))]
  };
  const rewards = [...eventCards[event.id], ...event.achievements.flatMap(row => row.rewards),
    ...event.loopRewards.flatMap(row => row.rewards), ...event.exchanges.flatMap(shop => shop.products.map(product => product.reward)),
    ...event.challengeSongs.flatMap(song => song.rankingRewards.flatMap(row => row.rewards)),
    ...Object.values(event.pointRules).flatMap(rule => rule.rewards.map(row => row.reward)),
    ...(event.eventItem ? [event.eventItem] : [])];
  const related = event.related;
  const relatedRewards = [...(related?.recruitment.flatMap(pool => pool.prizes) ?? []),
    ...(related?.missions.flatMap(group => group.stages.flatMap(stage => stage.rewards)) ?? []),
    ...(related?.passes.flatMap(pass => [...pass.levels.flatMap(level => [...level.free, ...level.premium]), ...pass.missions.flatMap(group => group.stages.flatMap(stage => stage.rewards))]) ?? [])];
  relatedRewards.filter(reward => (reward.resourceType ?? 0) > 0).forEach(reward => addRewardMedia({...reward, resolved:true, rarity:null}));
  rewards.forEach(addRewardMedia);
  for (const song of event.challengeSongs) {
    const track = catalog.musicTracks.find(track => track.masterId === song.musicId);
    if (track) eventMedia[`8:${song.musicId}`] = { image: imageUrl(track.jacketAssetId, false),
      href: eventHref(`/music/${track.id}/`), label: track.bandLabels.join(' / ') };
  }
}
export const eventArtworks = Object.fromEntries(eventRecords.map(event => [event.id, eventArtwork(event)]));
