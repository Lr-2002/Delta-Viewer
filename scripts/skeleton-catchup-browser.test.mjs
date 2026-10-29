import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';

test('skeleton catchup is reversible, deterministic across pause and seek, bounded by the clip, and resets with the model', async t => {
 const vite=await createServer({configFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();t.after(()=>vite.close());
 const executablePath=process.env.PLAYWRIGHT_CHROMIUM??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync)??chromium.executablePath();
 const browser=await chromium.launch({executablePath,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:960,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(vite.resolvedUrls.local[0]);
 await page.evaluate(async()=>{
  const R=await import('/node_modules/.vite/deps/react.js');const React=R.default??R;
  const D=await import('/node_modules/.vite/deps/react-dom_client.js');const {SkeletonViewer}=await import('/src/components/SkeletonViewer.tsx');
  document.body.innerHTML='<div id="fixture"></div>';
  const root=(D.createRoot??D.default.createRoot)(document.getElementById('fixture'));
  const skeleton={sourceName:'isolated',jointSource:'smpl_joints',frameCount:901,jointCount:24,usesTimelineFrameIds:true,
   frames:Array.from({length:901},(_,frameId)=>({frameId,joints:Array.from({length:24},(_,j)=>[j%3*.1,Math.floor(j/3)*.1,Math.sin(frameId/30+j)*.01])}))};
  window.spec={skeleton,frameId:300,timelineStartFrame:0,timelineEndFrame:900,timelineFps:30,playbackStartFrame:0,playbackEndFrame:900,playing:false,nativePlayback:true};
  window.renderSkeleton=patch=>{Object.assign(window.spec,patch);root.render(React.createElement(SkeletonViewer,{...window.spec,onFramePresenterChange:window.changed??(window.changed=p=>window.presentSkeleton=p)}))};
  window.renderSkeleton({});
 });
 const canvas=page.locator('.skeleton-canvas canvas');await canvas.waitFor();
 const rate=page.getByLabel('骨架追赶速度',{exact:true});
 await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='300');
 const original=await canvas.evaluate(c=>c.toDataURL());
 await rate.selectOption('1.1');await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='324');
 await page.evaluate(()=>window.presentSkeleton(600));
 await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.leadFrames==='24');
 assert.equal(await canvas.getAttribute('data-frame-id'),'624');
 await page.evaluate(()=>window.renderSkeleton({frameId:600,playing:false}));await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='624');
 await page.evaluate(()=>window.renderSkeleton({frameId:60}));await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='66');
 await page.evaluate(()=>window.renderSkeleton({frameId:300}));await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='324');
 await rate.selectOption('1');await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='300');
 assert.equal(await canvas.evaluate(c=>c.toDataURL()),original,'returning to exact mode restores the same pixels');
 await rate.selectOption('1.1');
 await page.evaluate(()=>window.renderSkeleton({frameId:300,playbackStartFrame:300,playbackEndFrame:330}));await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='300');
 await page.evaluate(()=>window.renderSkeleton({frameId:329}));await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='330');
 await page.evaluate(()=>window.renderSkeleton({skeleton:{...window.spec.skeleton}}));await page.waitForFunction(()=>document.querySelector('select[aria-label="骨架追赶速度"]')?.value==='1');
 await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.frameId==='329');
 assert.equal(await canvas.getAttribute('data-catchup-rate'),'1');
 for(const width of [1440,960,390]){await page.setViewportSize({width,height:800});const b=await rate.boundingBox();assert.ok(b&&b.width>0&&b.x>=0&&b.x+b.width<=width,`controls visible at ${width}`);}
 assert.deepEqual(errors,[]);
});
