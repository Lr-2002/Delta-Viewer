import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

test('data workspace ignores old model-library preferences and retains original skeleton playback and all sessions', async t => {
  const vite=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:15163}});await vite.listen();
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM,headless:true,args:['--no-sandbox']});
  t.after(async()=>{await browser.close();await vite.close();});
  const page=await browser.newPage({viewport:{width:1440,height:920}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('delta.skeleton-library.enabled','1'));
  await page.route('**/src/lib/backend.ts',async route=>{
    const response=await route.fetch();let body=await response.text();
    for(const signature of ['export async function skeletonModelLibrary(root) {','export async function loadSkeletonModel(sourcePath, revision) {']){
      assert.ok(body.includes(signature));body=body.replace(signature,signature+' throw Error("Removed model library must not be requested");');
    }
    await route.fulfill({response,body});
  });
  await page.goto(vite.resolvedUrls.local[0]+'?demoScenario=session-activation&machineAnnotation=present');
  await page.getByRole('button',{name:'离线模式',exact:false}).first().click();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'数据工作区',exact:true}).click();
  await page.locator('.quality-inspector').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.episode-item').length===3);
  await page.locator('.skeleton-canvas canvas').waitFor();
  assert.equal(await page.getByRole('button',{name:'骨架模型库',exact:true}).count(),0);
  assert.equal(await page.getByRole('checkbox',{name:'仅看有新模型'}).count(),0);
  assert.equal(await page.getByLabel('骨架模型',{exact:true}).count(),0);
  await page.getByRole('button',{name:'全局播放',exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('[aria-label="校对播放帧"]').value)>0);
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  await mkdir('artifacts/skeleton-model-library',{recursive:true});
  for(const [width,height] of [[1440,920],[960,680],[390,844]]){
    await page.setViewportSize({width,height});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:`artifacts/skeleton-model-library/workspace-${width}.png`});
  }
  assert.deepEqual(errors,[]);
});
