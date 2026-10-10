import {memberCards,supportCards} from './inventory-catalog';
import {catalog} from './catalog';
import {sharedTeamPresentation} from './shared-team-presentation.mjs';
export {sharedTeamPresentation};
import {globalSystems} from './global-systems';
import {bandItemDatabase} from './band-items';
import formalRules from '../data/formal-scoring-rules.json';

/** Loaded on first open on tools without a calculator, using the active content snapshot. */
export function sharedTeamData() {
  if(formalRules.sourceReleaseId!==catalog.release.id)throw Error('卡库规则与当前内容版本不一致，请刷新匹配内容。');
  return {formalRules,memberCards,supportCards,locale:catalog.release.locale,...sharedTeamPresentation(),
    vipRanks:globalSystems.sourceReleaseId===catalog.release.id?globalSystems.vipRanks:[],
    characters:catalog.characters.map(c=>({id:c.masterId,name:c.displayName})),
    bands:catalog.bands.map(b=>({id:b.masterId,name:b.displayName})),
    instruments:bandItemDatabase.items.map(i=>({id:i.masterId,name:i.name,bandId:i.bandId}))};
}
