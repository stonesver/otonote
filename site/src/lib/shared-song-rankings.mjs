import {validGradeThresholds} from './song-grade-ranking.mjs';
import {SCORE_MODEL_VERSION} from './scoring-rules/model-version.mjs';
import {mergeEditionRows, stableContent, catalogIdentity, presenceLabel} from './edition-library.mjs';
export async function neutralRankingRulesFingerprint(rules, releaseId) {
  if (rules?.sourceReleaseId!==releaseId || !rules.native || !rules.tables) return null;
  const value=stableContent([rules.native,Object.fromEntries(Object.entries(rules.tables)
    // LiveScoreRank maps final scores to reward grades; it never contributes
    // to the fixed-power benchmark. Edition-specific songs add unrelated rows.
    // Both benchmark modes construct fixed skill effects from the benchmark
    // settings, so new card skills and their effect rows cannot split songs.
    .filter(([name])=>name.startsWith('Live') && !['LiveMusic','LiveMusicScore','LiveSkill','LiveSkillEffect','LiveScoreRank'].includes(name)))]);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),
    byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Result identity includes the verified rule digest and chart digest, not scores or IDs. */
export function combineSongRankings(sources, {region = "global", locale = 'zh-CN'} = {}) {
  const order = [region, region === 'jp' ? 'global' : 'jp'];
  /** @type {{ordinary:any[],gekisou:any[],artwork:Record<string,string>,releases:Record<string,string>}} */
  const result = {ordinary:[],gekisou:[],artwork:{},releases:{}};
  const rowsFor = (source, mode) => {
    if (!source) return null;
    const {catalog,data,edition} = source;
    // The fixed-power benchmark does not use cards, skills or event schedules.
    // Keep the native implementation and all live-scoring tables; song-specific
    // levels and missions are compared with the complete result metrics below.
    const neutralRules=source.neutralRulesFingerprint;
    const counterpart=sources.find(s=>s?.edition!==edition);
    const otherSongs=new Set(counterpart?.catalog.musicTracks.map(track=>catalogIdentity('musicTracks',track,counterpart.catalog))??[]);
    result.releases[edition] = catalog.release.id;
    const tracks = new Map(catalog.musicTracks.map(t=>[t.id,t]));
    const ready = data && !data.unavailable && data.sourceReleaseId === catalog.release.id
      && data.benchmark?.modelVersion === SCORE_MODEL_VERSION;
    const computed = new Map((ready ? data[mode] : []).map(row=>[row.id,row]));
    return catalog.musicCharts.map(chart=>{
      const track=tracks.get(chart.trackId), row=computed.get(chart.id);
      const asset=catalog.assets.find(a=>a.id===track?.jacketAssetId);
      result.artwork[`${edition}--${chart.trackId}`]=asset?.thumbnailUrl ?? asset?.previewUrl;
      const songIdentity=track && catalogIdentity('musicTracks',track,catalog);
      const chartIdentity=songIdentity && chart.contentIdentity ? stableContent([songIdentity,chart.difficulty,chart.contentIdentity]) : null;
      const metrics=row && Object.fromEntries(Object.entries(row).filter(([key])=>
        !['id','trackId','title','bands','bandLabels','attribute','chartFingerprint','chartSeconds','audioSeconds','skillReference','meta'].includes(key)));
      const resultIdentity=row?.chartFingerprint && data.rulesFingerprint
        ? neutralRules && chartIdentity
          ? stableContent([mode,neutralRules,data.benchmark,chartIdentity,metrics])
          : stableContent([mode,data.rulesFingerprint,data.benchmark,row.chartFingerprint]) : null;
      return {...(row ?? {}), id:chart.id, trackId:`${edition}--${chart.trackId}`, title:track?.title ?? chart.trackId,
        difficulty:chart.difficulty, level:chart.displayLevel ?? chart.level, bands:track?.bandIds ?? [], bandLabels:track?.bandLabels ?? [],
        expectedScore:row?.expectedScore ?? null, audioSeconds:row?.audioSeconds ?? track?.audioDuration ?? null,
        chartSeconds:row?.chartSeconds ?? chart.duration ?? null, pending:!row, sourceEdition:edition,
        libraryPresence:{status:counterpart && songIdentity?'known':'unknown',editions:otherSongs.has(songIdentity)?['global','jp']:[edition]},
        chartIdentity,resultIdentity,benchmark:data?.benchmark,gradeReference:{edition,trackId:chart.trackId,sourceReleaseId:catalog.release.id,thresholds:validGradeThresholds(track?.soloRewards?.scoreRanks)}};
    });
  };
  for (const mode of ['ordinary','gekisou']) {
    const primary=sources.find(s=>s?.edition===order[0]),secondary=sources.find(s=>s?.edition===order[1]);
    const primaryRows=rowsFor(primary,mode)??[],secondaryRows=rowsFor(secondary,mode);
    const sourceRows=[...primaryRows,...(secondaryRows??[])];
    result[mode]=mergeEditionRows(primaryRows,secondaryRows,{
      region,locale,key:r=>r.resultIdentity ?? (r.pending && r.chartIdentity ? `pending:${r.chartIdentity}` : null),path:r=>`/music/${r.trackId.replace(/^(jp|global)--/,'')}/`,
      // Older analysis projections differ below the game's millisecond clock.
      // Keep the preferred source duration; materially different timings stay separate.
      canMerge:(a,b)=>['chartSeconds','audioSeconds'].every(field=>a[field]===b[field] ||
        Number.isFinite(a[field]) && Number.isFinite(b[field]) && Math.abs(a[field]-b[field])<=0.001)
    });
    for (const row of result[mode]) {
      row.applicableEditions = row.pending ? [] : [...row.editionPresence.editions];
      row.pendingEditions = row.pending ? [...row.editionPresence.editions] : [];
    }
    // A pending calculation for the same content belongs to its existing row.
    // Only the verified edition is listed as applicable to that score.
    const folded=new Set();
    for (const row of result[mode].filter(r=>r.pending && r.chartIdentity)) {
      const matches=result[mode].filter(r=>!r.pending && r.chartIdentity===row.chartIdentity && r.sourceEdition!==row.sourceEdition);
      if(matches.length!==1)continue;
      const target=matches[0];
      target.pendingEditions.push(...row.pendingEditions);
      target.editionPresence={...target.editionPresence,status:'known',editions:['global','jp']};
      if(row.sourceEdition===region)target.title=row.title;
      folded.add(row);
    }
    result[mode]=result[mode].filter(row=>!folded.has(row));
    for(const row of result[mode]){
      row.gradeReferences={};
      for(const candidate of sourceRows){
        const own=candidate.sourceEdition===row.sourceEdition&&candidate.id===row.sourceId;
        const sameChart=row.chartIdentity&&candidate.chartIdentity===row.chartIdentity;
        const sameResult=row.resultIdentity&&candidate.resultIdentity===row.resultIdentity;
        const counterpart=(sameChart||sameResult)&&row.editionPresence.editions.includes(candidate.sourceEdition);
        if((own||counterpart)&&candidate.gradeReference.thresholds){
          row.gradeReferences[candidate.sourceEdition]={...candidate.gradeReference,
            verified:!candidate.pending&&row.applicableEditions.includes(candidate.sourceEdition)&&candidate.resultIdentity===row.resultIdentity};
        }
      }
    }
  }
  return result;
}

export function rankingEditionLabel(row, en=typeof document!=='undefined' && document.documentElement.lang==='en') {
  return presenceLabel(row.libraryPresence,en);
}
