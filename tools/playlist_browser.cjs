const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome'});
 try {
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 const base=process.env.PLAYLIST_TEST_URL || 'http://127.0.0.1:8765/site/tests/fixtures/calculation-scope.html';
 await page.goto(base);
 const score=page.locator('#score'),event=page.locator('#event');
 await score.getByRole('button',{name:'管理歌单',exact:true}).click();
 await page.getByRole('button',{name:'新建歌单',exact:true}).click();
 const editor=page.locator('.playlist-editor').first();
 await editor.getByRole('textbox',{name:'歌单名称',exact:true}).fill('浏览器常打');
 await editor.getByRole('group',{name:'测试歌曲 1',exact:true}).getByRole('button',{name:'EXPERT',exact:true}).click();
 await editor.getByRole('group',{name:'测试歌曲 2',exact:true}).getByRole('button',{name:'HARD',exact:true}).click();
 await editor.getByRole('button',{name:'创建歌单',exact:true}).click();
 await page.locator('.playlist-manager[open]').getByRole('button',{name:'用于当前计算',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#score .calculation-scope > p').textContent.includes('2 首 / 2 张'));
 const value=await score.getByRole('combobox',{name:'计算范围',exact:true}).inputValue();
 await event.getByRole('combobox',{name:'计算范围',exact:true}).selectOption(value);
 assert.match(await event.locator('.calculation-scope > p').first().textContent(),/1 首 \/ 1 张/);
 await score.getByRole('button',{name:'调整本次范围',exact:true}).click();
 await editor.getByRole('group',{name:'测试歌曲 1',exact:true}).getByRole('button',{name:'EXPERT',exact:true}).click();
 await editor.getByRole('group',{name:'测试歌曲 2',exact:true}).getByRole('button',{name:'HARD',exact:true}).click();
 await editor.getByRole('button',{name:'应用本次调整',exact:true}).click();
 await score.getByRole('button',{name:'检查计算范围',exact:true}).click();
 assert.match(await score.getAttribute('data-result'),/范围为空/);
 assert.match(await event.locator('.calculation-scope > p').first().textContent(),/1 首 \/ 1 张/);
 await page.reload();assert.match(await score.locator('.calculation-scope > p').first().textContent(),/0 首 \/ 0 张/);
 await score.getByRole('button',{name:'恢复原范围',exact:true}).click();
 assert.match(await score.locator('.calculation-scope > p').first().textContent(),/2 首 \/ 2 张/);
 await score.getByRole('button',{name:'管理歌单',exact:true}).click();
 await page.locator('.playlist-manager .playlist-more').click();
 await page.locator('.playlist-manager[open]').getByRole('button',{name:'删除歌单',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#event .calculation-scope > p').textContent.includes('已不存在'));
 await page.getByRole('dialog',{name:'我的歌单'}).getByRole('button',{name:'撤销上次删除',exact:true}).click();
 await page.getByRole('dialog',{name:'我的歌单'}).getByRole('button',{name:'关闭',exact:false}).click();
 assert.match(await event.locator('.calculation-scope > p').first().textContent(),/1 首 \/ 1 张/);

 // Empty temporary selection derived from ALL must update immediately as well.
 await score.getByRole('button',{name:'扩大到全部可用谱面',exact:true}).click();
 await score.getByRole('button',{name:'调整本次范围',exact:true}).click();
 for(let i=1;i<=3;i++)for(const difficulty of ['HARD','EXPERT'])await editor.getByRole('group',{name:`测试歌曲 ${i}`,exact:true}).getByRole('button',{name:difficulty,exact:true}).click();
 await editor.getByRole('button',{name:'应用本次调整',exact:true}).click();
 assert.match(await score.locator('.calculation-scope > p').first().textContent(),/0 首 \/ 0 张/);
 await score.getByRole('button',{name:'检查计算范围',exact:true}).click();assert.match(await score.getAttribute('data-result'),/范围为空/);
 // A carried empty range survives navigation, but a missing token cannot broaden it.
 const handed=await page.evaluate(()=>{const a=document.createElement('a');const url=new URL(location.href);url.searchParams.set('tool','event');a.href=url.href;window.scoreScope.carry(a);return a.href;});
 await page.goto(handed);assert.match(await score.locator('.calculation-scope > p').first().textContent(),/0 首 \/ 0 张/);
 await score.getByRole('button',{name:'恢复原范围',exact:true}).click();await page.reload();
 assert.match(await score.locator('.calculation-scope > p').first().textContent(),/3 首 \/ 6 张/);
 await page.goto(base+'#calculation-range=missing');await score.getByRole('button',{name:'检查计算范围',exact:true}).click();assert.match(await score.getAttribute('data-result'),/无效/);
 await score.getByRole('combobox',{name:'计算范围',exact:true}).selectOption(value);
 // Stale editor updates cannot erase a concurrent write; saving a copy can proceed.
 await score.getByRole('button',{name:'管理歌单',exact:true}).click();
 await page.locator('.playlist-manager .playlist-more').click();
 await page.locator('.playlist-manager[open]').getByRole('button',{name:'编辑／重命名'}).click();
 await editor.getByRole('textbox',{name:'歌单名称',exact:true}).fill('旧页面编辑');
 const other=await context.newPage();await other.goto(base);
 await other.evaluate(async()=>{const store=window.scoreScope.store,p=store.read().playlists[0];await store.save({...p,name:'另一页面已保存'});});
 await page.waitForFunction(()=>window.scoreScope.store.read().playlists[0].name==='另一页面已保存');
 await editor.getByRole('button',{name:'保存修改',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('[role=status]')].some(n=>n.textContent.includes('其他页面更新')));
 assert.match(await editor.getByRole('status').textContent(),/其他页面更新/);
 await editor.getByRole('button',{name:'另存为新歌单',exact:true}).click();
 await page.waitForFunction(()=>window.scoreScope.store.read().playlists.length===2);
 await other.close();
 await page.locator('.playlist-manager[open]').getByRole('button',{name:'关闭 ×',exact:true}).click();
 // Import is explicit append, even for duplicate names and IDs in a valid backup.
 await score.getByRole('button',{name:'管理歌单',exact:true}).click();
 const backup=await page.evaluate(()=>window.scoreScope.store.exportWorkspace());
 await page.getByText('备份与保存位置',{exact:true}).click();
 await page.getByLabel('导入歌单备份').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
 await page.getByRole('button',{name:'确认追加导入',exact:true}).click();
 await page.waitForFunction(()=>window.scoreScope.store.read().playlists.length===4);
 await page.getByRole('dialog',{name:'我的歌单'}).getByRole('button',{name:'关闭',exact:false}).click();
 await page.setViewportSize({width:390,height:844});
 await score.getByRole('button',{name:'管理歌单',exact:true}).click();
 await page.locator('.playlist-manager .playlist-more').first().click();
 await page.locator('.playlist-manager[open]').getByRole('button',{name:'编辑／重命名'}).first().click();
 assert.equal(await editor.isVisible(),true);
 if(process.env.PLAYLIST_SCREENSHOT)await page.screenshot({path:process.env.PLAYLIST_SCREENSHOT,fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: create / shared selection / stage intersection / temporary empty / reload / restore / delete / undo / all-to-empty / handoff / stale editor / append import / mobile dialog; no page errors');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
