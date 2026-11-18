export const SCORING_INPUT_SCHEMA_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function hashText(text, hash = 0x811c9dc5) {
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const formatHash = hash => `fnv1a32:${hash.toString(16).padStart(8, "0")}`;

export function stableSnapshotHash(value) {
  return formatHash(hashText(JSON.stringify(canonicalize(value))));
}

/** Snapshot the fixed fields once; changing one field preserves the exact
 * canonical JSON and FNV identity used by stableSnapshotHash. */
export function createSnapshotFieldHasher(snapshot, field) {
  const fixed = canonicalize({ ...snapshot, [field]: null });
  const keys = Object.keys(fixed), index = keys.indexOf(field);
  const entries = keys.map(key => JSON.stringify(key) + ':' + JSON.stringify(fixed[key]));
  const before = entries.slice(0, index), after = entries.slice(index + 1);
  const prefix = hashText('{' + (before.length ? before.join(',') + ',' : '') + JSON.stringify(field) + ':');
  const suffix = (after.length ? ',' + after.join(',') : '') + '}';
  return value => value === undefined
    ? formatHash(hashText('{' + [...before, ...after].join(',') + '}'))
    : formatHash(hashText(suffix, hashText(JSON.stringify(canonicalize(value)), prefix)));
}

const numberOrZero = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function snapshotChart(chart) {
  if (!chart || typeof chart !== "object") return null;
  const noteObjectCount = Array.isArray(chart.notes)
    ? chart.notes.length
    : Number.isFinite(chart.noteCount) ? chart.noteCount : null;
  return {
    id: chart.id ?? null,
    trackId: chart.trackId ?? null,
    difficulty: chart.difficulty ?? null,
    duration: numberOrZero(chart.duration),
    noteCount: noteObjectCount,
    noteObjectCount,
    judgementCount: numberOrZero(chart.statistics?.judgementCount),
    fullComboCount: numberOrZero(chart.fullComboCount),
    skillTimings: Array.isArray(chart.skillTimings)
      ? chart.skillTimings.map(numberOrZero)
      : [],
    feverRanges: Array.isArray(chart.feverRanges)
      ? chart.feverRanges.map((range) => ({
          start: numberOrZero(range?.start),
          end: numberOrZero(range?.end)
        }))
      : []
  };
}

function snapshotTeam(summary) {
  const basePower = summary?.basePower ?? {};
  return {
    basePower: {
      performance: numberOrZero(basePower.performance),
      technic: numberOrZero(basePower.technic),
      visual: numberOrZero(basePower.visual),
      total: numberOrZero(basePower.total)
    },
    selectedCards: Array.isArray(summary?.selectedCards)
      ? summary.selectedCards.map((card) => ({
          slotIndex: numberOrZero(card?.slotIndex),
          cardId: card?.cardId ?? null
        }))
      : [],
    skillSummaries: Array.isArray(summary?.skillSummaries)
      ? summary.skillSummaries.map((skill) => ({
          skillId: skill?.skillId ?? null,
          name: skill?.name ?? null
        }))
      : []
  };
}

export function createScoringInputSnapshot({
  sourceReleaseId,
  draft,
  chart,
  teamSummary,
  tgwCardBonus,
  formationPower
}) {
  const payload = {
    schemaVersion: SCORING_INPUT_SCHEMA_VERSION,
    sourceReleaseId: sourceReleaseId ?? null,
    scoringRuleSetVersion: "scoring-research-v1",
    draft: canonicalize(draft ?? null),
    chart: snapshotChart(chart),
    team: snapshotTeam(teamSummary),
    ...(formationPower ? { formationPower: canonicalize(formationPower) } : {}),
    ...(tgwCardBonus ? { tgwCardBonus: canonicalize(tgwCardBonus) } : {})
  };
  return { ...payload, inputHash: stableSnapshotHash(payload) };
}

function blockedResult(snapshot, evidence, trace, status = "blocked") {
  return {
    schemaVersion: 1,
    ruleSetVersion: evidence?.ruleSet?.id ?? "scoring-research-v1",
    sourceReleaseId: snapshot?.sourceReleaseId ?? null,
    inputHash: snapshot?.inputHash ?? null,
    status,
    score: null,
    estimatedScore: null,
    optimizerEligible: false,
    knownMechanisms: [...(evidence?.knownMechanisms ?? [])],
    unknownMechanisms: [...(evidence?.unknownMechanisms ?? [])],
    trace
  };
}

export function evaluateScoringResearch(snapshot, evidence) {
  if (snapshot?.schemaVersion !== SCORING_INPUT_SCHEMA_VERSION) {
    return blockedResult(snapshot, evidence, [{
      stage: "input",
      status: "rejected",
      code: "unsupported_snapshot_schema"
    }], "invalid_input");
  }
  if (snapshot.sourceReleaseId !== evidence?.sourceReleaseId) {
    return blockedResult(snapshot, evidence, [{
      stage: "input",
      status: "rejected",
      code: "release_mismatch",
      snapshotReleaseId: snapshot.sourceReleaseId,
      evidenceReleaseId: evidence?.sourceReleaseId ?? null
    }], "invalid_input");
  }
  if (snapshot.scoringRuleSetVersion !== evidence?.ruleSet?.id) {
    return blockedResult(snapshot, evidence, [{
      stage: "input",
      status: "rejected",
      code: "rule_set_mismatch"
    }], "invalid_input");
  }

  return blockedResult(snapshot, evidence, [
    {
      stage: "input",
      status: "accepted",
      code: "snapshot_hashed",
      inputHash: snapshot.inputHash
    },
    {
      stage: "evidence",
      status: "available",
      code: "mechanism_structure_identified",
      knownMechanismCount: evidence.knownMechanisms?.length ?? 0
    },
    {
      stage: "formula",
      status: "blocked",
      code: "unverified_formula_not_executed",
      unknownMechanismCount: evidence.unknownMechanisms?.length ?? 0
    },
    {
      stage: "validation",
      status: "blocked",
      code: "exact_integer_reconciliation_required",
      replaySampleCount: evidence.validationGate?.replaySampleCount ?? 0
    }
  ]);
}
