import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;

test('one compact sync notice, native history modality and both outboxes recover without hiding other errors',async t=>{
 const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:920}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(({version})=>{
  window.expired=true;window.annotationFlushes=0;window.auditFlushes=0;
  if(!sessionStorage.getItem('seeded')){localStorage.setItem('dohc-viewer.pending-audits.v1',JSON.stringify([{eventId:'fixture-annotation',action:'saved',taskId:'fixture',trajectoryCode:'fixture',occurredAtMs:1793021652000}]));sessionStorage.setItem('seeded','1');}
  const user={username:'admin',displayName:'内测账号',role:'operator',canManage:true};
  localStorage.setItem('delta.updates.release-notes.seen',version);
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd,args)=>{
   if(cmd==='plugin:event|listen')return 1;if(cmd==='plugin:event|unlisten')return null;
   if(cmd==='get_auth_status')return {workspaceMode:'managed',currentUser:user,userCenter:{configured:true,endpoint:'https://fixture.local',serviceId:'fixture'}};
   if(cmd==='check_app_update')return {currentVersion:version,latestVersion:version,available:false,ready:false,notes:null};
   if(cmd==='get_assigned_tasks'){if(window.expired)throw Error('AUTH_REQUIRED');return [];}
   if(['list_task_definitions','list_assigned_task_definitions','list_my_machine_reviews','list_operation_errors','list_annotated_episodes'].includes(cmd))return [];
   if(cmd==='get_assigned_source_root')return null;
   if(cmd==='record_annotation_audit'){window.annotationFlushes++;if(window.expired)throw Error('AUTH_REQUIRED');return null;}
   if(cmd==='get_pending_source_reviews')return {pending:0,items:[],ready:false,storageError:''};
   if(['persist_review_audit','flush_review_audit_queue','get_review_audit_queue_status'].includes(cmd)){
    if(cmd==='flush_review_audit_queue')window.auditFlushes++;
    return {pending:window.expired?3497:0,blocked:0,error:window.expired?'AUTH_REQUIRED':'',oldestPendingAtMs:1793021652000,lastSuccessAtMs:1793021638000};
   }
   if(cmd==='login_account'){assertPassword(args);window.expired=false;return user;}
   if(cmd==='client_management')return args.request.kind==='versions'?{generatedAtMs:Date.now(),users:[]}:{generatedAtMs:Date.now(),reminder:null};
   throw Error('Unexpected command '+cmd);
  }};
  function assertPassword(args){if(args.request.username!=='admin'||args.request.password!=='fixture-password')throw Error('INVALID_CREDENTIALS');}
 },{version});
 await page.goto(server.resolvedUrls.local[0]);
 const notice=page.getByLabel('操作记录同步状态',{exact:true});
 await notice.getByRole('button',{name:'重新登录并补传',exact:true}).waitFor();
 assert.equal(await notice.count(),1);
 assert.equal(await page.locator('.alert-error').count(),0,'authentication errors are represented by the one sync recovery notice');
 assert.equal(await page.locator('.audit-sync-detail').isVisible(),false);
 assert.ok((await notice.boundingBox()).height<105,'compact desktop status does not consume editor');
 await mkdir('artifacts/audit-layout',{recursive:true});
 for(const [width,height]of [[1976,1280],[1440,920],[960,680],[390,844]]){
  await page.setViewportSize({width,height});
  assert.ok((await notice.boundingBox()).height<(width<600?210:145));
  for(const button of await notice.getByRole('button').all()){
   const box=await button.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1);
   assert.ok(await button.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=12));
  }
  await page.screenshot({path:`artifacts/audit-layout/compact-${width}.png`});
  await page.getByRole('button',{name:'查看历史版本',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'历史版本',exact:true});await dialog.waitFor();
  assert.equal(await dialog.evaluate(el=>el.matches(':modal')),true);
  assert.equal(await notice.count(),1,'modal does not discard monitoring');
  const occlusion=await notice.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('dialog')!==null;});
  assert.equal(occlusion,true,'sync status cannot paint or receive clicks above native dialog');
  for(let n=0;n<3;n++){await page.keyboard.press('Tab');assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);}
  await page.screenshot({path:`artifacts/audit-layout/history-${width}.png`});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'查看历史版本',exact:true}).evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 await page.setViewportSize({width:960,height:680});
 await notice.getByRole('button',{name:'同步详情',exact:true}).click();
 assert.match(await notice.locator('.audit-sync-facts').innerText(),/3497.*条/);
 assert.match(await notice.locator('.audit-sync-facts').innerText(),/2026/);
 assert.match(await notice.locator('.audit-sync-detail').innerText(),/另有标注操作记录/);
 await notice.getByRole('button',{name:'收起详情',exact:true}).click();
 await page.getByRole('button',{name:'管理模式',exact:true}).click();
 assert.equal(await notice.count(),1,'one notice also visible in management mode');
 await page.getByRole('button',{name:'测试模式',exact:true}).click();
 await notice.getByRole('button',{name:'重新登录并补传',exact:true}).click();
 await notice.getByLabel('当前账号密码').fill('fixture-password');
 await notice.getByRole('button',{name:'登录并补传',exact:true}).click();
 await notice.waitFor({state:'detached'});
 assert.ok(await page.evaluate(()=>window.annotationFlushes>=2&&window.auditFlushes>=2),'same-account recovery retries both queues');
 assert.equal(await page.evaluate(()=>localStorage.getItem('dohc-viewer.pending-audits.v1')),null,'annotation outbox removed only after successful replay');
 assert.equal(await page.locator('.alert-error').count(),0,'obsolete authentication error clears after successful recovery');
 assert.deepEqual(errors,[]);
});
