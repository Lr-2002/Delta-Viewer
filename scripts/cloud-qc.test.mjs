import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import test from 'node:test';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

test('cloud QC distinguishes reviewer claims, admin policy and full review; failed fetch never opens', async () => {
  const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error',plugins:[{name:'cloud-qc-fixture',configureServer(server){
    server.middlewares.use(async(request,response,next)=>{
      if(request.url!='/__cloud-qc')return next();
      response.setHeader('content-type','text/html');
      response.end(await server.transformIndexHtml(request.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
      import React from 'react';import{createRoot}from'react-dom/client';import{CloudQcTasks}from'/src/components/CloudQcTasks.tsx';import{CloudQcSyncStatus}from'/src/components/CloudQcSyncStatus.tsx';import'/src/components/task-center.css';import'/src/styles.css';
      const root=createRoot(document.getElementById('root'));window.show=(role='operator')=>{window.cloudRole=role;root.render(React.createElement('section',{className:'task-center task-center-cloud',style:{margin:'20px auto'}},React.createElement(CloudQcTasks,{key:role,workspaceBusy:window.workspaceBusy??false,beginOperation:window.reserveCloud?()=>{if(window.refuseOwner)return null;window.ownerActive=true;return{id:901,finish:()=>{window.ownerActive=false;window.finishedOwners=(window.finishedOwners??0)+1;}}}:undefined,currentUser:{username:'alice',displayName:'审核甲',role},onOpen:async root=>{if(window.ownerActive)throw Error('owner not released before open');window.opened.push(root);}})));};window.show();window.showSync=()=>root.render(React.createElement(CloudQcSyncStatus,{username:'alice'}));
      </script></body></html>`));
    });
  }}]});
  await server.listen();
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync)??chromium.executablePath();
  let browser;
  try{
    browser=await chromium.launch({executablePath,headless:true});
    const page=await browser.newPage();
    await page.addInitScript(()=>{
      window.opened=[];window.calls=[];window.failFetch=false;
      window.plan={id:'a'.repeat(32),job_id:'b'.repeat(32),company_id:'company-a',external_order_id:'upload_'+ 'e'.repeat(32),source_revision:'f'.repeat(64),batch_path:'',created_at:'2026-10-27T08:44:17Z',version:1,state:'sampling',sample_count:1,population_count:20,sample_approved:0,sample_rejected:0,full_review:false,tasks:[{recording_id:'c'.repeat(32),path:'采集批次/recording_001',kind:'sample',assignee:null,qc:{decision:'pending',reason:null},claim_version:0}]};
      window.policy={version:1,policy:{enabled:true,sample_percent:5,batch_scope:'sealed_order',rounding:'ceil_min_one',release_mode:'sampled_only',failure_action:'hold'}};
      window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
        if (command === "review_identity_path") return args.path;
        window.calls.push([command,args]);
        if(command==='cloud_qc_call'){
          if(args.action==='identity')return {account_id:'alice',role:window.cloudRole==='admin'?'admin':'reviewer'};
          if(args.action==='tasks')return {plans:[structuredClone(window.plan)]};
          if(args.action==='policy')return structuredClone(window.policy);
          if(args.action==='claim'){window.plan.tasks[0].assignee='alice';window.plan.version++;return {plan:structuredClone(window.plan)};}
          if(args.action==='set_policy'){window.policy={version:2,policy:args.payload.policy};return structuredClone(window.policy);}
          if(args.action==='full_review'){window.plan.full_review=true;window.plan.version++;return {plan:structuredClone(window.plan)};}
        }
        if(command==='cloud_qc_fetch'){if(window.failFetch)throw Error('CLOUD_QC_DOWNLOAD_HASH_INVALID');return '/isolated/cloud-qc/recording_001';}
        if(command==='cloud_qc_sync'){window.plan.tasks[0].qc={decision:'approved',reason:null};return {synchronized:true};}
        throw Error('unexpected '+command);
      }};
    });
    const port=server.httpServer.address().port;
    await page.goto(`http://127.0.0.1:${port}/__cloud-qc`);
    await page.getByRole('button',{name:'领取并打开'}).waitFor();
    assert.equal(await page.getByText('公司抽样策略',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'转全量审查'}).count(),0);
    assert.equal(await page.getByRole('heading',{name:'采集批次',exact:true}).isVisible(),true);
    assert.equal(await page.getByText('upload_'+ 'e'.repeat(32),{exact:true}).isVisible(),false);
    await page.getByText('批次详情',{exact:true}).click();
    assert.equal(await page.getByText('upload_'+ 'e'.repeat(32),{exact:true}).isVisible(),true);
    await page.getByText('批次详情',{exact:true}).click();
    // A busy workspace cannot claim/download; even a stale render must reserve
    // the synchronous App owner before making the claim API call.
    await page.evaluate(()=>{window.workspaceBusy=true;window.reserveCloud=true;window.show();});
    await page.getByRole('status').filter({hasText:'正在恢复或处理数据'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'下载预览',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'领取并打开',exact:true}).isDisabled(),true);
    await page.evaluate(()=>{window.workspaceBusy=false;window.refuseOwner=true;window.show();});
    await page.getByRole('button',{name:'领取并打开',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'请等待完成后'}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(([c,a])=>c==='cloud_qc_call'&&a.action==='claim').length),0);
    await page.evaluate(()=>{window.refuseOwner=false;window.show();});
    await page.getByRole('button',{name:'下载预览',exact:true}).click();
    await page.waitForFunction(()=>window.opened.length===1);
    assert.equal(await page.evaluate(()=>window.calls.filter(([c,a])=>c==='cloud_qc_call'&&a.action==='claim').length),0);
    await page.evaluate(()=>{window.opened=[];window.failFetch=true});
    await page.getByRole('button',{name:'领取并打开'}).click();
    await page.getByRole('alert').filter({hasText:'CLOUD_QC_DOWNLOAD_HASH_INVALID'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.opened),[]);
    await page.waitForTimeout(5200);
    assert.equal(await page.getByRole('alert').filter({hasText:'CLOUD_QC_DOWNLOAD_HASH_INVALID'}).isVisible(),true,'unrelated polling must not clear an operation error');
    assert.equal(await page.evaluate(()=>window.plan.tasks[0].assignee),'alice');
    assert.equal(await page.evaluate(()=>window.calls.filter(([c,a])=>c==='cloud_qc_call'&&a.action==='claim').length),1);
    await page.evaluate(()=>window.failFetch=false);
    await page.getByRole('button',{name:'打开审核',exact:true}).click();
    await page.waitForFunction(()=>window.opened.length===1);
    assert.deepEqual(await page.evaluate(()=>window.opened),['/isolated/cloud-qc/recording_001']);
    assert.equal(await page.evaluate(()=>window.calls.filter(([c,a])=>c==='cloud_qc_call'&&a.action==='claim').length),1,'reopening a claimed task must not claim again');
    assert.equal(await page.evaluate(()=>window.ownerActive),false);
    assert.equal(await page.evaluate(()=>window.calls.filter(([c])=>c==='cloud_qc_fetch').every(([,a])=>a.operationId===901)),true);
    await page.getByRole('button',{name:'同步已保存的结论'}).click();
    await page.getByRole('status').filter({hasText:'已同步 Viewer 保存的真实审核结论'}).waitFor();
    await page.evaluate(()=>window.show('admin'));
    await page.getByText('公司抽样策略',{exact:true}).waitFor();
    await page.getByLabel('变更原因').fill('管理员更新后续批次');
    await page.getByRole('button',{name:'保存策略'}).click();
    await page.getByRole('status').filter({hasText:'策略已保存'}).waitFor();
    page.once('dialog',dialog=>dialog.accept('升级全量复查'));
    await page.getByRole('button',{name:'转全量审查'}).click();
    await page.waitForFunction(()=>window.plan.full_review);
    assert.equal(await page.getByRole('button',{name:'转全量审查'}).count(),0);
    // Native persistent queue remains after a partial failure, unrelated success cannot hide it.
    await page.evaluate(()=>{
      window.failSync=true;window.qcSyncCount=0;window.pending=[{directory:'/isolated/review/a'},{directory:'/isolated/review/b'}];
      const original=window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
        if(command==='cloud_qc_pending')return {items:[...window.pending]};
        if(command==='cloud_qc_sync'){
          window.qcSyncCount++;
          if(window.failSync&&args.directory.endsWith('/a'))throw Error(window.syncError??'CLOUD_QC_NETWORK_UNAVAILABLE');
          window.pending=window.pending.filter(row=>row.directory!==args.directory);return {synchronized:true};
        }
        return original(command,args);
      };window.showSync();
    });
    await page.getByRole('status').filter({hasText:'云端尚未确认'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.pending),[{directory:'/isolated/review/a'}]);
    // Native busy is in-flight work, not an ACK or a replacement business error.
    await page.evaluate(()=>window.syncError='CLOUD_QC_SYNC_BUSY');
    await page.getByRole('button',{name:'重试同步 QC'}).click();
    await page.waitForFunction(()=>window.qcSyncCount>=3);
    assert.match(await page.getByRole('status').innerText(),/暂时无法连接云端/);
    assert.equal(await page.evaluate(()=>window.pending.length),1);
    await page.evaluate(()=>{
      window.syncError='QC_TASK_NOT_CLAIMED';window.explicitClaims=0;
      window.confirm=()=>true;
      const original=window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
        if(command==='cloud_qc_access'){
          if(args.claim){window.explicitClaims++;window.failSync=false;}
          return {cloud:true,canEdit:!window.failSync,claimable:window.failSync,reason:'未领取'};
        }
        return original(command,args);
      };
    });
    await page.getByRole('button',{name:'重试同步 QC'}).click();
    await page.getByRole('button',{name:'领取并补传原结论'}).waitFor();
    assert.equal(await page.evaluate(()=>window.explicitClaims),0);
    await page.getByRole('button',{name:'领取并补传原结论'}).click();
    await page.waitForFunction(()=>window.pending.length===0);
    assert.equal(await page.evaluate(()=>window.explicitClaims),1);
    await page.evaluate(()=>window.failSync=false);
    await page.evaluate(()=>window.show('admin'));
    await page.getByText('公司抽样策略',{exact:true}).waitFor();
    mkdirSync('artifacts/cloud-qc',{recursive:true});
    for(const width of [1440,960,390]){
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.getByRole('button',{name:'下载预览',exact:true}).scrollIntoViewIfNeeded();
      const button=await page.getByRole('button',{name:'下载预览',exact:true}).boundingBox();
      assert.ok(button.x>=0 && button.x+button.width<=width);
      await page.screenshot({path:`artifacts/cloud-qc/rc3-cloud-layout-${width}.png`});
    }
  }finally{await browser?.close();await server.close();}
});

test('App cloud download owns the operation, invalidates delayed login restore and cancels with the native owner ID', async () => {
  const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath();
  let browser;
  try {
    browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.addInitScript(()=>{
      window.calls=[];window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
      window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback(){},invoke:async(command,args={})=>{
        if (command === "review_identity_path") return args.path;
        window.calls.push([command,args]);
        if(command==='get_auth_status')return {workspaceMode:'managed',currentUser:{username:'alice',displayName:'审核甲',role:'operator'},userCenter:{configured:true,serviceId:'fixture',endpoint:'https://127.0.0.1:1'}};
        if(command==='get_assigned_source_root'){window.restoreWaiting=true;return new Promise(resolve=>{window.resolveRestore=resolve;});}
        if(command==='get_task_center_root')return null;
        if(command==='plugin:event|listen')return 1;if(command==='plugin:event|unlisten')return null;
        if(command==='cloud_qc_call')return args.action==='identity'?{account_id:'alice',role:'reviewer'}:{plans:[{id:'a'.repeat(32),job_id:'b'.repeat(32),external_order_id:'竞态测试批次',source_revision:'v1',version:1,state:'sampling',sample_count:1,population_count:1,sample_approved:0,sample_rejected:0,tasks:[{recording_id:'c'.repeat(32),path:'batch/recording',assignee:null,kind:'sample',qc:{decision:'pending'}}]}]};
        if(command==='cloud_qc_fetch'){window.cloudStarted=true;window.cloudOperation=args.operationId;return new Promise((_resolve,reject)=>{window.rejectDownload=reject;});}
        if(command==='cancel_task'){window.cancelledOperation=args.operationId;window.rejectDownload(Error('CLOUD_QC_CANCELLED'));return null;}
        if(command==='resolve_source_path')return args.path;
        if(command==='scan_source')throw Error('Unexpected old-directory restore during explicit cloud navigation');
        if(command==='cloud_qc_pending')return {items:[]};
        if(command==='get_pending_source_reviews')return {pending:0,items:[],ready:false,storageError:''};
        if(['persist_review_audit','flush_review_audit_queue','get_review_audit_queue_status'].includes(command))return {pending:0,blocked:0,error:''};
        if(command==='flush_pending_annotation_audits')return 0;
        if(command==='client_management')return {generatedAtMs:Date.now(),reminder:null};
        if(command.startsWith('list_')||command==='get_assigned_tasks')return [];
        throw Error('Unexpected fixture command '+command);
      }};
    });
    await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>window.restoreWaiting);
    await page.getByRole('button',{name:'任务中心',exact:true}).click();
    await page.getByRole('button',{name:'云端 QC',exact:true}).click();
    await page.getByRole('button',{name:'下载预览',exact:true}).click();await page.waitForFunction(()=>window.cloudStarted);
    assert.equal(await page.getByRole('button',{name:'选择数据目录',exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.resolveRestore('/late-old-recording'));
    await page.waitForFunction(()=>!document.querySelector('.app-shell')?.hidden);
    assert.equal(await page.evaluate(()=>window.calls.filter(([command])=>command==='scan_source').length),0);
    await page.getByRole('button',{name:'取消下载',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'CLOUD_QC_CANCELLED'}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.topbar .button:disabled'));
    assert.equal(await page.evaluate(()=>window.cancelledOperation===window.cloudOperation),true);
    assert.equal(await page.evaluate(()=>window.calls.filter(([command])=>command==='scan_source').length),0);
    assert.equal(await page.evaluate(()=>window.calls.some(([command,args])=>command==='cloud_qc_call'&&args.action==='claim')),false);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await server.close();}
});
