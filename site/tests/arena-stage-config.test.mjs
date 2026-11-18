import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveArenaStage } from '../src/lib/arena-stage-config.mjs';
import { applyArenaContext } from '../../packages/scoring/scoring-rules/arena-context.mjs';

const data = {
  schemaVersion: 1, region: 'global', sourceReleaseId: 'release', sourceRevision: 'revision', serverScopes: ['global-hmt'], capabilities: { conditions: true },
  seasons: [{ id: 'season', name: 'Season', validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z' }],
  leagues: [{ id: 'league-9', bandId: '2', opensAt: null }],
  regulations: [
    { id: 'first', leagueId: 'league-9', attribute: 99, missions: [3, 3, 3], validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-11-02T00:00:00Z' },
    { id: 'next', leagueId: 'league-9', attribute: 0, missions: [3, 0, 1], validFrom: '2026-11-02T00:00:00Z', validUntil: '2026-11-03T00:00:00Z' }
  ]
};
const input = { region: 'global', serverId: 'global-hmt', sourceReleaseId: 'release', bandId: 2, now: Date.parse('2026-11-01T12:00:00Z') };

test('published league mapping and values flow into the scoring view with their identity', () => {
  const { stage } = resolveArenaStage(data, input);
  assert.equal(stage.bandId, 2); assert.equal(stage.leagueId, 'league-9'); assert.equal(stage.sourceRevision, 'revision');
  const rules = { tables: { Character: [{ _bandID: 2 }], LiveMusic: [{ _id: 1, _musicType: 2, _gekisouMission1: 1, _gekisouMission2: 2, _gekisouMission3: 3 }] } };
  const applied = applyArenaContext(rules, { ...stage, participantCount: 5 });
  assert.equal(applied.rules.tables.LiveMusic[0]._musicType, 99);
  assert.deepEqual([1,2,3].map(i => applied.rules.tables.LiveMusic[0][`_gekisouMission${i}`]), [3,3,3]);
  assert.equal(applied.context.regulationId, 'first');
  assert.equal(rules.tables.LiveMusic[0]._musicType, 2);
});

test('current selection switches at the exclusive boundary and preserves zero fallback and mixed missions', () => {
  const result = resolveArenaStage(data, { ...input, now: Date.parse('2026-11-02T00:00:00Z') });
  assert.equal(result.stage.regulationId, 'next'); assert.equal(result.stage.musicType, 0);
  assert.deepEqual(result.stage.missions, [3,0,1]);
  assert.throws(() => resolveArenaStage(data, { ...input, now: Date.parse('2026-11-03T00:00:00Z') }), /尚未收录/);
});

test('explicit periods distinguish preview and history and intersect season bounds', () => {
  assert.equal(resolveArenaStage(data, { ...input, regulationId: 'next' }).status, 'upcoming');
  assert.equal(resolveArenaStage(data, { ...input, regulationId: 'first', now: Date.parse('2026-11-02T00:00:00Z') }).status, 'past');
  const crossing = { ...data, regulations: [{ ...data.regulations[0], validUntil: '2026-12-02T00:00:00Z' }] };
  assert.equal(resolveArenaStage(crossing, input).stage.validUntil, '2026-12-01T00:00:00.000Z');
});

test('missing, conflicting, cross-server and cross-release conditions never become a manual JUST stage', () => {
  assert.throws(() => resolveArenaStage(null, input), /未收录/);
  assert.throws(() => resolveArenaStage(data, { ...input, sourceReleaseId: 'other' }), /版本/);
  assert.throws(() => resolveArenaStage(data, { ...input, serverId: 'jp' }), /区服/);
  assert.throws(() => resolveArenaStage(data, { ...input, regulationId: 'unknown' }), /不存在/);
  assert.throws(() => resolveArenaStage(data, { ...input, seasonId: 'unknown' }), /不存在/);
  assert.throws(() => resolveArenaStage({ ...data, regulations: [...data.regulations, { ...data.regulations[0], id: 'conflict' }] }, input), /冲突/);
});
