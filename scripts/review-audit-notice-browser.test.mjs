import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('persistent audit notice shows real outbox facts, recovery and account isolation', async t => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{
    name: 'audit-status-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__audit-status') return next();
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
          import React, {useEffect,useState} from 'react'; import {createRoot} from 'react-dom/client';
          import {AuditSyncNotice} from '/src/components/AuditSyncNotice.tsx'; import * as audit from '/src/lib/review-audit.ts'; import '/src/styles.css';
          window.audit=audit;
          function App() {
            const [user,setUser]=useState('alice'), [status,setStatus]=useState(null), [error,setError]=useState('');
            window.switchUser=setUser;
            useEffect(()=>{ const update=()=>setStatus(audit.getReviewSyncStatus()); window.addEventListener('review-audit-snapshot',update);
              const stop=audit.configureReviewAudit(user,'test-service'); update();
              return ()=>{stop();window.removeEventListener('review-audit-snapshot',update);}; },[user]);
            return React.createElement('main',{className:'main-content',style:{height:'100vh'}},
              React.createElement(AuditSyncNotice,{key:user,username:user,status,error,onError:setError,onPendingChange:()=>{},flush:audit.retryReviewAudit,autoRetry:false}),
              React.createElement('div',{style:{height:'1800px'}},'隔离审核工作区'));
          }
          createRoot(document.getElementById('root')).render(React.createElement(App));
        </script></body></html>`));
      });
    },
  }] });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? chromium.executablePath(), headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
  await page.addInitScript(() => {
    // Simulated committed database survives page reload; never contacts a server.
    const read=()=>JSON.parse(localStorage.getItem('fixture-database')??'{"alice":[],"bob":[]}');
    const save=db=>localStorage.setItem('fixture-database',JSON.stringify(db));
    if (!localStorage.getItem('fixture-database')) save({alice:[
      {eventId:'old',occurredAtMs:1700000000000}, {eventId:'other',occurredAtMs:1700000001000}], bob:[]});
    window.mode='offline'; window.failDisk=false;
    function state(username) {
      const rows=read()[username]??[], rejected=rows.filter(e=>e.blocked);
      return {pending:rows.length,blocked:rejected.length,error:rejected[0]?.blocked??'',blockedError:rejected[0]?.blocked??'',
        oldestPendingAtMs:rows.length?Math.min(...rows.map(e=>e.occurredAtMs)):null,
        lastSuccessAtMs:Number(localStorage.getItem('fixture-receipt:'+username))||null};
    }
    window.__TAURI_INTERNALS__={invoke:async(cmd,args)=>{
      if(cmd==='review_identity_path') return args.path;
      if(cmd==='get_review_audit_queue_status') return state(args.username);
      if(cmd==='persist_review_audit') {
        if(window.failDisk) throw Error('ENOSPC: no space left on device');
        const db=read(), rows=db[args.username]??=[];
        for(const event of args.events) if(!rows.some(e=>e.eventId===event.eventId)) rows.push(event);
        save(db);return state(args.username);
      }
      if(cmd==='flush_review_audit_queue') {
        if(window.mode==='partial') {
          const db=read(), rows=db[args.username]??[];
          rows.forEach(e=>{if(e.eventId==='old') e.blocked='REVIEW_EVENT_INVALID';});
          if(rows.some(e=>!e.blocked)) localStorage.setItem('fixture-receipt:'+args.username,'1700000100000');
          db[args.username]=rows.filter(e=>e.blocked);save(db);return state(args.username);
        }
        if(window.mode==='success') {
          const db=read();if(db[args.username]?.length) localStorage.setItem('fixture-receipt:'+args.username,'1700000200000');
          db[args.username]=[];save(db);return state(args.username);
        }
        if(window.mode==='queue') return state(args.username);
        return {...state(args.username),error:window.mode};
      }
      if(cmd==='login_account') { window.loginUsername=args.request.username; if(args.request.password==='bad') throw Error('INVALID_CREDENTIALS'); window.mode='success'; return {username:args.request.username,role:'operator'}; }
      throw Error(cmd);
    }};
  });
  await page.goto(server.resolvedUrls.local[0]+'__audit-status');
  const notice=page.getByLabel('操作记录同步状态');
  await notice.getByRole('button',{name:'同步详情',exact:true}).click();
  await notice.getByText('待传操作事件：2 条（含未落盘及异常）',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-audit-severity="warning"]'));
  const oldest=await notice.locator('.audit-sync-facts').innerText();
  assert.match(oldest,/2023/); assert.match(oldest,/最近成功同步.*未知/);
  for(const [mode,reason] of [['request timed out','请求超时'],['HTTP 503','用户中心服务异常'],['unexplained','原因未知']]) {
    await page.evaluate(async mode=>{window.mode=mode;await window.audit.retryReviewAudit();},mode);
    assert.match(await notice.locator('.audit-sync-reason').innerText(),new RegExp(reason));
    assert.match(await notice.innerText(),/待传操作事件：2 条/);
  }
  await page.evaluate(async()=>{window.mode='partial';await window.audit.retryReviewAudit();});
  assert.match(await notice.innerText(),/服务端拒绝 1 条/);
  assert.match(await notice.innerText(),/待传操作事件：1 条/);
  assert.match(await notice.innerText(),/2023/);
  await page.reload();
  await notice.getByText(/异常操作事件：服务端拒绝 1 条/).waitFor();
  await notice.getByRole('button',{name:'同步详情',exact:true}).click();
  assert.match(await notice.locator('.audit-sync-facts').innerText(),/最近成功同步.*2023/);
  await page.evaluate(async()=>{window.failDisk=true;window.audit.beginReviewAudit('/fixture/a','a');try{await window.audit.persistPendingReviewAudit();}catch{}});
  await page.waitForFunction(()=>document.querySelector('[data-audit-severity="danger"]'));
  assert.match(await notice.innerText(),/有丢失风险/);
  assert.match(await notice.innerText(),/未落盘：1 条/);
  await mkdir('artifacts/review-audit',{recursive:true});
  for (const width of [1440,960,390]) {
    await page.setViewportSize({width,height:width===960?680:844});
    const button=notice.getByRole('button',{name:'重试上传',exact:true});
    assert.ok(await button.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=12));
    const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:'artifacts/review-audit/disk-failure-'+width+'.png'});
  }
  await page.evaluate(async()=>{window.mode='partial';await window.audit.retryReviewAudit();});
  assert.equal(await notice.getAttribute('data-audit-severity'),'danger');
  assert.match(await notice.innerText(),/服务端拒绝 1 条/);
  await page.evaluate(async()=>{window.failDisk=false;window.mode='AUTH_REQUIRED';await window.audit.retryReviewAudit();});
  await notice.getByRole('button',{name:'收起详情',exact:true}).click();
  await notice.getByRole('button',{name:'重新登录并补传',exact:true}).click();
  await notice.getByLabel('当前账号密码').fill('bad');
  await notice.getByRole('button',{name:'登录并补传',exact:true}).click();
  await notice.getByText(/失败原因：.*账号或密码不正确/).waitFor();
  await mkdir('artifacts/review-audit',{recursive:true});
  for(const width of [1440,960,390]) {
    await page.setViewportSize({width,height:width===960?680:844});
    await page.locator('main').evaluate(e=>{e.scrollTop=600;});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('main').evaluate(e=>{e.scrollTop=0;});
    for(const control of await notice.locator('button,input:visible').all()) {
      assert.ok(await control.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=12),'control text remains readable');
      const box=await control.boundingBox(); assert.ok(box&&box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=844,'all controls visible');
    }
    assert.ok((await notice.boundingBox()).y>=0,'notice remains visible while scrolling');
    await page.screenshot({path:'artifacts/review-audit/status-'+width+'.png'});
  }
  await notice.getByLabel('当前账号密码').fill('good');
  await notice.getByRole('button',{name:'登录并补传',exact:true}).click();
  await notice.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.loginUsername),'alice');
  assert.equal(await page.evaluate(()=>window.audit.getReviewSyncStatus().pending),0);
  await page.evaluate(()=>window.switchUser('bob'));
  await page.waitForFunction(()=>window.audit.getReviewSyncStatus()?.owner==='test-service:bob');
  assert.equal(await notice.count(),0);
  assert.equal(await page.evaluate(()=>window.audit.getReviewSyncStatus().lastSuccessAtMs),null);
  // Fresh normal queuing stays hidden; monitoring still reveals a backlog.
  await page.evaluate(async()=>{window.mode='queue';window.audit.beginReviewAudit('/fixture/b','b');await window.audit.persistPendingReviewAudit();await window.audit.retryReviewAudit();});
  assert.equal(await notice.count(),0);
  await page.clock.install();
  await page.clock.fastForward(31000);
  await page.waitForFunction(()=>document.querySelector('[data-audit-severity="warning"]'));
  assert.match(await notice.innerText(),/尚未全部上传用户中心/);
  await notice.getByRole('button',{name:'同步详情',exact:true}).click();
  assert.match(await notice.innerText(),/最近成功同步.*未知/);
  await page.evaluate(async()=>{window.mode='success';await window.audit.retryReviewAudit();});
  await notice.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
});
