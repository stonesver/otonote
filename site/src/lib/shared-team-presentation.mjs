import {catalog,getAsset} from './catalog';
import {filterVisualOptions} from './filter-visuals';

/** Small maps shared by card views; asset IDs are resolved once at the catalog boundary. */
export function sharedTeamPresentation() {
  return {filterVisualOptions,growthIcons:Object.fromEntries(Object.entries(catalog.cardTaxonomy.growthIcons).map(([key,id])=>[key,getAsset(id)?.previewUrl??getAsset(id)?.thumbnailUrl??null]))};
}
