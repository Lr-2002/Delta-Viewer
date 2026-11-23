import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('skeleton source selection is isolated, editable and keeps one human output', async t => {
 const vite=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0}});await vite.listen();
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM,args:['--no-sandbox']});
 t.after(async()=>{await browser.close();await vite.close()});
 const page=await browser.newPage({viewport:{width:1440,height:920}});page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const model='./skeleton.description.tencent-custom.v1.json';
  const segs=[{sourceIndex:0,startFrame:0,endFrame:9,description:'右臂抬起',deleted:false,decision:'pending'},
    {sourceIndex:1,startFrame:10,endFrame:29,description:'左臂保持屈肘',deleted:false,decision:'pending'}];
  const root='/synthetic-skeleton';const states={};window.__calls=[];
  window.__proofData={summary:{name:'synthetic',root,streams:[{name:'cam0',label:'Camera 0',frameCount:30,firstFrame:0,lastFrame:29,width:320,height:180,totalBytes:1,missingFrames:[],missingFrameCount:0,channels:3}]},states:[]};
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(command==='review_identity_path')return args.path;
   if(['get_review_audit_queue_status','persist_review_audit','flush_review_audit_queue'].includes(command))return {pending:0,blocked:0,error:''};
   if(command==='get_video_source')return null;
   if(command==='read_frame')return {mimeType:'image/svg+xml',data:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#ddd"/></svg>')};
   if(command==='diagnose_video_failure')return null;
   if(command==='list_machine_annotation_sources')return ['./bailian_annotation.json','./description.json','./skeleton.description.json',model,'.session_meta/model_skeleton.v2.json'];
   if(command==='load_machine_annotation')return {sourceName:args.sourceName||'./bailian_annotation.json',sourceHash:args.sourceName||'action',episodeId:'synthetic',frameCount:30,segments:args.sourceName==='skeleton.description.json'?[]:structuredClone(segs),warnings:[]};
   if(command==='load_machine_review')return states[args.sourceName]||{sourceHash:args.sourceName||'action',revision:0,segments:args.sourceName==='skeleton.description.json'?[]:structuredClone(segs),published:false,status:'pending'};
   if(command==='save_machine_review'){
    window.__calls.push(structuredClone(args.request));
    const value={sourceHash:args.request.sourceHash,revision:args.request.expectedRevision+1,segments:args.request.segments,published:true,status:'pending',outputName:'skeleton.description.json'};
    states[args.request.sourceName]=value;return structuredClone(value);
   }
   throw Error('Unexpected IPC '+command);
  }};
 });
 await page.goto(vite.resolvedUrls.local[0]+'scripts/fixtures/proofreading.html');
 await page.getByRole('tab',{name:'骨架片段',exact:true}).click();
 const picker=page.getByLabel('骨架标注来源',{exact:true});await picker.waitFor();
 assert.deepEqual(await picker.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['skeleton.description.json','./skeleton.description.tencent-custom.v1.json','.session_meta/model_skeleton.v2.json']);
 await picker.selectOption('./skeleton.description.tencent-custom.v1.json');
 const input=page.getByRole('textbox',{name:'复核动作描述'});await input.waitFor();
 await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.value==='右臂抬起');
 await input.fill('右臂抬起并屈肘');await input.blur();
 await page.waitForFunction(()=>window.__calls.some(r=>r.segments[0].description==='右臂抬起并屈肘'));
 await page.waitForFunction(()=>!document.querySelector('[aria-label="骨架标注来源"]')?.disabled);
 assert.equal(await page.getByRole('button',{name:'通过',exact:true}).count(),0);
 assert.equal(await page.locator('.quality-output').innerText(),'skeleton.description.json');
 const call=await page.evaluate(()=>window.__calls.at(-1));assert.equal(call.sourceName,'./skeleton.description.tencent-custom.v1.json');assert.equal(call.status,'pending');
 await mkdir('artifacts/skeleton-sources',{recursive:true});
 for(const [width,height] of [[1440,920],[960,680],[390,844]]){
  await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`artifacts/skeleton-sources/sources-${width}.png`});
 }
 await page.getByRole('button',{name:'删除机标片段 1',exact:true}).click();
 await page.waitForFunction(()=>window.__calls.at(-1)?.segments[0].deleted===true);
 assert.equal(await page.locator('.machine-segment').count(),1);
 await page.waitForFunction(()=>!document.querySelector('[aria-label="骨架标注来源"]')?.disabled);
 await page.getByRole('tab',{name:'动作片段',exact:true}).click();
 assert.equal(await page.getByLabel('机标来源',{exact:true}).locator('option').filter({hasText:'skeleton'}).count(),0);
 await page.getByRole('tab',{name:'骨架片段',exact:true}).click();
 assert.equal(await picker.inputValue(),'./skeleton.description.tencent-custom.v1.json');
 assert.equal(await page.locator('.frame-error').count(),0);
 assert.deepEqual(errors,[]);
});
