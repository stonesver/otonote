import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_SERVICES,
  stageGachaHandoff,
  consumeGachaHandoff,
  clearGachaHandoff,
  createAccountSyncClient,
} from '../src/lib/account-sync-hub.mjs';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function memoryStorage() {
  const store = new Map();
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => { store.set(key, String(val)); },
    removeItem: key => { store.delete(key); },
  };
}

test('SYNC_SERVICES declares growth, gacha and arena capabilities cleanly', () => {
  assert.deepEqual(
    SYNC_SERVICES.map(s => s.id),
    ['growth', 'gacha', 'arena']
  );
});

test('checkCapabilities handles supported nonce, maintenance, and unsupported server', async () => {
  const unsupported = await createAccountSyncClient().checkCapabilities('jp-official');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, 'unsupported_server');

  const maintClient = createAccountSyncClient({
    fetcher: async () => jsonResponse({
      enabled: true,
      nonce: 'n-maint',
      serverId: 'global-hmt',
      gameStatus: { status: 'maintenance', summary: 'Server maintenance' },
    }),
  });
  const maint = await maintClient.checkCapabilities('global-hmt');
  assert.equal(maint.ok, true);
  assert.equal(maint.maintenance, true);

  const downClient = createAccountSyncClient({
    fetcher: async () => jsonResponse({ enabled: false }, 503),
  });
  const down = await downClient.checkCapabilities('global-hmt');
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'unavailable');
});

test('syncSelected runs checked services sequentially, preserves credentials out of errors, and halts on 403 or fatal errors without retrying', async () => {
  const calls = [];
  const client = createAccountSyncClient({
    fetcher: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', nonce: init.headers?.['X-Growth-Nonce'], body: init.body });
      if (url.includes('capabilities')) {
        return jsonResponse({
          enabled: true,
          nonce: 'nonce-1',
          serverId: 'global-hmt',
          gachaHistory: true,
          arenaPersonal: true,
        });
      }
      if (url.includes('/api/growth-export/read/')) {
        return jsonResponse({ snapshot: { format: 'otonote-growth', total: 5 } });
      }
      if (url.includes('/api/growth-export/gacha-history/')) {
        return jsonResponse({ snapshot: { format: 'otonote-gacha-history', batches: [] } });
      }
      if (url.includes('/api/growth-export/arena-rank/')) {
        return jsonResponse({ snapshot: { status: 'ranked', rank: 12, point: 420000 } });
      }
      return jsonResponse({}, 404);
    },
  });

  const cap = await client.checkCapabilities('global-hmt');
  assert.equal(cap.ok, true);

  const sampleCred = ['sample', 'fixture', 'cred'].join('-');
  const outcome = await client.syncSelected({
    serverId: 'global-hmt',
    account: 'user@example.com',
    password: sampleCred,
    services: ['growth', 'gacha', 'arena'],
    arenaScope: { seasonId: 'season-1', bandId: 'band-1' },
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(Object.keys(outcome.results), ['growth', 'gacha', 'arena']);
  assert.equal(calls.length, 4);
  assert.equal(calls[1].nonce, 'nonce-1');

  // Now simulate 403 expiration mid-sequence: must stop immediately, invalidate nonce, zero retry
  const expiredCalls = [];
  const expiredClient = createAccountSyncClient({
    fetcher: async url => {
      expiredCalls.push(url);
      if (url.includes('capabilities')) {
        return jsonResponse({ enabled: true, nonce: 'nonce-2', serverId: 'global-hmt', gachaHistory: true });
      }
      if (url.includes('/read/')) return jsonResponse({ error: 'expired' }, 403);
      return jsonResponse({ snapshot: {} });
    },
  });
  await expiredClient.checkCapabilities('global-hmt');
  const expiredOutcome = await expiredClient.syncSelected({
    serverId: 'global-hmt',
    account: 'user@example.com',
    password: sampleCred,
    services: ['growth', 'gacha'],
  });
  assert.equal(expiredOutcome.ok, false);
  assert.equal(expiredOutcome.nonceExpired, true);
  assert.equal(expiredCalls.filter(u => u.includes('/read/')).length, 1);
  assert.equal(expiredCalls.filter(u => u.includes('/gacha-history/')).length, 0);
  assert.equal(expiredClient.getState().nonce, null);
  assert.doesNotMatch(expiredOutcome.errors.growth, /sample-fixture-cred|user@example.com/);

  // Non-fatal error preserves earlier completed service result
  const partialClient = createAccountSyncClient({
    fetcher: async url => {
      if (url.includes('capabilities')) {
        return jsonResponse({ enabled: true, nonce: 'nonce-3', serverId: 'global-hmt', gachaHistory: true });
      }
      if (url.includes('/read/')) return jsonResponse({ snapshot: { ok: true } });
      return jsonResponse({ error: 'sdk_service_-100' }, 502);
    },
  });
  await partialClient.checkCapabilities('global-hmt');
  const partialOutcome = await partialClient.syncSelected({
    serverId: 'global-hmt',
    account: 'user@example.com',
    password: sampleCred,
    services: ['growth', 'gacha'],
  });
  assert.equal(partialOutcome.ok, false);
  assert.deepEqual(partialOutcome.results.growth, { ok: true });
  assert.match(partialOutcome.errors.gacha, /sdk_service_-100/);
});

test('gacha session handoff is single-use and server-scoped', () => {
  const storage = memoryStorage();
  clearGachaHandoff(storage);
  const sample = { format: 'otonote-gacha-history', schemaVersion: 1, batches: [] };

  assert.equal(stageGachaHandoff(sample, 'global-hmt', storage), true);
  assert.equal(consumeGachaHandoff('global-en', storage), null);
  // First mismatched consume cleared the staged record
  assert.equal(consumeGachaHandoff('global-hmt', storage), null);

  assert.equal(stageGachaHandoff(sample, 'global-hmt', storage), true);
  assert.deepEqual(consumeGachaHandoff('global-hmt', storage), sample);
  assert.equal(consumeGachaHandoff('global-hmt', storage), null);

  stageGachaHandoff(sample, 'global-hmt', storage);
  clearGachaHandoff(storage);
  assert.equal(consumeGachaHandoff('global-hmt', storage), null);
});
