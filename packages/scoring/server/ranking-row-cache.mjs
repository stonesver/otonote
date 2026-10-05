// Private build caches. Public ranking JSON keeps its existing shape.
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, rm, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const dataDigest = value => digest(JSON.stringify(value));

export async function algorithmFingerprint(sourceRoot) {
  const hash = createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = (await readdir(directory, {withFileTypes:true})).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = relative + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name + '/');
      else if (entry.name.endsWith('.mjs')) {
        hash.update(JSON.stringify(name)); hash.update(await readFile(join(directory, entry.name)));
      }
    }
  }
  await visit(sourceRoot);
  // Also bind the actual cache implementation when a caller supplies a copied
  // algorithm tree (the cache protocol itself is not supplied by that tree).
  for (const name of ['song-ranking-data.mjs', 'ranking-row-cache.mjs']) {
    hash.update(name); hash.update(await readFile(new URL(name, import.meta.url)));
  }
  return hash.digest('hex');
}

export async function readCache(path, key, validate) {
  try {
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    if (envelope.version === 1 && envelope.key === key && envelope.sha256 === dataDigest(envelope.data)
      && validate(envelope.data)) return envelope.data;
  } catch { /* Old, absent, partial or damaged caches are safe misses. */ }
  return null;
}

export async function writeCache(path, key, data) {
  await mkdir(dirname(path), {recursive:true});
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({version:1, key, sha256:dataDigest(data), data}));
    await rename(temp, path);
  } finally { await rm(temp, {force:true}); }
}

export function rankingContext({algorithm, benchmark, rules}) {
  const {sourceReleaseId: _release, ...boundRules} = rules;
  return dataDigest({version:1, algorithm, benchmark, rules:boundRules});
}

export function rowCacheKey({context, chart, mode}) {
  const {sourceReleaseId: _chartRelease, sourcePath: _source, analysisDataUrl: _url, ...boundChart} = chart;
  // Keep every other field, including chart/track ids and the complete native
  // and master tables. Only release/path provenance is independent of scoring.
  return dataDigest({version:1, context, chart:boundChart, mode});
}

const commonFields = ['id','trackId','difficulty','level','chartSeconds','expectedScore','minimumScore',
  'maximumScore','p10Score','power','baseScore','skillScoreGain','scoreMultiplier','skillMultiplier',
  'difficultyFactor','comboFactor','eventCount','convertedNoteCount','meta'];
const owns = (value, names) => value && typeof value === 'object' && names.every(name => Object.hasOwn(value, name));
export function validRow(row, chart, mode) {
  if (!owns(row, commonFields) || row.id !== chart.id || row.trackId !== chart.trackId || row.difficulty !== chart.difficulty) return false;
  if (!owns(row.meta, ['version','bpmMin','bpmMax','averageDensity','peakDensity','peakStart',
    'simultaneousEvents','generatedEvents','authoredEvents','startsSeconds'])) return false;
  if (mode === 'ordinary') return owns(row.skillReference, ['version','power','chartHash','gains','gainsByPosition','startsSeconds'])
    && row.skillReference.gains?.length === 41 && row.skillReference.gainsByPosition?.length === 5
    && row.skillReference.gainsByPosition.every(values => Array.isArray(values) && values.length === 41)
    && row.skillReference.startsSeconds?.length === 5;
  return owns(row, ['gekisouMultiplier','rankingBonus','rankingBonusShare','sections','standardError','sampleCount']) && Array.isArray(row.sections);
}

export async function cachedRankingRow({cacheRoot, context, chart, track, mode, chartHash, compute}) {
  const key = rowCacheKey({context, chart, mode});
  const path = join(cacheRoot, 'rows-v1', key.slice(0,2), `${key}.json`);
  let row = await readCache(path, key, value => validRow(value, chart, mode));
  if (!row) {
    const {title, bands, bandLabels, attribute, audioSeconds, ...calculated} = compute();
    row = calculated;
    await writeCache(path, key, row);
  }
  return {...row, title:track.title, bands:track.bandIds, bandLabels:track.bandLabels,
    attribute:track.musicTypeLabel, audioSeconds:track.audioDuration ?? null,
    ...(mode === 'ordinary' ? {skillReference:{...row.skillReference, chartHash}} : {})};
}
