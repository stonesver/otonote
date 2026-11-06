import {withAPTimingBasis} from './ap-grade.mjs';
// Farming uses on-time estimates even when the imported team has a timing plan.
// A cycle shares the collection; each stage owns its scoring basis and scope.
export function eventYieldStageInput(input,mode){
 const followup=mode==='challenge'&&input.mode==='ordinary'&&input.includeChallenge;
 const basis=followup?input.challengeBasis??input.basis:input.basis;
 return {...input,mode,basis,draft:withAPTimingBasis(input.draft,'expectedScore'),
   ...(followup?{scope:input.challengeScope&&input.challengeScope!=='same'?input.challengeScope:input.scope}:{})};
}
