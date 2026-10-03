import {entityIdentity,entityComparison} from './entity-identity.mjs';
import {itemIndex as nativeItems,skillIndex as nativeSkills} from './game-database';
import {catalog} from './shared-catalog';
import {activeReleaseContext} from './release-context';
import {otherEditionArtifact} from '../runtime/content.mjs';
import {mergeEditionRows,stableContent} from './edition-library.mjs';
export * from './game-database';
const {region,locale}=activeReleaseContext, other=region==='jp'?'global':'jp';
async function merge(kind:'items'|'skills', rows:typeof nativeItems | typeof nativeSkills) {
  const secondary=await otherEditionArtifact(region,`projection/database-shards/${kind}-index.json`);
  const icon=(id:string,foreign=false)=>catalog.assets.find(a=>a.id===(foreign?`${other}--${id}`:id))?.sha256;
  const mark=(entries:typeof rows,foreign=false)=>entries.map(row=>({...row,libraryKey:entityIdentity(kind,row) ?? row.contentIdentity ?? (kind==='items' && icon(row.iconAssetId!,foreign)
    ? stableContent([row.masterId,icon(row.iconAssetId!,foreign),Reflect.get(row,'typeCode'),Reflect.get(row,'maxOwned')]) : null)}));
  const merged=mergeEditionRows(mark(rows),secondary?mark(secondary.records,true):null,{
    region,locale,key:(row:{libraryKey:string})=>row.libraryKey,
    path:(row:{id:string})=>`/database/${kind}/${row.id}/`, difference:row=>entityComparison(kind,row)
  });
  for(const row of merged)if(row.sourceEdition===other&&row.iconAssetId)row.iconAssetId=`${other}--${row.iconAssetId}`;
  return merged;
}
export const itemIndex=await merge('items',nativeItems) as typeof nativeItems;
export const skillIndex=await merge('skills',nativeSkills) as typeof nativeSkills;
