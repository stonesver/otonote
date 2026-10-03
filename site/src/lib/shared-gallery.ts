import {gallery as native} from './gallery';
import {galleryIdentity} from './shared-archives';
import {bindGalleryRows,entityComparison,preferAvailable} from './entity-identity.mjs';
import {mergeEditionRows} from './edition-library.mjs';
import {activeReleaseContext} from './release-context';
import {otherEditionArtifact,editionSnapshot,checkedJson} from '../runtime/content.mjs';
const kinds = ['comics','stamps','stickers','backgrounds'] as const;
const {region,locale}=activeReleaseContext, other=region==='jp'?'global':'jp';
const secondary=await otherEditionArtifact(region,'projection/gallery.json');
async function bindings(edition:string, catalog:typeof native | null) {
  if (!catalog || kinds.every(kind=>catalog[kind].every(row=>Reflect.get(row,'sourceResource')))) return null;
  try {
    const snapshot=await editionSnapshot(edition);
    return await checkedJson(snapshot.root+'public/gallery/manifest.json',undefined,undefined,{timeoutMs:5000});
  } catch {return null;} // Older/incomplete snapshots keep conservative hash matching.
}
const [primaryBindings,otherBindings]=await Promise.all([bindings(region,native),bindings(other,secondary)]);
const values=kinds.map(kind=>mergeEditionRows(bindGalleryRows(native[kind],primaryBindings),
  secondary ? bindGalleryRows(secondary[kind],otherBindings) : null,
  {region,locale,key:galleryIdentity,preferSecondary:preferAvailable,difference:row=>entityComparison('gallery',row)}));
export const gallery = {...native,...Object.fromEntries(kinds.map((kind,index)=>[kind,values[index]]))} as typeof native;
