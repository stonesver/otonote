import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp, cp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shared = join(root, 'packages/scoring');
const require = createRequire(new URL('../package.json', import.meta.url));

test('every pure scoring entry bundles for browsers with dependencies contained in the package', async () => {
  const {build} = require('esbuild');
  const modules = (await readdir(shared)).filter(name => name.endsWith('.mjs'))
    .concat((await readdir(join(shared, 'scoring-rules'))).filter(name => name.endsWith('.mjs')).map(name => `scoring-rules/${name}`));
  const bundle = await build({entryPoints: modules.map(name => join(shared, name)),
    outdir: 'unused-scoring-test-output', bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true});
  assert.ok(bundle.outputFiles.length >= 30);
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const local = relative(shared, resolve(input));
    assert.ok(!local.startsWith('..') && !local.startsWith('server/'), `Unexpected browser dependency: ${local}`);
  }
});

test('content ranking module runs from a package-only copy with explicit storage', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ournotes-shared-scoring-'));
  try {
    const copy = join(temporary, 'scoring');
    await cp(shared, copy, {recursive: true});
    const {loadSongRankingData} = await import(pathToFileURL(join(copy, 'server/song-ranking-data.mjs')));
    const options = {rules: {sourceReleaseId: 'isolated-release', verificationStatus: 'code_audited',
      ruleSetVersion: 'test-rules', native: {}, tables: {}}, releaseId: 'isolated-release', tracks: [], charts: []};
    await assert.rejects(loadSongRankingData(options), /explicit publicRoot and cacheRoot/);
    const data = await loadSongRankingData({...options, publicRoot: join(temporary, 'public'), cacheRoot: join(temporary, 'cache')});
    assert.equal(data.sourceReleaseId, 'isolated-release');
    assert.deepEqual(data.ordinary, []);
    assert.match(data.fingerprint, /^[a-f0-9]{64}$/);
    const envelope = JSON.parse(await readFile(join(temporary, 'cache', `${data.fingerprint}.json`)));
    assert.deepEqual(envelope.data, data);
    assert.equal(envelope.key, data.fingerprint);
    assert.equal(envelope.sha256, createHash('sha256').update(JSON.stringify(data)).digest('hex'));
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});

test('website compatibility imports refer to the same scoring functions', async () => {
  for (const path of ['scoring-engine.mjs', 'song-ranking.mjs', 'scoring-rules/formal-chart.mjs',
    'scoring-rules/formal-song-score.mjs', 'scoring-rules/gekisou-song-score.mjs']) {
    const implementation = await import(pathToFileURL(join(shared, path)));
    const compatibility = await import(pathToFileURL(join(root, 'site/src/lib', path)));
    assert.deepEqual(compatibility, implementation);
  }
});

test('canonical audited rules bind to their packaged native evidence without website data', async () => {
  const rules = JSON.parse(await readFile(join(shared, 'data/formal-scoring-rules.json')));
  const native = JSON.parse(await readFile(join(shared, 'data/formal-scoring-native.json')));
  assert.deepEqual(rules.native, native);
  assert.equal(rules.nativeSha256, native.nativeSha256);
  assert.equal(rules.sourceReleaseId, native.sourceReleaseId);
});
