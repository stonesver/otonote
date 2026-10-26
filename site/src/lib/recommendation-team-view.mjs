import {createWorkbenchTeamView} from './workbench-team-view.mjs';
import {skillActivation} from './skill-activation-view.mjs';

/** One complete roster; skill replay remains an on-demand dialog. */
export function createRecommendationTeamView(tool,draft,activation={}) {
  const root=document.createElement('section');root.className='recommendation-team';
  const roster=createWorkbenchTeamView(tool,draft,{showGrowthNote:!activation.hideGrowthNote});
  root.append(roster,skillActivation(tool,draft,activation));return root;
}
