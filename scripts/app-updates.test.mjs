import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const appVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

test('update toast floats, pauses while engaged, exits smoothly and remembers this version', async t => {
  const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
    name:'isolated-toast',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(!req.url?.startsWith('/__toast'))return next();
      res.setHeader('content-type','text/html');
      res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
        import React from 'react';import {createRoot} from 'react-dom/client';import {AppUpdates} from '/src/components/AppUpdates.tsx';import '/src/styles.css';
        window.histories=0;window.hiddenForTest=false;Object.defineProperty(document,'hidden',{get:()=>window.hiddenForTest,configurable:true});
        createRoot(document.getElementById('root')).render(React.createElement('main',{},
          React.createElement('input',{id:'review',placeholder:'动作描述'}),React.createElement('p',{id:'workspace'},'审核区位置保持固定'),
          React.createElement(AppUpdates,{version:${JSON.stringify(appVersion)},currentSummary:'编号差异提示支持忽略，更新摘要改为平滑消息通知，保留完整更新记录。',currentNotes:['改善审核提示'],busy:false,
            check:async()=>({currentVersion:${JSON.stringify(appVersion)},latestVersion:${JSON.stringify(appVersion)},available:false,ready:false,notes:null}),
            onDownload:async()=>{},onInstall:async()=>{},onViewHistory:()=>window.histories++})));
      </script></body></html>`));
    });}
  }]});await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:920}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text())});page.on('requestfailed',req=>errors.push(req.url()));
  await page.clock.install();
  const url=server.resolvedUrls.local[0]+'__toast';await page.goto(url);
  const toast=page.getByLabel('版本更新提示');await toast.waitFor();await page.clock.runFor(300);
  assert.equal(await page.locator('#review').evaluate(e=>e===document.activeElement),false,'toast does not steal focus');
  assert.equal(await toast.evaluate(e=>getComputedStyle(e).position),'fixed');
  await mkdir('artifacts/app-updates',{recursive:true});
  for(const [width,height] of [[1440,920],[960,680],[390,844]]) {
    await page.setViewportSize({width,height});
    for(const button of await toast.getByRole('button').all()){
      const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=height);
      assert.ok(await button.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=12));
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:`artifacts/app-updates/toast-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:920});
  const before=await page.locator('#workspace').boundingBox();
  await toast.hover();await page.clock.runFor(12_000);assert.equal(await toast.isVisible(),true,'hover pauses timeout');
  await toast.getByRole('button',{name:'查看完整更新记录',exact:true}).focus();
  await page.mouse.move(0,0);await page.clock.runFor(12_000);assert.equal(await toast.isVisible(),true,'keyboard focus pauses timeout');
  await page.locator('#review').focus();
  await page.evaluate(()=>{window.hiddenForTest=true;document.dispatchEvent(new Event('visibilitychange'))});
  await page.clock.runFor(12_000);assert.equal(await toast.isVisible(),true,'hidden page pauses timeout');
  await page.evaluate(()=>{window.hiddenForTest=false;document.dispatchEvent(new Event('visibilitychange'))});
  await page.clock.runFor(10_000);await page.waitForFunction(()=>document.querySelector('.update-notice-closing'));
  await page.clock.runFor(200);await toast.waitFor({state:'detached'});
  assert.deepEqual(await page.locator('#workspace').boundingBox(),before,'notification never moves review content');
  assert.equal(await page.evaluate(()=>localStorage.getItem('delta.updates.release-notes.seen')),appVersion);
  await page.reload();await page.getByRole('button',{name:'版本与更新',exact:true}).waitFor();assert.equal(await toast.count(),0,'acknowledged version stays quiet');
  await page.evaluate(()=>localStorage.removeItem('delta.updates.release-notes.seen'));await page.reload();await toast.waitFor();
  await toast.getByRole('button',{name:'查看完整更新记录',exact:true}).click();await page.clock.runFor(200);await page.waitForFunction(()=>window.histories===1);
  await page.evaluate(()=>localStorage.removeItem('delta.updates.release-notes.seen'));await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await toast.waitFor();
  assert.equal(await toast.evaluate(e=>getComputedStyle(e).animationName),'none');
  await toast.getByRole('button',{name:'关闭更新提示',exact:true}).click();await page.clock.runFor(200);await toast.waitFor({state:'detached'});
  assert.deepEqual(errors,[]);
});

test('updates check in background, require download/install consent and retain work on failure', async t => {
  const server = await createServer({logLevel:'error', server:{host:'127.0.0.1',port:0}, plugins:[{
    name:'isolated-updates', configureServer(server) {
      server.middlewares.use(async(req,res,next)=>{
        if (!req.url?.startsWith('/__updates')) return next();
        res.setHeader('content-type','text/html');
        res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
          import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
          import {AppUpdates} from '/src/components/AppUpdates.tsx'; import '/src/styles.css';
          window.downloads=0;window.installs=0;window.saved=0;window.histories=0;window.fail='';window.releaseReady=false;const mode=new URLSearchParams(location.search).get('mode');
          window.checks=0;window.deferCheck=true;window.cached=mode==='cached';if(mode==='failed')window.fail='check';
          async function check(){window.checks++;if(window.deferCheck)await new Promise(resolve=>window.finishCheck=resolve);if(window.fail==='check')throw Error('HTTP 503');return {currentVersion:'1.0.63',latestVersion:'1.0.64',available:true,ready:window.cached,notes:'- 改善回放体验。\\n- 修复审核问题。',publishedAt:'2026-10-15T00:00:00Z'};}
          function App(){const [busy,setBusy]=useState(false);window.setBusy=setBusy;return React.createElement('main',{},
            React.createElement('p',{id:'data'},'数据已加载，审核可以继续'),
            React.createElement(AppUpdates,{version:'1.0.63',currentSummary:'更新改从 GitHub 正式 Release 获取。',currentNotes:['后台检查','主动下载'],busy,check,
              onViewHistory:()=>{window.histories++}, onDownload:async()=>{window.downloads++;if(window.fail==='download')throw Error('下载中断');window.cached=true},
              onInstall:async()=>{window.saved++;if(window.fail==='save')throw Error('当前修改尚未保存');if(window.fail==='audit')throw Error('审核操作落盘失败');window.installs++;}}));}
          createRoot(document.getElementById('root')).render(React.createElement(App));
        </script></body></html>`));
      });
    }
  }]});
  t.after(()=>server.close()); await server.listen();
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});
  t.after(()=>browser.close()); const page=await browser.newPage({viewport:{width:1440,height:920}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]+'__updates');
  await page.getByText('数据已加载，审核可以继续').waitFor();
  assert.equal(await page.getByRole('dialog').count(),0,'background check does not cover loading');
  assert.equal(await page.evaluate(()=>window.downloads),0);
  await page.getByRole('button',{name:'知道了',exact:true}).click();
  await page.evaluate(()=>{window.deferCheck=false;window.finishCheck()});
  await page.getByText('新版本 v1.0.64 可用',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.downloads),0,'discovery never auto downloads');
  await page.getByRole('button',{name:'稍后提醒',exact:true}).click();
  await page.reload();await page.waitForFunction(()=>window.finishCheck);
  await page.evaluate(()=>{window.deferCheck=false;window.finishCheck()});
  await page.waitForFunction(()=>document.querySelector('.update-dot'));
  assert.equal(await page.getByLabel('版本更新提示').count(),0,'same version notices do not repeat');
  await page.getByRole('button',{name:'版本与更新',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'版本与更新详情'});
  await dialog.getByText(/改善回放体验/).waitFor();
  await page.evaluate(()=>window.setBusy(true));
  await page.waitForFunction(()=>document.querySelector('.app-update-dialog footer .button-primary')?.disabled);
  assert.equal(await dialog.getByRole('button',{name:'下载更新',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.setBusy(false);window.fail='download'});
  await page.waitForFunction(()=>document.querySelector('.app-update-dialog footer .button-primary')?.disabled===false);
  await dialog.getByRole('button',{name:'下载更新',exact:true}).click();
  await dialog.getByText(/下载中断/).waitFor();
  assert.equal(await page.evaluate(()=>window.installs),0);
  await page.evaluate(()=>window.fail='');
  await dialog.getByRole('button',{name:'下载更新',exact:true}).click();
  await dialog.getByRole('button',{name:'保存并重启更新',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.installs),0,'download never installs');
  await dialog.getByRole('button',{name:'稍后',exact:true}).click();
  await page.getByText('数据已加载，审核可以继续').waitFor();
  await page.getByRole('button',{name:'版本与更新',exact:true}).click();
  for(const failure of ['save','audit']) {
    await page.evaluate(failure=>window.fail=failure,failure);
    await dialog.getByRole('button',{name:'保存并重启更新',exact:true}).click();
    await dialog.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>window.installs),0);
  }
  await page.evaluate(()=>window.setBusy(true));
  await page.waitForFunction(()=>document.querySelector('.app-update-dialog footer .button-primary')?.disabled);
  assert.equal(await dialog.getByRole('button',{name:'保存并重启更新',exact:true}).isDisabled(),true);
  await mkdir('artifacts/app-updates',{recursive:true});
  for(const [width,height] of [[1440,920],[960,680],[390,844]]) {
    await page.setViewportSize({width,height});
    const button=dialog.getByRole('button',{name:'保存并重启更新',exact:true});
    for (const action of await dialog.locator('footer button').all()) assert.ok(await action.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=12),'all action text remains visible');
    const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:`artifacts/app-updates/ready-${width}.png`});
  }
  await page.evaluate(()=>{window.setBusy(false);window.fail=''});
  await page.waitForFunction(()=>document.querySelector('.app-update-dialog footer .button-primary')?.disabled===false);
  await dialog.getByRole('button',{name:'保存并重启更新',exact:true}).click();
  await page.waitForFunction(()=>window.installs===1);
  await dialog.getByRole('button',{name:'稍后',exact:true}).click();
  await page.goto(server.resolvedUrls.local[0]+'__updates?mode=cached');
  await page.waitForFunction(()=>window.finishCheck);await page.evaluate(()=>{window.deferCheck=false;window.finishCheck()});
  await page.getByRole('button',{name:'版本与更新',exact:true}).click();
  await dialog.getByRole('button',{name:'保存并重启更新',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.downloads),0,'verified cache survives restart without another download');
  await dialog.getByRole('button',{name:'稍后',exact:true}).click();
  await page.goto(server.resolvedUrls.local[0]+'__updates?mode=failed');
  await page.waitForFunction(()=>window.finishCheck);await page.evaluate(()=>{window.deferCheck=false;window.finishCheck()});
  await page.waitForFunction(()=>document.querySelector('.app-update-entry svg.lucide-circle-alert'));
  assert.equal(await page.getByRole('dialog').count(),0,'background failure never blocks work');
  await page.getByRole('button',{name:'版本与更新',exact:true}).click();
  await dialog.getByText(/HTTP 503/).waitFor();
  await page.evaluate(()=>window.fail='');await dialog.getByRole('button',{name:'检查更新',exact:true}).click();
  await dialog.getByRole('button',{name:'下载更新',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});

test('real workspace saves before install and audit disk failure preserves the active review', async t => {
  const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1440,height:920}});const page=await context.newPage();
  await context.addInitScript(()=>{window.failAllAudit=true;window.auditDisk=new Map();window.installCalls=0;localStorage.setItem('delta.updates.release-notes.seen','1.0.63');localStorage.setItem('delta.updates.available.notified','1.0.64')});
  await context.route('**/src/lib/review-audit.ts',async route=>{
    const response=await route.fetch();const original=await response.text();
    const body=original.replace(/from "[^"\n]*\/backend\.ts[^"\n]*"/,'from "/__update-native-audit"');assert.notEqual(body,original);await route.fulfill({response,body});
  });
  await context.route('**/__update-native-audit',route=>route.fulfill({contentType:'application/javascript',body:`
    export const isTauriRuntime=()=>true;
    export const reviewIdentityPath=async path=>path;
    export async function persistReviewAudit(username,serviceId,events){if(window.failAllAudit)throw Error('模拟审核磁盘失败');for(const e of events)window.auditDisk.set(e.eventId,e);return {pending:window.auditDisk.size,blocked:0,error:''}}
    export async function getReviewAuditQueueStatus(){return {pending:window.auditDisk.size,blocked:0,error:''}}
    export async function flushReviewAuditQueue(){return {pending:window.auditDisk.size,blocked:0,error:'offline'}}
    export async function sendReviewAudit(){throw Error('unexpected network')}
  `}));
  await context.route('**/src/lib/backend.ts',async route=>{
    const response=await route.fetch();let body=await response.text();
    body=body.replace(/(export async function checkForAppUpdate\([^]*?\) \{)/,'$1\nreturn {currentVersion:"1.0.63",latestVersion:"1.0.64",available:true,ready:true,notes:"- 测试更新",publishedAt:null};');
    body=body.replace(/(export async function installAppUpdate\([^]*?\) \{)/,'$1\nwindow.installCalls++;return false;');
    await route.fulfill({response,body});
  });
  await page.goto(server.resolvedUrls.local[0]+'?demoScenario=session-activation&machineAnnotation=present');
  if(await page.getByRole('button',{name:'登录工作区'}).count())await page.getByRole('button',{name:'登录工作区'}).click();
  await page.getByLabel('显示名称').fill('Update Test');await page.locator('input[autocomplete="username"]').fill('update-test');
  await page.locator('input[type="password"]').nth(0).fill('demo-password-123');await page.locator('input[type="password"]').nth(1).fill('demo-password-123');
  await page.getByRole('button',{name:'创建并登录'}).click();
  await page.getByRole('navigation',{name:'工作区视图'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.disabled===false);
  await page.getByRole('button',{name:'版本与更新',exact:true}).click();const dialog=page.getByRole('dialog',{name:'版本与更新详情'});
  await dialog.getByRole('button',{name:'保存并重启更新',exact:true}).click();
  await dialog.getByText(/模拟审核磁盘失败/).waitFor();assert.equal(await page.evaluate(()=>window.installCalls),0);
  assert.equal(await page.getByRole('navigation',{name:'工作区视图'}).count(),1);
  await page.evaluate(()=>window.failAllAudit=false);
  await dialog.getByRole('button',{name:'稍后',exact:true}).click();
  await page.getByLabel('复核动作描述').fill('更新前的审核修改应保存');
  await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.disabled===false);
  await page.getByRole('button',{name:'版本与更新',exact:true}).click();
  await dialog.getByRole('button',{name:'保存并重启更新',exact:true}).click();await page.waitForFunction(()=>window.installCalls===1);
  const review=await page.evaluate(async()=> (await import('/src/lib/backend.ts')).loadMachineReview('demo://session-activation/session-a'));
  assert.equal(review.segments[0].description,'更新前的审核修改应保存');
  assert.ok(await page.evaluate(()=>window.auditDisk.size>0));
});


test('administrator workspace exposes the same update entry and version history', async t => {
  const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:920}});
  await page.goto(server.resolvedUrls.local[0]+'?demoScenario=operations-cockpit');
  await page.getByRole('heading',{name:'审核监管',exact:true}).waitFor();
  await page.getByRole('button',{name:'版本与更新',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'版本与更新详情'});await dialog.getByText(`当前版本 v${appVersion}`,{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'稍后',exact:true}).click();
  assert.equal(await page.getByRole('heading',{name:'审核监管',exact:true}).isVisible(),true);
});
