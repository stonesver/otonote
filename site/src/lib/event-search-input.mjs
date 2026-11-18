import {withEventRewardCandidates} from './event-reward-candidates.mjs';

/** Owned event searches start from actual growth, including the evidence used
 * by result cards and applied teams. Reward assumptions belong to this run. */
export function prepareEventSearchInput(options) {
 const {rules,scope,inventory}=options;
 let {draft}=options;
 if(scope==='owned'){
  if(!inventory)throw Error('请先导入已保存卡库与实际养成');
  draft=structuredClone(draft);draft.modifiers??={};
  draft.modifiers.growth=structuredClone(inventory.growth??{});
  draft.modifiers.planningScenario={schemaVersion:1,sourceReleaseId:rules.sourceReleaseId,scope:'owned',unknownGrowth:'exclude'};
  delete draft.modifiers.planningResult;
 }
 // Apply only the current run's explicit reward assumptions after clearing
 // prior reference, training and reward evidence from an owned search.
 return withEventRewardCandidates({...options,draft});
}
