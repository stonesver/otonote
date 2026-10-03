import {entityIdentity,entityComparison} from './entity-identity.mjs';
import native from '../data/immersive-scenes.json';
import {sharedRows} from './shared-archives';
type Scene = typeof native.scenes[number] & {contentIdentity?:string; sourceHref?:string; editionPresence?:{status:string;editions:string[]}};
const scenes=await sharedRows(native.scenes as Scene[],'supplemental/immersive-scenes.json','scenes',
  row=>entityIdentity('immersive',row) ?? (row.contentIdentity??null),row=>`/immersive/${row.id}/`,row=>entityComparison('immersive',row));
export default {...native,scenes};
