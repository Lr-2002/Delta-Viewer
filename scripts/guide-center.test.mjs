import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import test from 'node:test';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

test('documentation works offline in both languages, preserves work, and guides real acknowledged actions', {timeout:120000}, async()=>{
  const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error',plugins:[{
    name:'guide-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(req.url!=='/__guide')return next();
      res.setHeader('content-type','text/html');
      res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
      import React from 'react';import {createRoot} from 'react-dom/client';import {FolderOpen} from 'lucide-react';
      import {GuideCenter} from '/src/components/guides/GuideCenter.tsx';
      import {LanguageToggle} from '/src/components/LanguageToggle.tsx';
      import {DevicePageView} from '/src/components/DevicePageView.tsx';
      import {lessons,areas} from '/src/components/guides/catalog.ts';
      import '/src/styles.css';window.guideCatalog={lessons,areas};
      const page={address:'192.168.4.1',title:'Fixture',status:null,html:'<form method="post" action="/configure"><label>Wi-Fi<input name="ssid"></label><label>Password<input type="password" name="password"></label><button type="submit">Save</button></form>'};
      function Fixture(){const [opens,setOpens]=React.useState(0);return React.createElement(React.Fragment,null,
        React.createElement('header',{className:'topbar'},React.createElement('div',{className:'topbar-actions'},React.createElement('button',{className:'button',onClick:()=>setOpens(n=>n+1)},React.createElement(FolderOpen),'选择 SD 卡 / 选择数据目录'))),
        React.createElement('nav',{className:'workspace-navigation'},React.createElement('button',null,'设备管理区'),React.createElement('button',null,'数据工作区')),
        React.createElement('span',{'data-opens':opens},opens),React.createElement('input',{id:'preserved',defaultValue:'unsaved draft'}),
        React.createElement(DevicePageView,{page,busy:false,showConnectionMode:false,connectionModeLabel:'AP',onBack:()=>{},onRefresh:()=>{},onRequest:async()=>{throw Error('Fixture forbids device writes')},onVerifyAddress:async()=>page}),
        React.createElement(GuideCenter),React.createElement(LanguageToggle));}
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      </script></body></html>`));
    });}
  }]});
  let browser;
  try{
    await server.listen();
    browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync)??chromium.executablePath(),headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:920}}),errors=[],failed=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>failed.push(r.url()));
    await page.route('**/*',async route=>{const url=new URL(route.request().url());if(!['127.0.0.1','localhost','data:'].includes(url.hostname)&&url.protocol!=='data:')throw Error('Unexpected external documentation request');await route.continue();});
    const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(origin+'/__guide');await page.locator('.guide-entry').waitFor();
    const counts=await page.evaluate(()=>{
      const {lessons,areas}=window.guideCatalog;const ids=new Set();
      for(const l of lessons){if(ids.has(l.id)||!areas.some(a=>a[0]===l.area)||l.title.some(x=>!x.trim())||!l.steps.length)throw Error('Bad lesson '+l.id);ids.add(l.id);
        for(const s of l.steps){if(s.label.length!==2||s.label.some(x=>!x.trim()))throw Error('Missing translation');if(!s.target.startsWith('frame:'))document.querySelector(s.target);}
      }
      return {lessons:lessons.length,steps:lessons.reduce((n,l)=>n+l.steps.length,0),wikis:[...new Set(lessons.map(l=>l.wiki).filter(Boolean))]};
    });
    assert.ok(counts.lessons>=121);assert.ok(counts.steps>=480);
    for(const wiki of counts.wikis)assert.ok(existsSync('docs/wiki/'+wiki+'.md'),wiki);
    const open=async()=>{await page.locator('.guide-entry').click();await page.locator('.guide-center[open]').waitFor();};
    const select=async title=>{await page.locator('.guide-search input').fill(title);await page.locator('.guide-library nav').getByRole('button',{name:title,exact:true}).click();};
    await open();await select('选择目录、打开录制并播放');
    await page.locator('.guide-screenshot img').first().waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('.guide-screenshot img')].every(x=>x.complete&&x.naturalWidth>0));
    await page.getByRole('button',{name:'开始互动引导',exact:true}).click();
    await page.locator('.workspace-navigation button:last-child').click();
    await page.waitForFunction(()=>document.querySelector('.guide-tip h3')?.textContent.includes('选择 SD 卡'));
    // A different control never completes the highlighted step.
    await page.evaluate(()=>document.querySelector('.workspace-navigation button:first-child').click());
    assert.match(await page.locator('.guide-tip h3').textContent(),/选择 SD 卡/);
    await page.locator('.topbar-actions > .button:not(.guide-entry)').click();
    await page.waitForFunction(()=>document.querySelector('.guide-overlay')?.dataset.guideState==='waiting');
    assert.equal(await page.locator('[data-opens]').getAttribute('data-opens'),'1');
    // A dismissed/failed native picker produces no success event and cannot advance.
    await page.waitForTimeout(220);assert.match(await page.locator('.guide-tip h3').textContent(),/选择 SD 卡/);
    await page.evaluate(()=>window.dispatchEvent(new Event('d1-guide-source-selected')));
    await page.waitForFunction(()=>localStorage.getItem('d1-manager-guide-progress-v1')?.includes('"open-recording":2'));
    await page.locator('.guide-tip').getByRole('button',{name:'退出引导',exact:true}).last().click();
    await page.getByRole('button',{name:'继续学习',exact:true}).waitFor();
    await page.getByRole('button',{name:'继续学习',exact:true}).click();
    assert.match(await page.locator('.guide-tip h3').textContent(),/录制/);
    await page.keyboard.press('Escape');await page.locator('.guide-center[open]').waitFor();
    await page.getByRole('button',{name:'重新学习',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.guide-tip header')?.textContent.includes('1 /'));
    await page.keyboard.press('Escape');
    // Real sandbox messages can locate fixed controls and accept trusted input.
    await select('提交配网、核验新 IP 与失败重试');
    await page.getByRole('button',{name:'开始互动引导',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.guide-overlay')?.dataset.guideState==='ready');
    await page.evaluate(()=>window.postMessage({type:'d1-page-guide-action',token:'wrong',selector:'wifi-name',action:'change'},'*'));
    assert.match(await page.locator('.guide-tip h3').textContent(),/Wi-Fi 名称/);
    const frame=page.frameLocator('iframe');await frame.locator('[name=ssid]').fill('Fixture network');await frame.locator('[name=ssid]').press('Tab');
    await page.waitForFunction(()=>document.querySelector('.guide-tip h3')?.textContent.includes('Wi-Fi 密码'));
    await page.keyboard.press('Escape');
    // Both locales render and search new features without remounting the business form.
    await page.evaluate(()=>window.originalDraft=document.querySelector('#preserved'));
    const report='artifacts/documentation';mkdirSync(report,{recursive:true});
    for(const locale of ['zh','en']){
      if(locale==='en')await page.locator('.guide-header-actions').getByRole('button',{name:'Switch to English',exact:true}).click();
      await select(locale==='zh'?'开启高速浏览并恢复精确检查':'Use fast browsing and return to precise inspection');
      await page.getByRole('button',{name:locale==='zh'?'当前功能手册':'Current feature manual',exact:true}).click();
      const text=await page.locator('.guide-wiki-content').textContent();
      assert.ok(text.includes('PageUp/PageDown'));assert.ok(text.includes('support-bundle'));
      if(locale==='en')assert.equal(/[\u3400-\u9fff]/.test(text),false);
      for(const [width,height]of [[1440,920],[960,680],[390,844]]){
        await page.setViewportSize({width,height});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,locale+' page '+width);
        assert.equal(await page.locator('.guide-center').evaluate(el=>el.scrollWidth<=el.clientWidth),true,locale+' dialog '+width);
        assert.equal(await page.locator('.guide-center .button-secondary').evaluateAll(nodes=>nodes.every(n=>parseFloat(getComputedStyle(n).fontSize)>0)),true,locale+' readable buttons '+width);
        await page.screenshot({path:report+'/manual-'+locale+'-'+width+'.png'});
      }
    }
    assert.equal(await page.evaluate(()=>window.originalDraft===document.querySelector('#preserved')),true);
    assert.equal(await page.locator('#preserved').inputValue(),'unsaved draft');
    await page.locator('.guide-search input').fill('no-such-guide-xyz');await page.getByText('No guides match this search.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Show all guides',exact:true}).click();
    await page.getByRole('button',{name:'Close documentation',exact:true}).click();
    await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'en-US');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('d1-manager-guide-progress-v1'))['open-recording']),0);
    // Integration with the real app: complete entry navigation, read bundled images, keep frames.
    await page.setViewportSize({width:1440,height:920});await page.goto(origin+'/?machineAnnotation=present');
    await page.locator('.guide-entry').click();await select('Enter offline mode and find the two workspaces');
    await page.getByRole('button',{name:'Start interactive guide',exact:true}).click();
    await page.getByRole('button',{name:/Offline mode/}).click();
    await page.getByRole('button',{name:'Data workspace',exact:true}).click();
    await page.getByRole('button',{name:'Device workspace',exact:true}).click();
    await page.getByText('Guide completed',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Close documentation',exact:true}).click();
    await page.getByRole('button',{name:'Data workspace',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.frame-image').length===5&&[...document.querySelectorAll('.frame-image')].every(v=>v.naturalWidth>0));
    await page.locator('.guide-entry').click();await select('Customize shortcuts for your account');
    await page.getByRole('button',{name:'Start interactive guide',exact:true}).click();
    await page.getByRole('button',{name:'Keyboard shortcuts',exact:true}).click();
    await page.locator('.shortcut-search input').fill('play');await page.locator('.shortcut-search input').press('Tab');
    await page.locator('.guide-tip-actions').getByRole('button',{name:'Continue',exact:true}).click();
    await page.getByRole('button',{name:'Save shortcuts',exact:true}).click();await page.getByText('Guide completed',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Close documentation',exact:true}).click();
    assert.equal(await page.locator('.frame-image').count(),5);
    assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
    console.log('Guide catalog:',counts.lessons,'lessons,',counts.steps,'steps');
  }finally{await browser?.close();await server.close();}
});
