import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

test('custom reasons persist per account, reorder, remove and fail honestly when storage fails', async t => {
  const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'custom-reason-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__custom-reasons'))return next();res.setHeader('content-type','text/html');
    res.end(await server.transformIndexHtml(req.url,`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {RejectionReasons} from '/src/components/RejectionReasons.tsx';import '/src/styles.css';
      function App(){const [value,change]=useState('');const [user,setUser]=useState('alice');window.switchUser=setUser;return React.createElement('dialog',{className:'rejection-dialog',open:true},React.createElement('h2',{},'不通过原因'),React.createElement('form',{onSubmit:e=>{e.preventDefault();window.submits++}},React.createElement(RejectionReasons,{key:user,username:user,value,onChange:v=>{change(v);window.choice=v},disabled:false})));}window.submits=0;createRoot(document.getElementById('root')).render(React.createElement(App));
    </script></body></html>`));
  });}}]});await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM??chromium.executablePath(),headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:960,height:680}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('delta-viewer.rejection-order.v1:alice',JSON.stringify(['动作失范','骨架抖动']));});
  await page.goto(server.resolvedUrls.local[0]+'__custom-reasons');
  const options=page.getByRole('group',{name:'原因选项'});assert.equal(await options.getByRole('button').first().textContent(),'动作失范');
  const add=async text=>{await page.getByRole('button',{name:'添加常用原因',exact:true}).click();await page.getByLabel('常用原因名称').fill(text);await page.getByLabel('常用原因名称').press('Enter');};
  await add('多路视频不同步');await options.getByRole('button',{name:'多路视频不同步',exact:true}).click();assert.equal(await page.evaluate(()=>window.choice),'其他原因：多路视频不同步');assert.equal(await page.evaluate(()=>window.submits),0);
  await add('多路视频不同步');await page.getByRole('alert').filter({hasText:'已经存在'}).waitFor();await page.getByRole('button',{name:'取消添加'}).click();
  await page.getByRole('button',{name:'调整顺序',exact:true}).click();await options.getByRole('button',{name:'多路视频不同步',exact:true}).dragTo(options.getByRole('button').first());assert.equal(await options.getByRole('button').first().textContent(),'多路视频不同步');
  assert.equal(await options.getByRole('button').last().textContent(),'其他原因');
  await page.getByRole('button',{name:'恢复默认'}).click();assert.equal(await options.getByRole('button').first().textContent(),'骨架抖动');assert.equal(await options.getByRole('button',{name:'多路视频不同步',exact:true}).count(),1);
  await page.getByRole('button',{name:'完成排序'}).click();await page.reload();await options.getByRole('button',{name:'多路视频不同步',exact:true}).waitFor();
  await page.evaluate(()=>window.switchUser('bob'));await page.waitForFunction(()=>!document.querySelector('.rejection-options').textContent.includes('多路视频不同步'));
  await page.evaluate(()=>window.switchUser('alice'));await options.getByRole('button',{name:'多路视频不同步',exact:true}).waitFor();
  await add('第二个常用原因');await page.getByRole('button',{name:'调整顺序',exact:true}).click();await page.getByRole('button',{name:'移除常用原因 第二个常用原因',exact:true}).click();assert.equal(await options.getByRole('button',{name:'第二个常用原因',exact:true}).count(),0);await page.getByRole('button',{name:'完成排序'}).click();
  await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=()=>{throw Error('disk full')}});
  await add('不应假装保存');await page.getByRole('alert').filter({hasText:'未保存'}).waitFor();assert.equal(await options.getByRole('button',{name:'不应假装保存',exact:true}).count(),0);
  await page.evaluate(()=>window.restoreStorage());await page.getByRole('button',{name:'保存常用原因'}).click();await options.getByRole('button',{name:'不应假装保存',exact:true}).waitFor();
  await page.getByRole('button',{name:'添加常用原因',exact:true}).click();await page.getByLabel('常用原因名称').fill('正在填写');
  await mkdir('artifacts/custom-rejection',{recursive:true});
  for(const width of [1440,960,390]){await page.setViewportSize({width,height:844});assert.ok(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`artifacts/custom-rejection/adding-${width}.png`});}
  await page.getByLabel('常用原因名称').press('Escape');assert.equal(await page.getByLabel('常用原因名称').count(),0);assert.deepEqual(errors,[]);
});
