import type {EditionRecord} from "./catalog";
import { activeReleaseContext } from './release-context';
export interface GalleryEntry extends EditionRecord {
  contentIdentity?:string; sourceSha256?:string; sourceResource?:string;
  id: number; title: string; characterIds: number[]; bandIds: number[]; category: string;
  image: string | null; thumbnail: string | null; width: number | null; height: number | null;
  mediaType: 'comics' | 'stamps' | 'stickers' | 'backgrounds'; status: 'available' | 'missing'; description: string;
}
interface Gallery {
  schemaVersion: number; sourceReleaseId: string; locale: string; resourceVersion: string;
  comics: GalleryEntry[]; stamps: GalleryEntry[]; stickers: GalleryEntry[]; backgrounds: GalleryEntry[];
  characters: { id: number; name: string; bandId: number }[]; bands: { id: number; name: string }[];
}
const files = import.meta.glob<Gallery>('@projection-data/gallery.json', { eager: true, import: 'default' });
export const gallery: Gallery = Object.values(files)[0] ?? {
  schemaVersion: 2, sourceReleaseId: activeReleaseContext.contentReleaseId, locale: activeReleaseContext.locale,
  resourceVersion: '', comics: [], stamps: [], stickers: [], backgrounds: [], characters: [], bands: []
};
if (gallery.schemaVersion !== 2 || gallery.sourceReleaseId !== activeReleaseContext.contentReleaseId || gallery.locale !== activeReleaseContext.locale) {
  throw new Error('Gallery does not match the selected release and locale');
}
