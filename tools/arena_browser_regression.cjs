#!/usr/bin/env node
/** Local code/content preview, synthetic Arena fixtures; never calls game APIs.
 * PLAYWRIGHT_PATH=/installed/playwright node tools/arena_browser_regression.cjs http://127.0.0.1:4398
 */
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdir} = require('node:fs/promises');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.argv[2] || 'http://127.0.0.1:4398';
const output = resolve(process.env.ARENA_BROWSER_OUTPUT || 'output/playwright/arena');
const hash = value => createHash('sha256').update(value).digest('hex');
(async()=>{
 const {arenaFixture,arenaNow} = await import(pathToFileURL(resolve(__dirname,'../site/tests/fixtures/arena.mjs')));
 await mkdir(output,{recursive:true});
 const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE});
 const results=[];
 try {
 async function setup({region='global',locale='zh-CN',mutate,missing=false,corrupt=false,blockArtifact=false,scale=1,rankings=false,autoRankings=false,rankingPages=2,dynamic=false,population=false}={}){
  const context=await browser.newContext({viewport:{width:1280,height:1000},deviceScaleFactor:scale,reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();if(!autoRankings)await page.addInitScript(()=>{window.IntersectionObserver=undefined;});await page.clock.install({time:new Date(arenaNow)});
  const pointerPath=region==='jp'?'/content/jp/current.json':'/content/current.json';
  const originalPointer=await (await context.request.get(base+pointerPath)).json();
  const manifest=await (await context.request.get(base+originalPointer.manifest)).json();
  const data=arenaFixture();data.region=region;data.sourceReleaseId=manifest.contentReleaseId;if(region==='jp')data.serverScopes=['jp'];
  mutate?.(data);if(population){data.sourceMasterVersion='a'.repeat(32);data.completeRankBands=['1'];}
  const bytes=JSON.stringify(data);
  for(const loc of Object.keys(manifest.locales)){if(missing)delete manifest.locales[loc].files['projection/arena.json'];else manifest.locales[loc].files['projection/arena.json']={path:loc+'/arena-test.json',sha256:hash(bytes)};}
  const manifestBytes=JSON.stringify(manifest),pointer={...originalPointer,sha256:hash(manifestBytes)};
  let offline=false,changed=false,pointerGate=null,releasePointer,releaseArtifact;
  const artifactGate=blockArtifact?new Promise(resolve=>releaseArtifact=resolve):null;const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>requests.push(req.url()));
  await page.addInitScript(()=>{globalThis.arenaStorageAccess=[];const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
   Storage.prototype.getItem=function(key){globalThis.arenaStorageAccess.push(['get',key]);return get.call(this,key);};
   Storage.prototype.setItem=function(key,value){globalThis.arenaStorageAccess.push(['set',key]);return set.call(this,key,value);};
  });
  let rankingChanged=false,holdRanking=null,releaseRanking;
  await page.route('**/api/v1/arena-population**',async route=>{const p=new URL(route.request().url()).searchParams;
   const sc={serverId:p.get('server'),seasonId:p.get('season'),bandId:p.get('band')};
   if(population&&sc.serverId==='global-hmt'&&sc.seasonId==='s1'&&sc.bandId==='1'){
    const observed=arenaNow-(population==='stale'?7200000:0),expires=observed+(population==='stale'?3600000:21600000);
    return route.fulfill({json:{schemaVersion:1,...sc,status:population==='stale'?'stale':'available',observation:{schemaVersion:1,...sc,method:'rank_boundary_probe',accuracy:'estimate',sourceReleaseId:manifest.contentReleaseId,masterVersion:(population==='mismatch'?'b':'a').repeat(32),startedAt:new Date(observed-60000).toISOString(),observedAt:new Date(observed).toISOString(),expiresAt:new Date(expires).toISOString(),sampleReads:30,totalEstimate:2000,tiers:[{tier:1,threshold:0,count:800},{tier:2,threshold:100,count:1200}]}}});
   }
   return route.fulfill({json:{schemaVersion:1,...sc,status:'unavailable',observation:null}});
  });
  await page.route('**/api/v1/arena-rankings**',async route=>{
   const livePath=new URL(route.request().url()).pathname.endsWith('rankings-live');
   if(livePath&&!dynamic)return route.fulfill({status:404,json:{error:'not_connected'}});
   const p=new URL(route.request().url()).searchParams,sc={serverId:p.get('server'),seasonId:p.get('season'),bandId:p.get('band')};
   if(holdRanking)await holdRanking;
   if(p.has('cursor')&&rankingChanged)return route.fulfill({status:409,json:{error:'arena_ranking_snapshot_changed'}});
   if(livePath&&dynamic){
    const rank=Number(p.get('rank')||1),start=p.has('end')?rank:Math.floor((rank-1)/100)*100+1,end=p.has('end')?Number(p.get('end')):start+99,offset=p.has('cursor')?Number(p.get('cursor').replace('next-','')):rank-start;
    const limit=Number(p.get('limit')||10),total=end-start+1-(rank-start),entries=Array.from({length:Math.min(limit,total-offset)},(_,n)=>({playerId:'live-'+(start+offset+n),name:rankingChanged?'Updated player':'Live player '+(start+offset+n),rank:start+offset+n,point:1}));
    return route.fulfill({json:{schemaVersion:1,...sc,mode:'dynamic',status:'available',entries,observedAt:new Date(arenaNow).toISOString(),expiresAt:new Date(arenaNow+300000).toISOString(),snapshotId:(rankingChanged?'f':'e').repeat(64),sourceReleaseId:manifest.contentReleaseId,coverage:{startRank:start,endRank:end},maxRank:31279,totalEntries:total,nextCursor:offset+limit<total?'next-'+(offset+limit):null,nextRank:start+100}});
   }
   const available=rankings&&sc.serverId==='global-hmt'&&sc.seasonId==='s1'&&sc.bandId==='1';
   const start=p.has('cursor')?Number(p.get('cursor').replace('next-','')):0;assert.equal(p.get('limit'),'50');
   const entries=available?Array.from({length:10},(_,n)=>({playerId:'synthetic-'+(start+n),name:start+n===0?'<script>escaped player</script>':'Synthetic player '+(start+n),rank:start+n===1?1:start+n+1,point:1000-start-n,deck:start+n===0?{totalPower:123456,cards:[{slot:0,performanceOrder:0,member:{masterId:72},support:{masterId:51}}]}:null})):[];
   return route.fulfill({json:{schemaVersion:1,...sc,status:available?'available':'unavailable',entries,
    observedAt:available?'2026-10-28T03:55:00Z':null,expiresAt:available?'2026-10-28T04:10:00Z':null,
    snapshotId:available?'d'.repeat(64):null,sourceReleaseId:available?manifest.contentReleaseId:null,coverage:available?{startRank:1,endRank:100}:null,maxRank:available?100:null,
    totalEntries:available?rankingPages*10:0,nextCursor:available&&start+10<rankingPages*10?'next-'+(start+10):null}});
  });
  await page.route('**/content/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path===pointerPath){if(pointerGate)await pointerGate;if(offline)return route.abort();return route.fulfill({json:changed?{...pointer,sha256:'f'.repeat(64)}:pointer});}
   if(path===originalPointer.manifest)return route.fulfill({body:manifestBytes,contentType:'application/json'});
   if(path.endsWith('/arena-test.json')){if(artifactGate)await artifactGate;return route.fulfill({body:corrupt?'{}':bytes,contentType:'application/json'});}
   return route.continue();
  });
  const root=page.locator('[data-arena-root]');
  const go=async(query='',tool=false)=>{await page.goto(`${base}/${region}/${locale}/${tool?'tools/arena/':'arena/'}${query?'?'+query:''}`);await root.waitFor();await page.waitForFunction(()=>document.querySelector('[data-arena-root]')?.getAttribute('aria-busy')==='false');};
  return {page,context,root,go,errors,requests,rankingChanged:()=>rankingChanged=true,holdRanking:()=>{holdRanking=new Promise(resolve=>releaseRanking=resolve);},releaseRanking:()=>{releaseRanking();holdRanking=null;},offline:()=>offline=true,changed:()=>changed=true,releaseArtifact:()=>releaseArtifact?.(),holdPointer:()=>{pointerGate=new Promise(resolve=>releasePointer=resolve);},releasePointer:()=>{releasePointer();pointerGate=null;}};
 }
 const s=await setup();const {page,root}=s;
 await s.go('server=global-hmt');
 const band1=root.locator('[data-action="band"][data-value="1"]'),band2=root.locator('[data-action="band"][data-value="2"]');
 assert.match(await band1.getAttribute('aria-label'),/ALL.*LUCK \/ LUCK \/ LUCK/);assert.match(await band2.getAttribute('aria-label'),/JUST \/ (COMBO|LUCK|JUST) \/ COMBO/);assert.equal(await band1.locator('.arena-mini-mission').count(),3);
 assert.ok(!(await root.innerText()).includes('官方配对趋势'));assert.equal(await root.locator('.arena-calendar').count(),1);
 assert.match(await root.innerText(),/ALL／全属性/);
 assert.equal(await root.locator('.arena-segments').getAttribute('data-missions'),'2,2,2');assert.equal(await root.locator('[data-arena-dialog]').count(),0);assert.equal(await root.locator('[data-arena-reference-dialog]').getAttribute('open'),null);
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await root.getByRole('tab').count(),0);
  const reference=root.locator('[data-arena-reference-dialog]');
  for(const kind of ['schedule','ranks','rules']){
   const trigger=root.locator(`[data-action="reference"][data-value="${kind}"]`);await trigger.click();assert.equal(await reference.getAttribute('open')!==null,true);
   await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);await page.keyboard.press('Escape');assert.equal(await reference.getAttribute('open'),null);assert.ok(await trigger.evaluate(el=>el===document.activeElement));
  }
  await page.clock.runFor(500);await page.screenshot({path:resolve(output,`overview-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:640,height:500});await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
 await page.setViewportSize({width:1280,height:1000});
 await band2.focus();await page.keyboard.press('Enter');assert.equal(await band2.getAttribute('aria-pressed'),'true');await band1.click();
 await root.locator('[data-action="reference"][data-value="ranks"]').click();assert.match(await root.innerText(),/-40/);
 for(const n of [2,3,4,5]){await root.locator('[data-field="players"]').selectOption(String(n));assert.equal(await root.locator('.arena-ap-results li').count(),n);}
 await root.locator('[data-field="tier"]').selectOption('2');assert.match(await root.innerText(),/当前资料没有此积分配置/);await page.keyboard.press('Escape');
 await root.locator('[data-action="band"][data-value="2"]').click();assert.match(await root.innerText(),/很长的乐队名称/);
 await page.goBack();assert.equal(await root.locator('[data-action="band"][data-value="1"]').getAttribute('aria-pressed'),'true');
 await page.goForward();assert.equal(await root.locator('[data-action="band"][data-value="2"]').getAttribute('aria-pressed'),'true');
 await root.locator('[data-action="band"][data-value="1"]').click();
 s.holdPointer();const delayed=page.waitForResponse(res=>new URL(res.url()).pathname==='/content/current.json');await root.locator('[data-action="refresh"]').click();await root.locator('[data-action="band"][data-value="2"]').click();s.releasePointer();await delayed;assert.equal(await root.locator('[data-action="band"][data-value="2"]').getAttribute('aria-pressed'),'true');await root.locator('[data-action="band"][data-value="1"]').click();
 await root.locator('[data-action="copy-link"]').click();const copied=await page.evaluate(()=>navigator.clipboard.readText());
 assert.equal(new URL(copied).searchParams.get('regulation'),'r1');assert.equal(new URL(copied).searchParams.get('season'),'s1');
 assert.equal(await root.getByRole('button',{name:'舞台配队',exact:true}).isDisabled(),true);assert.equal(await root.getByRole('link',{name:/^舞台配队/}).count(),0);
 const href='/global/zh-CN/tools/arena/'+new URL(copied).search+'&context=previous-fixture-context';
 await page.goto(base+href);await page.waitForFunction(()=>document.querySelector('[data-arena-root]')?.getAttribute('aria-busy')==='false');
 assert.match(await root.innerText(),/舞台配队计算尚未开放/);assert.equal(await page.locator('[data-team-workspace-shell],team-draft-workbench,scoring-research-workbench').count(),0);
 await root.locator('[data-action="copy-summary"]').click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/抽歌后不能换队/);
 await page.clock.setFixedTime(new Date('2026-10-29T01:00:00Z'));await page.goto(base+href);await page.waitForFunction(()=>document.querySelector('[data-arena-root]')?.getAttribute('aria-busy')==='false');
 assert.match(await root.innerText(),/舞台条件已更新/);await root.getByRole('button',{name:'明确使用当前条件'}).click();assert.ok(!page.url().includes('regulation=r1'));
 assert.match(await root.innerText(),/当前条件/);
 await s.go('server=global-hmt&season=s1&band=1&regulation=r0');assert.match(await root.locator('.arena-calendar-detail').innerText(),/10\/27/);
 await page.clock.setFixedTime(new Date('2026-10-31T00:00:00Z'));await s.go('server=global-hmt');assert.match(await root.innerText(),/新条件尚未收录/);assert.match(await root.innerText(),/上一期（已过期）/);
 await s.go('',true);assert.match(await root.innerText(),/请选择乐队/);
 for(const [query,text] of [['season=unknown','该赛季资料未收录'],['band=unknown','该乐队资料未收录'],['regulation=unknown','该条件未收录']]){await s.go(query);assert.match(await root.innerText(),new RegExp(text));}
 await page.clock.setFixedTime(new Date(arenaNow));await s.go('server=global-kr&band=1',true);assert.match(await root.innerText(),/此账号区服的舞台适用范围尚未确认/);
 await s.go('server=global-hmt&season=s1&band=2');await page.locator('.context-switcher summary').click();await page.locator('.context-switcher a[lang="en"]').click();await page.waitForFunction(()=>document.querySelector('[data-arena-root]')?.getAttribute('aria-busy')==='false');assert.equal(new URL(page.url()).searchParams.get('band'),'2');assert.match(await root.innerText(),/Gekisou Arena/);
 await s.go('server=global-hmt');s.offline();await root.locator('[data-action="refresh"]').click();await page.waitForFunction(()=>document.querySelector('[data-arena-feedback]').textContent.includes('未能检查更新'));assert.match(await root.innerText(),/ALL／全属性/);
 assert.equal(s.errors.length,0,s.errors.join('\n'));
 const storage=await page.evaluate(()=>globalThis.arenaStorageAccess);assert.ok(!storage.some(([,key])=>/inventory|growth|team|preset/.test(key)),'no personal card or team access');
 assert.ok(!s.requests.some(url=>/workers\/|formal-scoring|\/api\/growth-export\/(read|login)/.test(url)),'no calculation or login requests');
 results.push('viewports, compact mission summary, keyboard, AP, history, copy, handoff, rotation, offline, no personal side effects');await s.context.close();
 const live=await setup();await live.go('server=global-hmt');
 await live.page.clock.fastForward(Date.parse('2026-10-29T00:00:00Z')-arenaNow+2);
 assert.match(await live.root.innerText(),/10\/30/);assert.match(await live.root.innerText(),/舞台条件已更新/);
 live.changed();await live.root.locator('[data-action="refresh"]').click();await live.page.waitForFunction(()=>document.querySelector('[data-arena-feedback]').textContent.includes('有新资料'));
 assert.match(await live.root.innerText(),/10\/30/);await live.context.close();results.push('automatic boundary and immutable pointer update');
 const resetAt=Date.parse('2026-10-28T19:00:00Z');
 const daily=await setup({mutate:d=>{d.regulations[1].validUntil=new Date(resetAt).toISOString();d.regulations[2].validFrom=new Date(resetAt).toISOString();}});
 await daily.go('server=global-hmt');await daily.page.clock.fastForward(resetAt-arenaNow+2);
 assert.equal(await daily.root.locator('.arena-segments').getAttribute('data-missions'),'2,2,2');
 assert.match(await daily.root.locator('.arena-condition [data-valid-until]').innerText(),/10\/30/);
 await daily.context.close();
 const gap=await setup({mutate:d=>{d.regulations[1].validUntil=new Date(resetAt).toISOString();d.regulations.splice(2,1);}});
 await gap.go('server=global-hmt');await gap.page.clock.fastForward(resetAt-arenaNow+2);
 assert.match(await gap.root.innerText(),/新条件尚未收录/);assert.equal(await gap.root.locator('.arena-condition .arena-segments').count(),0);
 await gap.context.close();results.push('Beijing 03:00 same-value turnover and missing-successor fail closed');
 const zoom=await setup({scale:2});await zoom.page.setViewportSize({width:640,height:500});await zoom.go('server=global-hmt');assert.equal(await zoom.page.evaluate(()=>devicePixelRatio),2);assert.ok(await zoom.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'200% equivalent reflow');await zoom.page.clock.runFor(500);await zoom.page.screenshot({path:resolve(output,'zoom-200-equivalent.png'),fullPage:true});await zoom.context.close();results.push('200% equivalent reflow (640 CSS pixels at 2x scale)');
 const loading=await setup({blockArtifact:true});await loading.page.goto(base+'/global/zh-CN/arena/');await loading.root.waitFor();assert.equal(await loading.root.getAttribute('aria-busy'),'true');assert.match(await loading.root.innerText(),/正在读取舞台条件/);loading.releaseArtifact();await loading.page.waitForFunction(()=>document.querySelector('[data-arena-root]')?.getAttribute('aria-busy')==='false');await loading.context.close();results.push('real loading placeholder');
 for(const scenario of [{missing:true},{corrupt:true},{mutate:d=>{d.capabilities.conditions=false;d.timeZone=null;d.timeSemanticsVersion=null;}},{mutate:d=>d.regulations.push({...d.regulations[1],id:'overlap'})},{region:'jp',locale:'en'}]){
  const x=await setup(scenario);await x.go(scenario.mutate?'season=s1':'');
  const text=await x.root.innerText();assert.ok(scenario.missing?/舞台资料暂未提供/.test(text):scenario.corrupt?/读取或校验失败/.test(text):scenario.region==='jp'?/Gekisou Arena/.test(text):/尚未核验|重叠冲突/.test(text),JSON.stringify(scenario)+' '+text.slice(0,800));
  assert.equal(x.errors.length,0,x.errors.join('\n'));await x.context.close();
 }
 const rail=await setup({mutate:d=>{for(let i=3;i<=5;i++){d.leagues.push({id:'league-'+i,bandId:String(i),name:'已公布乐队 '+i,openingSourceText:''});d.regulations.push({...d.regulations[1],id:'band-condition-'+i,leagueId:'league-'+i,attribute:i===5?0:99,missions:[1,2,3]});}}});
 await rail.page.setViewportSize({width:320,height:1000});await rail.go('server=global-hmt');await rail.root.locator('[data-action="band"][data-value="5"]').click();assert.equal(await rail.root.locator('[data-action="band"][data-value="5"]').getAttribute('aria-pressed'),'true');assert.ok(await rail.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await rail.context.close();
 results.push('compact band summaries and five-band mobile rail');
 const ranked=await setup({rankings:true});await ranked.go('server=global-hmt&season=s1&band=1');
 const leaderboard=ranked.root.locator('[data-arena-rankings]');await ranked.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]')?.dataset.rankingState==='available');
 assert.equal(await ranked.root.locator('[data-field="rank-min"],[data-field="rank-max"]').count(),0);
 assert.match(await ranked.root.locator('[data-arena-population]').innerText(),/尚未完成服务器探测/);
 await leaderboard.scrollIntoViewIfNeeded();
 const stickyGeometry=await ranked.page.evaluate(()=>({band:document.querySelector('.arena-band-rail').getBoundingClientRect().top,header:document.querySelector('.site-header').getBoundingClientRect().bottom}));
 assert.ok(Math.abs(stickyGeometry.band-stickyGeometry.header)<3,JSON.stringify(stickyGeometry));
 assert.equal(await leaderboard.locator('.arena-ranking-list li').count(),10);assert.match(await leaderboard.innerText(),/<script>escaped player<\/script>/);assert.equal(await leaderboard.locator('script').count(),0);
 await leaderboard.locator('.arena-ranking-player>summary').first().click();
 assert.equal(await leaderboard.locator('.arena-deck-slots>section').count(),5);assert.match(await leaderboard.innerText(),/不一定是获得当前积分时使用的队伍/);
 for(const width of [320,390,768,1280]){await ranked.page.setViewportSize({width,height:1000});await ranked.page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);}
 await leaderboard.locator('.arena-ranking-player>summary').first().click();
 await leaderboard.getByRole('button',{name:'查看更多排名'}).click();await ranked.page.waitForFunction(()=>document.querySelectorAll('.arena-ranking-list li').length===20);assert.ok(await leaderboard.locator('[data-player-rank="11"] summary').evaluate(el=>el===document.activeElement));
 await leaderboard.getByRole('button',{name:'刷新榜单'}).click();await ranked.page.waitForFunction(()=>document.querySelectorAll('.arena-ranking-list li').length===10);
 ranked.rankingChanged();await leaderboard.getByRole('button',{name:'查看更多排名'}).click();await ranked.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]').dataset.rankingState==='changed');assert.equal(await leaderboard.locator('li').count(),0);
 ranked.holdRanking();await leaderboard.getByRole('button',{name:'刷新榜单'}).click();await ranked.root.locator('[data-action="band"][data-value="2"]').click();assert.equal(await leaderboard.locator('li').count(),0);ranked.releaseRanking();
 await ranked.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]').dataset.rankingState==='not-collected');assert.equal(await leaderboard.locator('li').count(),0);
 await ranked.root.locator('[data-action="band"][data-value="1"]').click();await ranked.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]').dataset.rankingState==='available');
 for(const width of [320,390,768,1280]){await ranked.page.setViewportSize({width,height:1000});await ranked.page.clock.runFor(200);await ranked.page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);}
 await ranked.root.locator('[data-field="season"]').selectOption('s2');await ranked.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]').dataset.rankingState==='not-collected');
 await ranked.go('server=global-kr&season=s1&band=1');await ranked.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]').dataset.rankingState==='not-collected');assert.equal(await leaderboard.locator('li').count(),0);
 assert.equal(ranked.errors.length,0,ranked.errors.join('\n'));await ranked.context.close();
 const automatic=await setup({rankings:true,autoRankings:true,rankingPages:4});await automatic.go('server=global-hmt&season=s1&band=1');
 const autoList=automatic.root.locator('.arena-ranking-list');await automatic.page.waitForFunction(()=>document.querySelectorAll('.arena-ranking-list>li').length===10);
 await autoList.locator('.arena-ranking-player>summary').first().click();const retained=await autoList.locator('.arena-ranking-player').first().elementHandle();
 automatic.holdRanking();await automatic.root.locator('[data-ranking-sentinel]').scrollIntoViewIfNeeded();
 await automatic.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]').getAttribute('aria-busy')==='true');
 const anchor=await autoList.locator('li').nth(9).boundingBox();automatic.releaseRanking();await automatic.page.waitForFunction(()=>document.querySelectorAll('.arena-ranking-list>li').length===20);
 assert.ok(await retained.evaluate(el=>el.isConnected&&el.open));const after=await autoList.locator('li').nth(9).boundingBox();assert.ok(Math.abs(anchor.y-after.y)<2,'paging changed the reading position');
 await automatic.root.locator('[data-action="band"][data-value="2"]').click();await automatic.page.waitForFunction(()=>document.querySelector('[data-arena-rankings]').dataset.rankingState==='not-collected');
 assert.equal(await autoList.count(),0);assert.equal(automatic.errors.length,0,automatic.errors.join('\n'));await automatic.context.close();results.push('automatic scroll paging preserves expanded teams and reading position, then clears on scope change');
 results.push('player rankings: exact server/season/band, delayed responses, snapshot pagination, missing data, escaped names, responsive layout');
 for(const population of ['available','stale','mismatch']){
  const counts=await setup({population,rankings:true});await counts.go('server=global-hmt&season=s1&band=1');
  const stats=counts.root.locator('[data-arena-population]');await counts.page.waitForFunction(()=>document.querySelector('[data-arena-population]')?.textContent.includes('探测时段')||document.querySelector('[data-arena-population]')?.textContent.includes('未匹配'));
  assert.match(await stats.innerText(),population==='mismatch'?/未匹配/:/≈ 2,000/);
  if(population==='stale')assert.match(await stats.innerText(),/已过期/);
  if(population!=='mismatch'){assert.match(await stats.innerText(),/40.0%/);assert.equal(await stats.locator('[role=img]').count(),1);}else assert.equal(await stats.locator('[role=img]').count(),0);
  await counts.root.locator('[data-action="band"][data-value="2"]').click();await counts.page.waitForFunction(()=>document.querySelector('[data-arena-population]')?.textContent.includes('尚未完成服务器探测'));
  assert.ok(!(await stats.innerText()).includes('2,000'));assert.equal(counts.errors.length,0);await counts.context.close();
 }
 results.push('population aggregates: estimate labels, expired and mismatched versions, no game reads, scope clears');
 const dynamicLookup=await setup({dynamic:true});await dynamicLookup.go('server=global-hmt&season=s1&band=1&rank=10001&end=10100');
 await dynamicLookup.page.waitForFunction(()=>document.querySelector('.arena-ranking-list>li')?.dataset.playerRank==='10001');
 assert.match(await dynamicLookup.root.innerText(),/官方最大名次 31,279/);assert.match(await dynamicLookup.root.innerText(),/5 分钟缓存/);
 await dynamicLookup.root.locator('[data-action="ranking-more"]').click();await dynamicLookup.page.waitForFunction(()=>document.querySelectorAll('.arena-ranking-list>li').length===100);
 dynamicLookup.rankingChanged();await dynamicLookup.page.clock.runFor(60050);await dynamicLookup.page.waitForFunction(()=>document.querySelector('.arena-player-name')?.textContent==='Updated player');assert.equal(await dynamicLookup.root.locator('.arena-ranking-list>li').count(),100);
 await dynamicLookup.root.locator('[data-arena-rank-form] input[name=rank]').fill('15001');await dynamicLookup.root.locator('[data-arena-rank-form] input[name=end]').fill('15100');await dynamicLookup.root.locator('[data-arena-rank-form] button[type=submit]').click();await dynamicLookup.page.waitForFunction(()=>document.querySelector('.arena-ranking-list>li')?.dataset.playerRank==='15001');assert.equal(new URL(dynamicLookup.page.url()).searchParams.get('rank'),'15001');
 const rankRequestsBefore=dynamicLookup.requests.filter(url=>url.includes('arena-rankings-live')).length;
 await dynamicLookup.root.locator('[name=end]').fill('15101');await dynamicLookup.root.locator('[data-arena-rank-form] button[type=submit]').click();
 assert.match(await dynamicLookup.root.locator('[name=end]').evaluate(el=>el.validationMessage),/100/);
 assert.equal(dynamicLookup.requests.filter(url=>url.includes('arena-rankings-live')).length,rankRequestsBefore);
 await dynamicLookup.root.locator('[data-action="band"][data-value="2"]').click();assert.equal(new URL(dynamicLookup.page.url()).searchParams.has('rank'),false);
 await dynamicLookup.root.locator('[data-action="band"][data-value="1"]').click();
 let personalReads=0,personalServer='global-hmt',personalRelease=null;
 await dynamicLookup.page.route('**/api/growth-export/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('/capabilities/'))return route.fulfill({json:{enabled:true,serverId:personalServer,arenaPersonal:true,nonce:'synthetic-nonce'}});
  if(!url.pathname.endsWith('/arena-rank/'))return route.continue();
  const body=route.request().postDataJSON();personalReads++;assert.equal(body.serverId,'global-hmt');assert.equal(body.seasonId,'s1');assert.equal(body.bandId,'1');assert.equal(body.account,'synthetic@example.invalid');
  if(personalRelease)await personalRelease;
  return route.fulfill({json:{snapshot:{format:'otonote-arena-personal',schemaVersion:1,source:{serverId:body.serverId,edition:'global',clientVersion:'1.1.0',masterVersion:null},seasonId:body.seasonId,bandId:body.bandId,queriedAt:new Date(arenaNow).toISOString(),status:'ranked',rank:15001,point:4}}});
 });
 const personalDialog=dynamicLookup.root.locator('[data-arena-personal-dialog]');
 await dynamicLookup.root.locator('[data-action="my-rank"]').click();await personalDialog.locator('[data-personal-form] button').waitFor();
 await dynamicLookup.page.waitForFunction(()=>!document.querySelector('[data-personal-form] fieldset').disabled);
 await personalDialog.locator('[name=account]').fill('synthetic@example.invalid');await personalDialog.locator('[name=password]').fill('synthetic-secret');
 await personalDialog.locator('button[type=submit]').click();await personalDialog.locator('.arena-personal-result').waitFor();
 assert.match(await personalDialog.innerText(),/15,001/);assert.match(await personalDialog.innerText(),/待核验/);assert.equal(personalReads,1);assert.equal(await personalDialog.locator('[type=password]').count(),0);
 await dynamicLookup.page.clock.runFor(60050);assert.equal(personalReads,1);
 await personalDialog.locator('[data-personal-close]').click();await dynamicLookup.page.clock.runFor(50);assert.equal(await personalDialog.locator('.arena-personal-result').count(),0);
 await dynamicLookup.page.waitForFunction(()=>document.querySelector('[data-action="my-rank"]')===document.activeElement);
 const stores=await dynamicLookup.page.evaluate(()=>({local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage)}));assert.ok(!JSON.stringify(stores).includes('synthetic-secret'));assert.ok(!JSON.stringify(stores).includes('15001'));
 await dynamicLookup.root.locator('[data-action="my-rank"]').click();await dynamicLookup.page.waitForFunction(()=>!document.querySelector('[data-personal-form] fieldset').disabled);
 await personalDialog.locator('[data-personal-close]').click();await dynamicLookup.page.clock.runFor(50);
 await dynamicLookup.root.locator('[data-field="server"]').selectOption('global-kr');assert.equal(await personalDialog.locator('.arena-personal-result').count(),0);assert.equal(personalReads,1);
 assert.equal(dynamicLookup.errors.length,0,dynamicLookup.errors.join('\n'));await dynamicLookup.context.close();results.push('dynamic rank lookup beyond 1000, shared-cache copy, visible minute checks retaining loaded count, rank URL and scope reset');
 results.push('old content, integrity failure, unverified time, overlap, JP English');
 console.log(JSON.stringify({passed:results,screenshots:output},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
