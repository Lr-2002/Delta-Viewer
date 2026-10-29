import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

async function fixture(t) {
  const vite = await createServer({logLevel:'error', server:{host:'127.0.0.1', port:15145, strictPort:false}});
  await vite.listen();
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM, headless:true});
  t.after(async () => { await browser.close(); await vite.close(); });
  const page = await browser.newPage({viewport:{width:960, height:680}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/lib/backend.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    const replacements = [
      ['export async function skeletonModelLibrary(root) {', `window.libraryCalls=(window.libraryCalls??0)+1; return {root:'/models',libraryId:'test',revision:'v-test',model:{id:'mhr',label:'新模型 · 1080p实验',release:'2026-10-25',experimental:true,inputResolution:{width:1920,height:1080}},relatives:window.testRelatives??['D1-Daily/2026-10-14-Fridge/Fridge_001']};`],
      ['export async function loadSkeletonModel(sourcePath, revision) {', `window.modelCalls=(window.modelCalls??0)+1; if(window.deferModel)await new Promise(resolve=>window.finishModel=resolve); if(window.modelFail)throw Error('session.json 与模型快照不匹配'); return {sourceName:'新模型 · 1080p实验',jointSource:'smpl_joints',frameCount:2,jointCount:24,frames:[]};`],
      ['export async function chooseDirectory(title) {', `if(title.includes('骨架'))return '/models';`],
    ];
    for (const [signature, replacement] of replacements) {
      assert.ok(body.includes(signature), `missing backend fixture: ${signature}`);
      body = body.replace(signature, signature + replacement);
    }
    await route.fulfill({response, body});
  });
  return {page, errors, origin:vite.resolvedUrls.local[0]};
}

test('optional model library preserves the old selection on failure and ignores late replies after directory changes', async t => {
  const {page, errors, origin} = await fixture(t);
  await page.goto(origin);
  await page.evaluate(async () => {
    const ReactModule = await import('/node_modules/.vite/deps/react.js');
    const React = ReactModule.default ?? ReactModule;
    const RD = await import('/node_modules/.vite/deps/react-dom_client.js');
    const createRoot = RD.createRoot ?? RD.default.createRoot;
    const {SkeletonModelPicker} = await import('/src/components/SkeletonModelPicker.tsx');
    document.body.innerHTML = '<div id="fixture"></div>';
    const root = createRoot(document.getElementById('fixture'));
    window.renderPicker = path => root.render(React.createElement(SkeletonModelPicker, {
      root:path, disabled:false, onLibrary:v=>window.library=v,
      onModel:v=>window.model=v, onBusy:v=>window.modelBusy=v,
    }));
    window.renderPicker(undefined);
  });
  const configure = page.getByRole('button', {name:'骨架模型库', exact:true});
  await configure.waitFor();
  assert.equal(await page.evaluate(()=>window.libraryCalls??0), 0, 'no automatic IPC before opt-in');
  await configure.click();
  await page.waitForFunction(()=>window.library?.revision==='v-test');
  assert.equal(await page.evaluate(()=>window.model), null);
  const current = 'C:\\Datasets\\Delta-D1\\D1-Daily\\2026-10-14-Fridge\\Fridge_001';
  await page.evaluate(path=>window.renderPicker(path), current);
  const select = page.getByLabel('骨架模型', {exact:true});
  await select.waitFor();
  assert.equal(await select.inputValue(), 'old');
  await select.selectOption('new');
  await page.waitForFunction(()=>window.model?.sourceName==='新模型 · 1080p实验');
  await select.selectOption('old');
  await page.waitForFunction(()=>window.model===null);
  await page.evaluate(()=>{window.modelFail=true;});
  await select.selectOption('new');
  await page.getByRole('alert').getByText(/session.json/).waitFor();
  assert.equal(await select.inputValue(), 'old');
  assert.equal(await page.evaluate(()=>window.model), null, 'identity failure keeps original model');
  const wrongBatch = current.replace('2026-10-14', '2026-10-15');
  await page.evaluate(path=>window.renderPicker(path), wrongBatch);
  await page.waitForFunction(()=>document.querySelector('option[value=new]')?.disabled===true);
  await page.evaluate(path=>window.renderPicker(path), current.toUpperCase());
  await page.waitForFunction(()=>document.querySelector('option[value=new]')?.disabled===false);
  await page.evaluate(()=>{window.modelFail=false;window.deferModel=true;});
  await select.selectOption('new');
  await page.waitForFunction(()=>typeof window.finishModel==='function');
  await page.evaluate(path=>window.renderPicker(path), wrongBatch);
  await page.waitForFunction(()=>document.querySelector('option[value=new]')?.disabled===true);
  await page.evaluate(()=>window.finishModel());
  await page.waitForFunction(()=>window.modelBusy===false);
  assert.equal(await page.evaluate(()=>window.model), null, 'late success cannot replace another record');
  assert.equal(await select.inputValue(), 'old');
  await mkdir('artifacts/skeleton-model-library', {recursive:true});
  for (const [width,height] of [[1440,920],[960,680],[390,844]]) {
    await page.setViewportSize({width,height});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), true);
    const button = await configure.boundingBox();
    assert.ok(button.width >= 90 && button.height < 45, 'configuration label stays horizontal and readable');
    await page.screenshot({path:`artifacts/skeleton-model-library/picker-${width}.png`});
  }
  assert.deepEqual(errors, []);
});

test('new-model directory filter has a clear empty state and limits select-all to visible records', async t => {
  const {page, errors, origin} = await fixture(t);
  await page.addInitScript(()=>{
    window.testRelatives=['session-activation/session-a'];
    localStorage.setItem('delta.skeleton-library.enabled', '1');
  });
  await page.goto(origin+'?demoScenario=session-activation&machineAnnotation=present');
  await page.getByRole('button', {name:'登录工作区'}).click();
  await page.getByLabel('显示名称').fill('Model Test');
  await page.locator('input[autocomplete="username"]').fill('model-test');
  await page.locator('input[type="password"]').nth(0).fill('demo-password-123');
  await page.locator('input[type="password"]').nth(1).fill('demo-password-123');
  await page.getByRole('button', {name:'创建并登录', exact:true}).click();
  await page.getByRole('navigation', {name:'工作区视图'}).waitFor();
  const acknowledgement=page.getByRole('button', {name:'知道了',exact:true});
  if(await acknowledgement.count())await acknowledgement.click();
  await page.getByRole('tab', {name:'动作片段', exact:true}).waitFor();
  const filter = page.getByRole('checkbox', {name:'仅看有新模型'});
  await filter.waitFor();
  await filter.check();
  await page.waitForFunction(()=>document.querySelectorAll('.episode-item').length===1);
  assert.match(await page.locator('.episode-item').innerText(), /session-a/);
  await page.getByRole('checkbox', {name:'全选当前目录列表'}).check();
  await page.getByText('已选 1 条', {exact:true}).waitFor();
  await filter.uncheck();
  await page.getByText('已选 0 条', {exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.episode-item').length===3);
  await page.evaluate(()=>{window.testRelatives=['another-batch/session-a'];});
  await page.getByRole('button', {name:'刷新骨架模型库', exact:true}).click();
  await filter.check();
  await page.getByText('当前列表没有新模型条目', {exact:true}).waitFor();
  await page.getByRole('button', {name:'显示全部', exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.episode-item').length===3);
  const alias = await page.evaluate(async()=>{
    const {modelEpisodeCandidate}=await import('/src/lib/skeleton-library.ts');
    return modelEpisodeCandidate('C:/data/Delta-D1/D1-Daily/renamed/Fridge_001',
      {relatives:['D1-Daily/2026-10-14-Fridge/Fridge_001']},
      {'C:/data/Delta-D1/D1-Daily/renamed':'C:/data/Delta-D1/D1-Daily/2026-10-14-Fridge'});
  });
  assert.equal(alias, true, 'confirmed batch rename retains model availability');
  assert.deepEqual(errors, []);
});
