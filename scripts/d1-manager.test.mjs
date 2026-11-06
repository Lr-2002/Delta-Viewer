import assert from "node:assert/strict";
import {existsSync, mkdirSync, readdirSync, writeFileSync} from "node:fs";
import {resolve, join} from "node:path";
import {homedir} from "node:os";
import {after, before, test} from "node:test";
import {createServer} from "vite";
import {chromium} from "playwright-core";

const reportRoot=resolve("artifacts/d1-manager");mkdirSync(reportRoot,{recursive:true});
let server,browser,baseUrl;const evidence=[];
before(async()=>{
  server=await createServer({server:{host:"127.0.0.1",port:0,strictPort:true}});await server.listen();
  baseUrl=`http://127.0.0.1:${server.httpServer.address().port}`;
  const cache=join(homedir(),".cache/ms-playwright");
  const installed=existsSync(cache)?readdirSync(cache).filter(name=>name.startsWith("chromium-")).map(name=>join(cache,name,"chrome-linux64/chrome")):[];
  const executablePath=[process.env.PLAYWRIGHT_CHROMIUM,process.env.CHROME_BIN,chromium.executablePath(),...installed,"/usr/bin/google-chrome","/usr/bin/chromium"].filter(Boolean).find(existsSync);
  assert.ok(executablePath,"Chromium is required");browser=await chromium.launch({executablePath,headless:true,args:["--no-sandbox"]});
});
after(async()=>{await browser?.close();await server?.close();writeFileSync(resolve(reportRoot,"browser-report.json"),JSON.stringify({source:"local-synthetic",realDeviceOperations:false,otaRequests:false,evidence},null,2));});
async function session(viewport,managed=false,setup){
  const context=await browser.newContext({viewport});const page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[],external=[];page.on("pageerror",error=>errors.push(error.message));page.on("console",msg=>{if(msg.type()==="error")errors.push(msg.text());});
  await context.route("**/*",route=>{if(new URL(route.request().url()).origin===baseUrl)return route.continue();external.push(route.request().url());return route.abort();});
  if(setup) await setup(context);
  await page.goto(baseUrl+"?machineAnnotation=present");
  if(managed){await page.getByRole("button",{name:"登录工作区"}).click();await page.getByLabel("显示名称",{exact:true}).fill("模拟回归账号");await page.getByLabel("账号",{exact:true}).fill("d1-test");await page.getByLabel("密码",{exact:true}).fill("fixture-pass-1234");await page.getByLabel("确认密码",{exact:true}).fill("fixture-pass-1234");await page.getByRole("button",{name:"创建并登录",exact:true}).click();}
  else await page.getByRole("button",{name:"离线模式",exact:false}).first().click();
  await page.getByRole("heading",{name:"D1 设备工作台",exact:true}).waitFor();
  await navigate(page,"数据工作区");
  await page.locator(".quality-inspector").waitFor();
  await navigate(page,"首页");
  return {page,context,errors,external};
}
async function navigate(page,name){await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name,exact:true}).click();}
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}

test("Manager navigation retains the Viewer workspace at desktop/minimum/narrow widths",async()=>{
  for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
    const {page,context,errors,external}=await session(viewport);
    try{
      assert.equal(await page.title(),"D1 Manager");assert.equal(await page.locator(".brand-lockup strong").innerText(),"D1 Manager");
      const loaded=await page.locator(".loaded-label").textContent();
      await navigate(page,"首页");await page.getByRole("heading",{name:"D1 设备工作台"}).waitFor();await noOverflow(page);
      await page.screenshot({path:resolve(reportRoot,`home-${viewport.width}.png`),fullPage:true});
      for(const name of ["设备管理","检测排障","日志与支持"]){await navigate(page,name);await page.getByRole("heading",{name:"设备能力尚未接入"}).waitFor();await noOverflow(page);assert.equal(await page.getByRole("button",{name:"升级",exact:true}).count(),0);}
      await page.getByRole("button",{name:"体验本地模拟",exact:true}).click();await page.getByRole("button",{name:"运行模拟检测"}).click();await page.getByText("检测完成",{exact:true}).waitFor();
      assert.equal(await page.locator(".manager-check .result-normal").count(),3);await noOverflow(page);
      await page.screenshot({path:resolve(reportRoot,`diagnostics-${viewport.width}.png`),fullPage:true});
      await navigate(page,"数据工作区");assert.equal(await page.locator(".loaded-label").textContent(),loaded);assert.equal(await page.getByRole("button",{name:"校对",exact:true}).count(),1);
      await page.getByRole("button",{name:"检查",exact:true}).click();await page.locator(".checks-view").waitFor();await page.getByRole("button",{name:"导出",exact:true}).click();await page.locator(".export-view").waitFor();
      await page.getByRole("button",{name:"校对",exact:true}).click();await noOverflow(page);
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);evidence.push({viewport,status:"passed",workspaceRetained:true,externalRequests:external.length});
    }finally{await context.close();}
  }
});

test("Leaving the data workspace pauses playback and retains its saved draft",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},true);
  try{
    await navigate(page,"数据工作区");
    await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.disabled===false);
    await page.getByLabel("复核动作描述",{exact:true}).fill("切换设备区后保留的本机草稿");
    await page.waitForFunction(async()=>{
      const backend=await import("/src/lib/backend.ts");
      return (await backend.loadMachineReview("/demo/2026-07-13_07-34-12")).segments[0].description==="切换设备区后保留的本机草稿";
    });
    await page.getByLabel("校对播放帧",{exact:true}).fill("20");
    await page.getByRole("button",{name:"全局播放",exact:true}).click();
    await page.waitForFunction(()=>Number(document.querySelector('[aria-label="校对播放帧"]').value)>20);
    await navigate(page,"设备管理");
    await page.getByRole("heading",{name:"设备能力尚未接入"}).waitFor();
    const frame=await page.getByLabel("校对播放帧",{exact:true}).inputValue();
    await page.waitForTimeout(350);
    assert.equal(await page.getByLabel("校对播放帧",{exact:true}).inputValue(),frame);
    await navigate(page,"数据工作区");
    assert.equal(await page.getByLabel("复核动作描述",{exact:true}).inputValue(),"切换设备区后保留的本机草稿");
    assert.equal(await page.getByRole("button",{name:"暂停",exact:true}).count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:"passed",playbackPaused:true,savedDraftRetained:true});
  }finally{await context.close();}
});

test("Audit persistence failure keeps navigation in the current data session",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},true,async context=>{
    await context.addInitScript(()=>{window.auditDisk=new Map();window.failAllAudit=false;});
    await context.route("**/src/lib/review-audit.ts",async route=>{
      const response=await route.fetch();const original=await response.text();
      const body=original.replace(/from "[^"\n]*\/backend\.ts[^"\n]*"/,'from "/__d1-audit"');
      assert.notEqual(body,original);await route.fulfill({response,body});
    });
    await context.route("**/__d1-audit",route=>route.fulfill({contentType:"application/javascript",body:`
      export const isTauriRuntime=()=>true;
      export const reviewIdentityPath=async path=>path;
      export async function persistReviewAudit(username,serviceId,events){
        if(window.failAllAudit)throw Error("模拟审计磁盘不可用");
        for(const event of events)window.auditDisk.set(event.eventId,event);
        return {pending:window.auditDisk.size,blocked:0,error:""};
      }
      export async function getReviewAuditQueueStatus(){return {pending:window.auditDisk.size,blocked:0,error:""};}
      export async function flushReviewAuditQueue(){return {pending:window.auditDisk.size,blocked:0,error:"offline"};}
      export async function sendReviewAudit(){throw Error("unexpected network");}
    `}));
  });
  try{
    await navigate(page,"数据工作区");
    await page.waitForFunction(()=>[...window.auditDisk.values()].some(event=>event.action==="loaded"));
    const sessionId=await page.evaluate(()=>[...window.auditDisk.values()].at(-1).sessionId);
    await page.evaluate(()=>{window.failAllAudit=true;});
    await navigate(page,"首页");
    await page.getByText("Error: 模拟审计磁盘不可用",{exact:true}).waitFor();
    assert.equal(await page.getByRole("navigation",{name:"主导航"}).locator('[aria-current="page"]').innerText(),"数据工作区");
    await page.evaluate(()=>{window.failAllAudit=false;});
    await page.getByRole("button",{name:"下一帧",exact:true}).click();
    await page.waitForFunction(()=>[...window.auditDisk.values()].some(event=>event.action==="seek"));
    assert.equal(await page.evaluate(()=>[...window.auditDisk.values()].at(-1).sessionId),sessionId);
    await navigate(page,"首页");await page.getByRole("heading",{name:"D1 设备工作台",exact:true}).waitFor();
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:"passed",auditFailureBlocksNavigation:true,originalSessionRetained:true});
  }finally{await context.close();}
});

test("Admin can return to Manager home while Viewer entry retains the management role boundary",async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:920}});const page=await context.newPage();
  const errors=[],external=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>{if(new URL(route.request().url()).origin===baseUrl)return route.continue();external.push(route.request().url());return route.abort();});
  try{
    await page.goto(baseUrl+"/?demoScenario=operations-cockpit");
    await page.getByRole("heading",{name:"审核监管",exact:true}).waitFor();
    assert.equal(await page.getByRole("button",{name:"测试模式",exact:true}).count(),0);
    await page.getByRole("button",{name:"D1 Manager 首页",exact:true}).click();
    await page.getByRole("heading",{name:"D1 设备工作台",exact:true}).waitFor();
    assert.equal(await page.getByRole("button",{name:/选择 (SD 卡|数据目录)/}).count(),0);
    await navigate(page,"数据工作区");await page.getByRole("heading",{name:"审核监管",exact:true}).waitFor();
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:"passed",adminHome:true,adminViewerEntryReturnsToManagement:true});
  }finally{await context.close();}
});

test("Simulation outcomes, cancel and recovery cannot manufacture hardware damage or review activity",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},true);
  try{
    const loaded=await page.locator(".loaded-label").textContent();
    await navigate(page,"设备管理");
    const frame=await page.locator(".frame-counter").textContent();
    await page.keyboard.press("Space");await page.keyboard.press("ArrowRight");assert.equal(await page.locator(".frame-counter").textContent(),frame);
    await page.getByRole("button",{name:"体验本地模拟",exact:true}).click();
    const countReview=()=>page.evaluate(()=>JSON.parse(localStorage.getItem("dohc.demo.review-events")??"[]").length);
    await page.waitForTimeout(2300);const before=await countReview();
    for(const [scenario,selector,expected] of [["failure",".result-abnormal",1],["partial",".result-unsupported",1],["parse_failure",".result-indeterminate",1],["offline",".result-indeterminate",1],["disconnect",".result-indeterminate",1],["timeout",".result-indeterminate",1]]){
      await page.getByLabel("模拟场景").selectOption(scenario);await page.getByRole("button",{name:"运行模拟检测"}).click();await page.locator(".manager-run-summary").waitFor();
      assert.equal(await page.locator(`.manager-check ${selector}`).count(),expected);
      if(["offline","disconnect","timeout"].includes(scenario)){assert.equal(await page.locator(".manager-check .result-abnormal").count(),0);assert.ok(await page.locator(".manager-check .result-not_run").count()>0);}
    }
    await page.getByLabel("模拟场景").selectOption("success");await page.getByRole("button",{name:"运行模拟检测"}).click();
    await page.getByRole("button",{name:"取消检测",exact:true}).click();await page.getByText("检测已取消",{exact:true}).waitFor();assert.ok(await page.locator(".manager-check .result-not_run").count()>0);
    await page.getByRole("button",{name:"运行模拟检测"}).click();await page.getByText("检测完成",{exact:true}).waitFor();
    await page.waitForTimeout(16000);assert.equal(await countReview(),before,"simulation must not create review events or heartbeats");
    await navigate(page,"日志与支持");assert.equal(await page.getByRole("button",{name:"预览包内容",exact:true}).isDisabled(),true);await noOverflow(page);
    await navigate(page,"数据工作区");assert.equal(await page.locator(".loaded-label").textContent(),loaded);
    await page.getByRole("button",{name:"退出登录",exact:true}).click();await page.getByRole("heading",{name:"审核员注册",exact:true}).waitFor();
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);evidence.push({status:"passed",scenarios:7,cancellation:true,keyboardIsolation:true,auditIsolation:true,logout:true});
  }finally{await context.close();}
});
