// Differential verification against a frozen source tree, using public datasets.
// No personal inventory or account export is read or written by this harness.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{baseline:{type:'string'},datasets:{type:'string'},output:{type:'string'}}});
if(!values.baseline||!values.datasets||!values.output)throw Error('--baseline, --datasets and --output are required');
const root=resolve(import.meta.dirname,'..'),load=(dir,file)=>import(pathToFileURL(resolve(dir,file)));
const engines=await Promise.all([resolve(values.baseline),root].map(async dir=>({
 power:(await load(dir,'packages/scoring/scoring-rules/formation-power.mjs')).createFormationCalculator,
 song:(await load(dir,'packages/scoring/scoring-rules/formal-song-score.mjs')).createFormalSongCalculator,
 event:(await load(dir,'packages/scoring/scoring-rules/event-efficiency.mjs')).createEventEfficiency
})));
const report={startedAt:new Date().toISOString(),node:process.version,pairs:0,charts:0,replays:0,datasets:[],failures:0};
for(const dataset of JSON.parse(readFileSync(values.datasets))){
 const rules=JSON.parse(readFileSync(dataset.rules)),t=rules.tables,power=engines.map(e=>e.power(rules));
 const growth={};
 for(const [kind,table] of [['member',t.MemberCard],['support',t.SupportCard]])for(const card of table){
  const rank=card._id%5+1,awake=card._id%5+1;
  growth[`${kind}-card-${card._id}`]={rank,level:power[0].resolveGrowth(card,kind==='member'?'Member':'Support',{rank,awake}).level,
   ...(kind==='member'?{awake,skillLevel:card._id%5+1,gekisouSkillLevel:card._id%5+1}:{})};
 }
 const bandItems=Object.fromEntries(t.BandItem.map(item=>{
  const max=Math.max(...t.BandItemSkillEffect.filter(r=>r._bandItemId===item._id).map(r=>r._level));
  return [item._id,1+item._id%max];
 }));
 const modifiers={growth,bandItems,characterRanks:Object.fromEntries(t.Character.map(c=>[c._id,1+c._id%50])),tgwCardRank:12};
 for(const member of t.MemberCard)for(const support of t.SupportCard){
  const draft={slots:[{memberCardId:`member-card-${member._id}`,supportCardId:`support-card-${support._id}`},{},{},{},{}],modifiers};
  assert.deepEqual(power[1].calculate(draft),power[0].calculate(draft));report.pairs++;
 }
 const files=readdirSync(dataset.charts).filter(f=>/^music-chart-\d+\.json$/.test(f)).sort();
 assert.deepEqual(files.map(f=>Number(/\d+/.exec(f)[0])).sort((a,b)=>a-b),t.LiveMusicScore.map(r=>r._id).sort((a,b)=>a-b));
 const seenMembers=new Set(),seenSupports=new Set(),timings=[0,0];let replays=0;
 for(const [index,file] of files.entries()){
  const chart=JSON.parse(readFileSync(resolve(dataset.charts,file))),members=[],characters=new Set();
  for(let j=0;j<t.MemberCard.length&&members.length<5;j++){
   const member=t.MemberCard[(index+j)%t.MemberCard.length];
   if(!characters.has(member._characterID)){characters.add(member._characterID);members.push(member);}
  }
  const slots=members.map((member,j)=>({memberCardId:`member-card-${member._id}`,supportCardId:`support-card-${t.SupportCard[(index*5+j)%t.SupportCard.length]._id}`}));
  for(const slot of slots){seenMembers.add(slot.memberCardId);seenSupports.add(slot.supportCardId);}
  const draft={slots,selectedSongId:chart.trackId,selectedDifficulty:chart.difficulty,modifiers};
  const contexts=[null,...t.ChallengeMusic.filter(m=>`music-${m._liveMusicId}`===chart.trackId&&(!dataset.eventIds||dataset.eventIds.includes(m._eventId))).map(m=>m._eventId)];
  for(const eventId of contexts){
   const team=structuredClone(draft);
   if(eventId)team.modifiers.event={id:eventId,sourceReleaseId:rules.sourceReleaseId};
   const run=(engine,n)=>{
    const start=performance.now(),eventAdapters=eventId?[engine.event({tables:t,sourceReleaseId:rules.sourceReleaseId,eventId}).challengeAdapter(rules)]:[];
    const calculator=engine.song(rules,chart,{eventAdapters,frameRate:[30,60,120][index%3]});
    const first=calculator.calculate(team),changed=structuredClone(team);
    changed.modifiers.tgwCardRank=21;
    const second=calculator.calculate(changed); // Reuse factors; recompute power and every note score.
    timings[n]+=performance.now()-start;return [first,second];
   };
   // Alternate timing order to limit systematic warmup bias; full batch timing
   // remains a separate, serial worker measurement.
   const results=[];for(const n of index%2?[1,0]:[0,1])results[n]=run(engines[n],n);
   assert.deepEqual(results[1],results[0],`${rules.sourceReleaseId}:${chart.id}:${eventId}`);replays+=2;
  }
  report.charts++;
  if(report.charts%50===0)console.log(JSON.stringify({charts:report.charts,pairs:report.pairs}));
 }
 assert.equal(seenMembers.size,t.MemberCard.length);assert.equal(seenSupports.size,t.SupportCard.length);
 report.replays+=replays;report.datasets.push({sourceReleaseId:rules.sourceReleaseId,charts:files.length,members:seenMembers.size,supports:seenSupports.size,replays,timingsMs:{baseline:timings[0],current:timings[1]}});
}
report.finishedAt=new Date().toISOString();mkdirSync(dirname(resolve(values.output)),{recursive:true});writeFileSync(values.output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
