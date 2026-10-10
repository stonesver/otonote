import {artifact,artifactGlob} from '../runtime/content.mjs';

/** Start independent inputs together; runtime promises deduplicate template reads. */
export async function preloadTeamWorkspaceData({readArtifact=artifact,readGroup=artifactGlob}={}) {
 await Promise.all([
  ...['projection/catalog.json','projection/release-index.json','projection/band-items.json','projection/global-systems.json','supplemental/formal-scoring-rules.json'].map(name=>readArtifact(name)),
  ...['skills','member-cards','support-cards'].map(name=>readGroup(`@projection-data/database-shards/${name}/*.json`))
 ]);
}
/** Avoid evaluating collection modules when a calculator already has the data. */
export async function loadTeamWorkspaceData(context,{
 loadPresentation=()=>import('./shared-team-presentation.mjs'),
 loadCollection=()=>Promise.all([import('./shared-team-data.mjs'),preloadTeamWorkspaceData()]).then(([module])=>module)
}={}) {
 const rules=context?.rules??context?.data?.formalRules??context?.data?.rules;
 if(context?.data?.memberCards&&rules){
  if(context.data.filterVisualOptions&&context.data.growthIcons)return {...context.data,formalRules:rules};
  const {sharedTeamPresentation}=await loadPresentation();
  return {...context.data,...sharedTeamPresentation(),formalRules:rules};
 }
 const {sharedTeamData}=await loadCollection();
 return sharedTeamData();
}
