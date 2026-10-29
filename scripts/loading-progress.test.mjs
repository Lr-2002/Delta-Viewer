import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('slow source reads explain the wait, retain cancel and clear on progress', async t => {
 const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
  name:'loading-progress',configureServer(server){server.middlewares.use(async(req,res,next)=>{
   if(!req.url?.startsWith('/__loading'))return next();
   res.setHeader('content-type','text/html');
   res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ProgressStrip} from '/src/components/ProgressStrip.tsx';import '/src/styles.css';
    window.cancelled=0;
    function Test(){const [p,set]=useState({operationId:1,task:'scan',phase:'读取目录及文件元数据',current:0,total:0,bytesDone:0,totalBytes:0,currentPath:'\\\\\\\\10.1.40.2/Datasets/Delta-D1/batch/session',elapsedMs:0});window.change=update=>set(current=>({...current,...update}));return React.createElement('div',{className:'sidebar',style:{width:'260px',maxWidth:'100vw'}},React.createElement(ProgressStrip,{progress:p,onCancel:()=>window.cancelled++}));}
    createRoot(document.getElementById('root')).render(React.createElement(Test));
   </script></body></html>`));
  });}
 }]});await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install();await page.goto(server.resolvedUrls.local[0]+'__loading');
 await page.getByRole('button',{name:'取消任务'}).waitFor();
 await page.clock.runFor(7000);assert.equal(await page.getByRole('alert').count(),0);
 await page.clock.runFor(2000);await page.getByRole('alert').getByText(/NAS 磁盘负载/).waitFor();
 await mkdir('artifacts/loading-progress',{recursive:true});
 for(const [width,height] of [[1440,920],[960,680],[390,844]]){
  await page.setViewportSize({width,height});
  const alert=page.getByRole('alert');const box=await alert.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'取消任务'}).click();
  await page.screenshot({path:`artifacts/loading-progress/wait-${width}.png`});
 }
 assert.equal(await page.evaluate(()=>window.cancelled),3);
 await page.evaluate(()=>window.change({phase:'读取完整状态记录'}));
 await page.getByRole('alert').waitFor({state:'detached'});
 await page.clock.runFor(9000);await page.getByRole('alert').waitFor();
 await page.evaluate(()=>window.change({operationId:2,task:'export',phase:'正在导出'}));
 await page.clock.runFor(9000);assert.equal(await page.getByRole('alert').count(),0);
 assert.deepEqual(errors,[]);
});
