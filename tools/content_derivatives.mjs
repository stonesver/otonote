#!/usr/bin/env node
// Compute content-dependent tables on update, without invoking the website build.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {loadSongRankingData} from '../packages/scoring/server/song-ranking-data.mjs';
import {scoringRulesAvailable} from '../packages/scoring/scoring-release-gate.mjs';
import {inspectPublishedSkillsCompatibility} from '../packages/scoring/scoring-rules/scoring-compatibility.mjs';
const [boundPath,release,locale,output,cache,rulesPath] = process.argv.slice(2);
const bound=resolve(boundPath);
const catalog=JSON.parse(await readFile(join(bound,'generated/releases',release,locale,'catalog.json'),'utf8'));
const rules=JSON.parse(await readFile(rulesPath ?? new URL('../packages/scoring/data/formal-scoring-rules.json',import.meta.url),'utf8'));
if(!scoringRulesAvailable(rules,catalog.release.id)) {
  await writeFile(output,JSON.stringify({sourceReleaseId:catalog.release.id,unavailable:true}));
  await writeFile(join(dirname(output),'scoring-compatibility.json'),JSON.stringify({status:'unavailable',sourceReleaseId:catalog.release.id,checks:0,issues:[]}));
} else {
  const compatibility = inspectPublishedSkillsCompatibility(rules, catalog);
  await writeFile(join(dirname(output),'scoring-compatibility.json'),JSON.stringify(compatibility));
  const tracks=catalog.musicTracks.map(t=>({id:t.id,title:t.title,bandIds:t.bandIds,bandLabels:t.bandLabels,musicTypeLabel:t.musicTypeLabel,audioDuration:t.audioDuration}));
  const charts=catalog.musicCharts.map(c=>({id:c.id,trackId:c.trackId,difficulty:c.difficulty,duration:c.duration,analysisDataUrl:c.analysisDataUrl}));
  const data=await loadSongRankingData({rules,releaseId:catalog.release.id,tracks,charts,publicRoot:join(bound,'public'),cacheRoot:resolve(cache)});
  await writeFile(output,JSON.stringify(data));
}
