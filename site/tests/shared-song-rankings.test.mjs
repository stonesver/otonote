import test from 'node:test';
import assert from 'node:assert/strict';
import {combineSongRankings,rankingEditionLabel,neutralRankingRulesFingerprint} from '../src/lib/shared-song-rankings.mjs';
import {rankSongRows} from '../src/lib/song-ranking-view.mjs';
import {validateRankingResponse} from '../src/lib/player-rankings-ui.mjs';
import {SCORE_MODEL_VERSION} from '../src/lib/scoring-rules/model-version.mjs';
const source=(edition,options={})=>({edition,catalog:{release:{id:edition},assets:[],musicTracks:[{id:'song',title:'Song',bandIds:[],bandLabels:[]}],musicCharts:[{id:'chart',trackId:'song',difficulty:'expert',displayLevel:25}]},data:options.pending?null:{sourceReleaseId:edition,rulesFingerprint:options.rule??'rule',benchmark:{power:100000,modelVersion:SCORE_MODEL_VERSION},ordinary:[{id:'chart',chartFingerprint:options.chart??'chart',expectedScore:100,chartSeconds:10}],gekisou:[]}});
test('unified ranking merges only matching verified rules and chart content',()=>{
  assert.equal(combineSongRankings([source('global'),source('jp')]).ordinary.length,1);
  assert.equal(combineSongRankings([source('global'),source('jp',{rule:'other'})]).ordinary.length,2);
  assert.equal(combineSongRankings([source('global'),source('jp',{chart:'other'})]).ordinary.length,2);
});
test('old or missing scoring model versions cannot supply current ranking scores',()=>{
  for(const modelVersion of [undefined, 'ournotes-native-score-v1']) {
    const old=source('global'); old.data.benchmark.modelVersion=modelVersion;
    const row=combineSongRankings([old]).ordinary[0];
    assert.equal(row.pending,true); assert.equal(row.expectedScore,null);
    assert.deepEqual(row.applicableEditions,[]);
  }
});
test('unverified charts remain visible and never receive ranks',()=>{
  const data=combineSongRankings([source('jp',{pending:true}),source('global')],{region:'jp'});
  const rows=rankSongRows(data.ordinary);assert.equal(rows[0].rank,1);assert.equal(rows[1].rank,null);assert.equal(rows[1].pending,true);
});
test('shared chart uses one row with separately stated pending editions',()=>{
  const withIdentity=(edition,pending)=>{
    const s=source(edition,{pending});
    s.catalog.assets=[{id:'jacket',sha256:'same-jacket'}];
    Object.assign(s.catalog.musicTracks[0],{jacketAssetId:'jacket',musicSoundId:1});
    s.catalog.musicCharts[0].contentIdentity='same-full-chart';
    return s;
  };
  const data=combineSongRankings([withIdentity('global',true),withIdentity('jp',false)]).ordinary;
  assert.equal(data.length,1);
  assert.deepEqual(data[0].applicableEditions,['jp']);
  assert.deepEqual(data[0].pendingEditions,['global']);
  assert.equal(rankingEditionLabel(data[0]),'');
  const pending=combineSongRankings([withIdentity('global',true),withIdentity('jp',true)]).ordinary;
  assert.equal(pending.length,1);
  assert.equal(rankSongRows(pending)[0].rank,null);
  assert.deepEqual(pending[0].pendingEditions,['global','jp']);
});
test('player response cannot replace the selected server or event',()=>{
  const value={schemaVersion:1,serverId:'jp',board:'music',eventId:'one',musicId:'song',status:'empty',entries:[],events:[],songs:[]};
  assert.equal(validateRankingResponse(value,'jp','music','one','song'),value);
  for(const [server,event] of [['global-en','one'],['jp','two']])assert.throws(()=>validateRankingResponse(value,server,'music',event,'song'));
});

test('neutral benchmark joins common charts across unrelated edition tables and analysis revisions',async()=>{
  const proven=async(edition)=>{
    const value=source(edition,{rule:edition,chart:edition});
    value.catalog.musicTracks[0].contentIdentity='same-song';
    value.catalog.musicCharts[0].contentIdentity='same-authored-notes';
    value.rules={sourceReleaseId:edition,native:{difficultyIncrement:0.005},tables:{
      LiveNoteParameter:[{_scorePercent:100}],LiveMusic:[{_name:edition}],LiveMusicScore:[{_id:edition}],MemberCard:[{edition}]}};
    value.neutralRulesFingerprint=await neutralRankingRulesFingerprint(value.rules,edition);
    return value;
  };
  const a=await proven('global'),b=await proven('jp');
  const combined=combineSongRankings([a,b]).ordinary;
  assert.equal(combined.length,1);
  assert.deepEqual(combined[0].applicableEditions,['global','jp']);
  const changed=structuredClone(b);changed.rules.tables.LiveNoteParameter[0]._scorePercent=200;
  changed.neutralRulesFingerprint=await neutralRankingRulesFingerprint(changed.rules,'jp');
  assert.equal(combineSongRankings([a,changed]).ordinary.length,2);
  const differentNotes=structuredClone(b);differentNotes.catalog.musicCharts[0].contentIdentity='other-notes';
  assert.equal(combineSongRankings([a,differentNotes]).ordinary.length,2);
  const differentResult=structuredClone(b);differentResult.data.ordinary[0].expectedScore=101;
  assert.equal(combineSongRankings([a,differentResult]).ordinary.length,2);
  const differentDuration=structuredClone(b);differentDuration.data.ordinary[0].chartSeconds=11;
  assert.equal(combineSongRankings([a,differentDuration]).ordinary.length,2);
  const projectionPrecision=structuredClone(b);projectionPrecision.data.ordinary[0].chartSeconds=10.0005;
  assert.equal(combineSongRankings([a,projectionPrecision]).ordinary.length,1);
});

test('new edition score-rank thresholds do not split identical benchmark songs',async()=>{
  const sources=await Promise.all(['global','jp'].map(async edition=>{
    const value=source(edition,{rule:edition});
    value.catalog.musicTracks[0].contentIdentity='shared-song';
    value.catalog.musicCharts[0].contentIdentity='shared-notes';
    const rules={sourceReleaseId:edition,native:{difficultyIncrement:0.005},tables:{
      LiveNoteParameter:[{_scorePercent:100}],
      // A newly released song has different grade/reward thresholds in each edition.
      LiveScoreRank:[{_id:edition==='global'?625:631,_group:edition==='global'?1100107:1100108,
        _liveScoreRank:2,_requiredScore:0,_battleLiveRequiredScore:0}]
    }};
    value.neutralRulesFingerprint=await neutralRankingRulesFingerprint(rules,edition);
    value.data.gekisou=structuredClone(value.data.ordinary);
    return value;
  }));
  for(const region of ['global','jp'])for(const mode of ['ordinary','gekisou']) {
    const rows=combineSongRankings(sources,{region})[mode];
    assert.equal(rows.length,1,`${region}/${mode}: same chart must appear once`);
    assert.deepEqual(rows[0].applicableEditions,['global','jp']);
  }
});

test('card skill-effect updates do not duplicate either fixed-skill benchmark',async()=>{
  const sources=await Promise.all(['global','jp'].map(async edition=>{
    const value=source(edition,{rule:edition,chart:edition});
    value.catalog.musicTracks[0].contentIdentity='shared-song';
    value.catalog.musicCharts[0].contentIdentity='shared-notes';
    value.data.gekisou=[{...value.data.ordinary[0],expectedScore:200}];
    value.rules={sourceReleaseId:edition,native:{difficultyIncrement:0.005},tables:{
      LiveNoteParameter:[{_scorePercent:100}],LiveComboScoreBonus:[{_bonusFactor:0.01}],
      LiveSkill:[{_id:1}],LiveSkillEffect:[{_id:1,_liveSkillID:1,_effectValue:10000}]
    }};
    if(edition==='global'){
      value.rules.tables.LiveSkill.push({_id:2});
      value.rules.tables.LiveSkillEffect.push({_id:2,_liveSkillID:2,_effectValue:15000});
      value.rules.tables.LiveSkillEffect[0]._effectValue=20000;
    }
    value.neutralRulesFingerprint=await neutralRankingRulesFingerprint(value.rules,edition);
    return value;
  }));
  const before=structuredClone(sources);
  for(const region of ['global','jp']){
    const merged=combineSongRankings(sources,{region});
    for(const mode of ['ordinary','gekisou']){
      assert.equal(merged[mode].length,1);
      assert.deepEqual(merged[mode][0].applicableEditions,['global','jp']);
      assert.equal(merged[mode][0].expectedScore,mode==='ordinary'?100:200);
    }
  }
  assert.deepEqual(sources,before,'published scoring inputs and scores are unchanged');
  const changed=structuredClone(sources[1]);
  changed.rules.tables.LiveComboScoreBonus[0]._bonusFactor=0.02;
  changed.neutralRulesFingerprint=await neutralRankingRulesFingerprint(changed.rules,'jp');
  const separate=combineSongRankings([sources[0],changed]);
  for(const mode of ['ordinary','gekisou'])assert.equal(separate[mode].length,2,'real scoring changes must remain separate');
});

test('shared benchmark retains distinct edition thresholds for grade-power lookup',()=>{
 const a=source('global'),b=source('jp');
 for(const [i,s] of [a,b].entries())s.catalog.musicTracks[0].soloRewards={scoreRanks:[2,3,4,5,6,7].map((rank,j)=>({rank,requiredScore:j*(i+1)*1000}))};
 for(const region of ['global','jp']){
  const rows=combineSongRankings([a,b],{region}).ordinary;assert.equal(rows.length,1);
  assert.equal(rows[0].gradeReferences.global.thresholds[1].score,1000);assert.equal(rows[0].gradeReferences.jp.thresholds[1].score,2000);
  assert.equal(rows[0].gradeReferences.global.verified,true);assert.equal(rows[0].gradeReferences.jp.verified,true);
  assert.equal(rows[0].gradeReferences.global.trackId,'song');
 }
});
