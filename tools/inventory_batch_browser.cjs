const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const base=process.env.INVENTORY_BROWSER_URL||'http://127.0.0.1:4398';
const key='ournotes:personal-growth:global:global-hmt';
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
 try{await fs.mkdir('output/playwright',{recursive:true});for(const width of [1280,390,320]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto(base+'/global/zh-CN/tools/deck-builder/?server=global-hmt');
   await page.getByRole('button',{name:'卡库与队伍',exact:true}).click();await page.getByRole('tab',{name:'卡库',exact:true}).click();
   const root=page.locator('#tw-inventory'),btn=name=>root.getByRole('button',{name,exact:true}),cards=root.locator('.tw-inventory-card'),checks=root.locator('[data-batch-card]'),form=root.locator('.tw-batch-form');
   const read=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
   await root.locator('[data-batch-entry]').click();await btn('选择本页').click();assert.equal(await checks.filter({visible:true}).count(),24);assert.equal(await root.locator('[data-batch-card]:checked').count(),24);await btn('清空').click();assert.equal(await root.locator('[data-batch-card]:checked').count(),0);
   const first=await cards.first().getAttribute('data-card-id');await cards.first().locator('.tw-card-view').click();assert.equal(await checks.first().isChecked(),true);
   assert.equal(await root.locator('[data-inventory-edit]').count(),0,'batch mode must not open an inline card editor');
   assert.equal(await checks.first().evaluate(n=>getComputedStyle(n).padding),'0px','selection check has no inherited input padding');
   await cards.first().locator('.tw-card-select').click();assert.equal(await checks.first().isChecked(),false);await cards.first().locator('.tw-card-select').click();assert.equal(await checks.first().isChecked(),true);assert.equal(await cards.count(),24);assert.equal(await root.locator('.tw-growth-editor').count(),0);
   await btn('设置养成').click();assert.ok(await form.isVisible());await form.getByRole('button',{name:'收起',exact:true}).click();await root.locator('[data-batch-entry]').click();assert.equal(await root.locator('[data-inventory-edit]').count(),24);await root.locator('[data-batch-entry]').click();await btn('清空').click();assert.equal(await root.locator('[data-batch-card]:checked').count(),0);assert.equal(await cards.count(),24);await checks.first().check();
   const checkColor=await checks.first().evaluate(n=>getComputedStyle(n).backgroundColor);assert.equal(checkColor,'rgb(122, 49, 85)','selected check uses the site accent');
   await checks.first().press('Space');assert.equal(await checks.first().isChecked(),false);await checks.first().press('Space');assert.equal(await checks.first().isChecked(),true);
   if(width<=600){
    assert.equal(await root.locator('.tw-inventory-list').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),2,'phone cards use two columns');
    const refine=root.locator('.tw-inventory-extra-filters');await refine.locator('summary').click();await root.locator('.tw-inventory-common-filters').getByRole('button',{name:'红赤',exact:true}).click();assert.match(await refine.locator('summary').textContent(),/1 项/);assert.match(await root.locator('.tw-batch-tools strong').textContent(),/1/);await btn('清空筛选').click();await refine.locator('summary').click();assert.equal(await checks.first().isChecked(),true);
   }
   await btn('下一页').click();const second=await checks.first().getAttribute('data-batch-card');await checks.first().check();
   await btn('留影').click();const support=await checks.first().getAttribute('data-batch-card');await checks.first().check();
   await btn('只看已选').click();assert.equal(await cards.count(),3);assert.equal(await checks.filter({visible:true}).count(),3);
   assert.match(await root.locator('.tw-batch-tools strong').textContent(),/3/);
   await page.screenshot({path:`output/playwright/inventory-selected-${width}.png`});
   await btn('设置养成').click();await form.getByRole('combobox').selectOption('custom');await form.locator('[data-batch-field=level]').fill('99999');await form.locator('[data-batch-save]').click();assert.match(await form.locator('.tw-batch-message').textContent(),/level|等级/);assert.equal(await read(),null,'invalid batch writes nothing');
   await form.locator('[data-batch-field=level]').fill('2');await page.screenshot({path:`output/playwright/inventory-growth-${width}.png`});
   assert.equal(await root.evaluate(n=>n.scrollWidth>n.clientWidth),false,'no horizontal overflow');
   await form.locator('[data-batch-save]').click();const saved=await read();assert.equal(saved.inventory.memberCardIds.length,2);assert.equal(saved.inventory.supportCardIds.length,1);for(const id of [first,second,support])assert.equal(saved.inventory.growth[id].level,2);
   await btn('撤销上次修改').click();const undone=await read();assert.ok(!undone||!undone.inventory.memberCardIds.length,'one undo restores the entire batch');
   await btn('成员卡').click();await checks.first().check();await btn('设置养成').click();await form.getByRole('combobox').selectOption('custom');await form.locator('[data-batch-field=level]').fill('3');await form.locator('[data-batch-save]').click();
   await btn('全部卡片').click();await checks.first().check();await checks.nth(1).check();await btn('设置养成').click();await form.getByRole('combobox').selectOption('minimum');await form.locator('[data-batch-save]').click();assert.equal((await read()).inventory.growth[first].level,3,'recorded growth preserved by default');
   // A competing tab must not be silently overwritten by a prepared batch.
   await checks.nth(2).check();await btn('设置养成').click();await form.getByRole('combobox').selectOption('minimum');
   const before=await read(),other=await context.newPage();await other.goto(base+'/global/zh-CN/tools/deck-builder/?server=global-hmt');await other.evaluate(({key,id})=>{const p=JSON.parse(localStorage.getItem(key));p.inventory.growth[id].level=2;localStorage.setItem(key,JSON.stringify(p));},{key,id:first});await other.close();
   await form.locator('[data-batch-save]').click();assert.match(await form.locator('.tw-batch-message').textContent(),/卡库已变化/);assert.equal((await read()).inventory.memberCardIds.length,before.inventory.memberCardIds.length);assert.match(await root.locator('.tw-batch-tools strong').textContent(),/1/);
   await form.getByRole('button',{name:'收起',exact:true}).click();await btn('设置养成').click();await form.locator('.tw-batch-overwrite input').check();await form.locator('[data-batch-save]').click();assert.equal((await read()).inventory.memberCardIds.length,3);
   await checks.first().check();await btn('设置养成').click();await form.getByRole('combobox').selectOption('minimum');await form.locator('.tw-batch-overwrite input').check();await form.locator('[data-batch-save]').click();assert.equal((await read()).inventory.growth[first].level,1,'explicit overwrite works');
   // Continuous entry keeps filters and advances across a page boundary.
   await root.locator('[data-batch-entry]').click();await btn('未记录').click();
   const nextId=await cards.nth(1).getAttribute('data-card-id'),currentId=await cards.first().getAttribute('data-card-id');
   await cards.first().locator('[data-inventory-edit]').click();await root.locator('.tw-growth-editor select[name=level]').selectOption('2');await root.locator('[data-save-next]').click();assert.equal((await read()).inventory.growth[currentId].level,2);assert.equal(await root.locator(`[data-inventory-edit="${nextId}"]`).getAttribute('aria-expanded'),'true');
   await page.screenshot({path:`output/playwright/inventory-next-${width}.png`});await root.locator('.tw-growth-editor').getByRole('button',{name:'取消',exact:true}).click();
   await cards.last().locator('[data-inventory-edit]').click();await root.locator('[data-save-next]').click();assert.equal(await root.locator('.tw-growth-editor').count(),1);assert.equal(await root.locator('[data-inventory-edit][aria-expanded=true]').count(),1);
   await root.locator('.tw-growth-editor').getByRole('button',{name:'取消',exact:true}).click();
   while(await btn('下一页').isEnabled())await btn('下一页').click();await cards.last().locator('[data-inventory-edit]').click();await root.locator('[data-save-next]').click();assert.equal(await root.locator('.tw-growth-editor').count(),0);assert.ok(await page.locator('.tw-feedback').getByText('当前筛选已录入到最后一张。',{exact:true}).isVisible());
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);console.log(`PASS inventory batch / preserve / undo / conflict / save-next: ${width}px`);
  }finally{await context.close();}
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
