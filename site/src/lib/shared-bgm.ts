import {entityIdentity,entityComparison} from './entity-identity.mjs';
import {bgmCatalog as native} from './bgm-catalog';
import {sharedRows} from './shared-archives';
export * from './bgm-catalog';
export const bgmCatalog = {...native, tracks:await sharedRows(native.tracks,'projection/bgm.json','tracks',
  row=>entityIdentity('bgm',row) ?? (row.audio?.sha256?`${row.cueName}:${row.audio.sha256}`:null),undefined,row=>entityComparison('bgm',row))};
