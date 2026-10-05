// Server/build-only. Visitors receive the finished ranking, never a calculator.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateRankingRow, SONG_RANKING_BENCHMARK } from '../song-ranking.mjs';
import {prepareFormalChart} from '../scoring-rules/formal-song-score.mjs';
import {algorithmFingerprint, cachedRankingRow, readCache, writeCache, validRow, rankingContext} from './ranking-row-cache.mjs';
import { scoringRulesAvailable } from '../scoring-release-gate.mjs';

const defaultSource = fileURLToPath(new URL('../', import.meta.url));
const pending = new Map();

export async function loadSongRankingData({ rules, releaseId, tracks, charts, sourceRoot = defaultSource,
  publicRoot, cacheRoot }) {
  if (!publicRoot || !cacheRoot) throw new Error('Ranking calculation requires explicit publicRoot and cacheRoot');
  if (!scoringRulesAvailable(rules, releaseId)) throw new Error('排行榜规则尚未通过当前版本核验');
  const algorithm = await algorithmFingerprint(sourceRoot);
  const context = rankingContext({algorithm, benchmark:SONG_RANKING_BENCHMARK, rules});
  const hash = createHash('sha256').update(algorithm);
  hash.update(JSON.stringify({ rules, tracks, charts, benchmark: SONG_RANKING_BENCHMARK }));
  const byId = new Map(tracks.map(track => [track.id, track]));
  const prepared = [];
  // Retain only identities and digests. Hundreds of parsed charts plus their
  // source strings exceed the production updater's memory allowance.
  for (const summary of charts) {
    const relative = String(summary.analysisDataUrl ?? '').replace(/^\/+/, '');
    const path = resolve(publicRoot, relative);
    if (!relative || !path.startsWith(resolve(publicRoot) + '/')) throw new Error('无效的排行榜谱面路径');
    const raw = await readFile(path, 'utf8');
    const chart = JSON.parse(raw);
    if (chart.id !== summary.id || chart.trackId !== summary.trackId || chart.difficulty !== summary.difficulty ||
      chart.sourceReleaseId && chart.sourceReleaseId !== releaseId) throw new Error(`谱面版本不一致：${summary.id}`);
    if (!byId.has(chart.trackId)) throw new Error('歌曲与谱面不一致');
    hash.update(raw);
    prepared.push({path, summary, sha256:createHash('sha256').update(raw).digest('hex')});
  }
  const fingerprint = hash.digest('hex');
  const pendingKey = JSON.stringify([resolve(cacheRoot), fingerprint]);
  if (pending.has(pendingKey)) return pending.get(pendingKey);
  const job = (async () => {
    const cacheFile = join(cacheRoot, `${fingerprint}.json`);
    const cached = await readCache(cacheFile, fingerprint, value => value?.fingerprint === fingerprint
      && value.sourceReleaseId === releaseId && value.ruleSetVersion === rules.ruleSetVersion
      && value.rulesFingerprint && value.benchmark
      && ['ordinary','gekisou'].every(mode => value[mode]?.length === charts.length
        && value[mode].every((row,index) => row.chartFingerprint && validRow(row, charts[index], mode))));
    if (cached) return cached;
    const data = { sourceReleaseId: releaseId, ruleSetVersion: rules.ruleSetVersion, fingerprint,
      rulesFingerprint:createHash('sha256').update(JSON.stringify({native:rules.native,tables:rules.tables})).digest('hex'), benchmark: SONG_RANKING_BENCHMARK, ordinary: [], gekisou: [] };
    for (const {path,summary,sha256} of prepared) {
      const raw = await readFile(path,'utf8');
      if (createHash('sha256').update(raw).digest('hex') !== sha256) throw new Error(`谱面在计算期间发生变化：${summary.id}`);
      const chart = {...summary,...JSON.parse(raw),sourceReleaseId:releaseId};
      // Validate the current release/native/chart even when both scores are cached.
      const {chartHash} = prepareFormalChart(rules, chart);
      for (const mode of ['ordinary', 'gekisou']) {
        data[mode].push({...await cachedRankingRow({cacheRoot, context, chart, track:byId.get(chart.trackId), mode, chartHash, compute:() => calculateRankingRow({rules, chart, track:byId.get(chart.trackId), mode})}), chartFingerprint:createHash('sha256').update(JSON.stringify(JSON.parse(raw), (key,value)=>['id','trackId','sourceReleaseId','analysisDataUrl','sourcePath'].includes(key)?undefined:value)).digest('hex')});
      }
    }
    await writeCache(cacheFile, fingerprint, data);
    return data;
  })();
  pending.set(pendingKey, job);
  try { return await job; } finally { pending.delete(pendingKey); }
}
