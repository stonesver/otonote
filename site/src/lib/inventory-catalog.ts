import {catalog, getAsset, getBand, getCharacter, getCardRarity} from './catalog';
import {cardDetailProjections, publicSkills} from './game-card-data';
import {buildCardSkillFilters} from './card-skill-filtering.mjs';

const projectionById = new Map(
  [...cardDetailProjections.memberCards, ...cardDetailProjections.supportCards]
    .map((projection) => [projection.cardId, projection])
);

export const skillFilters = buildCardSkillFilters([...projectionById.values()],publicSkills,catalog.release.locale,'archive');
const skillMap = new Map(publicSkills.map(s=>[s.id,s]));
const skillsFor = (id: string) => (projectionById.get(id)?.skillRefs ?? []).flatMap(ref=>{
  const skill=skillMap.get(ref.skillId);return skill?[{slot:ref.slot,kind:skill.kind,name:skill.name,mission:skill.missionTypeCode,levels:skill.levels.map(l=>({level:l.level,summary:l.renderedSummary}))}]:[];
});
export const memberCards = catalog.memberCards.map((card) => {
  const character = getCharacter(card.characterId);
  const band = getBand(character?.bandId);
  return {
    ...card,
    kind: "member",
    rarityLabel: getCardRarity(card.rarity)?.label ?? `RARITY ${card.rarity}`,
    characterIds: [card.characterId], bandIds: character?.bandId ? [character.bandId] : [],
    skills: skillsFor(card.id), skillFacets: skillFilters.records.get(card.id),
    shortLabel: card.subtitle || card.displayName,
    relationLabel: [character?.displayName, band?.displayName].filter(Boolean).join(" · "),
    artUrl: getAsset(card.variantAssetIds?.[0])?.previewUrl ?? null,
  imageUrl: getAsset(card.thumbnailAssetId)?.thumbnailUrl ?? getAsset(card.thumbnailAssetId)?.previewUrl ?? null
  };
});
export const supportCards = catalog.supportCards.map((card) => ({
  ...card,
  kind: "support",
  rarityLabel: getCardRarity(card.rarity)?.label ?? `RARITY ${card.rarity}`,
  characterIds: card.featuredCharacterIds, bandIds: [...new Set(card.featuredCharacterIds.map(id=>getCharacter(id)?.bandId).filter(Boolean))],
  skills: skillsFor(card.id), skillFacets: skillFilters.records.get(card.id),
  shortLabel: card.description || card.displayName,
  relationLabel: card.featuredCharacterIds
    .map((id) => getCharacter(id)?.displayName)
    .filter(Boolean)
    .join("、"),
  artUrl: getAsset(card.variantAssetIds?.[0])?.previewUrl ?? null,
  imageUrl: getAsset(card.thumbnailAssetId)?.thumbnailUrl ?? getAsset(card.thumbnailAssetId)?.previewUrl ?? null
}));
export const projections = [...projectionById.values()].map((projection) => ({
  cardId: projection.cardId,
  skillSummaries: projection.skillSummaries
}));
