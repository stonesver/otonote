import type {GrowthProfile} from './game-database';
import {recordsFromGlob} from './database-records';

export const growthProfiles = recordsFromGlob<GrowthProfile>('database-shards/growth', 'id',
  import.meta.glob('@projection-data/database-shards/growth/*.json', {eager:true}));
