import assert from "node:assert/strict";
import test from "node:test";

import {
  SCORING_INPUT_SCHEMA_VERSION,
  createScoringInputSnapshot,
  evaluateScoringResearch,
  stableSnapshotHash,
  createSnapshotFieldHasher
} from "../src/lib/scoring-engine.mjs";

const evidence = {
  sourceReleaseId: "release-1",
  ruleSet: { id: "scoring-research-v1", status: "research_contract", producesScore: false },
  capability: { status: "blocked", producesFormalScore: false },
  knownMechanisms: ["combo_bonus", "note_score_core"],
  unknownMechanisms: ["integer_rounding_points"],
  validationGate: {
    replaySampleCount: 0,
    exactIntegerReconciliation: false,
    differenceTraceComplete: false
  }
};

test("creates a release-bound replayable scoring input snapshot", () => {
  const snapshot = createScoringInputSnapshot({
    sourceReleaseId: "release-1",
    draft: {
      schemaVersion: 1,
      ruleSetVersion: "formation-research-v1",
      slots: [{ memberCardId: "member-card-1", supportCardId: null }],
      selectedSongId: "music-track-1",
      selectedDifficulty: "expert",
      modifiers: {}
    },
    chart: {
      id: "music-chart-1",
      trackId: "music-track-1",
      difficulty: "expert",
      notes: [{ id: "note-1" }, { id: "note-2" }],
      skillTimings: [1.5],
      feverRanges: [{ start: 10, end: 20 }],
      duration: 120
    },
    teamSummary: {
      basePower: { performance: 100, technic: 200, visual: 300, total: 600 },
      selectedCards: [{ slotIndex: 0, cardId: "member-card-1" }],
      skillSummaries: [{ skillId: "live-skill-1", name: "Score Up" }]
    }
  });

  assert.equal(snapshot.schemaVersion, SCORING_INPUT_SCHEMA_VERSION);
  assert.equal(snapshot.sourceReleaseId, "release-1");
  assert.equal(snapshot.chart.noteCount, 2);
  assert.equal(snapshot.chart.noteObjectCount, 2);
  assert.equal(snapshot.chart.fullComboCount, 0);
  assert.deepEqual(snapshot.chart.skillTimings, [1.5]);
  assert.equal(snapshot.team.basePower.total, 600);
  assert.match(snapshot.inputHash, /^fnv1a32:[0-9a-f]{8}$/);
});

test("hash is stable across object key order and changes with material input", () => {
  assert.equal(stableSnapshotHash({ a: 1, b: 2 }), stableSnapshotHash({ b: 2, a: 1 }));
  assert.notEqual(stableSnapshotHash({ a: 1 }), stableSnapshotHash({ a: 2 }));
});

test("missing chart payload cannot masquerade as a zero-note chart", () => {
  const snapshot = createScoringInputSnapshot({ chart: { id: "chart", fullComboCount: 100 } });
  assert.equal(snapshot.chart.noteObjectCount, null);
});

test("T.G.W configuration is covered by the scoring input hash", () => {
  const base = {
    sourceReleaseId: "release-1",
    draft: { modifiers: { tgwCardRank: 2 } },
    chart: null,
    teamSummary: null
  };
  const first = createScoringInputSnapshot({
    ...base,
    tgwCardBonus: { rank: 2, type: 7, rawValue: 100 }
  });
  const second = createScoringInputSnapshot({
    ...base,
    tgwCardBonus: { rank: 2, type: 7, rawValue: 200 }
  });
  assert.notEqual(first.inputHash, second.inputHash);
});

test("returns a deterministic blocked trace without emitting an estimated score", () => {
  const snapshot = createScoringInputSnapshot({
    sourceReleaseId: "release-1",
    draft: {
      schemaVersion: 1,
      ruleSetVersion: "formation-research-v1",
      slots: [{ memberCardId: null, supportCardId: null }],
      selectedSongId: null,
      selectedDifficulty: null,
      modifiers: {}
    },
    chart: null,
    teamSummary: {
      basePower: { performance: 0, technic: 0, visual: 0, total: 0 },
      selectedCards: [],
      skillSummaries: []
    }
  });
  const first = evaluateScoringResearch(snapshot, evidence);
  const second = evaluateScoringResearch(snapshot, evidence);

  assert.deepEqual(first, second);
  assert.equal(first.status, "blocked");
  assert.equal(first.score, null);
  assert.equal(first.estimatedScore, null);
  assert.equal(first.optimizerEligible, false);
  assert.equal(first.trace.at(-1).code, "exact_integer_reconciliation_required");
  assert.deepEqual(first.knownMechanisms, ["combo_bonus", "note_score_core"]);
});

test("rejects a snapshot from a different release before calculation", () => {
  const snapshot = createScoringInputSnapshot({
    sourceReleaseId: "release-2",
    draft: { schemaVersion: 1, ruleSetVersion: "formation-research-v1", slots: [] },
    chart: null,
    teamSummary: null
  });
  const result = evaluateScoringResearch(snapshot, evidence);

  assert.equal(result.status, "invalid_input");
  assert.equal(result.trace[0].code, "release_mismatch");
  assert.equal(result.score, null);
});


test('prepared snapshot hashes retain canonical identity for every varying-field position', () => {
  const snapshot = { z: '尾部', a: { b: 2, a: [1, undefined, -0] }, 2: 'numeric', omitted: undefined };
  for (const field of ['skillOrder', 'a', 'z', '0', '10', 'quoted"key']) {
    const hash = createSnapshotFieldHasher(snapshot, field);
    for (const value of [[0,1,2,3,4], [4,3,2,1,0], { z: 1, a: '判定' }, null, undefined]) {
      assert.equal(hash(value), stableSnapshotHash({ ...snapshot, [field]: value }));
    }
  }
  const hash = createSnapshotFieldHasher(snapshot, 'skillOrder');
  const expected = hash([0,1,2,3,4]);
  snapshot.a.b = 99;
  assert.equal(hash([0,1,2,3,4]), expected, 'fixed fields belong to the captured snapshot');
});
