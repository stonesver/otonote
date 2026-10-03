import {activeReleaseContext} from './release-context';
import {validateCostumes} from './costume-library.mjs';

export interface CostumeModel {
  masterId:number; typeCode:number; modelPath:string; modelId:string | null;
  state:'available' | 'unavailable';
}
export interface Costume {
  id:string; masterId:number; name:string; characterId:string; characterMasterId:number;
  bandId:string; isInitial:boolean; unlockMemberCardId:string | null; startAt:string | null;
  icon:{url:string; width:number; height:number} | null; models:CostumeModel[];
}
export interface CostumeCatalog {
  schemaVersion:1; contentReleaseId:string; region:string; locale:string;
  status:'available' | 'unavailable'; costumes:Costume[];
}
const files = import.meta.glob<CostumeCatalog>('@projection-data/costumes.json', {eager:true, import:'default'});
export const costumeCatalog:CostumeCatalog = validateCostumes(Object.values(files)[0], activeReleaseContext);
