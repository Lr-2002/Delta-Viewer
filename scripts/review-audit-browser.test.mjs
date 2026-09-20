import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("review sync supports in-place authentication and retry without losing error details", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{ name: "audit-notice-fixture", configureServer(server) {
    server.middlewares.use(async (request,response,next) => {
      if(request.url !== "/__audit-test") return next();
      response.setHeader("content-type","text/html");
      response.end(await server.transformIndexHtml(request.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {AuditSyncNotice} from '/src/components/AuditSyncNotice.tsx'; import '/src/styles.css';
        function App(){const [error,setError]=useState('监管记录 12000 条已保存在本机，待上传；AUTH_REQUIRED');
          window.setAuditError=setError;
          return React.createElement(AuditSyncNotice,{username:'alice',error,onError:setError,onPendingChange:()=>{},autoRetry:false,message:'监管记录同步状态',flush:async()=>{window.flushCalls++;return 0;}});}
        createRoot(document.getElementById('root')).render(React.createElement(App));
      </script></body></html>`));
    });
  }}]});
  await server.listen();
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM ?? ["/usr/bin/google-chrome","/usr/bin/chromium"].find(existsSync) ?? chromium.executablePath();
  const browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:920}});
  const errors=[]; page.on("pageerror",error=>errors.push(String(error)));
  try{
    await page.addInitScript(()=>{
      window.flushCalls=0;
      window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
        if(command==='login_account'){window.loginArgs=args;return {username:'alice',displayName:'Alice',role:'operator'};}
        throw Error(command);
      }};
    });
    await page.goto(`${server.resolvedUrls.local[0]}__audit-test`);
    await page.getByRole('button',{name:'重新登录',exact:true}).click();
    await page.getByLabel('当前账号密码').fill('test-password');
    await page.getByRole('button',{name:'登录并补传',exact:true}).click();
    await page.waitForFunction(()=>window.flushCalls===1);
    assert.equal(await page.getByLabel('当前账号密码').count(),0);
    assert.equal(await page.evaluate(()=>window.loginArgs.request.username),'alice');
    await page.evaluate(()=>window.setAuditError('监管记录 12000 条已保存在本机，待上传；REVIEW_EVENT_INVALID: '+ 'x'.repeat(400)));
    await mkdir('artifacts/review-audit',{recursive:true});
    for(const width of [1440,960,390]){
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:`artifacts/review-audit/notice-${width}.png`,fullPage:true});
    }
    await page.getByRole('button',{name:'重试上传',exact:true}).click();
    await page.waitForFunction(()=>window.flushCalls===2);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await server.close();}
});
