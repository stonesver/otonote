import test from 'node:test';
import assert from 'node:assert/strict';
import {arenaContext,arenaBandPreviews,arenaParams} from '../src/lib/arena-context.mjs';
import {arenaDeckTrend} from '../src/lib/arena-trends.mjs';
import {arenaTrendView} from '../src/lib/arena-trend-view.mjs';
import {arenaFixture,arenaNow as now,arenaTrendFixture} from './fixtures/arena.mjs';
const context=(d,q='server=global-hmt')=>arenaContext(d,q,{now});
test('band summaries resolve independently of the chosen band or historical detail row',()=>{
 const d=arenaFixture(),previews=arenaBandPreviews(d,'server=global-hmt&band=1&regulation=r0',{now});
 assert.equal(previews[0].condition.id,'r1');assert.equal(previews[1].condition.attribute,1);assert.deepEqual(previews[1].condition.missions,[3,0,1]);
 d.regulations.push({...d.regulations[1],id:'overlap'});assert.equal(arenaBandPreviews(d,'',{now})[0].condition,null);
 const end=Date.parse('2026-10-29T00:00:00Z');assert.equal(arenaBandPreviews(arenaFixture(),'',{now:end})[0].condition.id,'r2');
});
test('official trends require exact server, season, band and song scope',()=>{
 const d=arenaTrendFixture();const c=context(d);
 assert.equal(arenaDeckTrend(d,c,null,{now}).status,'select-song');assert.equal(arenaDeckTrend(d,context(d,''),'100001',{now}).status,'select-server');
 assert.equal(arenaDeckTrend(d,c,'100001',{now}).status,'available');
 for(const q of ['server=global-kr','server=global-hmt&band=2','server=global-hmt&season=s2'])assert.equal(arenaDeckTrend(d,context(d,q),'100001',{now}).status,'not-collected');
 assert.equal(arenaDeckTrend(d,c,'999',{now}).status,'not-collected');
 assert.equal(arenaParams(context(d,'server=global-hmt&music=100001')).get('music'),'100001');
});
test('unknown, malformed, verified-empty and old-condition observations remain distinct',()=>{
 const d=arenaTrendFixture(),c=context(d);d.deckTrends[0].observedAt='2026-10-27T00:00:00Z';
 assert.equal(arenaDeckTrend(d,c,'100001',{now}).period,'before-period');
 d.deckTrends[0].leaders=[];d.deckTrends[0].members=[];d.deckTrends[0].supports=[];assert.equal(arenaDeckTrend(d,c,'100001',{now}).status,'empty');
 d.deckTrends[0].source='unknown';assert.equal(arenaDeckTrend(d,c,'100001',{now}).status,'invalid');
 delete d.capabilities.deckTrends;assert.equal(arenaDeckTrend(d,c,'100001',{now}).status,'not-collected');assert.equal(arenaDeckTrend(d,c,null,{now}).status,'not-collected');
});
test('unknown cards remain in official order without inventing percentages or pairing links',()=>{
 const d=arenaTrendFixture(),c=context(d),t=(zh)=>zh;
 const html=arenaTrendView({data:d,context:c,musicId:'100001',visuals:{songs:[],members:[],supports:[]},t,base:'/global/zh-CN/',time:x=>x,now});
 assert.match(html,/官方配对趋势/);assert.match(html,/成员卡 #2/);assert.match(html,/留影 #1/);assert.match(html,/不表示一一配对/);assert.ok(!html.includes('%'));
 d.deckTrends[0].members=['<script>'];assert.equal(arenaDeckTrend(d,c,'100001',{now}).status,'invalid');
 d.deckTrends={};assert.doesNotThrow(()=>arenaTrendView({data:d,context:c,musicId:'100001',visuals:{songs:[]},t,base:'/global/zh-CN/',time:x=>x,now}));
});
test('compact trend panel previews one category, expands in official order and labels Beijing time',()=>{
 const d=arenaTrendFixture(),c=context(d),t=zh=>zh;
 d.deckTrends[0].members=['1','2','3','4','5','6','7'];
 const options={data:d,context:c,musicId:'100001',visuals:{songs:[],members:[],supports:[]},t,base:'/global/zh-CN/',time:x=>x,now,compact:true,kind:'members'};
 const preview=arenaTrendView(options),full=arenaTrendView({...options,expanded:true});
 assert.equal((preview.match(/class="arena-trend-group"/g)??[]).length,1);
 assert.equal((preview.match(/class="arena-trend-card"/g)??[]).length,6);
 assert.equal((full.match(/class="arena-trend-card"/g)??[]).length,7);
 assert.match(preview,/查看完整趋势/);assert.match(preview,/北京时间/);assert.ok(!full.includes('收起列表'));
 assert.match(arenaTrendView({...options,expanded:true,modal:true}),/arena-dialog-trends-title/);
});
