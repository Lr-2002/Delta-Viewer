import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('outbound review plays every camera, persists valid and invalid decisions, and saves custom reasons', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'outbound-ui-'));
  const videoFile = path.join(scratch, 'sample.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=10:d=2',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoFile]);
  const videoBytes = readFileSync(videoFile);
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{
    name: 'outbound-ui-fixture', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== '/__outbound') return next();
        response.setHeader('content-type', 'text/html');
        response.end(await server.transformIndexHtml(request.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import {OutboundReviewTasks} from '/src/components/OutboundReviewTasks.tsx';
          import {TaskCenter} from '/src/components/TaskCenter.tsx';
          import '/src/components/task-center.css'; import '/src/styles.css';
          function Harness(){const [batch,setBatch]=React.useState(null);return batch
            ? React.createElement('main',{'aria-label':'数据主工作区'},React.createElement(OutboundReviewTasks,{currentUser:{username:'reviewer1',displayName:'审核员',role:'operator'},view:'workspace',initialBatch:batch,onReturnToTasks:()=>setBatch(null)}))
            : React.createElement('section',{className:'task-center task-center-cloud',style:{margin:'20px auto'}},React.createElement(OutboundReviewTasks,{currentUser:{username:'reviewer1',displayName:'审核员',role:'operator'},onOpenReview:async value=>setBatch(value)}));}
          createRoot(document.getElementById('root')).render(React.createElement(Harness));
        </script></body></html>`));
      });
    },
  }] });
  await server.listen();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync) ?? chromium.executablePath();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror',error=>console.error('OUTBOUND_APP_PAGE_ERROR',error.message));
    await page.route('https://outbound.fixture/**', async route => {
      await page.waitForFunction(() => window.fixtureMediaAllowed === true);
      const range = route.request().headers().range;
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), videoBytes.length - 1) : videoBytes.length - 1;
      await route.fulfill({ status: match ? 206 : 200, body: videoBytes.subarray(start, end + 1), headers: {
        'content-type': 'video/mp4', 'content-length': String(end - start + 1), 'accept-ranges': 'bytes',
        'access-control-allow-origin': '*', ...(match ? { 'content-range': `bytes ${start}-${end}/${videoBytes.length}` } : {}),
      } });
    });
    await page.addInitScript(() => {
      window.fixtureMediaAllowed = location.pathname!=="/__outbound";
      window.fixtureReasonOptions = [];
      window.fixtureBatch = { id: 'star-batch', name: '星炬 11.8 幼儿园', version: 0, claim: null, total: 2,
        reviewed: 0, valid: 0, invalid: 0, rate: null, recordings: [5, 7].map((cameraCount, index) => ({
          id: `upload_fixture_00${index + 1}`, name: `录制 00${index + 1}`, decision: null,
          videos: Array.from({ length: cameraCount }, (_, segment) => ({ segment, label: `cam${segment}/video.mp4`, size: 1024, sha256: null })),
        })) };
      window.fixtureCalls = [];
      window.fixtureInvoke = async (command, args) => {
        if (command !== 'outbound_review_call') throw Error('Unexpected command ' + command);
        const input = args.input; window.fixtureCalls.push(input);
        if (input.action === 'list') return { batches: [structuredClone(window.fixtureBatch)], reasonOptions: [...window.fixtureReasonOptions] };
        if (input.action === 'video-url') {
          if(window.fixtureHoldVideo) await new Promise(resolve => { (window.fixtureVideoResolvers ||= []).push(resolve); });
          return { url: 'https://outbound.fixture/api/platform/manager-outbound/media/' + 'a'.repeat(64) };
        }
        if (input.action === 'save-reason-option') {
          if (!window.fixtureReasonOptions.includes(input.reason)) window.fixtureReasonOptions.push(input.reason);
          return { reasonOptions: [...window.fixtureReasonOptions] };
        }
        if (input.version !== window.fixtureBatch.version) throw Error('OUTBOUND_VERSION_CONFLICT');
        window.fixtureBatch.version++;
        if (input.action === 'claim') window.fixtureBatch.claim = 'reviewer1';
        if (input.action === 'release') window.fixtureBatch.claim = null;
        if (input.action === 'decide') {
          const recording = window.fixtureBatch.recordings.find(row => row.id === input.recordingId);
          recording.decision = { value: input.value, ...(input.reason ? { reason: input.reason } : {}), actor: 'reviewer1', at: new Date().toISOString() };
          const reviewed = window.fixtureBatch.recordings.filter(row => row.decision);
          window.fixtureBatch.reviewed = reviewed.length;
          window.fixtureBatch.valid = reviewed.filter(row => row.decision.value === 'valid').length;
          window.fixtureBatch.invalid = reviewed.filter(row => row.decision.value === 'invalid').length;
          window.fixtureBatch.rate = reviewed.length === window.fixtureBatch.total ? window.fixtureBatch.valid / window.fixtureBatch.total : null;
        }
        return { batch: structuredClone(window.fixtureBatch) };
      };
      if(location.pathname==="/__outbound")window.__TAURI_INTERNALS__={invoke:window.fixtureInvoke};
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__outbound`);
    assert.equal(await page.locator('video').count(),0,'task center never embeds review players');
    assert.equal(await page.getByRole('button',{name:'有效数据',exact:true}).count(),0);
    await page.getByRole('button', { name: '领取并打开' }).click();
    await page.getByRole('main',{name:'数据主工作区'}).waitFor();
    assert.equal(await page.getByRole('region',{name:'外发审核任务',exact:true}).count(),0,'claim closes task center');
    await page.waitForFunction(() => document.querySelectorAll('video').length === 5);
    assert.equal(await page.getByRole('button', { name: '有效数据' }).isDisabled(), true, 'decisions wait for every camera');
    await page.evaluate(() => { window.fixtureMediaAllowed = true; });
    await page.waitForFunction(() => [...document.querySelectorAll('video')].length === 5
      && [...document.querySelectorAll('video')].every(video => video.readyState >= 3));
    assert.equal(await page.getByRole('button', { name: '有效数据' }).isEnabled(), true);
    await page.evaluate(() => { window.fixtureMediaAllowed = false; });
    await page.getByRole('button', { name: '有效数据' }).click();
    await page.waitForFunction(() => document.querySelectorAll('video').length === 7);
    assert.equal(await page.getByRole('button', { name: '无效数据' }).isDisabled(), true, 'invalid decisions wait for every camera');
    await page.evaluate(() => { window.fixtureMediaAllowed = true; });
    await page.waitForFunction(() => [...document.querySelectorAll('video')].length === 7
      && [...document.querySelectorAll('video')].every(video => video.readyState >= 3));
    await page.getByRole('button', { name: '无效数据' }).click();
    await page.getByLabel('新增常用原因').fill('画面遮挡');
    await page.getByRole('button', { name: '保存常用项' }).click();
    await page.getByRole('button', { name: '画面遮挡' }).click();
    await page.getByRole('button', { name: '确认无效' }).click();
    await page.getByText('合格率 50%', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(input => input.action === 'video-url').length), 12);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(input => input.action === 'decide').length), 2);
    assert.deepEqual(await page.evaluate(() => window.fixtureBatch.recordings.map(row => row.decision.value)), ['valid', 'invalid']);
    assert.equal(await page.evaluate(() => window.fixtureBatch.recordings[1].decision.reason), '画面遮挡');
    assert.equal(await page.evaluate(() => window.fixtureReasonOptions.includes('画面遮挡')), true);
    assert.equal(await page.evaluate(() => document.querySelectorAll('canvas').length), 0, 'external review does not render skeletons');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.OUTBOUND_SCREENSHOT_DIR) {
      mkdirSync(process.env.OUTBOUND_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OUTBOUND_SCREENSHOT_DIR, 'desktop.png') });
    }
    await page.setViewportSize({ width: 600, height: 780 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.OUTBOUND_SCREENSHOT_DIR)
      await page.screenshot({ path: path.join(process.env.OUTBOUND_SCREENSHOT_DIR, 'narrow.png') });
    await page.evaluate(() => {
      const long=window.fixtureBatch.recordings[0];
      long.decision=null;
      long.videos=Array.from({length:56},(_,segment)=>({segment,label:`cam${Math.floor(segment/8)}/cam${Math.floor(segment/8)}-${String(segment%8).padStart(5,'0')}.mp4`,size:1024,sha256:null}));
      window.fixtureCalls=[];
    });
    await page.getByRole('button', { name: '刷新外发批次' }).click();
    await page.getByRole('button', { name: /录制 001/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('video').length === 7);
    await page.getByText('7 路原始视频 · 共 8 段', { exact:true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(x=>x.action==='video-url').length),7,'load one part per camera instead of 56 parallel players');
    await page.getByRole('button', { name: '第 8 段',exact:true }).click();
    await page.waitForFunction(() => document.querySelectorAll('video').length === 7);
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.filter(x=>x.action==='video-url').slice(-7).map(x=>x.segment)),[7,15,23,31,39,47,55],'last part of every camera stays reachable');
    await page.evaluate(()=>{window.fixtureHoldVideo=true;window.fixtureVideoResolvers=[];});
    await page.getByRole('button', { name: '第 1 段',exact:true }).click();
    await page.waitForFunction(()=>window.fixtureVideoResolvers.length===4);
    await page.getByRole('button', { name: /录制 002/ }).click();
    await page.evaluate(()=>{window.fixtureHoldVideo=false;window.fixtureVideoResolvers.forEach(resolve=>resolve());});
    await page.waitForFunction(()=>document.querySelector('.outbound-player-heading strong')?.textContent==='录制 002');
    await page.waitForFunction(()=>document.querySelectorAll('video').length===7);
    assert.equal(await page.getByRole('button',{name:'录制 002 无效'}).getAttribute('aria-pressed'),'true','late URLs cannot change the selected recording');
    // Exercise the actual App -> TaskCenter -> data workspace wiring as well
    // as the shared reviewer component. All accounts/media are isolated fixtures.
    await page.route('**/src/lib/outbound-review.ts',async route=>{
      const response=await route.fetch();const original=await response.text();
      const body=original.replace('invoke("outbound_review_call",','window.fixtureInvoke("outbound_review_call",');
      assert.notEqual(body,original);await route.fulfill({response,body});
    });
    await page.setViewportSize({width:1440,height:920});
    await page.context().clearCookies();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?machineAnnotation=present`);
    await page.waitForSelector('.auth-shell');
    await page.getByRole('button',{name:'登录工作区'}).click();
    await page.getByLabel('显示名称',{exact:true}).fill('外发夹具审核员');
    await page.getByLabel('账号',{exact:true}).fill('reviewer1');
    await page.getByLabel('密码',{exact:true}).fill('fixture-pass-1234');
    await page.getByLabel('确认密码',{exact:true}).fill('fixture-pass-1234');
    await page.getByRole('button',{name:'创建并登录',exact:true}).click();
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'数据工作区',exact:true}).click();
    await page.getByRole('button',{name:'任务中心',exact:true}).click();
    const tasks=page.getByRole('dialog',{name:'任务中心',exact:true});
    await tasks.getByRole('button',{name:'外发审核',exact:true}).click();
    assert.equal(await tasks.locator('video').count(),0);
    await tasks.getByRole('button',{name:'领取并打开',exact:true}).click();
    const workspace=page.getByRole('region',{name:'外发审核工作区',exact:true});await workspace.waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.outbound-review.is-workspace video').length===5);
    assert.equal(await tasks.count(),0,'actual task center closes after opening');
    assert.equal(await page.locator('.workspace').isVisible(),false,'local review is not shown under the outbound workspace');
    assert.equal(await workspace.locator('canvas').count(),0);
    for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      await workspace.getByRole('button',{name:'有效数据',exact:true}).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(process.env.OUTBOUND_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.OUTBOUND_SCREENSHOT_DIR,`actual-app-${viewport.width}.png`)});
    }
    await workspace.getByRole('button',{name:'返回任务中心',exact:true}).click();await tasks.waitFor();
    assert.equal(await tasks.getByRole('button',{name:'打开审核',exact:true}).count(),1);
    assert.equal(await workspace.locator('video').evaluateAll(videos=>videos.every(video=>video.paused)),true);
    await tasks.getByRole('button',{name:'打开审核',exact:true}).click();await workspace.waitFor();
    assert.equal(await tasks.count(),0);
    console.log('PASS outbound reviewer claim, five/seven camera playback, valid/invalid decisions, persistent custom reason, desktop/mobile width');
  } finally {
    await browser?.close(); await server.close(); rmSync(scratch, { recursive: true, force: true });
  }
});
