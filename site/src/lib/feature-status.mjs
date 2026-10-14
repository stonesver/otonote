import {recognitionCoverage} from './card-recognition/index-contract.mjs';
export function featureStatus({catalog, modes, rules, scoring, recognition}) {
  const id = catalog.release.id;
  const bound = x => x?.sourceReleaseId === id;
  let screenshot = {status:'unavailable',reason:'index_not_published'};
  if (recognition) {
    try { screenshot=recognitionCoverage(recognition,catalog); }
    catch(error) { screenshot={status:'unavailable',reason:error.message}; }
  }
  const calculator = !bound(rules) || !bound(scoring) || !['code_audited','reference_compatible'].includes(rules.verificationStatus) ? 'unavailable'
    : scoring.status === 'compatible' ? 'estimated'
    : scoring.status === 'partial' ? 'partial' : 'unavailable';
  return {region:catalog.release.region,sourceReleaseId:id,clientVersion:catalog.release.versionName,
    clientVersionCode:catalog.release.versionCode,generatedAt:catalog.generatedAt,
    catalog:{status:'available',members:catalog.memberCards.length,supports:catalog.supportCards.length},
    events:{status:bound(modes)?'available':'unavailable',count:bound(modes)?modes.events?.records?.length??0:0},
    calculator:{status:calculator,ruleSetVersion:rules?.ruleSetVersion,gameplayVerified:false},screenshot};
}
export function snapshotFreshness(pinned, latest) {
  if (!latest) return 'unknown';
  return pinned.contentReleaseId === latest.contentReleaseId && pinned.root === latest.manifest?.slice(0,-'manifest.json'.length) ? 'current':'stale';
}
