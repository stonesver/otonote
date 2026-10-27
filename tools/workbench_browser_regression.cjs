#!/usr/bin/env node
/** Run against a local preview with scoring content: node tools/workbench_browser_regression.cjs BASE_URL */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function playwright() {
  if (process.env.PLAYWRIGHT_PATH) return require(process.env.PLAYWRIGHT_PATH);
  const cache = path.join(process.env.HOME || '', '.npm', '_npx');
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const candidate = path.join(cache, entry, 'node_modules', 'playwright');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return require(candidate);
  }
  throw Error('Set PLAYWRIGHT_PATH to the installed playwright package');
}

async function checkAccount(page) {
  const dialog = page.locator('.task-account-dialog');
  await page.locator('.task-account-entry').click();
  const scope=dialog.getByRole('combobox',{name:'角色范围'}),search=dialog.getByRole('searchbox',{name:'搜索角色'});
  await scope.selectOption('all');
  assert.ok(await dialog.locator('.task-character-row:visible').count()<=5,'show at most five characters');
  const row = dialog.locator('.task-character-row').first();
  const rank = row.getByRole('spinbutton', {name:'评级', exact:true});
  assert.equal(await dialog.getByRole('spinbutton', {name:/回忆/}).count(),0,'unverified memory input must not be exposed');
  assert.ok(!/回忆/.test(await dialog.innerText()),'no memory labels or instructions');
  await rank.fill('1'); await rank.press('Tab');
  await row.getByRole('button', {name:'减少评级',exact:true}).click();
  assert.equal(await rank.inputValue(), '1', 'rank cannot fall below its lower bound');
  await row.getByRole('button', {name:'增加评级',exact:true}).click();
  assert.equal(await rank.inputValue(), '2');
  await rank.fill('20'); await rank.press('Tab');
  await dialog.getByRole('button',{name:'下一页角色'}).click();
  assert.ok(!await row.isVisible(),'pagination hides the first page');
  await dialog.getByRole('button',{name:'上一页角色'}).click();
  assert.equal(await rank.inputValue(),'20','paging retains edits');
  await rank.fill('-1');await rank.press('Tab');
  await dialog.getByRole('button',{name:'下一页角色'}).click();
  await dialog.getByRole('button',{name:'应用加成',exact:true}).click();
  assert.ok(await dialog.evaluate(n=>n.open),'invalid hidden inputs must block applying');
  assert.ok(await rank.isVisible(),'invalid character is brought back into view');
  await rank.fill('20');await rank.press('Tab');
  const name=await row.locator('strong').innerText();
  await search.fill(name);
  assert.ok(await dialog.locator('.task-character-row:visible').count()>=1);
  await dialog.getByRole('button', {name:'一键满级',exact:true}).click();
  assert.equal(await search.inputValue(),name,'batch actions preserve the character filter');
  assert.equal(await rank.inputValue(), await rank.getAttribute('max'));
  const widths = await dialog.locator('.task-character-row input').evaluateAll(inputs => inputs
    .filter(input => input.getClientRects().length).map(input => {
      const style = getComputedStyle(input), box = input.getBoundingClientRect();
      const control = input.parentElement.getBoundingClientRect();
      return {content:input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
        contained:box.left>=control.left&&box.right<=control.right};
    }));
  assert.ok(widths.length && widths.every(row => row.content >= 48 && row.contained), 'numeric values must fit visibly inside their steppers');
  assert.ok(await dialog.locator('.task-character-row .task-number-stepper button').evaluateAll(buttons=>buttons
    .filter(button=>button.getClientRects().length).every(button=>{
      const box=button.getBoundingClientRect(),control=button.parentElement.getBoundingClientRect();
      return box.left>=control.left&&box.right<=control.right;
    })), 'both stepper buttons must remain fully visible');
  assert.ok(await dialog.evaluate(n => n.scrollWidth <= n.clientWidth + 1), 'dialog must not overflow horizontally');
  await dialog.getByRole('button', {name:'应用加成',exact:true}).click();
  await page.locator('.task-account-entry').click();
  await scope.selectOption('all');
  assert.equal(await rank.inputValue(), await rank.getAttribute('max'), 'applied values survive reopening');
  await rank.fill('7'); await rank.press('Tab');
  await dialog.getByRole('button', {name:'取消',exact:true}).click();
  await page.locator('.task-account-entry').click();
  await scope.selectOption('all');
  assert.equal(await rank.inputValue(), await rank.getAttribute('max'), 'cancel does not change the calculation');
  await search.fill('no-such-character-000');
  assert.equal(await dialog.locator('.task-character-row:visible').count(),0);
  assert.ok(await dialog.locator('.task-character-empty').isVisible());
  await search.fill('');
  const band=await scope.locator('option[value^="band:"]').first().getAttribute('value');
  await scope.selectOption(band);
  assert.ok(await dialog.locator('.task-character-row:visible').count()<=5);
  await dialog.getByRole('button', {name:'取消',exact:true}).click();
}

async function main() {
  const base = new URL(process.argv[2] || 'http://127.0.0.1:4399');
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname), 'use a local preview');
  const browser = await playwright().chromium.launch({headless:true});
  try {
    for (const width of [1512,820,390,320]) {
      const page = await browser.newPage({viewport:{width,height:982}}), errors=[];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(new URL('/global/zh-CN/tools/deck-builder/?server=global-en',base).href);
      await page.locator('.team-builder-view:not([data-tool-pending])').waitFor();
      // Seed one selected member to cover the current-team filter.
      await page.evaluate(() => {
        const host=document.querySelector('team-draft-workbench');
        host.draft.slots[0].memberCardId=host.data.memberCards[0].id;host.commit();
      });
      for (const selector of ['.team-primary-goals','.team-primary-growth','.task-account-entry'])
        assert.ok(await page.locator('.ds-condition-rail '+selector).isVisible(), selector+' remains in the condition rail');
      await page.locator('.team-primary-goals').getByRole('button',{name:/^最低分/}).click();
      assert.equal(await page.locator('[data-pairing-objective]').inputValue(),'minimum_song_score');
      if(width===1512)assert.ok(await page.locator('.team-primary-goals .tool-options button').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height<=30&&n.getBoundingClientRect().width<120)),'desktop goal buttons stay compact');
      await checkAccount(page);
      await page.getByRole('button',{name:'高级设置',exact:true}).click();
      const dialog=page.locator('.task-conditions-dialog');
      assert.ok(await dialog.locator('details').evaluateAll(nodes => nodes.every(n=>n.open&&n.querySelector(':scope > summary').hidden)), 'advanced settings have no second disclosure');
      await dialog.locator('[data-performance-bias]').fill('12');
      await dialog.locator('[data-performance-bias]').press('Tab');
      await dialog.locator(':scope > header button').click();
      await page.getByRole('button',{name:'高级设置',exact:true}).click();
      assert.equal(await dialog.locator('[data-performance-bias]').inputValue(),'12');
      await dialog.locator(':scope > header button').click();
      await page.locator('[data-planning-kind]').selectOption('training');
      await page.getByRole('button',{name:'培养设置',exact:true}).click();
      assert.equal(await dialog.evaluate(n=>n.open),false,'left-panel growth settings do not open an empty advanced dialog');
      assert.ok(await page.locator('[data-planning-training-scope]').locator('..').isVisible());
      assert.deepEqual(errors,[]);
      console.log(`PASS workbench ${width}px: visible numbers, bounds, apply/cancel, persistent controls, expanded advanced settings`);
      await page.close();
    }
    for(const route of ['song-calculator','event-efficiency']) for(const width of [1512,390]) {
      const page=await browser.newPage({viewport:{width,height:982}}), errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(new URL(`/global/zh-CN/tools/${route}/?server=global-en`,base).href);
      await page.locator('.task-workbench:not([data-tool-pending])').waitFor();
      if(!await page.locator('.task-account-entry').isVisible()) {
        const advanced=page.getByRole('button',{name:'高级设置',exact:true});
        if(await advanced.isVisible())await advanced.click();
        else await page.getByRole('button',{name:'修改条件',exact:true}).click();
      }
      await checkAccount(page);
      assert.deepEqual(errors,[]);
      console.log(`PASS ${route} ${width}px: shared account controls`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
