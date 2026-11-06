import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRankingResponse, rankingStatus} from '../src/lib/player-rankings-ui.mjs';
import {eventRankingPath} from '../src/lib/event-ranking-links.mjs';
import {validateHighScoreDeck, orderedDeckSlots, rankingCard, rankingScoreAnomaly} from '../src/lib/player-ranking-decks.mjs';

test('score anomaly rule flags only the integer limit and clears on a corrected score',()=>{
  assert.equal(rankingScoreAnomaly(2147483647),'score-int32-max');
  for (const score of [0,17014421,2147483646,2147483648,'2147483647',null,undefined,NaN])
    assert.equal(rankingScoreAnomaly(score),null);
  const row={playerId:'same-player',score:2147483647};
  assert.equal(rankingScoreAnomaly(row.score),'score-int32-max');
  row.score=17014421;
  assert.equal(rankingScoreAnomaly(row.score),null);
});

const response = () => ({schemaVersion:1,serverId:'global-hmt',board:'music',eventId:'1',musicId:'100109',
  status:'available',boards:['music'],events:[{id:'1',name:'Event'}],songs:[{id:'100109',name:'Song'}],
  entries:[{playerId:'p',name:'<img onerror=alert(1)>',rank:1,score:123}],nextCursor:null,
  observedAt:'2026-09-30T00:00:00Z',expiresAt:'2026-09-30T00:15:00Z'});

test('automatic board selection accepts the collected song board but rejects foreign identities',()=>{
  const value=response();
  assert.equal(validateRankingResponse(value,'global-hmt','auto','',''),value);
  for(const args of [['global-en','auto','',''],['global-hmt','music','2',''],['global-hmt','music','1','100056']])
    assert.throws(()=>validateRankingResponse(value,...args));
});
test('malformed scores, duplicate players, timestamps and board kinds are rejected',()=>{
  for(const change of [v=>v.entries[0].score=NaN,v=>v.entries[0].rank=0,v=>v.entries.push(v.entries[0]),
    v=>v.entries=[null],v=>v.expiresAt='bad',v=>v.boards=['wrong'],v=>v.nextCursor={}]){
    const value=response();change(value);assert.throws(()=>validateRankingResponse(value,'global-hmt','auto','',''));
  }
});
test('an open page changes to stale when its observation expires',()=>{
  assert.equal(rankingStatus(response(),Date.parse('2026-09-30T00:14:59Z')),'available');
  assert.equal(rankingStatus(response(),Date.parse('2026-09-30T00:15:00Z')),'stale');
  assert.equal(rankingStatus({...response(),status:'unavailable'},Infinity),'unavailable');
});
test('an explicit final record stays final after the live snapshot TTL',()=>{
  assert.equal(rankingStatus({...response(),isFinal:true,status:'stale'},Infinity),'available');
  assert.equal(rankingStatus({...response(),isFinal:true,status:'empty',entries:[]},Infinity),'empty');
});
test('event links use LiveMusic IDs and only offer configured boards',()=>{
  const event={id:1,ranking:{configured:{eventPoints:false,music:true,totalMusic:true}},challengeSongs:[{id:1,musicId:100109}]};
  assert.equal(eventRankingPath(event,'music',100109),'/rankings/?event=1&board=music&music=100109');
  assert.equal(eventRankingPath(event,'total-music'),'/rankings/?event=1&board=total-music');
  assert.equal(eventRankingPath(event,'event-points'),null);
  assert.equal(eventRankingPath(event,'music',1),null);
  assert.equal(eventRankingPath(event,'unknown'),null);
});

const deck = () => ({totalPower:2756699,cards:[{slot:0,performanceOrder:2,
  member:{masterId:59,exp:721000,rank:5,awake:4,liveSkillLevel:null,performanceSkillLevel:null},
  support:{masterId:61,exp:0,rank:5}}]});
test('high score teams accept absent optional data but reject ambiguous or unsafe slots',()=>{
  validateHighScoreDeck(null);validateHighScoreDeck(deck());
  for(const mutate of [d=>d.cards.push(d.cards[0]),d=>d.cards[0].slot=5,d=>d.cards[0].performanceOrder=true,
    d=>d.totalPower=-1,d=>d.cards[0].member.masterId=0,d=>d.cards[0].member.liveSkillLevel=0]){
    const value=deck();mutate(value);assert.throws(()=>validateHighScoreDeck(value));
  }
  const value=response();value.entries[0].highScoreDeck={cards:'bad'};
  assert.throws(()=>validateRankingResponse(value,'global-hmt','auto','',''));
});
test('card kinds never collide and incomplete decks retain five explicit positions',()=>{
  const catalog={member:{59:{name:'Member'}},support:{59:{name:'Support'}}};
  assert.equal(rankingCard('member',59,catalog).name,'Member');
  assert.equal(rankingCard('support',59,catalog).name,'Support');
  assert.equal(rankingCard('support',999,catalog),undefined);
  const slots=orderedDeckSlots(deck());assert.equal(slots.length,5);
  assert.equal(slots[0].member.masterId,59);assert.equal(slots[0].performanceOrder,2);
  assert.equal(slots[1].member,null);assert.equal(slots[1].performanceOrder,null);
});

test('activity schedules and final archives stay separate from snapshot freshness',async()=>{
  const {rankingEvents,filterRankingEvents,rankingEventLabel}=await import('../src/lib/player-ranking-events.mjs');
  const definitions=[{id:3,name:'Now',startAt:'2026-10-18T12:00:00+08:00',endAt:'2026-10-25T12:00:00+08:00',bandIds:['1'],attributes:[2]},
    {id:4,name:'Next',startAt:'2026-10-26T12:00:00+08:00',endAt:'2026-11-01T12:00:00+08:00',bandIds:['2']}];
  const records=rankingEvents(definitions,[{id:'2',name:'Archive',isFinal:true}],Date.parse('2026-10-18T20:00:00+08:00'));
  assert.deepEqual(records.map(item=>item.state),['active','upcoming','ended']);
  assert.deepEqual(filterRankingEvents(records,'1').map(item=>item.id),['3']);
  assert.deepEqual(filterRankingEvents(records,'2').map(item=>item.id),['4']);
  assert.equal(filterRankingEvents(records,'missing').length,0);
  assert.equal(filterRankingEvents(records,'').length,3);
  assert.equal(rankingEventLabel(records[2]),'Archive · 已结束 · 最终记录');
  assert.deepEqual(records[0].attributes,[2]);
  assert.equal(rankingEvents(definitions,[],Date.parse('2026-10-25T12:00:01+08:00')).find(item=>item.id==='3').state,'ended');
});

test('public profile images reject foreign origins and credentials',async()=>{
  const {validatePlayerProfile}=await import('../src/lib/player-ranking-decks.mjs');
  const url='https://l14-prod-hk-patch-sirius.gamerfusiontech.com/profile/test.png';
  validatePlayerProfile(null);validatePlayerProfile({avatarMasterId:59,profileCardImages:[url]});
  for(const profile of [{avatarMasterId:true,profileCardImages:[]},{profileCardImages:['https://evil.example/test.png']},
    {profileCardImages:[url+'?token=private']},{profileCardImages:[url+'#fragment']},{profileCardImages:[url.replace('https:','http:')]},
    {profileCardImages:[(()=>{const image=new URL(url);image.username='EXAMPLE_USER';image.password='EXAMPLE_PASSWORD';return image.href;})()]}]) assert.throws(()=>validatePlayerProfile(profile));
  const value=response();value.entries[0].profile={profileCardImages:['https://evil.example/test.png']};
  assert.throws(()=>validateRankingResponse(value,'global-hmt','auto','',''));
});


test('band links and refresh preserve an empty band instead of selecting another band',async()=>{
  const {rankingEventForBand}=await import('../src/lib/player-ranking-events.mjs');
  const events=[{id:'3',bandIds:['2']},{id:'2',bandIds:['2']},{id:'1',bandIds:['1']}];
  assert.equal(rankingEventForBand(events,'1','3'),'1');
  assert.equal(rankingEventForBand(events,'2','2'),'2');
  assert.equal(rankingEventForBand(events,'missing','3'),'');
  assert.equal(rankingEventForBand(events,'','99'),'99');
});

test('configured total score boards remain selectable before capture without inventing results',async()=>{
 const {availableRankingBoards}=await import('../src/lib/player-ranking-events.mjs');
 assert.deepEqual(availableRankingBoards({rankingConfigured:{music:true,totalMusic:true}},['music'],'music'),['music','total-music']);
 assert.deepEqual(availableRankingBoards({rankingConfigured:{totalMusic:false}},[]),[]);
 assert.deepEqual(availableRankingBoards({},[],'total-music'),['total-music']);
 const value=response();value.board='total-music';value.musicId='';value.boards=['total-music'];value.songs=[];
 assert.equal(validateRankingResponse(value,'global-hmt','total-music','1',''),value);
});
