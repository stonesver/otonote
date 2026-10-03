import {entityIdentity,entityComparison} from './entity-identity.mjs';
import native from '../data/live2d-catalog.json';
import {sharedRows} from './shared-archives';
const models=await sharedRows(native.models,'supplemental/live2d-catalog.json','models',
  row=>entityIdentity('live2d',row) ?? (row.sourceSha256?`${row.characterId}:${row.costumeId}:${row.sourceSha256}`:null),undefined,row=>entityComparison('live2d',row));
export default {...native,models};
