#!/usr/bin/env node
// Recompute only rankings from a previously verified, immutable public snapshot.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {loadSongRankingData} from '../packages/scoring/server/song-ranking-data.mjs';
import {SCORE_MODEL_VERSION} from '../packages/scoring/scoring-rules/model-version.mjs';
import {inspectPublishedSkillsCompatibility} from '../packages/scoring/scoring-rules/scoring-compatibility.mjs';

const [sourceArg, outputArg, model] = process.argv.slice(2);
if (model !== SCORE_MODEL_VERSION) throw Error('Requested model differs from producer');
const source = resolve(sourceArg), output = resolve(outputArg);
const manifest = JSON.parse(await readFile(join(source, 'manifest.json')));
await mkdir(output, {recursive:true});
for (const locale of ['zh-CN','en']) {
  const artifact = async key => JSON.parse(await readFile(join(source, manifest.locales[locale].files[key].path)));
  const catalog = await artifact('projection/catalog.json');
  const rules = await artifact('supplemental/formal-scoring-rules.json');
  const tracks = catalog.musicTracks.map(t => ({id:t.id,title:t.title,bandIds:t.bandIds,
    bandLabels:t.bandLabels,musicTypeLabel:t.musicTypeLabel,audioDuration:t.audioDuration}));
  const charts = catalog.musicCharts.map(c => {
    if (!c.analysisDataUrl?.startsWith(manifest.root)) throw Error('Chart is outside pinned snapshot');
    return {id:c.id,trackId:c.trackId,difficulty:c.difficulty,duration:c.duration,
      analysisDataUrl:'/' + c.analysisDataUrl.slice(manifest.root.length)};
  });
  const data = await loadSongRankingData({rules,releaseId:catalog.release.id,tracks,charts,
    publicRoot:source,cacheRoot:join(output,'cache')});
  await writeFile(join(output,locale + '.json'), JSON.stringify(data));
  await writeFile(join(output,locale + '-compatibility.json'),
    JSON.stringify(inspectPublishedSkillsCompatibility(rules,catalog)));
  console.log(JSON.stringify({locale,model:data.benchmark.modelVersion,
    ordinary:data.ordinary.length,gekisou:data.gekisou.length}));
}
