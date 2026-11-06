import type {MemberGrowth, PlanningScenario, PlanningComparison} from '../../src/lib/calculation/growth-types.ts';
import type {OptimizerCommand, OptimizerMessage, OptimizerRequest} from '../../src/lib/calculation/optimizer-types.ts';
import {sendOptimizerCommand} from '../../src/lib/calculation/optimizer-client.ts';

declare const payload: OptimizerRequest;
declare const transport: Pick<Worker, 'postMessage'>;
sendOptimizerCommand(transport, {type:'optimize',requestId:1,payload});
sendOptimizerCommand(transport, {type:'cancel'});
// @ts-expect-error A job must carry its request identity.
sendOptimizerCommand(transport, {type:'optimize',payload});
// @ts-expect-error Growth values use numbers, not serialized form text.
const badGrowth: MemberGrowth = {level:'70',rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1};
// @ts-expect-error Actual member growth requires both skill levels.
const incompleteActual: MemberGrowth = {level:70,rank:1,awake:1,skillLevel:1};
const partialInput: PlanningScenario = {scope:'selected',plan:{targets:{'member-card-1':{level:70}}}};
// @ts-expect-error Support reference growth has no member skill level.
const supportSkills: PlanningScenario = {referenceGrowth:{support:{skillLevel:5}}};
// @ts-expect-error Removed execution switches must not reappear in requests.
const ecoRequest: OptimizerRequest = {...payload,eco:true};
// @ts-expect-error Objective names are a closed set.
const wrongObjective: OptimizerRequest = {...payload,objective:'expectedScore'};
// @ts-expect-error Errors cannot masquerade as completed results.
const wrongMessage: OptimizerMessage = {requestId:1,type:'result',error:'failed'};
declare const comparison: PlanningComparison;
// @ts-expect-error Unavailable actual-growth scores stay nullable.
const actualScore: number = comparison.plannedTeamCurrentValue;
function read(message: OptimizerMessage) {
  if(message.type==='progress') {
    message.progress.bestCandidate?.planning?.plannedTeamCurrentValue;
    // @ts-expect-error Progress does not contain a finished report.
    message.result;
  } else if(message.type==='result') {
    if(message.result.kind==='playlist-team-batch')return message.result.rows;
    return message.result.results;
  }
}
// @ts-expect-error A live candidate message must contain its scored candidate.
const missingCandidate: OptimizerMessage = {requestId:1,type:'progress',progress:{phase:'planning-result'}};
const cancel = {type:'cancel'} satisfies OptimizerCommand;
void [badGrowth,incompleteActual,partialInput,supportSkills,ecoRequest,wrongObjective,wrongMessage,actualScore,read,cancel,missingCandidate];
