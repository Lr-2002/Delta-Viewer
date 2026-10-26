import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;

test('admin switches modes in one session, account versions stay truthful, single/multi/all sends and narrow layout',async t=>{
 const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:920}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(({version})=>{
  localStorage.setItem('delta.updates.release-notes.seen',version);
  window.calls=[];window.versionFail=false;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  const users=['admin','alice','bob','legacy'].map(username=>({username,displayName:username,accountStatus:'active',operations:0,approved:0,rejected:0,seeks:0,labelsAdded:0,labelsDeleted:0,averageMs:null,lastActivityAtMs:null,online:false}));
  window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback(){},invoke:async(cmd,args={})=>{
   if(cmd==='plugin:event|listen')return 1;if(cmd==='plugin:event|unlisten')return null;
   if(cmd==='get_auth_status')return {workspaceMode:'managed',currentUser:{username:'admin',displayName:'内测账号',role:'operator',canManage:true},userCenter:{configured:true,endpoint:'https://10.1.11.200:17880',serviceId:'fixture'}};
   if(cmd==='check_app_update')return {currentVersion:version,latestVersion:version,available:false,ready:false,notes:null};
   if(['list_task_definitions','list_assigned_task_definitions','get_assigned_tasks','list_my_machine_reviews','list_operation_errors','list_annotated_episodes'].includes(cmd))return [];
   if(cmd==='get_assigned_source_root')return null;
   if(cmd==='flush_pending_annotation_audits')return 0;
   if(cmd==='get_pending_source_reviews')return {pending:0,items:[],ready:false,storageError:''};
   if(['persist_review_audit','flush_review_audit_queue','get_review_audit_queue_status'].includes(cmd))return {pending:0,blocked:0,error:''};
   if(cmd==='get_review_dashboard')return {users,events:[],sessions:[],nextBefore:null,nextSessionBefore:null,total:0,generatedAtMs:Date.now()};
   if(cmd==='client_management') {
    const req=args.request;
    if(req.kind==='poll')return {generatedAtMs:Date.now(),reminder:null};
    if(req.kind==='versions') {
     if(window.versionFail)throw Error('SERVICE_UNAVAILABLE: 统计连接超时');
     return {generatedAtMs:Date.now(),users:users.map(u=>({username:u.username,pendingReminder:null,clients:u.username==='alice'?[{clientId:'one',version:'1.3.2',platform:'windows',online:true,lastSeenAtMs:1700000000000},{clientId:'two',version,platform:'linux',online:false,lastSeenAtMs:1699999999000}]:[]}))};
    }
    window.calls.push(req);return {queued:(req.all?['alice','bob','legacy']:req.usernames).map(username=>({username,id:crypto.randomUUID(),reused:false}))};
   }
   throw Error('Unexpected command '+cmd);
  }};
 },{version});
 await page.goto(server.resolvedUrls.local[0]);
 await page.getByRole('button',{name:'管理模式',exact:true}).click();
 await page.getByRole('button',{name:'测试模式',exact:true}).waitFor();
 assert.equal(await page.locator('.app-shell').isVisible(),false);
 await page.getByRole('button',{name:'审核账号',exact:true}).click();
 await page.locator('.account-version-cell').getByText('v1.3.2',{exact:true}).waitFor();
 const row=page.getByRole('row').filter({hasText:'@alice'});
 assert.match(await row.textContent(),/windows · 在线/);
 assert.match(await row.textContent(),/linux · 离线/);
 assert.match(await page.getByRole('row').filter({hasText:'@legacy'}).textContent(),/未上报/);
 await row.getByRole('button',{name:'推送更新提醒',exact:true}).click();
 await page.getByLabel('选择账号 @alice',{exact:true}).check();await page.getByLabel('选择账号 @bob',{exact:true}).check();
 await page.getByRole('button',{name:'推送选中（2）',exact:true}).click();
 await page.getByRole('button',{name:'一键推送更新提醒',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls.map(c=>({all:c.all,usernames:c.usernames}))),[
  {all:false,usernames:['alice']},{all:false,usernames:['alice','bob']},{all:true,usernames:[]}]);
 await page.evaluate(()=>{window.versionFail=true;});await page.clock.install();await page.clock.runFor(15_100);
 await page.getByText(/版本状态暂不可刷新/).waitFor();assert.match(await row.textContent(),/状态未知/);
 assert.equal(await row.getByText('v1.3.2',{exact:true}).count(),1,'failed refresh retains last version');
 await mkdir('artifacts/client-management',{recursive:true});
 for(const [width,height]of [[1440,920],[960,680],[390,844]]){
  await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(const name of ['测试模式','一键推送更新提醒']) {
   const button=page.getByRole('button',{name,exact:true}),box=await button.boundingBox();
   assert.ok(box.x>=0&&box.x+box.width<=width);assert.ok(await button.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=12),'action labels remain readable');
  }
  await page.screenshot({path:`artifacts/client-management/accounts-${width}.png`,fullPage:true});
 }
 await page.getByRole('button',{name:'测试模式',exact:true}).click();
 assert.equal(await page.locator('.app-shell').isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'管理模式',exact:true}).isVisible(),true);
 assert.ok(await page.getByRole('button',{name:'管理模式',exact:true}).evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=12));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
});

test('reminder persists until action, survives ack failure/reload, isolates accounts, opens official updater',async t=>{
 const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'reminder-fixture',configureServer(s){
 s.middlewares.use(async(req,res,next)=>{if(req.url!=='/__reminder')return next();res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ClientPresence}from'/src/components/ClientPresence.tsx';import{AppUpdates}from'/src/components/AppUpdates.tsx';import '/src/styles.css';
 window.fail=false;window.owner='service:alice';window.received=[];
 const poll=async(id,ack)=>{window.received.push({owner:window.owner,ack});if(window.fail)throw Error('offline');return{generatedAtMs:Date.now(),reminder:window.owner==='service:alice'&&!ack.length?{id:'aabbccdd-aabb-4abb-8abb-aabbccddeeff',sender:'admin',createdAtMs:1700000000000}:null};};
 function Fixture(){const[owner,setOwner]=useState(window.owner);window.switchUser=owner=>{window.owner=owner;setOwner(owner)};return React.createElement(React.Fragment,{},React.createElement('input',{id:'draft',defaultValue:'本机草稿'}),React.createElement(ClientPresence,{key:owner,owner,poll}),React.createElement(AppUpdates,{version:'${version}',currentSummary:'test',currentNotes:[],busy:false,check:async()=>({currentVersion:'${version}',latestVersion:'${version}',available:false,ready:false}),onDownload:async()=>{},onInstall:async()=>{},onViewHistory:()=>{}}));}
 localStorage.setItem('delta.updates.release-notes.seen','${version}');createRoot(document.getElementById('root')).render(React.createElement(Fixture));
 </script></body></html>`));});}}]});await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install();
 await page.goto(server.resolvedUrls.local[0]+'__reminder');const popup=page.getByLabel('管理员更新提醒',{exact:true});await popup.waitFor();
 await page.locator('#draft').fill('未提交的修改');await page.clock.runFor(45_000);assert.equal(await popup.isVisible(),true,'does not auto-disappear');
 for(const button of await popup.getByRole('button').all()){const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=844);}
 await page.screenshot({path:'artifacts/client-management/reminder-390.png'});
 await page.evaluate(()=>{window.fail=true;});await popup.getByRole('button',{name:'查看更新',exact:true}).click();await page.clock.runFor(200);
 await page.getByRole('dialog').waitFor();assert.equal(await page.locator('#draft').inputValue(),'未提交的修改');
 await page.clock.runFor(15_100);assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem('delta.reminder-acks:service:alice')))).length,1,'ack retained offline');
 await page.reload();await page.getByRole('button',{name:'版本与更新',exact:true}).waitFor();await page.clock.runFor(100);
 assert.equal(await popup.count(),0,'lost acknowledgement retried before showing same popup');
 assert.ok(await page.evaluate(()=>window.received[0].ack.includes('aabbccdd-aabb-4abb-8abb-aabbccddeeff')));
 await page.evaluate(()=>window.switchUser('service:bob'));await page.clock.runFor(100);
 assert.equal(await popup.count(),0);assert.deepEqual(await page.evaluate(()=>window.received.at(-1).ack),[]);
 assert.deepEqual(errors,[]);
});
