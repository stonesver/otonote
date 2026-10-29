export const arenaNow = Date.parse('2026-10-28T04:00:00Z');
export function arenaFixture() {
  return {schemaVersion:1,region:'global',sourceReleaseId:'arena-test',observedAt:'2026-10-28T00:00:00Z',sourceRevision:'a'.repeat(64),
    serverScopes:['global-hmt'],timeZone:'Asia/Tokyo',timeSemanticsVersion:'inclusive-second-v1',limitations:[],
    capabilities:{conditions:true,ranks:true,basePoints:true,rewards:true,rankings:false},
    seasons:[{id:'s1',name:'测试赛季',validFrom:'2026-10-01T00:00:00Z',validUntil:'2026-11-01T00:00:00Z',statisticsUntil:'2026-11-01T00:00:01Z'},
      {id:'s2',name:'下一赛季',validFrom:'2026-11-01T00:00:00Z',validUntil:'2026-12-01T00:00:00Z'}],
    leagues:[{id:'l7',bandId:'1',openingSourceText:'',name:'MyGO!!!!!'},{id:'l9',bandId:'2',openingSourceText:'',name:'Ave Mujica · 很长的乐队名称，用于窄屏验收'}],
    regulations:[{id:'r0',leagueId:'l7',attribute:0,missions:[1,0,3],validFrom:'2026-10-27T00:00:00Z',validUntil:'2026-10-28T00:00:00Z'},
      {id:'r1',leagueId:'l7',attribute:99,missions:[2,2,2],validFrom:'2026-10-28T00:00:00Z',validUntil:'2026-10-29T00:00:00Z'},
      {id:'r2',leagueId:'l7',attribute:99,missions:[2,2,2],validFrom:'2026-10-29T00:00:00Z',validUntil:'2026-10-30T00:00:00Z'},
      {id:'r3',leagueId:'l9',attribute:1,missions:[3,0,1],validFrom:'2026-10-28T00:00:00Z',validUntil:'2026-10-29T00:00:00Z'}],
    ranks:[{id:'k1',bandId:'1',tier:1,division:1,openingSourceText:'',name:'初学者',threshold:0},{id:'k2',bandId:'1',tier:2,division:1,openingSourceText:'',name:'白金',threshold:100}],
    basePoints:[2,3,4,5].flatMap(players=>Array.from({length:players},(_,i)=>({tier:1,players,place:i+1,points:i===players-1?-40:40-i*5}))),
    rewards:[{kind:'promotion',bandId:'1',rankId:'k1',label:'首次晋段',items:[{itemId:'1',name:'测试物品',count:50}]}],dailyReward:{limit:3,resetTime:'04:00'}};
}

// Synthetic official-response-shaped data, used only by tests.
export function arenaTrendFixture() {
 const data=arenaFixture();data.capabilities.deckTrends=true;
 data.deckTrends=[{source:'ArenaService.DeckTrend',serverId:'global-hmt',seasonId:'s1',bandId:'1',musicId:'100001',
  observedAt:'2026-10-28T01:00:00Z',sourceRevision:'c'.repeat(64),leaders:['1'],members:['2','1'],supports:['1']}];
 return data;
}
