import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

test('media failure details remain visible, recover and ignore stale frame diagnostics', async t => {
  const server = await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
    name:'isolated-media-failures',
    transform(code,id){if(id.endsWith('/src/lib/backend.ts'))return {code:`
      export async function videoSource(){return null;}
      export async function frameUrl(root,stream,frame){
        if(window.reason!=='ok')throw new Error(window.reason);
        return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="gray"/></svg>');
      }
      export async function diagnoseVideoFailure(root,stream,frame,reason){
        if(window.hold)await new Promise(resolve=>window.release=resolve);
        return reason;
      }
    `,map:null};},
    configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(!req.url.startsWith('/__media'))return next();
      res.setHeader('content-type','text/html');
      res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
        import React from 'react';import {createRoot} from 'react-dom/client';import {FramePanel} from '/src/components/FramePanel.tsx';import '/src/styles.css';
        const root=createRoot(document.getElementById('root'));window.reason='VIDEO_FILE_MISSING: 视频文件缺失：cam0/clip.mp4。请从原件补齐。';
        window.renderFrame=(frame=0)=>root.render(React.createElement('div',{className:'proofreading-view',style:{width:'100%',maxWidth:600}},React.createElement('div',{className:'camera-grid'},React.createElement(FramePanel,{root:'/isolated',stream:{name:'cam0',label:'Camera 0',frameCount:100,firstFrame:0,lastFrame:99},frameId:frame,isPrimary:true,playbackEndFrame:99,onFrameUnavailable:(stream,frame,failure)=>window.lastFailure={stream,frame,...failure}}))));
        window.renderFrame();
      </script></body></html>`));
    });}
  }]});await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:960,height:680}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]+'__media');
  await page.getByRole('status').filter({hasText:'视频文件缺失'}).waitFor();
  const cases=[['VIDEO_FILE_DAMAGED: 视频文件损坏：cam0/clip.mp4（缺少 moov 播放索引）。请从完整原件恢复。','视频文件损坏'],['permission denied (os error 13)','画面读取失败'],['request timeout','画面读取失败'],['decoder unsupported','画面读取失败']];
  let frame=1;
  for(const [reason,label] of cases){
    await page.evaluate(({reason,frame})=>{window.reason=reason;window.renderFrame(frame);},{reason,frame:frame++});
    await page.waitForFunction(reason=>window.lastFailure.detail.includes(reason),reason);
    assert.ok((await page.getByRole('status').innerText()).includes(label));
  }
  await page.evaluate(()=>{window.reason='VIDEO_FILE_DAMAGED: 视频文件损坏：cam0/clip.mp4（容器声明长度超出实际文件，文件不完整）。请从完整原件恢复。';window.renderFrame(6);});
  await page.getByRole('status').filter({hasText:'视频文件损坏'}).waitFor();
  await mkdir('artifacts/media-failure',{recursive:true});
  for(const width of [1440,960,390]){
    await page.setViewportSize({width,height:680});const error=page.getByRole('status');
    assert.ok(await error.evaluate(e=>e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`artifacts/media-failure/diagnostic-${width}.png`});
  }
  await page.evaluate(()=>{window.hold=true;window.reason='VIDEO_FILE_MISSING: stale';window.renderFrame(7);});
  await page.waitForFunction(()=>!!window.release);
  await page.evaluate(()=>{window.reason='ok';window.renderFrame(8);});
  await page.locator('img[aria-hidden=false]').waitFor();
  await page.evaluate(()=>window.release());
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('status').count(),0);
  assert.notEqual(await page.evaluate(()=>window.lastFailure.frame),7);
  assert.deepEqual(errors,[]);
});
