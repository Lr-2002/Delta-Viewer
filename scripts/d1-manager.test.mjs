import assert from "node:assert/strict";
import {existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync} from "node:fs";
import {resolve, join} from "node:path";
import {homedir} from "node:os";
import {after, before, test} from "node:test";
import {createServer} from "vite";
import {chromium} from "playwright-core";

const reportRoot=resolve(process.env.D1_MANAGER_REPORT_DIR??"artifacts/d1-manager");mkdirSync(reportRoot,{recursive:true});
let server,browser,baseUrl;const evidence=[];
before(async()=>{
  server=await createServer({server:{host:"127.0.0.1",port:15162,strictPort:false}});await server.listen();
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
async function navigate(page,name){
  const parent=page.getByRole("navigation",{name:"主导航"});
  if(name==="数据工作区")return parent.getByRole("button",{name,exact:true}).click();
  await parent.getByRole("button",{name:"设备管理区",exact:true}).click();
  await page.getByRole("navigation",{name:"设备功能"}).getByRole("button",{name:name==="设备管理"?"设备信息":name,exact:true}).click();
}
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}

test("Account entry retains registration, login and offline access at all viewports",async()=>{
  for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
    const context=await browser.newContext({viewport});const page=await context.newPage();const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    try{
      await page.goto(baseUrl);await page.getByRole("button",{name:"登录工作区"}).click();
      await page.getByRole("button",{name:"返回登录",exact:true}).click();
      await page.getByRole("heading",{name:"欢迎回来",exact:true}).waitFor();
      const password=page.getByLabel("密码",{exact:true});
      assert.equal(await password.getAttribute("type"),"password");
      await password.fill("preview-password");
      await page.getByRole("button",{name:"显示密码",exact:true}).click();
      assert.equal(await password.getAttribute("type"),"text");
      assert.equal(await password.inputValue(),"preview-password");
      await page.getByRole("button",{name:"隐藏密码",exact:true}).click();
      assert.equal(await password.getAttribute("type"),"password");
      assert.equal(await password.inputValue(),"preview-password");
      await noOverflow(page);
      await page.screenshot({path:resolve(reportRoot,`login-${viewport.width}.png`),fullPage:true});
      await page.getByRole("button",{name:"注册审核员账号",exact:true}).click();
      await page.getByLabel("显示名称",{exact:true}).waitFor();await noOverflow(page);
      await page.getByRole("button",{name:"离线模式 · 直接进入",exact:true}).click();
      await page.getByRole("heading",{name:"D1 设备工作台",exact:true}).waitFor();assert.deepEqual(errors,[]);
      evidence.push({viewport,status:"passed",accountEntry:true});
    }finally{await context.close();}
  }
});

test("Manager navigation retains the Viewer workspace at desktop/minimum/narrow widths",async()=>{
  for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
    const {page,context,errors,external}=await session(viewport);
    try{
      assert.equal(await page.title(),"D1 Manager");assert.equal(await page.locator(".brand-lockup strong").innerText(),"D1 Manager");
      const loaded=await page.locator(".loaded-label").textContent();
      await navigate(page,"首页");await page.getByRole("heading",{name:"D1 设备工作台"}).waitFor();await noOverflow(page);
      assert.deepEqual(await page.getByRole("navigation",{name:"主导航"}).getByRole("button").allTextContents(),["设备管理区","数据工作区"]);
      assert.deepEqual(await page.getByRole("navigation",{name:"设备功能"}).getByRole("button").allTextContents(),["首页","设备信息","检测排障","日志与支持"]);
      assert.equal(await page.locator(".source-display").count(),0);
      assert.equal(await page.getByRole("button",{name:"操作错误历史",exact:true}).count(),0);
      assert.equal(await page.getByRole("button",{name:/^选择 (SD 卡|数据目录)$/}).count(),0);
      assert.equal(await page.getByRole("button",{name:"查看历史版本",exact:true}).count(),1);
      await page.screenshot({path:resolve(reportRoot,`home-${viewport.width}.png`),fullPage:true});
      await page.getByRole("button",{name:"设备热点（AP）",exact:true}).click();
      await page.getByText("如何连接设备热点",{exact:true}).waitFor();
      assert.equal(await page.locator(".manager-connection-area").evaluate(root=>{const guide=root.querySelector(".manager-connection-guide"),controls=root.querySelector(".manager-segmented");return Boolean(guide&&controls&&(guide.compareDocumentPosition(controls)&Node.DOCUMENT_POSITION_FOLLOWING));}),true,"the yellow connection guide appears before the mode selector");
      await page.getByText("Delta-D1-***",{exact:true}).waitFor();await noOverflow(page);
      assert.equal(await page.getByRole("button",{name:"连接设备",exact:true}).isDisabled(),true);
      await page.screenshot({path:resolve(reportRoot,`ap-guide-${viewport.width}.png`),fullPage:true});
      await page.getByRole("button",{name:"局域网 IP",exact:true}).click();
      await page.getByText("如何获取设备 IP",{exact:true}).waitFor();
      await page.getByText("长按录制键后接短按，等待设备语音播报本机 IP。",{exact:true}).waitFor();
      await noOverflow(page);await page.screenshot({path:resolve(reportRoot,`lan-guide-${viewport.width}.png`),fullPage:true});
      await page.getByRole("button",{name:"Type-C 连接",exact:true}).click();
      const typeCGuide=page.getByRole("complementary",{name:"Type-C 连接提示"});
      await typeCGuide.getByText("请使用支持数据传输的 USB-A 转 Type-C 数据线，将电脑 A 口连接到 D1 的 Type-C 口。",{exact:true}).waitFor();
      assert.equal(await typeCGuide.evaluate(e=>getComputedStyle(e).backgroundColor),"rgb(255, 248, 230)");await noOverflow(page);
      for(const name of ["设备管理","检测排障","日志与支持"]){await navigate(page,name);await page.getByRole("heading",{name:name==="设备管理"?"等待 D1 连接":name==="检测排障"?"尚未运行检测":"还没有检测记录"}).waitFor();if(name==="设备管理"){assert.equal(await page.getByRole("group",{name:"连接方式"}).count(),0);assert.equal(await page.locator(".manager-actual-connection").count(),0,"device information must not show a connection mode before connection");}await noOverflow(page);assert.equal(await page.getByRole("button",{name:"升级",exact:true}).count(),0);}
      assert.equal(await page.getByRole("button",{name:/模拟/}).count(),0);
      assert.equal(await page.getByRole("button",{name:"运行设备检测"}).count(),0);
      await navigate(page,"数据工作区");
      assert.equal(await page.getByRole("navigation",{name:"设备功能"}).count(),0);
      assert.equal(await page.getByRole("button",{name:"操作错误历史",exact:true}).count(),1);
      assert.equal(await page.getByRole("button",{name:"选择 SD 卡",exact:true}).count(),1);
      assert.equal(await page.locator(".source-display").count(),1);
      assert.equal(await page.locator(".loaded-label").textContent(),loaded);assert.equal(await page.getByRole("button",{name:"校对",exact:true}).count(),1);
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
    await page.getByRole("heading",{name:"等待 D1 连接"}).waitFor();
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
    await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"设备管理区",exact:true}).click();
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


// These fixtures exist only in the test runner; the shipped app has no simulator.
async function physicalContractFixture(context,{typeCHotplug=false}={}){
  await context.addInitScript((typeCHotplug)=>{
    const now=Date.now();
    const device={id:"test-d1-device",applicationVersion:"1.1.1",releaseId:"test-release",firmware:"test-board-version",hardwareProfile:"rk3588",architecture:"aarch64",channel:"factory",source:"device_report",identityVerified:false};
    window.deviceFixture={connection:"connected",attemptedAddress:"192.168.188.1",identity:device,realDeviceEnabled:true,selectedInterfaceId:"usb-test",error:null,
      configuration:{schemaVersion:1,deviceOta:{enabled:false,scheme:null,status:"waiting_interface",reservedAddress:"deltadevice.cn:4174/ota/latest"},productionOperations:[]},
      linkDiscovery:{status:"candidates_found",platform:"windows",observedAtMs:now,error:null,candidates:[{interfaceId:"usb-test",name:"USB test connection",description:"Remote NDIS Compatible Device",usbId:null,wireless:false,state:"identity_unverified",localIpv4:["192.168.188.86/24"],gatewayCandidates:["192.168.188.1"],identityVerified:false}]},
      observation:{connectionAddress:"192.168.188.1",connectionMode:"type_c",cameraPortLimited:false,connectionLimitedOnly:false,observedAtMs:now,httpStatus:503,device,phase:"FAULT",health:"FAILED",heartbeatStale:false,voltage:7,temperature:49,
        cameras:[... ["main","left","right","stereo_extension"].map(role=>({role,name:role,state:"STREAMING",enabled:true,required:true,fresh:true,effectiveFps:30,reason:null})),{role:"t265",name:"T265",state:"FAULT",enabled:true,required:true,fresh:false,effectiveFps:0,reason:"waiting for finite T265 pose data"}],storage:{mounted:true,writable:true,filesystem:"exfat",freeBytes:1024,usageWarning:false,reason:null},alerts:[],selfTest:{phase:"IDLE",result:null},otaState:null}};
    window.deviceAvailabilityFailure=null;window.deviceTestMode="success";window.deviceTestCalls=0;window.deviceAvailabilityCalls=[];
    window.typeCPhase=typeCHotplug?"absent":null;
  },typeCHotplug);
  await context.route("**/src/lib/backend.ts",async route=>{
    const response=await route.fetch();const original=await response.text();
    const body=original.replace(/export async function getDeviceAvailability\([\s\S]*?(?=export async function previewDeviceBundle)/,`
      export async function getDeviceAvailability(interfaceId,apAddress,connectionMode){
        window.deviceAvailabilityCalls.push({interfaceId,apAddress,connectionMode,phase:window.typeCPhase});
        const value=structuredClone(window.deviceFixture);
        if(connectionMode==="type_c"&&window.typeCPhase==="dhcp_wait"){
          value.connection="not_connected";value.identity=null;value.observation=null;value.realDeviceEnabled=false;
          value.linkDiscovery.platform="windows";
          Object.assign(value.linkDiscovery.candidates[0],{state:"waiting_address",localIpv4:["169.254.9.83/16"],gatewayCandidates:[]});
          return value;
        }
        if(connectionMode==="type_c"&&window.typeCPhase==="absent"){
          value.connection="not_connected";value.identity=null;value.observation=null;value.error=null;
          value.attemptedAddress=null;value.selectedInterfaceId=null;value.realDeviceEnabled=false;
          value.linkDiscovery={...value.linkDiscovery,status:"no_candidates",candidates:[]};
          return value;
        }
        if(connectionMode==="type_c"&&window.typeCPhase==="enumerated"){
          value.connection="query_failed";value.identity=null;value.observation=null;value.realDeviceEnabled=false;
          value.selectedInterfaceId="usb-test";value.attemptedAddress=null;
          value.error={code:"D1_HEALTH_PAGE_ONLY",message:"USB 网卡已出现，设备报告暂未就绪。"};
          value.linkDiscovery={...value.linkDiscovery,status:"candidates_found"};
          return value;
        }
        if(connectionMode==="ap"){
          value.linkDiscovery.candidates=[{interfaceId:"wifi-test",name:"Wi-Fi test",wireless:true,state:"identity_unverified",localIpv4:["192.168.4.121/24"],gatewayCandidates:["192.168.4.1"],usbId:null,identityVerified:false,description:"test-only"}];
          value.selectedInterfaceId="wifi-test";
        }
        const address=connectionMode==="ap"?value.linkDiscovery.candidates[0].gatewayCandidates[0]:apAddress;
        if(address&&value.observation){value.observation.connectionMode=connectionMode??"lan";value.observation.connectionAddress=address;value.observation.cameraPortLimited=false;value.observation.connectionLimitedOnly=false;}
        value.attemptedAddress=address??value.observation?.connectionAddress??null;
        if(window.deviceAvailabilityFailure){value.error=window.deviceAvailabilityFailure;value.identity=null;value.observation=null;value.realDeviceEnabled=false;value.connection="query_failed";}
        return value;
      }
      export async function runDeviceDiagnostics(interfaceId,operationId,apAddress){
        window.deviceTestCalls++;window.deviceTestCancelled=false;
        const start=Date.now();await new Promise(resolve=>setTimeout(resolve,window.deviceTestMode==="slow"?450:30));
        const mode=window.deviceTestCancelled?"cancelled":window.deviceTestMode;
        const status=mode==="timeout"?"timed_out":mode==="disconnect"?"disconnected":mode==="protocol"?"unavailable":mode==="cancelled"?"cancelled":"completed";
        const checkStatus=mode==="cancelled"?"not_run":mode==="protocol"?"unsupported":mode==="timeout"||mode==="disconnect"?"indeterminate":"abnormal";
        return {id:"device:test-run",source:"physical_device",device:status==="completed"?window.deviceFixture.identity:null,observation:status==="completed"?window.deviceFixture.observation:null,
          startedAtMs:start,finishedAtMs:Date.now(),status,checks:[...(mode==="success"?[{id:"heartbeat",name:"采集状态时效",status:"normal",evidence:"设备报告采集状态已过期：否"},{id:"health",name:"设备总体状态",status:"abnormal",evidence:"设备报告 health=FAILED，phase=FAULT"},...["main","left","right","stereo_extension"].map(role=>({id:"camera:"+role,name:"相机 · "+role,status:role==="stereo_extension"&&window.deviceFixture.observation.cameraPortLimited&&!apAddress?"not_run":"normal",evidence:role==="stereo_extension"&&window.deviceFixture.observation.cameraPortLimited&&!apAddress?"Type-C 当前用于诊断连接，扩展双目相机未检查":"设备报告状态=STREAMING"})),{id:"storage",name:"采集存储",status:"normal",evidence:"已挂载，可写"},{id:"self-test",name:"设备已有长时自检",status:"not_run",evidence:"本次未启动长时自检"}].map(check=>({...check,observedAtMs:Date.now(),ruleVersion:"dohc-health-v1",applicableFirmware:"DOHC 1.1.1",suggestion:"按设备报告复检",errorKind:null})):[]),{id:"camera:t265",name:"相机 · T265",status:checkStatus,evidence:mode==="success"?"设备报告 state=FAULT":"本次未取得有效观测",observedAtMs:mode==="cancelled"?null:Date.now(),ruleVersion:"dohc-health-v1",applicableFirmware:"DOHC 1.1.1",suggestion:"检查相机连接后复检",errorKind:null}]};
      }
      export async function clearDeviceSession(){}
    `).replace(/export async function cancelTask\(operationId\)\s*\{[\s\S]*?\n\}/,'export async function cancelTask(operationId){window.deviceTestCancelled=true;return true;}');
    assert.notEqual(body,original);await route.fulfill({response,body});
  });
}

test("Type-C hotplug recovers when the app starts first and the device report becomes ready later",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},false,context=>physicalContractFixture(context,{typeCHotplug:true}));
  try{
    await navigate(page,"设备管理");
    await page.getByRole("heading",{name:"等待 D1 连接",exact:true}).waitFor();
    await page.evaluate(()=>{window.typeCPhase="enumerated";});
    await page.waitForFunction(()=>window.deviceAvailabilityCalls.some(call=>call.phase==="enumerated"),null,{timeout:10000});
    await page.getByRole("heading",{name:"暂不能读取设备报告",exact:true}).waitFor();
    await page.evaluate(()=>{window.typeCPhase="ready";});
    await page.locator(".manager-connection").getByText("已连接 D1",{exact:true}).waitFor({timeout:10000});
    const phases=await page.evaluate(()=>window.deviceAvailabilityCalls.map(call=>call.phase));
    assert.ok(phases.includes("absent"),"the app must begin discovery before USB appears");
    assert.ok(phases.includes("enumerated"),"the hotplug must be observed while the report is unavailable");
    assert.ok(phases.filter(phase=>phase==="ready").length>=1,"discovery must continue until the device report recovers");
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:"passed",typeCHotplugRecovery:true,sequence:["app_started_without_device","usb_link_enumerated_report_not_ready","device_report_ready"],realDeviceOperations:false});
  }finally{await context.close();}
});

async function desktopPhysicalContractFixture(context){
    await physicalContractFixture(context);
    // Desktop capability only for this component; app data/auth remain browser fixtures.
    await context.route("**/src/components/ManagerWorkspace.tsx",async route=>{
      const response=await route.fetch();const original=await response.text();
      const body=original.replace(/from "[^"\n]*\/backend\.ts[^"\n]*"/,'from "/__d1-component-runtime"');
      assert.notEqual(body,original);await route.fulfill({response,body});
    });
    await context.route("**/__d1-component-runtime",route=>route.fulfill({contentType:"application/javascript",body:'export * from "/src/lib/backend.ts"; import * as backend from "/src/lib/backend.ts"; export const isTauriRuntime=()=>true; export async function renewUsbDeviceAddress(interfaceId,operationId){window.usbRenewalCalls=(window.usbRenewalCalls??[]).concat({interfaceId,operationId});window.typeCPhase="ready";} export async function readDevicePage(request,operationId){if(window.unassociatedHotspotFixture)throw new Error("请先连接设备标签对应的 Delta-D1 热点，再打开设备页面。");return backend.readDevicePage(request,operationId);}'}));
}

test("Windows USB automatic-address recovery uses one owned renewal then reads the device report",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},false,desktopPhysicalContractFixture);
  try{
    await page.evaluate(()=>{window.typeCPhase="dhcp_wait";window.usbRenewalCalls=[];});
    await navigate(page,"首页");
    await page.waitForFunction(()=>window.usbRenewalCalls.length===1,null,{timeout:10000});
    await page.locator(".manager-connection.is-connected").waitFor({timeout:10000});
    const calls=await page.evaluate(()=>window.usbRenewalCalls);
    assert.equal(calls[0].interfaceId,"usb-test");assert.ok(calls[0].operationId>0);
    await navigate(page,"设备信息");await page.getByText("实际连接方式",{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.usbRenewalCalls.length),1);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:"passed",usbDhcpRecovery:true,taskControl:true,realDeviceOperations:false});
  }finally{await context.close();}
});

test("Type-C guide stays visible and AP connection errors slide in then dismiss",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},false,desktopPhysicalContractFixture);
  try{
    await navigate(page,"设备管理");
    assert.equal(await page.getByRole("group",{name:"连接方式"}).count(),0,"connection controls are home-only");
    await navigate(page,"首页");
    const guide=page.getByRole("complementary",{name:"Type-C 连接提示"});
    await guide.getByText("请使用支持数据传输的 USB-A 转 Type-C 数据线，将电脑 A 口连接到 D1 的 Type-C 口。",{exact:true}).waitFor();
    await guide.getByText("扩展相机将暂时断开",{exact:false}).waitFor();
    assert.equal(await guide.evaluate(e=>getComputedStyle(e).backgroundColor),"rgb(255, 248, 230)");
    await page.screenshot({path:"/tmp/d1-manager-type-c-guide.png",fullPage:true});
    await page.getByRole("button",{name:"设备热点（AP）",exact:true}).click();
    await page.evaluate(()=>window.unassociatedHotspotFixture=true);
    const started=Date.now();
    await page.getByRole("button",{name:"连接设备",exact:true}).click();
    const toast=page.getByRole("alert").filter({hasText:"请先连接设备标签对应的 Delta-D1 热点"});
    await toast.waitFor();
    assert.equal(await toast.evaluate(e=>getComputedStyle(e).animationName),"manager-toast-in");
    await page.waitForTimeout(260);
    await page.screenshot({path:"/tmp/d1-manager-connection-toast.png",fullPage:true});
    await toast.waitFor({state:"detached",timeout:3800});
    const elapsed=Date.now()-started;
    assert.ok(elapsed>=2600&&elapsed<=3800,`dismiss started after ${elapsed}ms`);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:"passed",typeCGuide:true,connectionErrorToast:true,autoDismissMs:elapsed,externalRequests:0});
  }finally{await context.close();}
});

test("Real device UI shows reported identity and failures without any simulation entry at all viewports",async()=>{
  for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
    const {page,context,errors,external}=await session(viewport,false,physicalContractFixture);
    try {
      await navigate(page,"设备管理");
      const card=page.getByRole("region",{name:"真实 D1 设备"});await card.getByText("test-d1-device",{exact:true}).waitFor();
      assert.equal(await page.getByRole("group",{name:"连接方式"}).count(),0,"device information must not repeat connection controls");
      await page.getByText("实际连接方式",{exact:true}).waitFor();await page.getByText("Type-C 连接",{exact:true}).waitFor();
      await card.getByText("1.1.1",{exact:true}).waitFor();await card.getByText("存在异常",{exact:true}).waitFor();
      const internetIp=card.locator(".manager-metadata>div").filter({has:page.locator("dt",{hasText:/^联网 IP$/})});
      assert.equal(await internetIp.locator("dd").innerText(),"暂未获取");
      assert.equal(await card.locator(".manager-metadata>div").filter({has:page.locator("dt",{hasText:/^Type-C IP$/})}).locator("dd").innerText(),"192.168.188.1");
      assert.equal(await page.getByText("本机地址",{exact:true}).count(),0);
      assert.equal(await page.getByText("连接详情",{exact:true}).count(),0);
      assert.equal(await page.getByText("设备管理与诊断",{exact:true}).count(),0);
      assert.equal(await page.getByText("192.168.188.86/24",{exact:true}).count(),0);
      assert.equal(await page.getByRole("button",{name:/模拟/}).count(),0);await noOverflow(page);
      await page.screenshot({path:resolve(reportRoot,`real-device-${viewport.width}.png`),fullPage:true});
      await navigate(page,"检测排障");await page.getByRole("button",{name:"运行设备检测"}).click();
      await page.getByText("检测完成",{exact:true}).waitFor();assert.equal(await page.locator(".manager-check .result-abnormal").count(),2);assert.equal(await page.locator(".manager-check").count(),9);await noOverflow(page);
      const geometry=await page.locator(".manager-checks").evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(" ").length,bottom:el.getBoundingClientRect().bottom}));
      assert.equal(geometry.columns,viewport.width===1440?4:viewport.width===960?3:1);
      if(viewport.width===1440)assert.ok(geometry.bottom<=viewport.height,"all nine modules fit in the default desktop viewport");
      assert.equal(await page.locator(".manager-connection.is-connected").innerText(),"已连接 D1");
      assert.ok(await page.locator(".manager-result").first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=13);
      const t265=page.locator(".manager-check").filter({has:page.getByRole("heading",{name:"T265 定位相机",exact:true})});
      await t265.getByText("等待有效的 T265 位姿数据",{exact:false}).waitFor();
      assert.equal(await page.locator(".manager-checks").innerText().then(text=>/STREAMING|FAULT|FAILED|CAMERA LEFT/.test(text)),false);
      await page.screenshot({path:resolve(reportRoot,`real-diagnostics-${viewport.width}.png`),fullPage:true});
      await t265.getByText("证据与建议",{exact:true}).click();await t265.getByText("观测时间",{exact:true}).waitFor();
      await t265.getByText("原始记录与规则",{exact:true}).click();await t265.getByText("设备报告 state=FAULT",{exact:true}).waitFor();
      await t265.getByText("证据与建议",{exact:true}).click();
      await navigate(page,"日志与支持");await page.getByText("test-d1-device",{exact:true}).waitFor();
      assert.equal(await page.getByRole("button",{name:"预览包内容"}).isDisabled(),true);
      assert.equal(await page.getByRole("button",{name:"上传诊断包",exact:true}).isDisabled(),true);await page.getByText("上传服务待接入",{exact:true}).waitFor();await noOverflow(page);
      await page.screenshot({path:resolve(reportRoot,`support-${viewport.width}.png`),fullPage:true});
      await navigate(page,"设备管理");
      await page.evaluate(()=>{window.deviceFixture={...window.deviceFixture,connection:"not_connected",identity:null,observation:null,selectedInterfaceId:null,realDeviceEnabled:false,linkDiscovery:{...window.deviceFixture.linkDiscovery,status:"no_candidates",candidates:[]}};});
      await page.getByRole("heading",{name:"等待 D1 连接"}).waitFor();
      assert.equal(await page.getByText("test-d1-device",{exact:true}).count(),0);assert.equal(await page.getByText("192.168.188.1",{exact:true}).count(),0);
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);evidence.push({viewport,status:"passed",testOnlyContractFixture:true,realIdentityRendering:true,staleDeviceCleared:true,simulationEntries:0});
    }finally{await context.close();}
  }
});

test("Device query timeout, disconnection, unsupported protocol and cancellation cannot report hardware failure",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},true,physicalContractFixture);
  try{
    await navigate(page,"检测排障");
    const countReview=()=>page.evaluate(()=>JSON.parse(localStorage.getItem("dohc.demo.review-events")??"[]").length);
    await page.waitForTimeout(2300);const before=await countReview();
    for(const [mode,status] of [["timeout","indeterminate"],["disconnect","indeterminate"],["protocol","unsupported"]]){
      await page.evaluate(mode=>window.deviceTestMode=mode,mode);await page.getByRole("button",{name:"运行设备检测"}).click();
      await page.locator(".manager-run-summary").waitFor();assert.equal(await page.locator(`.manager-check .result-${status}`).count(),1);
      assert.equal(await page.locator(".manager-check .result-abnormal").count(),0);
    }
    await page.evaluate(()=>window.deviceTestMode="slow");await page.getByRole("button",{name:"运行设备检测"}).click();
    await page.getByRole("button",{name:"取消检测",exact:true}).click();await page.getByText("检测已取消",{exact:true}).waitFor();
    assert.equal(await page.locator(".manager-check .result-not_run").count(),1);
    await page.waitForTimeout(16000);assert.equal(await countReview(),before,"device views must not create review events or heartbeats");
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);evidence.push({status:"passed",testOnlyContractFixture:true,timeout:true,disconnect:true,unsupported:true,cancellation:true,auditIsolation:true});
  }finally{await context.close();}
});


test("Type-C diagnostic port limitation remains explicit",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},false,physicalContractFixture);
  try{
    await page.evaluate(()=>{window.deviceFixture.observation.cameraPortLimited=true;});
    await navigate(page,"设备管理");await page.getByText("未检查",{exact:true}).waitFor();
    await navigate(page,"检测排障");await page.getByRole("button",{name:"运行设备检测"}).click();await page.getByText("检测完成",{exact:true}).waitFor();
    const extension=page.locator(".manager-check").filter({has:page.getByRole("heading",{name:"扩展双目相机",exact:true})});
    assert.equal(await extension.locator(".result-not_run").count(),1);
    assert.equal(await page.locator(".manager-check .result-abnormal").count(),2);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await context.close();}
});

async function nativePageFixture(context){
  await desktopPhysicalContractFixture(context);
  await context.addInitScript(()=>{window.nativePageCalls=[];window.wifiConnectCalls=[];window.pageApiCalls=[];window.pageFixtureMode="success";window.wifiFixtureConnected=false;});
  const pageHtml=[
    '<!doctype html><html><head><style>body{background:#f5f5f7;color:#222;font-family:sans-serif}h1{font-size:24px}</style></head><body>',
    '<h1>DOHC 设备状态</h1><p id="deviceId">-</p><div id="cameraRows"></div><span id="cameraSummary">-</span>',
    '<button id="changeName">更改设备名称</button><input type="password" value="fixture-secret">',
    '<script>window.fixtureScriptRan=true;document.addEventListener("click",event=>{if(event.target?.id==="changeName"){window.fixtureClicked=true;void fetch("/api/v1/device-name",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({name:"D1 Lab"})}).then(response=>response.text()).then(text=>window.fixtureReply=text)}});void fetch("http://example.invalid/blocked");try{parent.hacked=true}catch{}</script>',
    '<img src="http://example.invalid/pixel" onerror="parent.hacked=true"><iframe src="http://example.invalid/iframe"></iframe><a href="javascript:parent.hacked=true">链接</a><form action="http://example.invalid/post"><input name="secret" value="fixture-only"></form><svg onload="parent.hacked=true"></svg></body></html>',
  ].join("");
  const runtime=`
    export * from "/src/lib/backend.ts";
    export const isTauriRuntime=()=>true;
    export async function requestDevicePageApi(request,api){window.pageApiCalls.push(api);if(window.pageFixtureMode==="provision-failed"&&api.path==="/")return {status:200,contentType:"text/html",body:"<html><body>无法连接该 Wi-Fi，请检查名称和密码后重试。</body></html>"};return api.path==="/configure"?{status:202,contentType:"text/html",body:'<html><body><h1>正在连接</h1><p>设备正在连接所选 Wi-Fi，配网热点将自动关闭。</p></body></html>'}:{status:200,contentType:"application/json",body:JSON.stringify({ok:true})};}
    export async function requestDevicePageBatch(request,apis){return Promise.all(apis.map(api=>requestDevicePageApi(request,api)));}
    export async function getWifiInventory(){return {supported:true,message:null,observedAtMs:Date.now(),networks:[{interfaceId:"22",ssid:"Delta-D1-test001",signal:92,connected:window.wifiFixtureConnected,recommended:true,connectable:true},{interfaceId:"22",ssid:"Office",signal:99,connected:false,recommended:false,connectable:false}]};}
    export async function connectDeviceWifi(request){window.wifiConnectCalls.push({ssid:request.ssid,interfaceId:request.interfaceId,passwordLength:request.password.length});if(window.pageFixtureMode==="wrong-password")throw new Error("热点连接未完成。请核对密码后重试。");return {interfaceId:request.interfaceId,ssid:request.ssid,connected:true};}
    export async function readDevicePage(request){window.nativePageCalls.push(request);if(window.pageFixtureMode==="unreachable")throw new Error("无法访问设备页面。");if(window.pageFixtureMode==="provisioning")return {address:"192.168.4.1",observedAtMs:Date.now(),html:'<html><body><h1>设备维护</h1><form method="post" action="/configure"><label>Wi-Fi 名称<input name="ssid" required maxlength="32"></label><label>Wi-Fi 密码<input type="password" name="password" required minlength="8" maxlength="63"></label><button type="submit">连接网络</button></form><button id="ota-relay">在线下载并升级</button><input id="ota-file" type="file"><button id="ota-submit">上传并升级</button></body></html>'};return {address:request.apAddress??"192.168.4.1",observedAtMs:Date.now(),status:{schema:"dohc.device.status-summary.v2",device:{device_id:"native-fixture-device",workspace_version:"1.1.1",channel:"factory"},health:"OK",cameras:{configured:1,fresh:1,items:[{role:"main",state:"STREAMING",fresh:true,required:true}]},alerts:{total:0,critical:0,warning:0,items:[]}},html:JSON_HTML};}
  `.replace("JSON_HTML",JSON.stringify(pageHtml));
  await context.route("**/__d1-component-runtime",route=>route.fulfill({contentType:"application/javascript",body:runtime}));
}

test("Wi-Fi recommendations and routed LAN/AP native pages retain back navigation and isolate page actions",async()=>{
  for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
    const {page,context,errors,external}=await session(viewport,false,nativePageFixture);
    try{
      await navigate(page,"首页");await page.getByRole("button",{name:"局域网 IP",exact:true}).click();
      const guide=page.getByRole("complementary",{name:"局域网连接教程"});await guide.getByText("如何获取设备 IP",{exact:true}).waitFor();
      assert.equal(await guide.evaluate(e=>getComputedStyle(e).textAlign),"center");
      assert.equal(await guide.locator("summary").count(),0,"guide must remain expanded");
      await page.getByLabel("设备 IP",{exact:true}).fill("http://10.1.30.114");await page.getByRole("button",{name:"连接设备",exact:true}).click();
      await page.getByRole("alert").filter({hasText:"请输入设备的 IPv4 地址"}).waitFor();assert.equal(await page.evaluate(()=>window.nativePageCalls.length),0);
      await page.getByLabel("设备 IP",{exact:true}).fill("10.1.30.114");await page.getByRole("button",{name:"连接设备",exact:true}).click();
      const frame=page.frameLocator('iframe[title="D1 设备页面"]');await frame.getByRole("heading",{name:"DOHC 设备状态"}).waitFor();
      await frame.getByText("native-fixture-device",{exact:true}).waitFor();await frame.getByText("STREAMING",{exact:true}).waitFor();assert.equal(await page.locator('iframe[title="D1 设备页面"]').getAttribute("sandbox"),"allow-scripts allow-forms allow-modals");
      assert.equal(await frame.locator("img,iframe,svg,script[src]").count(),0);
      assert.equal(await frame.locator("script").count(),2,"only inline device behavior and the local bridge are retained");
      assert.equal(await frame.locator('input[type="password"]').getAttribute("value"),null);
      assert.equal(await page.evaluate(()=>window.hacked),undefined);
      await frame.locator("body").evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      let confirmation="";page.once("dialog",async dialog=>{confirmation=dialog.message();await dialog.accept();});
      await frame.getByRole("button",{name:"更改设备名称"}).click();
      await page.waitForFunction(()=>window.pageApiCalls.some(api=>api.method==="PUT"&&api.path==="/api/v1/device-name"));
      assert.match(confirmation,/修改设备配置/);
      const apiCall=await page.evaluate(()=>window.pageApiCalls.find(api=>api.method==="PUT"&&api.path==="/api/v1/device-name"));
      assert.equal(apiCall.path,"/api/v1/device-name");assert.equal(apiCall.method,"PUT");assert.equal(apiCall.body,'{"name":"D1 Lab"}');
      await noOverflow(page);await page.screenshot({path:resolve(reportRoot,`native-lan-${viewport.width}.png`),fullPage:true});
      await page.getByRole("button",{name:"刷新页面",exact:true}).click();assert.equal(await page.evaluate(()=>window.nativePageCalls.length),2);
      await page.getByRole("button",{name:"返回设备管理",exact:true}).click();
      await navigate(page,"首页");
      await page.getByRole("button",{name:"连接设备",exact:true}).click();await frame.getByRole("heading",{name:"DOHC 设备状态"}).waitFor();
      await page.getByRole("button",{name:"返回设备管理",exact:true}).click();
      await navigate(page,"首页");
      await page.getByRole("button",{name:"设备热点（AP）",exact:true}).click();
      await page.getByRole("region",{name:"可用 Wi-Fi"}).waitFor();await page.getByRole("button",{name:/Delta-D1-test001/}).waitFor();
      const refreshWifi=page.getByRole("button",{name:"刷新 Wi-Fi",exact:true});
      assert.ok((await refreshWifi.getAttribute("class")).includes("button-secondary"));
      assert.equal(await refreshWifi.evaluate(e=>getComputedStyle(e).textDecorationLine),"none");
      assert.equal(await page.getByRole("button",{name:/Office/}).isDisabled(),true);
      await page.getByText("信号质量 92%",{exact:true}).waitFor();
      await page.evaluate(()=>window.wifiFixtureConnected=true);await page.locator(".manager-wifi-connected").waitFor();
      await page.evaluate(()=>window.wifiFixtureConnected=false);await page.locator(".manager-wifi-connected").waitFor({state:"detached"});
      await page.getByRole("complementary",{name:"热点连接教程"}).getByText("如何连接设备热点",{exact:true}).waitFor();
      const manualPassword=page.getByRole("button",{name:"手动输入密码",exact:true});
      assert.ok((await manualPassword.getAttribute("class")).includes("button-secondary"));
      assert.equal(await manualPassword.evaluate(e=>getComputedStyle(e).textDecorationLine),"none");
      await manualPassword.click();await page.getByLabel("热点密码",{exact:true}).fill("fixture-password");
      await page.evaluate(()=>window.pageFixtureMode="wrong-password");await page.getByRole("button",{name:"连接热点并打开",exact:true}).click();
      await page.getByRole("alert").filter({hasText:"热点连接未完成"}).waitFor();assert.equal(await page.getByLabel("热点密码",{exact:true}).inputValue(),"");
      await page.evaluate(()=>window.pageFixtureMode="success");await page.getByLabel("热点密码",{exact:true}).fill("fixture-password");
      await noOverflow(page);await page.screenshot({path:resolve(reportRoot,`native-ap-wifi-${viewport.width}.png`),fullPage:true});
      await page.getByRole("button",{name:"连接热点并打开",exact:true}).click();await frame.getByRole("heading",{name:"DOHC 设备状态"}).waitFor();
      assert.equal(await page.evaluate(()=>window.nativePageCalls.at(-1).connectionMode),"ap");
      assert.equal(await page.evaluate(()=>window.nativePageCalls.at(-1).apAddress),undefined);
      await page.getByText("设备页面 · 192.168.4.1",{exact:true}).waitFor();
      await page.getByRole("button",{name:"返回设备管理",exact:true}).click();await navigate(page,"首页");assert.equal(await page.getByLabel("热点密码",{exact:true}).inputValue(),"");
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
      evidence.push({viewport,status:"passed",nativePage:true,confirmedConfigurationRequest:true,wifiRecommendation:true,passwordCleared:true,opaqueSandbox:true,guidesAlwaysVisible:true,routedLan:true,externalRequests:0});
    }finally{await context.close();}
  }
});

test("AP provisioning form requires host confirmation and returns the connecting page without enabling OTA",async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},false,nativePageFixture);
  try{
    await navigate(page,"首页");await page.getByRole("button",{name:"设备热点（AP）",exact:true}).click();
    await page.getByRole("button",{name:"手动输入密码",exact:true}).click();await page.getByLabel("热点密码",{exact:true}).fill("fixture-hotspot-password");
    await page.evaluate(()=>window.pageFixtureMode="provisioning");
    await page.getByRole("button",{name:"连接热点并打开",exact:true}).click();
    const frame=page.frameLocator('iframe[title="D1 设备页面"]');await frame.getByRole("heading",{name:"设备维护"}).waitFor();
    assert.equal(await frame.getByRole("button",{name:"在线下载并升级"}).isDisabled(),true);
    assert.equal(await frame.getByRole("button",{name:"上传并升级"}).isDisabled(),true);
    await frame.getByLabel("Wi-Fi 名称",{exact:true}).fill("Office fixture");await frame.getByLabel("Wi-Fi 密码",{exact:true}).fill("fixture-network-password");
    page.once("dialog",dialog=>dialog.dismiss());await frame.getByRole("button",{name:"连接网络",exact:true}).click();
    assert.equal(await page.evaluate(()=>window.pageApiCalls.length),0);
    await frame.getByLabel("Wi-Fi 密码",{exact:true}).fill("fixture-network-password");
    let confirmation="";page.once("dialog",async dialog=>{confirmation=dialog.message();await dialog.accept();});
    await frame.getByRole("button",{name:"连接网络",exact:true}).click();
    await page.waitForTimeout(1000);
    if(!(await page.getByRole("heading",{name:"设备正在配网",exact:true}).count()))throw new Error(JSON.stringify({confirmation,apiCalls:await page.evaluate(()=>window.pageApiCalls),frameText:await frame.locator("body").innerText(),pageErrors:errors}));
    await page.getByRole("progressbar",{name:"等待设备配网结果"}).waitFor();
    assert.match(confirmation,/热点会断开/);
    const apiCall=await page.evaluate(()=>window.pageApiCalls[0]);assert.equal(apiCall.path,"/configure");assert.equal(apiCall.method,"POST");
    assert.deepEqual(JSON.parse(apiCall.body),{ssid:"Office fixture",password:"fixture-network-password"});
    await page.evaluate(()=>window.pageFixtureMode="provision-failed");
    await page.getByRole("heading",{name:"配网失败",exact:true}).waitFor();
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:"passed",apProvisioningForm:true,confirmationRequired:true,otaDisabled:true,provisioningFailureFromDevice:true,externalRequests:0});
  }finally{await context.close();}
});

async function actualNativeMarkupFixture(context){
  await nativePageFixture(context);
  const native=readFileSync(new URL('./fixtures/d1-native/status.html',import.meta.url),'utf8');
  const config=readFileSync(new URL('./fixtures/d1-native/config.html',import.meta.url),'utf8');
  const runtime=`
    export * from '/__d1-native-base';
    import * as base from '/__d1-native-base';
    const status={schema:'dohc.device.status-summary.v2',device:{device_id:'native-fixture-device',workspace_version:'1.1.1'},health:'OK',phase:'IDLE',heartbeat_stale:false,cameras:{configured:1,fresh:1,items:[{role:'main',state:'STREAMING',enabled:true,fresh:true,required:true,last_frame_age_seconds:0.01,reconnect_count:0}]},storage:{mounted:true,writable:true,usage_warning:false,free_bytes:1024**3,total_bytes:2*1024**3,used_percent:50,filesystem_type:'exfat'},emmc_storage:{usage_warning:false,free_bytes:1024**3,used_percent:40},recording:{session_active:false,quality:'OK',writer_alive:true,queue_depth:0,queue_capacity:256,dropped_batches:0},indicators:{status:{color_name:'white',pattern:'steady',write_state:'SYNCHRONIZED'},battery:{color_name:'yellow',pattern:'steady',write_state:'SYNCHRONIZED'}},alerts:{total:0,items:[]},qc:{phase:'IDLE',result:null},stress_test:{phase:'IDLE',result:null},telemetry:{vcc_voltage:7.1,chip_temp:50}};
    const currentStatus=()=>{let value={...status};if(window.pageFixtureMode==='degraded')value={...value,health:'DEGRADED',phase:'RECOVERING',alerts:{total:1,items:[{code:'BATTERY_VOLTAGE_LOW',component:'battery',severity:'warning'}]}};if(window.pageFixtureMode==='warning')value={...value,health:'FAILED',phase:'FAULT',alerts:{total:1,items:[{code:'CHIP_TEMPERATURE_CRITICAL',component:'temperature',severity:'critical'}]}};if(window.pageFixtureMode==='stale')value={...value,health:'DEGRADED',phase:'RECOVERING',heartbeat_stale:true,alerts:{total:1,items:[{code:'BATTERY_VOLTAGE_LOW',component:'battery',severity:'warning'}]}};return value;};
    export async function readDevicePage(request){window.nativePageCalls.push(request);return {address:request.apAddress??'192.168.4.1',observedAtMs:Date.now(),status:currentStatus(),html:ROOT};}
    export async function requestDevicePageApi(request,api){window.pageApiCalls.push(api);if(api.path==='/config'||api.path==='/')return {status:200,contentType:'text/html',body:api.path==='/config'?CONFIG:ROOT};if(api.path==='/status')return {status:200,contentType:'application/json',body:JSON.stringify(currentStatus())};
      if(api.path==='/api/v1/runtime-config')return {status:200,contentType:'application/json',body:JSON.stringify({sha256:'a'.repeat(64),categories:[{id:'camera',label:'相机'},{id:'storage',label:'存储方法'}],fields:[{key:'DOHC_T265_CAPTURE_MODE',type:'select',label:'T265 采集内容',category:'camera',value:'images-and-pose',choices:[{label:'图像 + 位姿',value:'images-and-pose'},{label:'仅位姿',value:'pose-only'}]},{key:'DOHC_RECORDING_QUEUE_SIZE',type:'integer',label:'采集队列容量',category:'storage',value:'256',minimum:16,maximum:4096}]})};
      if(api.path==='/api/v1/camera-config')return {status:200,contentType:'application/json',body:JSON.stringify({sha256:'b'.repeat(64),manifest:{version:1,cameras:{main:{enabled:true,required:true,profile:'USB',recording_fps:30}}}})};
      return {status:200,contentType:'application/json',body:JSON.stringify(api.path.endsWith('device-name')?{name:'测试人员',choices:['测试人员']}:{task:'fixture-task',choices:[{value:'fixture-task',label:'测试任务'}]})};}
    export async function requestDevicePageBatch(request,apis){window.readBatchSizes??=[];window.readBatchSizes.push(apis.length);return Promise.all(apis.map(api=>requestDevicePageApi(request,api)));}
  `.replaceAll('ROOT',JSON.stringify(native)).replaceAll('CONFIG',JSON.stringify(config));
  await context.route('**/__d1-native-base',route=>route.fulfill({contentType:'application/javascript',body:`export * from '/src/lib/backend.ts';export const isTauriRuntime=()=>true;export async function getDeviceAvailability(){return {connection:'not_connected',observation:null,identity:null,configuration:{deviceOta:{enabled:false}},linkDiscovery:{candidates:[]}}};export async function getWifiInventory(){return {supported:true,observedAtMs:Date.now(),networks:[{interfaceId:'22',ssid:'Delta-D1-test001',signal:92,connected:false,recommended:true,connectable:true}]}};export async function connectDeviceWifi(request){window.wifiConnectCalls.push({passwordLength:request.password.length});return {interfaceId:'22',ssid:request.ssid,connected:true}};`}));
  await context.route('**/__d1-component-runtime',route=>route.fulfill({contentType:'application/javascript',body:runtime}));
}

test('actual device HTML loads all startup APIs, navigates configuration repeatedly and exposes Chinese runtime evidence',async()=>{
  for(const viewport of [{width:1440,height:920},{width:960,height:680},{width:390,height:844}]){
  const {page,context,errors,external}=await session(viewport,false,actualNativeMarkupFixture);
  try{
    await navigate(page,'首页');await page.getByRole('button',{name:'局域网 IP',exact:true}).click();
    await page.getByLabel('设备 IP',{exact:true}).fill('10.1.50.81');await page.getByRole('button',{name:'连接设备',exact:true}).click();
    const frame=page.frameLocator('iframe[title="D1 设备页面"]');
    await frame.locator('#cameraConfigRows input').first().waitFor();
    await frame.locator('#deviceName').getByRole('option',{name:'测试人员'}).waitFor({state:'attached'});
    await frame.locator('#deviceTask').getByRole('option',{name:'测试任务'}).waitFor({state:'attached'});
    assert.equal(await page.evaluate(()=>Math.max(...window.readBatchSizes)),4);
    for(let i=0;i<3;i++){
      await frame.getByRole('link',{name:'运行配置',exact:true}).click();
      await frame.locator('#fields input').waitFor();
      await frame.locator('#category').selectOption('camera');await frame.locator('#fields select').waitFor();
      await frame.locator('#category').selectOption('storage');await frame.locator('#fields input').fill('512');
      assert.equal(await frame.locator('#fields input').getAttribute('data-key'),'DOHC_RECORDING_QUEUE_SIZE');
      await frame.getByRole('link',{name:'返回状态',exact:true}).click();await frame.locator('#cameraConfigRows input').first().waitFor();
    }
    await page.getByRole('button',{name:'返回设备管理',exact:true}).click();
    await navigate(page,'设备管理');
    await page.getByRole('region',{name:'设备实时运行状态'}).waitFor();await page.locator('.manager-summary-storage').waitFor();
    assert.equal(await page.locator('.overview-health.tone-normal').count(),1);
    assert.equal(await page.locator('.overview-health.tone-normal').evaluate(card=>getComputedStyle(card).backgroundColor),'rgb(237, 247, 241)');
    assert.equal(await page.locator('.overview-phase.tone-info').count(),1);
    assert.equal(await page.locator('.overview-voltage.tone-info').count(),1,'voltage values stay informational without a device-reported threshold alert');
    assert.equal(await page.locator('.overview-temperature.tone-info').count(),1,'temperature values stay informational without a device-reported threshold alert');
    assert.deepEqual(await page.locator('.manager-summary-card').evaluateAll(cards=>[...new Set(cards.map(card=>getComputedStyle(card).backgroundColor))]),['rgb(255, 255, 255)']);
    await page.screenshot({path:resolve(reportRoot,`runtime-overview-${viewport.width}.png`),fullPage:true});
    await page.evaluate(()=>window.pageFixtureMode='degraded');await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await page.locator('.overview-health.tone-attention').waitFor();await page.locator('.overview-phase.tone-attention').waitFor();await page.locator('.overview-voltage.tone-attention').waitFor();
    assert.equal(await page.locator('.overview-health.tone-attention').evaluate(card=>getComputedStyle(card).backgroundColor),'rgb(255, 248, 232)');
    await page.evaluate(()=>window.pageFixtureMode='warning');await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await page.locator('.overview-health.tone-warning').waitFor();await page.locator('.overview-phase.tone-warning').waitFor();await page.locator('.overview-temperature.tone-warning').waitFor();
    assert.equal(await page.locator('.overview-health.tone-warning').evaluate(card=>getComputedStyle(card).backgroundColor),'rgb(255, 240, 239)');
    await navigate(page,'检测排障');await page.getByRole('heading',{name:'采集与写入',exact:true}).waitFor();
    await noOverflow(page);await page.screenshot({path:resolve(reportRoot,`runtime-status-${viewport.width}.png`),fullPage:true});
    await page.evaluate(()=>window.pageFixtureMode='stale');await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await page.locator('.manager-runtime .check-indeterminate').first().waitFor();await page.locator('.overview-health.tone-info').waitFor();
    assert.equal(await page.locator('.overview-voltage.tone-info').evaluate(card=>getComputedStyle(card).backgroundColor),'rgb(238, 245, 251)','a stale warning must not color stale telemetry as current');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:'passed',actualDeviceMarkup:true,viewport,startupBatch:4,repeatedNavigation:3,chineseRuntime:true,statusCardTones:['normal','attention','warning','info'],staleUnknown:true,realDeviceOperations:false});
  }finally{await context.close();}
  }
});


test('AP and LAN both expose the same Chinese device information and complete diagnostics',async()=>{
  for(const mode of ['ap','lan']){
    const {page,context,errors,external}=await session({width:960,height:680},false,actualNativeMarkupFixture);
    try{
      await navigate(page,'首页');await page.getByRole('button',{name:mode==='ap'?'设备热点（AP）':'局域网 IP',exact:true}).click();
      if(mode==='lan'){
        await page.getByLabel('设备 IP',{exact:true}).fill('10.1.30.114');await page.getByRole('button',{name:'连接设备',exact:true}).click();
      }else await page.getByRole('button',{name:'连接热点并打开',exact:true}).click();
      await page.frameLocator('iframe[title="D1 设备页面"]').locator('#cameraConfigRows input').first().waitFor();
      await navigate(page,'设备信息');
      const runtime=page.getByRole('region',{name:'设备实时运行状态'});await runtime.waitFor();
      assert.equal(await page.locator('iframe[title="D1 设备页面"]').count(),0,'device information does not remain trapped in the native page');
      await page.getByText('实际连接方式',{exact:true}).waitFor();
      for(const label of ['存储','采集与写入','相机','指示灯','设备测试'])await runtime.getByRole('heading',{name:label,exact:true}).waitFor();
      assert.match(await runtime.innerText(),/native-fixture-device/);assert.match(await runtime.innerText(),/正常/);
      await navigate(page,'检测排障');
      for(const label of ['采集存储卡','设备内置存储','主相机','设备已有自检','设备已有压力测试'])await runtime.getByRole('heading',{name:label,exact:true}).waitFor();
      assert.equal(await runtime.getByText('未执行',{exact:true}).count(),2,'reading existing idle tests cannot claim a pass');
      await page.screenshot({path:resolve(reportRoot,`unified-${mode}-diagnostics.png`),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    }finally{await context.close();}
  }
});

test('D1 hotspot uses factory default on explicit user connection and retains manual override',async()=>{
  const {page,context,errors,external}=await session({width:960,height:680},false,nativePageFixture);
  try{
    await navigate(page,'首页');await page.getByRole('button',{name:'设备热点（AP）',exact:true}).click();
    await page.getByRole('button',{name:/Delta-D1-test001/}).waitFor();
    assert.equal(await page.getByLabel('热点密码',{exact:true}).count(),0);
    await page.getByRole('button',{name:'连接热点并打开',exact:true}).click();
    await page.frameLocator('iframe[title="D1 设备页面"]').getByRole('heading',{name:'DOHC 设备状态'}).waitFor();
    assert.equal(await page.evaluate(()=>window.wifiConnectCalls[0].passwordLength),0,'empty override delegates to the Rust factory default');
    await navigate(page,'设备信息');await page.getByText('实际连接方式',{exact:true}).waitFor();await page.getByText('设备热点（AP）',{exact:true}).waitFor();
    assert.equal(await page.getByRole('group',{name:'连接方式'}).count(),0,'native device view shows the connected mode without repeating selectors');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await context.close();}
});


test('Type-C runtime summary keeps port exemption, unknown fields and disconnect semantics',async()=>{
  const {page,context,errors,external}=await session({width:1440,height:920},false,physicalContractFixture);
  try{
    await page.evaluate(()=>{
      const o=window.deviceFixture.observation;o.cameraPortLimited=true;o.connectionLimitedOnly=true;
      o.statusSummary={schema:'dohc.device.status-summary.v2',health:'DEGRADED',heartbeat_stale:false,device:{device_id:'test-d1-device',workspace_version:'1.1.1'},cameras:{items:[{role:'stereo_extension',state:'FAULT',fresh:false,enabled:true}]}};
    });
    await navigate(page,'设备信息');await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await page.getByText('连接受限',{exact:true}).waitFor();
    await page.locator('.manager-runtime .manager-summary-cameras .result-not_run').waitFor();
    assert.equal(await page.locator('.manager-runtime .manager-summary-storage .result-indeterminate').count(),1);
    await navigate(page,'检测排障');assert.equal(await page.getByRole('heading',{name:'尚未运行检测',exact:true}).count(),0);
    await page.evaluate(()=>window.deviceAvailabilityFailure={code:'D1_DISCONNECTED',message:'设备已断开'});
    await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await page.getByText('设备未就绪',{exact:true}).waitFor();
    assert.equal(await page.locator('.manager-runtime .result-normal').count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    evidence.push({status:'passed',typeCRuntimePortExemption:true,missingFieldsUnknown:true,disconnectClearsSummary:true});
  }finally{await context.close();}
});
