import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {createServer as createTcpServer} from 'node:net';
const availablePort=()=>new Promise((resolve,reject)=>{const server=createTcpServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
import { createServer } from 'vite';
import ts from 'typescript';
import { chromium } from 'playwright-core';

const catalogue = JSON.parse(readFileSync(new URL('../src/lib/messages.en.json', import.meta.url)));
test('English catalogue retains placeholders and stable diagnostic codes', () => {
  for (const [source, translated] of Object.entries(catalogue)) {
    assert.ok(translated.trim(), source);
    assert.doesNotMatch(translated, /_Other Organiser|== sync|I don.t think so|I.m sorry|Bonobo|Could not close temporary folder|Synchronising/i, source);
    assert.doesNotMatch(translated, /[\u3400-\u9fff]/, source);
    assert.deepEqual([...translated.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort(), [...source.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort(), source);
    const code=/^([A-Z][A-Z0-9_]+):/.exec(source);
    if(code) assert.ok(translated.startsWith(code[1]+':'), source);
  }
});

test('all explicit Chinese presentation messages have English entries', () => {
  const componentRoot=new URL('../src/components/',import.meta.url);
  const files=[new URL('../src/App.tsx',import.meta.url),...readdirSync(componentRoot).filter(name=>name.endsWith('.tsx')).map(name=>new URL(name,componentRoot))];
  for(const file of files){
    const ast=ts.createSourceFile(file.pathname,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const walk=node=>{
      if(ts.isCallExpression(node)&&node.expression.getText(ast)==='t'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])){
        const source=node.arguments[0].text;
        if(/[\u3400-\u9fff]/.test(source))assert.ok(Object.hasOwn(catalogue,source),file.pathname+': '+source);
      }
      if(ts.isJsxText(node))assert.doesNotMatch(node.text,/[\u3400-\u9fff]/,file.pathname);
      ts.forEachChild(node,walk);
    };walk(ast);
  }
});

test('language switches preserve auth fields, modal state, device forms and preferences', async () => {
  const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:await availablePort()},plugins:[{
    name:'language-state-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(req.url!=='/__language')return next();
      res.setHeader('content-type','text/html');
      res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {AuthScreen} from '/src/components/AuthScreen.tsx';
        import {LanguageToggle} from '/src/components/LanguageToggle.tsx';
        import {DevicePageView} from '/src/components/DevicePageView.tsx';
        import {t,tr,useLanguage} from '/src/lib/i18n.ts';import '/src/styles.css';
        const page={address:'192.168.4.1',observedAtMs:Date.now(),status:null,html:'<h1>DOHC 设备状态</h1><form><label>用户名字<input name="deviceName" value="任务中心"></label><label>Wi-Fi 密码<input type="password" name="password"></label><select name="task"><option>测试数据</option><option>设备没有正确佩戴</option></select><button type="button">保存</button></form><p id="deviceId">任务中心</p><p>当前任务：任务中心</p><p>更新于 17:32</p><button type="button" id="eventButton">刷新状态</button><script>document.getElementById("eventButton").addEventListener("click",()=>document.getElementById("eventButton").textContent="读取中");<\\/script>'};
        function Harness(){useLanguage();return React.createElement(React.Fragment,null,React.createElement(LanguageToggle),React.createElement(AuthScreen,{workspaceMode:'managed',userCenter:{configured:true},allowDemoRegistration:false,onChooseMode:async()=>{},onWorkspaceModeSelected:async()=>{},onAuthenticated:()=>{},onUserCenterConfigured:()=>{}}),React.createElement('button',{id:'modal-open',onClick:()=>document.querySelector('dialog').showModal()},t('修改')),React.createElement('dialog',null,React.createElement('h2',null,t('修改显示名称')),React.createElement('input',{defaultValue:'任务中心'}),React.createElement('button',{onClick:()=>document.querySelector('dialog').close()},t('关闭'))),React.createElement(DevicePageView,{page,busy:false,showConnectionMode:false,connectionModeLabel:'',onBack:()=>{},onRefresh:()=>{},onRequest:async()=>{throw Error('No device operations allowed')},onVerifyAddress:async()=>page}));}
        createRoot(document.getElementById('root')).render(React.createElement(Harness));
      </script></body></html>`));
    });}
  }]});
  let browser;
  try{
    await server.listen();
    const executablePath=process.env.PLAYWRIGHT_CHROMIUM??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync)??chromium.executablePath();
    browser=await chromium.launch({executablePath,headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:920}}), errors=[],failed=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('requestfailed',r=>failed.push(r.url()));
    const url=`http://127.0.0.1:${server.httpServer.address().port}/__language`;
    await page.goto(url);
    await page.getByLabel('账号',{exact:true}).fill('reviewer_1');
    await page.locator('#auth-password').fill('Local-test-password');
    await page.getByRole('button',{name:'显示密码',exact:true}).click();
    const frame=page.frameLocator('iframe');await frame.getByRole('heading',{name:'DOHC 设备状态'}).waitFor();
    await frame.locator('input[name="deviceName"]').fill('任务中心');
    await frame.locator('input[name="password"]').fill('Private-fixture-password');
    await frame.locator('select').selectOption({label:'设备没有正确佩戴'});
    await page.evaluate(()=>{window.authField=document.querySelector('#auth-password');window.deviceFrame=document.querySelector('iframe');});
    await page.getByRole('button',{name:'Switch to English',exact:true}).click();
    await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();
    assert.equal(await page.getByLabel('Account',{exact:true}).inputValue(),'reviewer_1');
    assert.equal(await page.locator('#auth-password').inputValue(),'Local-test-password');
    assert.equal(await page.locator('#auth-password').getAttribute('type'),'text');
    assert.equal(await page.evaluate(()=>window.authField===document.querySelector('#auth-password')&&window.deviceFrame===document.querySelector('iframe')),true);
    await frame.getByRole('heading',{name:'DOHC device status'}).waitFor();
    assert.equal(await frame.locator('input[name="deviceName"]').inputValue(),'任务中心');
    assert.equal(await frame.locator('input[name="password"]').inputValue(),'Private-fixture-password');
    assert.equal(await frame.locator('select').inputValue(),'设备没有正确佩戴');
    assert.equal(await frame.locator('#deviceId').textContent(),'任务中心');
    await frame.getByText('Current task: 任务中心',{exact:true}).waitFor();
    await frame.getByText('Updated at 17:32',{exact:true}).waitFor();
    await frame.getByRole('button',{name:'Refresh status',exact:true}).click();
    await frame.getByRole('button',{name:'Reading',exact:true}).waitFor();
    await page.locator('#modal-open').click();await page.locator('dialog[open]').waitFor();
    await page.getByRole('button',{name:'切换为中文',exact:true}).click();
    assert.equal(await page.getByRole('dialog').isVisible(),true);
    assert.equal(await page.getByRole('dialog').locator('input').inputValue(),'任务中心');
    await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
    await frame.getByRole('button',{name:'读取中',exact:true}).waitFor();
    assert.equal(await frame.locator('select').inputValue(),'设备没有正确佩戴');
    const report='artifacts/i18n';mkdirSync(report,{recursive:true});
    for(const language of ['zh','en']){
      if(language==='en')await page.getByRole('button',{name:'Switch to English',exact:true}).click();
      for(const [width,height] of [[1440,920],[960,680],[390,844]]){
        await page.setViewportSize({width,height});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,language+' '+width);
        await page.screenshot({path:`${report}/forms-${language}-${width}.png`,fullPage:true});
      }
    }
    await page.reload();await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),'en-US');
    assert.equal(await page.evaluate(()=>localStorage.getItem('d1-manager-language-v1')),'en');
    // Presentation matching must stay bounded on hostile diagnostic text.
    const elapsed=await page.evaluate(async()=>{const {tr}=await import('/src/lib/i18n.ts');const start=performance.now();for(let i=0;i<200;i++)tr('审核'+(' / · ，'.repeat(600))+'不存在'+i);return performance.now()-start;});
    assert.ok(elapsed<1000,`bounded diagnostic localization: ${elapsed}ms`);
    await page.setViewportSize({width:1440,height:920});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?machineAnnotation=present`);
    await page.getByRole('button',{name:/Offline mode/}).click();
    await page.getByRole('button',{name:'Data workspace',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.frame-image').length===5&&[...document.querySelectorAll('.frame-image')].every(image=>image.naturalWidth>0));
    for(const language of ['en','zh']){
      if(language==='zh')await page.getByRole('button',{name:'切换为中文',exact:true}).click();
      const tabs=language==='en'?['Proofread','Checks','Export','Batch']:['校对','检查','导出','批量'];
      for(const tab of tabs){
        await page.getByRole('button',{name:tab,exact:true}).click();
        for(const [width,height] of [[1440,920],[960,680],[390,844]]){
          await page.setViewportSize({width,height});
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${language} ${tab} ${width}`);
          await page.screenshot({path:`${report}/workspace-${language}-${tabs.indexOf(tab)}-${width}.png`,fullPage:true});
        }
      }
    }
    const dialogs=await page.evaluate(async()=>{
      const calls=[];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{calls.push({command,args});return command.includes('open')?null:true;}};
      try{const backend=await import('/src/lib/backend.ts');const {setLanguage}=await import('/src/lib/i18n.ts');setLanguage('en');
        await backend.chooseDirectory('选择数据根目录');await backend.confirmAction('确认删除','删除任务');await backend.confirmDeviceOtaUpgrade('9.8.7');return calls;
      }finally{delete window.__TAURI_INTERNALS__;}
    });
    assert.equal(dialogs.length,3);
    assert.equal(dialogs[0].args.options.title,'Choose data root directory');
    assert.equal(dialogs[1].args.title??dialogs[1].args.options?.title,'Delete task');
    assert.equal(dialogs[2].args.title??dialogs[2].args.options?.title,'Confirm device upgrade');
    assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  }finally{await browser?.close();await server.close();}
});
