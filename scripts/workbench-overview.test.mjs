import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, mkdir} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const origin=process.env.WORKBENCH_TEST_ORIGIN;
test('Viewer overview is anonymous, read-only, filterable and exportable', {skip:!origin}, async()=>{
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM ?? ['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync) ?? chromium.executablePath();
  const browser=await chromium.launch({executablePath,headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:920}});
  const page=await context.newPage();
  const errors=[],calls=[];
  page.on('pageerror',e=>errors.push(String(e)));
  const start=Date.parse('2026-09-23T09:00:00+08:00');
  const session={kind:'work',records:3,approved:2,rejected:1,start_ms:start,end_ms:start+3600000,review_seconds:3600,original_hours:0.1,known_final_hours:0.05};
  const daily={date:'2026-09-23',username:'fixture',reviewer:'测试审核员',records:3,approved:2,rejected:1,review_hours:1,original_hours:0.1,known_original_hours:0.1,active_original_hours:0.1,timed_records:3,active_records:3,rest_records:0,rest_seconds:0,started_at_ms:start,ended_at_ms:start+3600000,sessions:[session]};
  const data={loading:false,reviewer_ready:true,counts:{approved:2,rejected:1},known_original_hours:0.1,approved_original_hours:0.08,approved_original_verified:2,approved_original_missing:0,known_final_hours:0.05,final_verified:2,final_missing:0,people:[{username:'fixture',name:'测试审核员'}],daily:[daily],rows:[],batches:[],total:3,page:1,pages:1,indexed_at:'2026-09-23T02:00:00Z'};
  try{
    if(process.env.WORKBENCH_TEST_SCRIPT)await page.route('**/qc-management.js',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(process.env.WORKBENCH_TEST_SCRIPT,'utf8')}));
    await page.route('**/preview-session',route=>route.fulfill({json:{token:'test-local-token'}}));
    await page.route('**/api/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      calls.push({path:url.pathname,query:url.searchParams,method:request.method(),cookie:request.headers().cookie});
      if(url.pathname==='/api/qc/management'){
        if(!request.headers()['x-local-token'])return route.fulfill({status:401,json:{error:'Local authorization required'}});
        return route.fulfill({json:data});
      }
      if(url.pathname==='/api/account')return route.fulfill({json:{configured:true,current_user:null}});
      return route.fulfill({status:403,json:{error:'forbidden test endpoint'}});
    });
    await context.addCookies([{name:'unrelated-admin-session',value:'must-not-send',url:origin}]);
    await page.goto(origin+'/qc.html?viewer=overview');
    await page.waitForFunction(()=>document.querySelector('#reviewedTotal').textContent==='3');
    assert.equal(await page.getByRole('heading',{name:'审核总览',exact:true}).count(),1);
    for(const id of ['managementTabs','identity','accountButton','recordsView','eventsView','accountsView','tasksView','loginDialog'])assert.equal(await page.locator('#'+id).count(),0,id);
    await page.locator('[data-period=today]').click();
    await page.waitForFunction(()=>document.querySelector('[data-period=today]').getAttribute('aria-pressed')==='true');
    await page.locator('#reviewer').selectOption('fixture');
    await page.locator('#dateFrom').fill('2026-09-22');
    await page.locator('#dateTo').fill('2026-09-23');
    await page.waitForTimeout(300);
    await page.locator('.review-work-segment').first().click();
    assert.equal(await page.locator('#reviewWorkDialog').isVisible(),true);
    await page.locator('[data-close=reviewWorkDialog]').click();
    const download=page.waitForEvent('download');
    await page.locator('#exportReport').click();
    const csv=await readFile(await (await download).path(),'utf8');
    assert.match(csv,/测试审核员/);
    await page.evaluate(()=>window.postMessage({type:'workbench:view',view:'accounts'},location.origin));
    await page.locator('#refreshManagement').click();
    await page.waitForTimeout(300);
    assert.ok(calls.some(c=>c.query.get('username')==='fixture' && c.query.get('from')==='2026-09-22'));
    assert.ok(calls.every(c=>c.path==='/api/qc/management' && c.method==='GET' && !c.cookie));
    await mkdir('artifacts/workbench-overview',{recursive:true});
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:920});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:`artifacts/workbench-overview/overview-${width}.png`,fullPage:true});
    }
    await page.goto(origin+'/qc.html');
    await page.waitForFunction(()=>document.querySelector('#reviewedTotal').textContent==='3');
    assert.equal(await page.locator('#managementTabs').isVisible(),true);
    assert.equal(await page.locator('#accountButton').isVisible(),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
