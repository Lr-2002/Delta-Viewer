import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('cloud preview stays read only until an explicit verified claim; local review remains editable', async () => {
  const server = await createServer({ logLevel:'error', server:{host:'127.0.0.1',port:0,strictPort:false} });
  await server.listen();
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync)??chromium.executablePath();
  let browser;
  try {
    browser = await chromium.launch({executablePath,headless:true});
    for (const cloud of [true, false]) {
      const context = await browser.newContext({viewport:{width:960,height:680}});
      const page = await context.newPage();
      await page.addInitScript(({cloud}) => {
        const segments=[{sourceIndex:0,startFrame:0,endFrame:29,description:'整理物品',deleted:false,decision:'pending'}];
        const root=cloud?'/private/cloud-qc/data/alice/company/'+ 'a'.repeat(32)+'/'+ 'b'.repeat(32)+'/files/batch/recording':'/synthetic-local';
        const stream={name:'cam0',label:'Camera 0',frameCount:30,firstFrame:0,lastFrame:29,width:320,height:180,totalBytes:1,missingFrames:[],missingFrameCount:0,channels:3};
        window.__proofData={summary:{name:'synthetic',root,streams:[stream]},states:[]};
        window.owner=null;window.claimCalls=0;window.saveCalls=0;window.accessFails=false;
        window.__TAURI_INTERNALS__={convertFileSrc:p=>p,invoke:async(command,args)=>{
        if (command === "review_identity_path") return args.path;
          if(['get_review_audit_queue_status','persist_review_audit','flush_review_audit_queue'].includes(command)) return {pending:0,blocked:0,error:''};
          if(command==='list_machine_annotation_sources')return ['bailian_annotation.json'];
          if(command==='load_machine_annotation')return {sourceName:'bailian_annotation.json',sourceHash:'synthetic-source',sourceJson:'{}',episodeId:'synthetic',frameCount:30,segments,warnings:[]};
          if(command==='load_machine_review')return {sourceHash:'synthetic-source',revision:0,segments,published:false,status:'pending',qcStatus:'pending'};
          if(command==='get_video_source')return {fps:30,mediaFps:30,segmentSeconds:300,startFrame:0,paths:[]};
          if(command==='cloud_qc_access'){
            if(window.accessFails)throw Error('CLOUD_QC_NETWORK_UNAVAILABLE');
            if(args.claim){window.claimCalls++;window.owner='alice';}
            return {cloud:true,canEdit:window.owner==='alice',claimable:window.owner===null,reason:window.owner===null?'当前为只读预览；领取后才能修改和审核':window.owner==='alice'?'已领取，可审核':'其他账号已领取'};
          }
          if(command==='save_machine_review'){window.saveCalls++;throw Error('test must not write a conclusion');}
          throw Error('unexpected '+command);
        }};
      }, {cloud});
      await page.route('**/scripts/fixtures/proofreading.tsx', async route => {
        const response=await route.fetch();const original=await response.text();
        await route.fulfill({response,body:original.replace('import { MachineAnnotationPanel }', 'import { CloudMachineAnnotationPanel as MachineAnnotationPanel }').replace('/src/components/MachineAnnotationPanel', '/src/components/CloudMachineAnnotationPanel')});
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/proofreading.html`);
      await page.getByRole('button',{name:'通过',exact:true}).waitFor();
      if (cloud) {
        await page.getByText('当前为只读预览；领取后才能修改和审核',{exact:true}).waitFor();
        for (const name of ['通过','不通过','新增片段']) assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
        assert.equal(await page.getByRole('button',{name:'定位机标片段 1',exact:true}).isEnabled(),true,'preview can select a segment without editing it');
        assert.equal(await page.getByLabel('复核动作描述').isDisabled(),true);
        await page.keyboard.press('x');await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(()=>window.saveCalls),0);
        assert.equal(await page.evaluate(()=>window.claimCalls),0,'preview never claims automatically');
        mkdirSync('artifacts/cloud-qc',{recursive:true});
        for(const width of [1440,960,390]) {
          await page.setViewportSize({width,height:844});
          const button=page.getByRole('button',{name:'领取后审核',exact:true});await button.scrollIntoViewIfNeeded();
          const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
          await page.screenshot({path:`artifacts/cloud-qc/rc4-preview-${width}.png`});
        }
        await page.evaluate(()=>window.accessFails=true);
        await page.getByRole('button',{name:'领取后审核',exact:true}).click();
        await page.getByText(/暂时无法连接云端/).waitFor();
        assert.equal(await page.getByRole('button',{name:'通过',exact:true}).isDisabled(),true);
        await page.evaluate(()=>window.accessFails=false);
        await page.getByRole('button',{name:'领取后审核',exact:true}).click();
      }
      try { await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.disabled===false,{},{timeout:10000}); }
      catch(cause) { console.error(await page.locator('body').innerText());throw cause; }
      assert.equal(await page.getByRole('button',{name:'通过',exact:true}).isEnabled(),true);
      assert.equal(await page.evaluate(()=>window.claimCalls),cloud?1:0);
      assert.equal(await page.evaluate(()=>window.saveCalls),0);
      if(cloud){
        await page.evaluate(()=>window.owner='bob');
        await page.getByRole('button',{name:'重新读取机标',exact:true}).click();
        await page.getByText('其他账号已领取',{exact:true}).waitFor();
        assert.equal(await page.getByRole('button',{name:'通过',exact:true}).isDisabled(),true);
        assert.equal(await page.getByRole('button',{name:'领取后审核',exact:true}).count(),0);
      }
      await context.close();
    }
  } finally { await browser?.close();await server.close(); }
});
