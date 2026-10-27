import {catalog,getAsset} from './catalog';
import formalRules from '../data/formal-scoring-rules.json';
/** Collection metadata only: opening the library never runs a song search/scorer. */
export function sharedPlaylistData(){
 const music=new Map((formalRules.tables?.LiveMusic??[]).map(m=>[`music-${m._id}`,m]));
 return {sourceReleaseId:catalog.release.id,tracks:catalog.musicTracks.map(t=>{const m=music.get(t.id);return {...t,jacketUrl:getAsset(t.jacketAssetId)?.previewUrl,missions:m?[m._gekisouMission1,m._gekisouMission2,m._gekisouMission3]:[]};}),charts:catalog.musicCharts,
 attributeVisuals:catalog.cardTaxonomy.attributes.map(a=>({code:a.code,name:a.names[catalog.release.locale],iconUrl:getAsset(a.iconAssetId)?.previewUrl}))};
}
