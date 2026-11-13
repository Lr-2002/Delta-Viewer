import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdirSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

const reportRoot=resolve('artifacts/d1-services');mkdirSync(reportRoot,{recursive:true});
let server,browser,origin;const evidence=[];
before(async()=>{
  server=await createServer({server:{host:'127.0.0.1',port:15285,strictPort:false}});await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  const cache=join(homedir(),'.cache/ms-playwright');
  const installed=existsSync(cache)?readdirSync(cache).filter(n=>n.startsWith('chromium-')).map(n=>join(cache,n,'chrome-linux64/chrome')):[];
  const executablePath=[process.env.PLAYWRIGHT_CHROMIUM,chromium.executablePath(),...installed,'/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
  assert.ok(executablePath);browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();await server?.close();writeFileSync(resolve(reportRoot,'report.json'),JSON.stringify({syntheticOnly:true,realDeviceOperations:false,externalRequests:0,evidence},null,2));});

const backend=`
export async function readOtaHistory(){return window.otaHistory??[];}
export async function previewOtaLogs(id,operationId){window.otaPreviewRecord=id;return {...await previewDiagnosticLogs('SSH',operationId),previewId:'frozen-ota-preview'};}
export async function getOtaServiceStatus(){return {enabled:true,origin:null,channel:'factory',trust:'digest_only',trustKeyId:null,detail:'本地测试夹具'};}
export async function previewOtaRelease(){window.previewCalls++;return {previewId:'fixture-preview',releaseId:'fixture-release',version:'1.0.0',channel:'factory',keyId:null,rollbackIndex:null,artifactBytes:123,totalBytes:456,files:[],trust:'digest_only'};}
export async function confirmDeviceOtaUpgrade(){window.confirmCalls++;return window.confirmUpgrade??false;}
export async function submitOtaToDevice(){window.submitCalls++;if(window.submitResult)return window.submitResult;throw Error('fixture must not submit');}
export async function readDeviceOtaStatus(){window.statusCalls++;(window.statusRequests??=[]).push(arguments[0]);if(window.statusError)throw Error('设备连接中断');return window.otaStatus??{available:true,failureCodes:[],reason:null,previousResult:false,state:'SUCCESS',result:'PASS',operationId:'fixture-op',releaseBefore:'fixture-before',releaseTarget:'fixture-after',targetVersion:'1.0.0',active:false,finalState:true,guidance:null,detail:'本地夹具成功'};}
export async function getDiagnosticServiceStatus(){return {enabled:true,origin:null,detail:'本地测试夹具'};}
export async function chooseSessionDirectory(){window.chooseSessionCalls=(window.chooseSessionCalls??0)+1;return '/synthetic/session';}
export async function previewDiagnosticLogs(source,operationId){window.logPreviewOperation=operationId;return {previewId:'frozen-preview',checkCount:3,reportType:'runtime-diagnostic',source,deviceId:'synthetic-device',hasCid:true,workspaceVersion:'1.0.0',releaseId:null,totalEntries:3,selectedEntries:3,levels:{error:0,warning:0,info:3,debug:0},startedAt:null,completedAt:null,truncated:false,fileCount:2};}
export async function uploadDiagnosticLogs(previewId,operationId){window.logRequests.push({previewId,operationId});if(window.logRequests.length===1)throw Error('夹具回执超时');return {reportId:'frozen-report',deviceId:'synthetic-device',entryCount:3,message:'本地夹具已接收'};}
`;

test('OTA status becomes unavailable on disconnect; all three modes query SSH status; logs retry the same report',async()=>{
  for(const width of [1440,960,390]){
    const context=await browser.newContext({viewport:{width,height:920}}),page=await context.newPage();
    const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(url.pathname==='/src/lib/backend.ts')return route.fulfill({contentType:'application/javascript',body:backend});
      if(url.pathname==='/device-services-fixture'){
        const html=await server.transformIndexHtml(url.pathname,`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
          import React from 'react';import{createRoot}from'react-dom/client';
          import{DeviceOtaPanel}from'/src/components/DeviceOtaPanel.tsx';import{DiagnosticLogPanel}from'/src/components/DiagnosticLogPanel.tsx';import'/src/styles.css';import'/src/components/manager-workspace.css';
          window.statusCalls=0;window.previewCalls=0;window.confirmCalls=0;window.submitCalls=0;window.logRequests=[];
          const root=createRoot(document.getElementById('root'));let op=100;
          window.renderPanel=(request,connected)=>root.render(React.createElement('main',{className:'manager-workspace'},
            React.createElement(DeviceOtaPanel,{request,connected,busy:false,beginOperation:()=>({id:++op,finish(){}}),onError:message=>window.lastError=message}),
            React.createElement(DiagnosticLogPanel,{busy:false,beginOperation:()=>({id:++op,finish(){}}),onError:message=>window.lastError=message})));
          window.renderPanel({interfaceId:'lan',apAddress:'192.168.4.1',connectionMode:'lan'},true);
        </script></body></html>`);
        return route.fulfill({contentType:'text/html',body:html});
      }
      return route.continue();
    });
    try{
      await page.goto(origin+'/device-services-fixture');
      await page.getByText('设备报告升级成功。',{exact:false}).waitFor();
      assert.ok(!/未提供/.test(await page.locator('.manager-observed').innerText()));
      await page.getByRole('button',{name:'检查最新版本',exact:true}).click();
      await page.getByRole('button',{name:'开始升级',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.confirmCalls),1);assert.equal(await page.evaluate(()=>window.submitCalls),0);
      await page.evaluate(()=>{window.otaStatus={available:true,state:'FAILED',result:'FAIL',operationId:'early-failure',releaseBefore:'1.1.1',releaseTarget:null,targetVersion:null,active:false,finalState:true,previousResult:true,failureCodes:['OTA_TRUST_ROOT_MISSING'],reason:'release trust root is unavailable',guidance:'设备缺少发布验签公钥，升级尚未进入安装。需要通过设备维护入口恢复可信公钥后再重试；等待或重新上传不能解决。',detail:'上一次升级未成功，请查看设备提示'};});
      await page.getByText('上次升级失败',{exact:true}).waitFor();
      assert.equal(await page.locator('.manager-ota-failure').count(),1);
      assert.equal(await page.getByText('设备缺少发布验签公钥',{exact:false}).count(),1);
      assert.equal(await page.getByText('设备报告升级成功。',{exact:false}).count(),0);
      assert.equal(await page.getByRole('button',{name:'开始升级',exact:true}).isDisabled(),false);
      await page.getByText('技术详情',{exact:true}).click();
      await page.getByText('OTA_TRUST_ROOT_MISSING',{exact:true}).waitFor();
      await page.screenshot({path:resolve(reportRoot,`ota-failure-${width}.png`),fullPage:true});
      await page.evaluate(()=>{window.confirmUpgrade=true;window.submitResult={operationId:'next-operation',releaseId:'fixture-release',message:'设备已接收，等待安装结果'};});
      await page.getByRole('button',{name:'开始升级',exact:true}).click();
      await page.getByText('等待设备开始升级',{exact:true}).waitFor();
      assert.equal(await page.locator('.manager-ota-failure').count(),0);
      assert.equal(await page.locator('.manager-ota-success').count(),0);
      assert.equal(await page.getByRole('button',{name:'开始升级',exact:true}).isDisabled(),true);
      await page.evaluate(()=>{window.otaStatus={...window.otaStatus,operationId:'next-operation',previousResult:false};});
      await page.locator('.manager-ota-failure').getByText('升级失败',{exact:true}).waitFor();
      assert.equal(await page.getByText('设备已接收，等待安装结果',{exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'开始升级',exact:true}).isDisabled(),false);
      await page.evaluate(()=>{window.statusError=true;});
      await page.getByText('设备连接中断',{exact:true}).waitFor();
      assert.equal(await page.getByText('设备报告升级成功。',{exact:false}).count(),0);
      for(const mode of ['type_c','ap','lan']){
        await page.evaluate(mode=>{window.statusError=false;window.renderPanel({interfaceId:mode,apAddress:mode==='type_c'?null:'192.168.4.1',connectionMode:mode},true);},mode);
        await page.waitForFunction(mode=>window.statusRequests.at(-1)?.connectionMode===mode,mode);
        await page.getByRole('button',{name:'检查最新版本',exact:true}).waitFor({state:'visible'});
        assert.equal(await page.getByRole('button',{name:'检查最新版本',exact:true}).isDisabled(),false);
      }
      await page.evaluate(()=>window.renderPanel(null,true));
      await page.getByText('尚未取得设备网络地址，请回到首页重新连接。',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'检查最新版本',exact:true}).isDisabled(),true);
      const calls=await page.evaluate(()=>window.statusCalls);await page.waitForTimeout(3100);assert.equal(await page.evaluate(()=>window.statusCalls),calls);
      await page.evaluate(()=>{window.otaHistory=[{id:'ssh-fixture-history',deviceId:'synthetic-device',cid:'0123456789abcdef0123456789abcdef',operationId:'synthetic-operation',targetVersion:'1.3.1',state:'FAILED',result:'FAIL',startedAtMs:Date.now()-2000,updatedAtMs:Date.now(),events:[{atMs:Date.now(),level:'error',message:'电压低于升级门限'}],truncated:false,receipt:null}];window.renderPanel({interfaceId:'usb-test',connectionMode:'type_c'},true);});
      await page.getByText('升级日志与售后上传（1）',{exact:true}).click();
      await page.getByRole('button',{name:'上传本次升级日志到售后',exact:true}).click();
      const historyPanel=page.locator('.manager-ota-history .manager-support-upload');
      await historyPanel.getByRole('button',{name:'预览本次升级日志',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.otaPreviewRecord),'ssh-fixture-history','upgrade history uses its backend record without a recording folder');
      assert.equal(await page.evaluate(()=>window.chooseSessionCalls??0),0,'upgrade logs never ask for a session directory');
      await historyPanel.getByRole('button',{name:'上传到售后',exact:true}).click();
      await historyPanel.getByText('夹具回执超时',{exact:true}).waitFor();
      await historyPanel.getByRole('button',{name:'上传到售后',exact:true}).click();
      await historyPanel.getByText('本地夹具已接收',{exact:false}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.logRequests.map(r=>r.previewId)),['frozen-ota-preview','frozen-ota-preview']);
      // The ordinary support panel below still exercises immutable retry.
      await page.evaluate(()=>{window.logRequests=[];window.renderPanel(null,false);});
      const supportPanel=page.locator('main > .manager-support-upload');
      await supportPanel.getByRole('button',{name:'预览检测与日志',exact:true}).click();
      await supportPanel.getByText('synthetic-device',{exact:true}).waitFor();
      assert.ok(await page.evaluate(()=>window.logPreviewOperation>100));
      await supportPanel.getByRole('button',{name:'上传到售后',exact:true}).click();
      await supportPanel.getByText('夹具回执超时',{exact:true}).waitFor();
      await supportPanel.getByRole('button',{name:'上传到售后',exact:true}).click();
      await supportPanel.getByText('本地夹具已接收',{exact:false}).waitFor();
      const requests=await page.evaluate(()=>window.logRequests);assert.equal(requests.length,2);assert.equal(requests[0].previewId,requests[1].previewId);assert.equal(requests[0].previewId,"frozen-preview");
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
      await page.screenshot({path:resolve(reportRoot,`services-${width}.png`),fullPage:true});evidence.push({width,status:'passed',staleStateCleared:true,updatedAt:true,allThreeModes:true,cancelConfirmation:true,logRetrySameIdentity:true});
    }finally{await context.close();}
  }
});
