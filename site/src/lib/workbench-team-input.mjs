import {resolveTeamCardGrowth} from './team-card-view.mjs';

/** Make declared reference assumptions executable when crossing into a direct calculator.
 * The actual collection stays untouched and the original baseline remains explicit. */
export function materializeTeamAssumptions(draft,data,inventory) {
  if(!draft.modifiers?.planningScenario)return draft;
  const rules=data.formalRules??data.rules;let result=draft;
  for(const slot of draft.slots)for(const kind of ['member','support']) {
    const id=slot[`${kind}CardId`],card=data[`${kind}Cards`]?.find(c=>c.id===id);if(!card)continue;
    const state=resolveTeamCardGrowth({card,draft,inventory,rules});
    if(state.source!=='reference'||!Object.keys(state.growth).length||JSON.stringify(state.growth)===JSON.stringify(draft.modifiers.growth?.[id]))continue;
    if(result===draft)result=structuredClone(draft);
    result.modifiers.growth??={};result.modifiers.growth[id]=state.growth;
    const previous=result.modifiers.planningResult??={schemaVersion:1,sourceReleaseId:rules.sourceReleaseId,actualGrowth:{}};
    previous.actualGrowth??={};if(!Object.hasOwn(previous.actualGrowth,id))previous.actualGrowth[id]=inventory?.[`${kind}CardIds`]?.includes(id)?structuredClone(inventory.growth?.[id]??null):null;
    previous.referenceCardIds=[...new Set([...(previous.referenceCardIds??[]),id])];
  }
  return result;
}
