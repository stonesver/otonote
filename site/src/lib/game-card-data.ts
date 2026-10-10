import {recordsFromGlob} from "./database-records";
import type {SkillDefinition,CardDetailProjection,CardDetailProjections} from "./game-database";

// Calculator and inventory consumers need these three collections only.
const skillDetails = recordsFromGlob<SkillDefinition>(
  "database-shards/skills",
  "id",
  import.meta.glob("@projection-data/database-shards/skills/*.json", {
    eager: true
  })
);
const memberCardDetails = recordsFromGlob<CardDetailProjection>(
  "database-shards/member-cards",
  "cardId",
  import.meta.glob("@projection-data/database-shards/member-cards/*.json", {
    eager: true
  })
);
const supportCardDetails = recordsFromGlob<CardDetailProjection>(
  "database-shards/support-cards",
  "cardId",
  import.meta.glob("@projection-data/database-shards/support-cards/*.json", {
    eager: true
  })
);

export const publicSkills=skillDetails;
export const cardDetailProjections={schemaVersion:1,memberCards:memberCardDetails,supportCards:supportCardDetails} satisfies CardDetailProjections;
