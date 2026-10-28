import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('batch rejection requires warning confirmation and reason, skips reviewed data, reports failures and stops between saves', async () => {
  const server = await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'batch-fixture',configureServer(server) {
    server.middlewares.use(async (req,res,next) => {
      if (req.url !== '/__batch-test') return next();
      res.setHeader('content-type','text/html');
      res.end(await server.transformIndexHtml(req.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import React from 'react'; import {createRoot} from 'react-dom/client'; import {BatchRejectionDialog} from '/src/components/BatchRejectionDialog.tsx';
        import {configureReviewAudit} from '/src/lib/review-audit.ts'; import '/src/styles.css'; import '/src/components/task-center.css';
        configureReviewAudit('alice','test-center');
        const root=createRoot(document.getElementById('root')); let revision=0;
        window.showBatch=(folder=false)=>root.render(React.createElement(BatchRejectionDialog,{key:++revision,username:'alice',...(folder?{folder:'/source/batch'}:{selected:[1,2,3].map(i=>({path:'/source/batch/'+i,name:'session-'+i}))}),onSaved:path=>window.fixture.saved.push(path),onClose:()=>root.render(null)}));
        window.showBatch();
      </script></body></html>`));
    });
  }}]});
  await server.listen();
  const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM ?? ['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync) ?? chromium.executablePath()});
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[]; page.on('pageerror',error=>errors.push(String(error)));
  try {
    await page.addInitScript(() => {
      window.fixture={calls:[],saved:[],audit:[],delay:false,scanError:false};
      window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async (command,args)=>{
        if(command==='persist_review_audit') {window.fixture.audit.push(...args.events);return {pending:0,blocked:0,error:''};}
        if(command==='flush_review_audit_queue') return {pending:0,blocked:0,error:''};
        if(command==='scan_task_center') {
          if(window.fixture.scanError) throw Error('共享目录读取失败');
          return {sourceRoot:'/source/batch',tree:{name:'batch',relativePath:'',session:false,incomplete:false,children:[1,2,3,4].map(i=>({name:'session-'+i,relativePath:String(i),session:true,status:i===2?'approved':i===4?'error':'pending',incomplete:false,children:[]}))}};
        }
        if(command==='cancel_task') return true;
        if(command==='defer_machine_review') {
          window.fixture.local ??= [];window.fixture.local.push(args.entry);
          return {pendingSourceWrite:true,status:'rejected'};
        }
        if(command==='reject_pending_machine_review') {
          window.fixture.calls.push(args);
          if(window.fixture.full) throw Error('REVIEW_STORAGE_FULL: NAS 空间不足');
          if(window.fixture.existing) throw Error('SOURCE_REVIEW_EXISTS: 已有本机待写结果');
          if(window.fixture.delay) await new Promise(resolve=>window.fixture.finish=resolve);
          if(args.sourcePath.endsWith('/2')) return null;
          if(args.sourcePath.endsWith('/3')) throw Error('目录只读，未保存');
          return {revision:1,revisionLabel:'fixture-v1',status:'rejected'};
        }
        throw Error(command);
      }};
    });
    await page.goto(`${server.resolvedUrls.local[0]}__batch-test`);
    const confirm=page.getByRole('button',{name:'确认不通过',exact:true});
    const reason=page.getByRole('textbox',{name:'批量不通过原因'});
    const acknowledge=page.getByRole('checkbox');
    await confirm.waitFor();
    assert.equal(await confirm.isDisabled(),true);
    const reasons = page.getByRole('group',{name:'原因选项'});
    assert.equal(await reasons.getByRole('button').count(),13);
    await page.getByRole('button',{name:'调整顺序',exact:true}).click();
    await reasons.getByRole('button',{name:'动作失范',exact:true}).dragTo(reasons.getByRole('button',{name:'骨架抖动',exact:true}));
    assert.equal(await reasons.getByRole('button').first().textContent(),'动作失范');
    assert.equal(await reasons.getByRole('button',{name:'其他原因',exact:true}).getAttribute('draggable'),'false');
    await reasons.getByRole('button',{name:'动作失范',exact:true}).press('Alt+ArrowRight');
    assert.equal(await reasons.getByRole('button').nth(1).textContent(),'动作失范');
    await page.getByRole('button',{name:'恢复默认',exact:true}).click();
    assert.equal(await reasons.getByRole('button').first().textContent(),'骨架抖动');
    await reasons.getByRole('button',{name:'动作失范',exact:true}).dragTo(reasons.getByRole('button',{name:'骨架抖动',exact:true}));
    await page.getByRole('button',{name:'完成排序',exact:true}).click();
    await reasons.getByRole('button',{name:'状态异常',exact:true}).click();
    await acknowledge.check(); assert.equal(await confirm.isEnabled(),true); await acknowledge.uncheck();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('delta-viewer.rejection-order.v1:alice'))[0]),'动作失范');
    await page.getByRole('button',{name:'其他原因',exact:true}).click();await reason.fill('   '); await acknowledge.check();
    assert.equal(await confirm.isDisabled(),true);
    await page.getByRole('button',{name:'其他原因',exact:true}).click();await reason.fill('轨迹不动，统一检查确认无效'); await acknowledge.uncheck();
    assert.equal(await confirm.isDisabled(),true);
    await acknowledge.check();
    await mkdir('artifacts/batch-rejection',{recursive:true});
    await page.screenshot({path:'artifacts/batch-rejection/desktop.png'});
    await page.setViewportSize({width:960,height:680});
    assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.screenshot({path:'artifacts/batch-rejection/compact.png'});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.screenshot({path:'artifacts/batch-rejection/mobile.png'});
    await confirm.evaluate(button=>{button.click();button.click();});
    await page.getByText('成功 1 · 本机待写 0 · 跳过 1 · 失败 1 · 未执行 0',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.calls.length),3);
    assert.equal(await page.evaluate(()=>window.fixture.audit.filter(e=>e.action==='rejected').length),1);
    assert.equal(await page.evaluate(()=>window.fixture.audit[0].details.reason),'其他原因：轨迹不动，统一检查确认无效');
    assert.equal(await page.getByText('目录只读，未保存',{exact:false}).count(),1);
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.evaluate(()=>{window.fixture.calls=[];window.fixture.delay=true;window.showBatch();});
    await page.getByRole('button',{name:'其他原因',exact:true}).click();await reason.fill('无效数据');await acknowledge.check();await confirm.click();
    await page.waitForFunction(()=>typeof window.fixture.finish==='function');
    await page.getByRole('button',{name:'停止',exact:true}).click();
    await page.evaluate(()=>window.fixture.finish());
    await page.getByText('成功 1 · 本机待写 0 · 跳过 0 · 失败 0 · 未执行 2',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.calls.length),1);
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.evaluate(()=>{window.fixture.delay=false;window.fixture.calls=[];window.showBatch(true);});
    await page.getByText('待处理 2 条 · 已排除已审核或异常数据 2 条',{exact:true}).waitFor();
    assert.equal(await reasons.getByRole('button').first().textContent(),'动作失范','folder and selected modes share the account order');
    await page.getByRole('button',{name:'添加常用原因',exact:true}).click();
    await page.getByLabel('常用原因名称').fill('多路视频不同步');await page.getByLabel('常用原因名称').press('Enter');
    assert.equal(await page.evaluate(()=>window.fixture.calls.length),0,'adding a button must not submit');
    await reasons.getByRole('button',{name:'多路视频不同步',exact:true}).click();await acknowledge.check();await confirm.click();
    await page.getByText('成功 1 · 本机待写 0 · 跳过 0 · 失败 1 · 未执行 0',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.fixture.calls.map(c=>c.sourcePath)),['/source/batch/1','/source/batch/3']);
    assert.equal(await page.evaluate(()=>window.fixture.calls[0].reason),'其他原因：多路视频不同步');
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.evaluate(()=>{window.fixture.full=true;window.fixture.saved=[];window.fixture.audit=[];window.showBatch();});
    await page.getByRole('button',{name:'其他原因',exact:true}).click();await reason.fill('无效数据');await acknowledge.check();await confirm.click();
    await page.getByText('成功 0 · 本机待写 3 · 跳过 0 · 失败 0 · 未执行 0',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.local.length),3);
    assert.equal(await page.evaluate(()=>window.fixture.saved.length),0);
    assert.equal(await page.evaluate(()=>window.fixture.audit.filter(e=>e.action==='rejected').length),0);
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.evaluate(()=>{window.fixture.full=false;window.fixture.existing=true;window.showBatch();});
    await page.getByRole('button',{name:'其他原因',exact:true}).click();await reason.fill('无效数据');await acknowledge.check();await confirm.click();
    await page.getByText('成功 0 · 本机待写 0 · 跳过 0 · 失败 3 · 未执行 0',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.local.length),3,'existing local results cannot be overwritten by repeat batch');
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.evaluate(()=>{window.fixture.scanError=true;window.showBatch(true);});
    await page.getByRole('alert').waitFor();
    assert.equal(await confirm.isDisabled(),true);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await server.close();}
});
