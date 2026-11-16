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
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=10:d=8',
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
  let browser, page;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
      window.fixtureSlowSegment=location.pathname==="/__outbound"?1:null;
      window.fixtureExtraBatches = location.pathname==="/__outbound";
      window.fixtureHoldClaim = location.pathname==="/__outbound";
      window.fixtureInvoke = async (command, args) => {
        if (command !== 'outbound_review_call') throw Error('Unexpected command ' + command);
        const input = args.input; window.fixtureCalls.push(input);
        if (input.action === 'list') {
          window.fixtureListActive=(window.fixtureListActive||0)+1;
          window.fixtureListPeak=Math.max(window.fixtureListPeak||0,window.fixtureListActive);
          try {
          if(window.fixtureHoldList)await new Promise(resolve=>window.fixtureReleaseList=resolve);
          if(window.fixtureListFails)throw Error('OUTBOUND_USER_CENTER_TIMEOUT');
          const batches=[structuredClone(window.fixtureBatch), ...(window.fixtureExtraBatches ? [1,2].map(i=>({...structuredClone(window.fixtureBatch),id:'other-'+i,name:'其他批次 '+i})) : [])]
            .filter(batch=>!input.datasetId||input.datasetId===batch.id);
          if(window.fixtureNewBatch)batches.push({...structuredClone(window.fixtureBatch),id:'new-upload',name:'新完成的星炬上传'});
          if(input.summary)for(const batch of batches)batch.recordings=[];
          return {batches,reasonOptions:[...window.fixtureReasonOptions]};
          }finally{window.fixtureListActive--;}
        }
        if (input.action === 'claim' && window.fixtureHoldClaim) await new Promise(resolve=>window.fixtureReleaseClaim=resolve);
        if (input.action === 'video-url') {
          if(input.segment===window.fixtureSlowSegment)await new Promise(resolve=>window.fixtureReleaseSlow=resolve);
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
        if(window.fixtureUncertainAction===input.action){window.fixtureUncertainAction=null;throw Error('OUTBOUND_USER_CENTER_TIMEOUT');}
        const result=structuredClone(window.fixtureBatch);
        if(input.compact)for(const recording of result.recordings)delete recording.videos;
        return { batch: result };
      };
      if(location.pathname==="/__outbound")window.__TAURI_INTERNALS__={invoke:window.fixtureInvoke};
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__outbound`);
    assert.equal(await page.locator('video').count(),0,'task center never embeds review players');
    assert.equal(await page.getByRole('button',{name:'有效数据',exact:true}).count(),0);
    await page.getByRole('button',{name:'领取并打开'}).first().waitFor();
    await page.evaluate(()=>{window.fixtureHoldList=true;window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(()=>typeof window.fixtureReleaseList==='function');
    await page.waitForTimeout(5200);
    assert.equal(await page.evaluate(()=>window.fixtureListPeak),1,'poll and focus requests never overlap');
    await page.evaluate(()=>{window.fixtureNewBatch=true;window.fixtureHoldList=false;window.fixtureReleaseList();});
    await page.getByText('新完成的星炬上传',{exact:true}).waitFor();
    await page.evaluate(()=>{window.fixtureListFails=true;window.dispatchEvent(new Event('focus'));});
    await page.getByRole('alert').filter({hasText:'响应超时'}).waitFor();
    assert.equal(await page.getByText('新完成的星炬上传',{exact:true}).isVisible(),true,'failed background refresh preserves the existing queue');
    await page.evaluate(()=>{window.fixtureListFails=false;window.fixtureNewBatch=false;window.dispatchEvent(new Event('focus'));});
    await page.getByText('新完成的星炬上传',{exact:true}).waitFor({state:'detached'});
    const initialLists=await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='list').length);
    await page.getByRole('button', { name: '领取并打开' }).first().click();
    await page.waitForFunction(()=>typeof window.fixtureReleaseClaim==='function');
    assert.equal(await page.locator('.outbound-task-actions .spin').count(),1,'only the selected batch shows progress');
    assert.equal(await page.getByRole('button',{name:'领取并打开'}).nth(1).isDisabled(),false,'unrelated batches remain actionable while this batch is pending');
    await page.evaluate(()=>{window.fixtureExtraBatches=false;window.fixtureHoldClaim=false;window.fixtureReleaseClaim();});
    await page.getByRole('main',{name:'数据主工作区'}).waitFor();
    assert.equal(await page.getByRole('region',{name:'外发审核任务',exact:true}).count(),0,'claim closes task center');
    await page.waitForFunction(()=>typeof window.fixtureReleaseSlow==='function');
    await page.waitForFunction(()=>document.querySelectorAll('video[src]').length>=3);
    assert.equal(await page.getByRole('button',{name:'有效数据'}).isDisabled(),true,'a delayed camera cannot be skipped for review');
    await page.evaluate(()=>{window.fixtureSlowSegment=null;window.fixtureReleaseSlow();});
    await page.waitForFunction(() => document.querySelectorAll('video').length === 5);
    assert.equal(await page.getByRole('button', { name: '有效数据' }).isDisabled(), true, 'decisions wait for every camera');
    await page.evaluate(() => { window.fixtureMediaAllowed = true; });
    await page.waitForFunction(() => [...document.querySelectorAll('video')].length === 5
      && [...document.querySelectorAll('video')].every(video => video.readyState >= 3));
    await page.waitForFunction(()=>!document.querySelector('.outbound-valid-button')?.disabled);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='list').length),initialLists,'workspace does not refetch every batch');
    await page.waitForTimeout(220);
    const followerClock = await page.evaluate(()=>{
      const videos=[...document.querySelectorAll('video')];
      const before=videos[0].currentTime;
      Object.defineProperty(videos[1],'currentTime',{configurable:true,get:()=>1.2,set:()=>{}});
      videos[1].dispatchEvent(new Event('timeupdate'));
      const after=videos[0].currentTime;
      delete videos[1].currentTime;
      return {before,after};
    });
    assert.equal(followerClock.after,followerClock.before,'follower clock never seeks the master');
    assert.equal(await page.locator('video').evaluateAll(videos=>videos.every(v=>!v.controls)),true,'one transport controls the complete camera group');
    await page.getByRole('button',{name:'全局播放',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.currentTime>1&&!v.paused));
    const stablePlayback=await page.evaluate(async()=>{
      const videos=[...document.querySelectorAll('video')];const follower=videos[1];
      const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
      let seeks=0;
      Object.defineProperty(follower,'currentTime',{configurable:true,get(){return descriptor.get.call(this)+.4;},set(value){seeks++;descriptor.set.call(this,value);}});
      const before=videos[0].currentTime;
      for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,230));videos[0].dispatchEvent(new Event('timeupdate'));}
      const result={seeks,advance:videos[0].currentTime-before};delete follower.currentTime;return result;
    });
    assert.equal(stablePlayback.seeks,0,'continuous clock correction must not repeatedly discard decoded frames');
    assert.ok(stablePlayback.advance>.7,'all-buffered playback continues at wall-clock speed');
    await page.evaluate(()=>{const follower=document.querySelectorAll('video')[1];Object.defineProperty(follower,'readyState',{configurable:true,get:()=>2});follower.dispatchEvent(new Event('waiting'));});
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.paused));
    await page.getByText('正在缓冲',{exact:true}).waitFor();
    await page.evaluate(()=>{delete document.querySelectorAll('video')[1].readyState;});
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>!v.paused));
    const slider=page.getByRole('slider',{name:'视频播放位置'});const sliderBox=await slider.boundingBox();
    await slider.click({position:{x:sliderBox.width*.55,y:sliderBox.height/2}});
    await page.waitForFunction(()=>{const videos=[...document.querySelectorAll('video')];return videos.every(v=>!v.paused&&!v.seeking&&v.currentTime>4)&&Math.max(...videos.map(v=>v.currentTime))-Math.min(...videos.map(v=>v.currentTime))<.15;});
    await page.getByRole('button',{name:'暂停',exact:true}).click();
    const healthyBefore=await page.locator('video').evaluateAll(videos=>videos.map(v=>({src:v.currentSrc,time:v.currentTime})));
    await page.evaluate(()=>{const v=document.querySelectorAll('video')[4];Object.defineProperty(v,'error',{configurable:true,value:{code:2}});v.dispatchEvent(new Event('error'));});
    await page.getByText('读取失败',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'有效数据'}).isDisabled(),true);
    assert.equal(await page.locator('.outbound-video-item').nth(4).getByText('已就绪',{exact:true}).count(),0,'failed camera cannot remain ready');
    await page.evaluate(()=>{const v=document.querySelectorAll('video')[4];delete v.error;v.dispatchEvent(new Event('canplay'));});
    await page.getByText('读取失败',{exact:true}).waitFor({state:'detached'});
    await page.waitForFunction(()=>!document.querySelector('.outbound-valid-button').disabled);
    await page.evaluate(()=>{const v=document.querySelectorAll('video')[4];Object.defineProperty(v,'error',{configurable:true,value:{code:2}});v.dispatchEvent(new Event('error'));});
    await page.getByRole('button',{name:'重试失败视频',exact:true}).waitFor();
    await page.evaluate(()=>{delete document.querySelectorAll('video')[4].error;});
    await page.getByRole('button',{name:'重试失败视频',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.outbound-valid-button').disabled);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='video-url').length),6,'only the failed camera requests a new ticket');
    const afterRetry=await page.locator('video').evaluateAll(videos=>videos.map(v=>({src:v.currentSrc,time:v.currentTime})));
    assert.deepEqual(afterRetry.slice(0,4),healthyBefore.slice(0,4),'healthy camera sources and positions survive recovery');
    assert.ok(Math.abs(afterRetry[4].time-healthyBefore[0].time)<.2,'retried camera resumes at the master position');
    await page.evaluate(() => { window.fixtureMediaAllowed = false; });
    await page.getByRole('button', { name: '有效数据' }).click();
    await page.waitForFunction(() => document.querySelectorAll('video').length === 7);
    assert.equal(await page.getByRole('button', { name: '无效数据' }).isDisabled(), true, 'invalid decisions wait for every camera');
    await page.evaluate(() => { window.fixtureMediaAllowed = true; });
    await page.waitForFunction(() => [...document.querySelectorAll('video')].length === 7
      && [...document.querySelectorAll('video')].every(video => video.readyState >= 3));
    const cameraSizes=await page.locator('.outbound-video-item').evaluateAll(items=>items.map(item=>({primary:item.classList.contains('is-primary'),width:item.getBoundingClientRect().width,height:item.getBoundingClientRect().height})));
    assert.equal(cameraSizes.filter(item=>item.primary).length,1);
    assert.ok(cameraSizes[0].width>cameraSizes[1].width*2,'main camera uses the original replay width ratio');
    assert.ok(cameraSizes[0].height>cameraSizes[1].height*1.8,'main camera spans both peer rows');
    await page.getByRole('button', { name: '无效数据' }).click();
    await page.getByLabel('新增常用原因').fill('画面遮挡');
    await page.getByRole('button', { name: '保存常用项' }).click();
    await page.getByRole('button', { name: '画面遮挡' }).click();
    await page.getByRole('button', { name: '确认无效' }).click();
    await page.getByText('合格率 50%', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(input => input.action === 'video-url').length), 13);
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
    await page.evaluate(()=>{
      window.fixtureBatch.recordings[0].videos=window.fixtureBatch.recordings[0].videos.filter(video=>video.segment!==48);
      window.fixtureCalls=[];
    });
    await page.getByRole('button',{name:'刷新外发批次'}).click();
    await page.getByRole('button',{name:/录制 001/}).click();
    await page.getByText('此相机没有本段源文件',{exact:true}).waitFor();
    assert.equal(await page.locator('.outbound-video-item').count(),7,'a missing part keeps its real camera slot visible');
    assert.equal(await page.locator('video').count(),6);
    assert.equal(await page.getByRole('button',{name:'有效数据'}).isDisabled(),true,'missing camera blocks decisions');
    assert.ok(!(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='video-url').map(x=>x.segment))).includes(49),'next segment must not shift into the missing first segment');
    await page.getByRole('button',{name:'第 2 段',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('video').length===7);
    assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='video-url').slice(-7).map(x=>x.segment)),[1,9,17,25,33,41,49]);
    // Camera count comes from the recording; every slot must remain usable
    // at both desktop and narrow widths, including even camera counts.
    for(const width of [1440,960,390]){
      await page.setViewportSize({width,height:920});
      for(let count=1;count<=8;count++){
        await page.evaluate(count=>{
          const recording=window.fixtureBatch.recordings[0];recording.decision=null;
          recording.videos=Array.from({length:count},(_,segment)=>({segment,label:`cam${segment}/video.mp4`,size:1024,sha256:null}));
        },count);
        await page.getByRole('button',{name:'刷新外发批次'}).click();
        await page.getByRole('button',{name:/录制 001/}).click();
        const grid=page.locator(`.outbound-video-grid.cameras-${count}`);await grid.waitFor();
        const sizes=await grid.evaluate(grid=>{const box=grid.getBoundingClientRect();return [...grid.children].map(item=>{const r=item.getBoundingClientRect();return {x:r.x-box.x,y:r.y-box.y,width:r.width,height:r.height,inside:r.x>=box.x-.5&&r.right<=box.right+.5};});});
        assert.equal(sizes.length,count);assert.ok(sizes.every(r=>r.inside&&r.width>40&&r.height>40),`${count} cameras remain visible at ${width}px`);
        for(let i=0;i<sizes.length;i++)for(let j=i+1;j<sizes.length;j++){
          const a=sizes[i],b=sizes[j];assert.ok(a.x+a.width<=b.x+.5||b.x+b.width<=a.x+.5||a.y+a.height<=b.y+.5||b.y+b.height<=a.y+.5,'camera tiles never overlap');
        }
        if(count>1)assert.ok(sizes[0].width*sizes[0].height>sizes[1].width*sizes[1].height*1.7,`primary camera remains larger: ${width}px/${count} ${JSON.stringify(sizes)}`);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        if(count===7&&process.env.OUTBOUND_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.OUTBOUND_SCREENSHOT_DIR,`seven-cameras-${width}.png`)});
      }
    }
    // The server may commit a claim and lose its response. Read authority,
    // never send the claim twice; preserve an explicit unknown state if reads fail.
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__outbound`);
    await page.getByRole('button',{name:'领取并打开'}).first().waitFor();
    await page.evaluate(()=>{window.fixtureHoldClaim=false;window.fixtureUncertainAction='claim';window.fixtureMediaAllowed=true;window.fixtureSlowSegment=null;});
    await page.getByRole('button',{name:'领取并打开'}).first().click();
    await page.getByRole('region',{name:'外发审核工作区',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='claim').length),1,'accepted but timed-out claim is reconciled without replay');
    assert.ok(await page.evaluate(()=>window.fixtureCalls.some(x=>x.action==='list'&&x.datasetId==='star-batch')));
    await page.waitForFunction(()=>!document.querySelector('.outbound-valid-button')?.disabled);
    await page.evaluate(()=>{window.fixtureUncertainAction='decide';window.fixtureListFails=true;});
    await page.getByRole('button',{name:'有效数据',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'提交结果尚未确认'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'释放批次',exact:true}).isDisabled(),true,'unknown decision result blocks further mutations');
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='decide').length),1);
    await page.evaluate(()=>window.fixtureListFails=false);
    await page.getByRole('button',{name:'刷新外发批次',exact:true}).click();
    await page.getByText(/已由 reviewer1 .* 判为有效/).waitFor();
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='decide').length),1,'read reconciliation never resubmits a conclusion');
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__outbound`);
    await page.getByRole('button',{name:'领取并打开'}).first().waitFor();
    await page.evaluate(()=>{window.fixtureHoldClaim=false;window.fixtureUncertainAction='claim';window.fixtureListFails=true;window.fixtureMediaAllowed=true;window.fixtureSlowSegment=null;});
    await page.getByRole('button',{name:'领取并打开'}).first().click();
    await page.getByRole('button',{name:'核对结果',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='claim').length),1);
    await page.evaluate(()=>window.fixtureListFails=false);
    await page.getByRole('button',{name:'核对结果',exact:true}).click();
    await page.getByRole('region',{name:'外发审核工作区',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x.action==='claim').length),1);
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
    const updateNotice=page.getByRole('button',{name:'知道了',exact:true});
    await updateNotice.waitFor({state:'visible',timeout:5000});await updateNotice.click();
    for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      await workspace.getByRole('button',{name:'有效数据',exact:true}).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(process.env.OUTBOUND_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.OUTBOUND_SCREENSHOT_DIR,`actual-app-${viewport.width}.png`)});
    }
    await workspace.getByRole('button',{name:'返回任务中心',exact:true}).click();await tasks.waitFor();
    await tasks.getByRole('button',{name:'打开审核',exact:true}).waitFor();
    assert.equal(await tasks.getByRole('button',{name:'打开审核',exact:true}).count(),1);
    assert.equal(await workspace.locator('video').evaluateAll(videos=>videos.every(video=>video.paused)),true);
    await tasks.getByRole('button',{name:'打开审核',exact:true}).click();await workspace.waitFor();
    assert.equal(await tasks.count(),0);
    console.log('PASS outbound reviewer claim, five/seven camera playback, valid/invalid decisions, persistent custom reason, desktop/mobile width');
  } finally {
    await page?.unrouteAll({behavior:'ignoreErrors'});
    await browser?.close(); await server.close(); rmSync(scratch, { recursive: true, force: true });
  }
});

test('independent batches remain interactive; latest navigation and session protocol survive delayed replies', async () => {
  const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error',plugins:[{
    name:'outbound-concurrency-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(req.url!=='/__batch_concurrency')return next();
      res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><body><div id="root"></div><script type="module">
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {OutboundReviewTasks} from '/src/components/OutboundReviewTasks.tsx';
        function Harness(){const [user,setUser]=React.useState('reviewer1'),[opened,setOpened]=React.useState('');
          window.switchReviewer=()=>setUser('reviewer2');return React.createElement(React.Fragment,null,
            React.createElement('output',{'aria-label':'打开的批次'},opened),
            React.createElement(OutboundReviewTasks,{currentUser:{username:user,role:'operator'},onOpenReview:async(batch,isCurrent)=>{
              if(window.holdNavigation===batch.id)await new Promise(resolve=>window.finishNavigation=resolve);
              if(isCurrent()){window.openedIds.push(batch.id);setOpened(batch.id);}
            }}));}
        createRoot(document.getElementById('root')).render(React.createElement(Harness));
      </script></body></html>`));
    });}
  }]});await server.listen();
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync)??chromium.executablePath();
  let browser;
  try{
    browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage();
    await page.addInitScript(()=>{
      window.openedIds=[];window.calls=[];window.holds={};window.resolvers={};
      window.rows=['a','b','c'].map(id=>({id,name:'批次 '+id,version:0,claim:id==='b'?'reviewer1':null,total:1,reviewed:0,valid:0,invalid:0,rate:null,recordings:[]}));
      window.__TAURI_INTERNALS__={invoke:async(command,{input})=>{
        if(command!=='outbound_review_call')throw Error(command);window.calls.push(structuredClone(input));
        if(window.legacy&&(input.summary||input.datasetId&&input.action==='list'||input.compact))throw Error('OUTBOUND_REQUEST_INVALID');
        if(window.failNext===input.action){window.failNext=null;throw Error('OUTBOUND_USER_CENTER_TIMEOUT');}
        if(input.action==='list')return {batches:structuredClone(window.rows.filter(row=>!input.datasetId||row.id===input.datasetId)),reasonOptions:[]};
        if(window.holds[input.datasetId])await new Promise(resolve=>window.resolvers[input.datasetId]=resolve);
        const row=window.rows.find(row=>row.id===input.datasetId);
        if(row.version!==input.version)throw Error('OUTBOUND_VERSION_CONFLICT');
        row.version++;row.claim=input.action==='claim'?'reviewer1':null;return {batch:structuredClone(row)};
      }};
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__batch_concurrency`);
    const row=id=>page.locator('article').filter({has:page.getByText('批次 '+id,{exact:true})});
    await row('a').getByRole('button',{name:'领取并打开'}).waitFor();
    await page.evaluate(()=>{window.holds.a=true;});
    await row('a').getByRole('button',{name:'领取并打开'}).dblclick();
    await page.waitForFunction(()=>Boolean(window.resolvers.a));
    assert.equal(await row('b').getByRole('button',{name:'释放批次'}).isEnabled(),true);
    await row('b').getByRole('button',{name:'释放批次'}).click();
    await row('b').getByText('已释放批次。',{exact:true}).waitFor();
    assert.equal(await row('a').getAttribute('aria-busy'),'true','unrelated release finishes while slow claim remains pending');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='claim'&&c.datasetId==='a').length),1,'same-batch double click sends one mutation');
    await row('c').getByRole('button',{name:'领取并打开'}).click();
    await page.waitForFunction(()=>document.querySelector('output').textContent==='c');
    await page.evaluate(()=>{window.holds.a=false;window.resolvers.a();});
    await row('a').getByText('已领取，可打开审核。',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.openedIds),['c'],'late first claim cannot replace latest opened batch');
    await page.evaluate(()=>{window.holdNavigation='a';});
    await row('a').getByRole('button',{name:'打开审核'}).click();
    await page.waitForFunction(()=>Boolean(window.finishNavigation));
    await row('c').getByRole('button',{name:'打开审核'}).click();
    await page.waitForFunction(()=>window.openedIds.length===2);
    await page.evaluate(()=>window.finishNavigation());
    await page.waitForFunction(()=>document.querySelectorAll('article[aria-busy="true"]').length===0);
    assert.deepEqual(await page.evaluate(()=>window.openedIds),['c','c'],'save/audit wait cannot let old navigation override newer intent');
    await page.evaluate(()=>{window.holds.b=true;});
    await row('b').getByRole('button',{name:'领取并打开'}).click();
    await page.waitForFunction(()=>Boolean(window.resolvers.b));
    await page.evaluate(()=>{window.switchReviewer();});
    await row('a').getByRole('button',{name:'审核员处理中'}).waitFor();
    await page.evaluate(()=>{window.holds.b=false;window.resolvers.b();});
    await page.waitForFunction(()=>window.rows.find(row=>row.id==='b').claim==='reviewer1');
    assert.deepEqual(await page.evaluate(()=>window.openedIds),['c','c'],'account switch invalidates in-flight open authority');
    const negotiation=await page.evaluate(async()=>{
      const {listOutboundBatches,changeOutboundBatch}=await import('/src/lib/outbound-review.ts');
      window.legacy=true;window.calls=[];const protocol={};
      await listOutboundBatches(undefined,protocol);await listOutboundBatches('a',protocol);await listOutboundBatches(undefined,protocol);
      let batch=structuredClone(window.rows[0]);batch=(await changeOutboundBatch(batch,'release',undefined,undefined,undefined,protocol)).batch;
      await changeOutboundBatch(batch,'release',undefined,undefined,undefined,protocol);
      const negotiated=structuredClone(window.calls);window.calls=[];window.legacy=false;window.failNext='release';
      let failed=false;try{await changeOutboundBatch(batch,'release',undefined,undefined,undefined,{});}catch{failed=true;}
      return {negotiated,ambiguous:window.calls,failed};
    });
    assert.equal(negotiation.negotiated.filter(c=>c.summary||c.action==='list'&&c.datasetId).length,1,'one explicit old-protocol rejection per session');
    assert.equal(negotiation.negotiated.filter(c=>c.compact).length,1,'compact mutation rejection is remembered');
    assert.equal(negotiation.failed,true);assert.equal(negotiation.ambiguous.length,1,'timeout never replays a write or negotiates authority');
  }finally{await browser?.close();await server.close();}
});
