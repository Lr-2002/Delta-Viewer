import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {createServer as tcpServer} from 'node:net';
const freePort=()=>new Promise(resolve=>{const s=tcpServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
import path from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
import {DEFAULT_SHORTCUTS,normalizeShortcuts,shortcutConflicts,shortcutChord,validShortcut,labelShortcutCandidates} from '../src/lib/shortcuts.ts';

test('combinations, overlapping workspaces, digit prefixes and corrupt preferences',()=>{
  assert.equal(shortcutConflicts(DEFAULT_SHORTCUTS).length,0);
  assert.equal(shortcutChord({code:'KeyJ',key:'j',ctrlKey:true,altKey:false,shiftKey:true,metaKey:false,isComposing:false}),'Ctrl+Shift+KeyJ');
  assert.equal(shortcutChord({code:'KeyJ',key:'j',isComposing:true}),null);
  assert.equal(validShortcut('Alt+F4'),false);assert.equal(validShortcut('Ctrl+KeyW'),false);
  assert.equal(validShortcut('Ctrl+Shift+KeyJ'),true);assert.equal(validShortcut('Shift+Ctrl+KeyJ'),false);
  assert.ok(shortcutConflicts({...DEFAULT_SHORTCUTS,faster:'Digit1'}).some(pair=>pair.includes('label1')));
  assert.ok(shortcutConflicts({...DEFAULT_SHORTCUTS,togglePlayback:'Digit1'}).some(pair=>pair.includes('label12')));
  assert.equal(shortcutConflicts({...DEFAULT_SHORTCUTS,mute:'KeyX'}).length,0,'outbound is a separate workspace');
  assert.deepEqual(normalizeShortcuts({nextRecording:'Ctrl+KeyW'}),DEFAULT_SHORTCUTS);
  assert.equal(normalizeShortcuts({nextRecording:''}).nextRecording,'');
  assert.deepEqual(labelShortcutCandidates({...DEFAULT_SHORTCUTS,label1:'F2'},'1',12),[10,11,12]);
});

let server,browser,base,scratch,video;
before(async()=>{
  scratch=mkdtempSync(path.join(os.tmpdir(),'manager-shortcuts-'));
  execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=teal:s=160x90:r=10:d=8','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',path.join(scratch,'video.mp4')]);
  video=readFileSync(path.join(scratch,'video.mp4'));
  server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:await freePort()},plugins:[{name:'shortcut-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    if(req.url!=='/__shortcuts')return next();
    res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ShortcutSettings} from '/src/components/ShortcutSettings.tsx';
      import {ShortcutProvider,useShortcutPreferences} from '/src/lib/use-shortcuts.tsx';
      import {OutboundReviewTasks} from '/src/components/OutboundReviewTasks.tsx';
      import {LanguageToggle} from '/src/components/LanguageToggle.tsx';import '/src/styles.css';
      function Harness(){const [owner,setOwner]=React.useState('service-a:alice'),[settings,setSettings]=React.useState(false),[busy,setBusy]=React.useState(false);const p=useShortcutPreferences(owner);
        window.switchOwner=setOwner;window.setWorkspaceBusy=setBusy;window.bindings=p.bindings;window.saveBindings=p.save;
        React.useEffect(()=>setSettings(false),[owner]);return React.createElement(ShortcutProvider,{bindings:p.bindings},React.createElement(LanguageToggle),React.createElement('button',{onClick:()=>setSettings(true)},'快捷键设置'),settings&&React.createElement(ShortcutSettings,{bindings:p.bindings,onSave:p.save,onClose:()=>setSettings(false)}),React.createElement('input',{'aria-label':'输入测试'}),React.createElement(OutboundReviewTasks,{currentUser:{username:'alice',role:'operator'},view:'workspace',initialBatch:window.batch,workspaceBusy:busy}));}
      createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>`));
  });}}]});
  await server.listen();base=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync)??chromium.executablePath()});
});
after(async()=>{await browser?.close();await server?.close();if(scratch)rmSync(scratch,{recursive:true,force:true});});
async function fixture(){
  const page=await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.addInitScript(()=>{
    window.calls=[];window.frameStep=.1;window.batch={id:'synthetic-batch',name:'快捷键夹具',version:1,claim:'alice',total:3,reviewed:1,valid:1,invalid:0,anomalous:0,rate:null,decisionValues:['valid','invalid','anomalous'],recordings:[0,1,2].map(n=>({id:'recording-'+n,name:'recording-'+n,decision:n===2?{value:'valid',actor:'alice',at:new Date().toISOString()}:null,videos:Array.from({length:14},(_,i)=>({segment:i,label:['cam0','cam1','cam2','t265_left','t265_right','extension_left','extension_right'][i%7]+'/video-'+Math.floor(i/7)+'.mp4',size:1024,sha256:null}))}))};
    window.__TAURI_INTERNALS__={invoke:async(command,{input})=>{
      if(command!=='outbound_review_call')throw Error('Unexpected command');window.calls.push(input);
      if(input.action==='release-media')return {released:true};
      if(input.action==='video-url')return {url:'http://127.0.0.1:17880/outbound-media/'+(input.segment+1).toString(16).padStart(64,'0')};
      if(input.action==='media-metadata')return {duration:8};
      if(input.action==='media-frame-step'){if(window.holdFrame)await new Promise(r=>window.releaseFrame=r);return {frameStep:window.frameStep};}
      if(input.action==='media-status')return {code:null};
      if(input.action==='list')return {batches:[structuredClone(window.batch)],reasonOptions:[],anomalousReasonOptions:[]};
      throw Error('Unexpected mutation '+input.action);
    }};
  });
  await page.route('http://127.0.0.1:17880/**',async route=>{
    const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range??''),start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),video.length-1):video.length-1;
    await route.fulfill({status:range?206:200,body:video.subarray(start,end+1),headers:{'content-type':'video/mp4','access-control-allow-origin':'*','accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${video.length}`}:{})}});
  });
  await page.goto(base+'/__shortcuts');await ready(page);return {page,errors};
}
async function ready(page){await page.waitForFunction(()=>document.querySelectorAll('video').length===7&&[...document.querySelectorAll('video')].every(v=>v.readyState>=3));}
const selected=page=>page.locator('.outbound-recordings [aria-pressed="true"]').innerText();
async function bodyKey(page,key){await page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus();});await page.keyboard.press(key);}
async function setKey(page,label,key){await page.getByRole('button',{name:'设置'+label+'快捷键',exact:true}).click();await page.keyboard.press(key);}

test('settings save per account and service, show conflicts, restore and retain media in three sizes',async()=>{
  const {page,errors}=await fixture();
  try{
    await page.evaluate(()=>window.originalVideo=document.querySelector('video'));
    await page.getByRole('button',{name:'快捷键设置',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'快捷键设置'});
    await setKey(page,'下一条数据','Control+j');await setKey(page,'上一条数据','Control+j');
    assert.equal(await dialog.getByRole('button',{name:'保存快捷键'}).isDisabled(),true);
    await dialog.getByRole('button',{name:'恢复上一条数据默认快捷键'}).click();
    await setKey(page,'播放／暂停','F5');await dialog.getByText('此组合键由系统或窗口使用，请选择其他按键。').waitFor();
    await page.keyboard.press('Escape');await setKey(page,'播放／暂停','k');
    await dialog.getByRole('button',{name:'清除主相机静音／恢复声音快捷键'}).click();
    mkdirSync('artifacts/shortcuts',{recursive:true});
    for(const [width,height] of [[1440,920],[960,680],[390,844]]){
      await page.setViewportSize({width,height});
      assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'dialog '+width);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'page '+width);
      await page.screenshot({path:`artifacts/shortcuts/settings-${width}.png`,fullPage:true});
    }
    await dialog.getByRole('button',{name:'保存快捷键'}).click();
    assert.equal(await page.evaluate(()=>window.bindings.nextRecording),'Ctrl+KeyJ');
    assert.equal(await page.evaluate(()=>window.originalVideo===document.querySelector('video')),true,'settings must not remount playback');
    await page.reload();await ready(page);assert.equal(await page.evaluate(()=>window.bindings.togglePlayback),'KeyK');
    for(const owner of ['service-a:bob','service-b:alice','offline:local:v1']){
      await page.evaluate(owner=>window.switchOwner(owner),owner);
      await page.waitForFunction(()=>window.bindings.nextRecording==='PageDown');
    }
    await page.evaluate(()=>window.switchOwner('service-a:alice'));await page.waitForFunction(()=>window.bindings.nextRecording==='Ctrl+KeyJ');
    await page.getByRole('button',{name:'快捷键设置',exact:true}).click();
    await setKey(page,'下一条数据','Control+l');
    await page.evaluate(()=>{window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw Error('disk full');};});
    await dialog.getByRole('button',{name:'保存快捷键'}).click();await dialog.getByText('无法保存快捷键，请重试。').waitFor();
    assert.equal(await page.evaluate(()=>window.bindings.nextRecording),'Ctrl+KeyJ');
    await page.evaluate(()=>Storage.prototype.setItem=window.realSetItem);
    await dialog.getByRole('button',{name:'全部恢复默认'}).click();await dialog.getByRole('button',{name:'保存快捷键'}).click();
    assert.deepEqual(await page.evaluate(()=>window.bindings),DEFAULT_SHORTCUTS);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('outbound navigation and playback never submit a review; frame lookup cannot override a newer recording',async()=>{
  const {page,errors}=await fixture();
  try{
    await bodyKey(page,'PageDown');await page.waitForFunction(()=>document.querySelector('.outbound-recordings .selected')?.textContent.includes('recording-1'),null,{timeout:5000}).catch(async e=>{console.error('SHORTCUT_STATE',await page.evaluate(async()=>({selected:document.querySelector('.outbound-recordings .selected')?.textContent,active:document.activeElement.outerHTML,dialogs:[...document.querySelectorAll("dialog[open], [role='dialog']")].map(e=>e.outerHTML),bindings:window.bindings,calls:window.calls.slice(-5)})));throw e;});await ready(page);
    await bodyKey(page,'PageDown');await page.waitForFunction(()=>document.querySelector('.outbound-recordings .selected')?.textContent.includes('recording-2'));await ready(page);
    await bodyKey(page,'PageDown');assert.match(await selected(page),/recording-2/);
    await bodyKey(page,'PageUp');await ready(page);
    await bodyKey(page,'ArrowDown');await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.src.endsWith('8')||v.src.endsWith('9')||v.src.endsWith('a')||v.src.endsWith('b')||v.src.endsWith('c')||v.src.endsWith('d')||v.src.endsWith('e')));await ready(page);
    await bodyKey(page,'ArrowUp');await ready(page);
    await page.getByRole('button',{name:'快捷键设置',exact:true}).click();await setKey(page,'下一条数据','Control+j');await setKey(page,'播放／暂停','k');await page.getByRole('button',{name:'保存快捷键'}).click();
    await bodyKey(page,'PageDown');assert.match(await selected(page),/recording-1/);
    await page.getByLabel('输入测试').focus();await page.keyboard.press('Control+j');assert.match(await selected(page),/recording-1/);
    await page.evaluate(()=>window.setWorkspaceBusy(true));await page.waitForFunction(()=>document.querySelector('.outbound-recordings button').disabled);await bodyKey(page,'Control+j');assert.match(await selected(page),/recording-1/);await page.evaluate(()=>window.setWorkspaceBusy(false));await page.waitForFunction(()=>!document.querySelector('.outbound-recordings button').disabled);
    await page.getByRole('button',{name:'快捷键设置',exact:true}).click();await page.keyboard.press('Control+j');assert.match(await selected(page),/recording-1/);await page.getByRole('button',{name:'取消',exact:true}).click();
    await bodyKey(page,'k');await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>!v.paused));await bodyKey(page,'k');await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.paused));
    await page.getByRole('slider',{name:'视频播放位置'}).fill('2');await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-2)<.02);
    await bodyKey(page,'ArrowRight');await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-2.1)<.02);
    await bodyKey(page,'ArrowLeft');await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-2)<.02);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='media-frame-step').length),1,'cache only confirmed current source timing');
    await bodyKey(page,'Equal');assert.equal(await page.getByLabel('播放速度',{exact:true}).inputValue(),'1.25');await bodyKey(page,'Minus');
    await bodyKey(page,'Home');await page.waitForFunction(()=>document.querySelector('video').currentTime<.01);
    await bodyKey(page,'Control+j');await ready(page);assert.match(await selected(page),/recording-2/);
    await page.evaluate(()=>{window.frameStep=null;});await bodyKey(page,'ArrowRight');await page.getByText('当前视频无法确认恒定帧间隔，暂不支持精确逐帧。其他播放和审核操作仍可使用。').waitFor();
    assert.equal(await page.getByRole('button',{name:'异常数据',exact:true}).isEnabled(),true);
    await bodyKey(page,'PageUp');await ready(page);await page.evaluate(()=>{window.frameStep=.1;window.holdFrame=true;});await bodyKey(page,'ArrowRight');await page.waitForFunction(()=>!!window.releaseFrame);
    await bodyKey(page,'Control+j');await ready(page);await page.evaluate(()=>window.releaseFrame());
    await page.waitForFunction(()=>document.querySelector('video').currentTime<.01);
    assert.equal(await page.evaluate(()=>window.calls.some(c=>['claim','release','decide','save-reason-option'].includes(c.action))),false);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('App settings drive local review, preserve multi-digit labels and navigate without a conclusion',async()=>{
  const page=await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.addInitScript(()=>localStorage.setItem('dohc-viewer.machine-label-library.v1:shortcut-reviewer',JSON.stringify(Array.from({length:12},(_,i)=>({id:'label-'+i,text:'常用动作描述 '+(i+1),createdAt:i+1})))));
    await page.goto(base+'/?demoScenario=session-activation&machineAnnotation=present');
    await page.getByRole('button',{name:'登录工作区'}).or(page.getByLabel('显示名称')).first().waitFor();
    if(await page.getByRole('button',{name:'登录工作区'}).count())await page.getByRole('button',{name:'登录工作区'}).click();
    await page.getByLabel('显示名称').fill('Shortcut reviewer');await page.locator('input[autocomplete="username"]').fill('shortcut-reviewer');
    await page.locator('input[type="password"]').nth(0).fill('demo-password-123');await page.locator('input[type="password"]').nth(1).fill('demo-password-123');await page.getByRole('button',{name:'创建并登录'}).click();
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'数据工作区',exact:true}).click();
    await page.getByRole('button',{name:'知道了',exact:true}).evaluateAll(items=>items[0]?.click());
    const editor=page.getByLabel('复核动作描述',{exact:true});await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.disabled===false);
    await page.getByRole('button',{name:'快捷键设置',exact:true}).click();await setKey(page,'播放／暂停','k');
    await page.locator('.shortcut-settings summary').click();await setKey(page,'常用标签 1','F2');await page.getByRole('button',{name:'保存快捷键'}).click();
    await bodyKey(page,'F2');await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]').value==='常用动作描述 1');
    await bodyKey(page,'1');await page.keyboard.press('2');await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]').value==='常用动作描述 12');
    await editor.focus();await page.keyboard.type('1');assert.equal(await editor.inputValue(),'常用动作描述 121','typing never selects a label');
    await bodyKey(page,'k');await page.getByRole('button',{name:'暂停',exact:true}).waitFor();await bodyKey(page,'k');await page.getByRole('button',{name:'全局播放',exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.quality-save-state')?.textContent.includes('正在保存'));
    await bodyKey(page,'PageDown');await page.waitForFunction(()=>document.querySelector('.episode-item.selected')?.textContent.includes('session-b'));
    const review=await page.evaluate(async()=> (await import('/src/lib/backend.ts')).loadMachineReview('demo://session-activation/session-a'));
    assert.equal(review.status,'pending');
    assert.deepEqual(errors,[]);
  }catch(e){console.error('SHORTCUT_APP_STATE',await page.locator('body').innerText(),errors);throw e;}finally{await page.close();}
});
