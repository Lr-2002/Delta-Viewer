import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

let server, browser, origin;
before(async () => {
  server=await createServer({logLevel:"error",server:{host:"127.0.0.1",port:0}});
  await server.listen(); origin=server.resolvedUrls.local[0];
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM ?? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","/usr/bin/google-chrome"].find(existsSync) ?? chromium.executablePath();
  browser=await chromium.launch({executablePath,headless:true});
  await mkdir("artifacts/segment-consistency",{recursive:true});
});
after(async()=>{await browser?.close();await server?.close();});

async function fixture(t, recovery) {
  const context=await browser.newContext({viewport:{width:1440,height:920}});
  t.after(()=>context.close());
  await context.addInitScript(recovery=>{
    const sourcePath="/synthetic-consistency";
    const segments=[[0,9],[10,19],[20,29]].map(([startFrame,endFrame],sourceIndex)=>({sourceIndex,startFrame,endFrame,description:`整理物品 ${sourceIndex}`,deleted:false,decision:"pending"}));
    const source={sourceName:"bailian_annotation.json",sourceHash:"current-source",episodeId:"synthetic",frameCount:30,segments,warnings:[]};
    const key=`dohc.machine-review.pending:${sourcePath}:account:undefined`;
    if (recovery && !localStorage.getItem("initialized")) {
      localStorage.setItem(key,JSON.stringify({sourceHash:recovery==="stale"?"old-source":source.sourceHash,status:"approved",segments:segments.map((s,i)=>({...s,startFrame:i===1?5:s.startFrame}))}));
      localStorage.setItem("initialized","true");
    }
    let state=JSON.parse(localStorage.getItem("saved-review")??"null")??{sourceHash:source.sourceHash,revision:0,segments,published:false,status:"pending",qcStatus:"pending"};
    window.__proofData={summary:{name:"synthetic",root:sourcePath,streams:[{name:"cam0",label:"Camera 0",frameCount:30,firstFrame:0,lastFrame:29,width:320,height:180,totalBytes:1,missingFrames:[],missingFrameCount:0,channels:3}]},states:[]};
    window.__rangeCalls=[];
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      if(command==="review_identity_path")return args.path;
      if(["get_review_audit_queue_status","persist_review_audit","flush_review_audit_queue"].includes(command))return {pending:0,blocked:0,error:""};
      if(command==="get_video_source")return null;
      if(command==="list_machine_annotation_sources")return ["bailian_annotation.json"];
      if(command==="load_machine_annotation")return structuredClone(source);
      if(command==="load_machine_review")return structuredClone(state);
      if(command==="save_machine_review"){
        window.__rangeCalls.push(structuredClone(args.request));
        state={...state,segments:args.request.segments,status:args.request.status,localDraft:args.request.status==="pending",revision:state.revision+1};
        localStorage.setItem("saved-review",JSON.stringify(state));return structuredClone(state);
      }
      throw Error(`Unexpected IPC ${command}`);
    }};
  },recovery);
  const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(new URL("scripts/fixtures/proofreading.html",origin).href);
  await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.disabled===false);
  return {page,errors};
}

test("consecutive deletion restore is explicit and saves only disjoint pending ranges",async t=>{
  const {page,errors}=await fixture(t);
  for(let i=0;i<2;i++){
    await page.getByRole("button",{name:"删除机标片段 1",exact:true}).evaluate(el=>el.click());
    await page.waitForFunction(n=>window.__rangeCalls.length===n,i+1);
    await page.waitForFunction(()=>!document.querySelector('[aria-label="重新读取机标"]')?.disabled);
  }
  await page.getByRole("button",{name:"恢复删除的片段",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"恢复交叠的删除历史"});await dialog.waitFor();
  assert.equal(await page.evaluate(()=>window.__rangeCalls.length),2);
  for(const width of [1440,960,390]){
    await page.setViewportSize({width,height:844});
    const confirm=dialog.getByRole("button",{name:"生成无重叠草稿并核对"});await confirm.scrollIntoViewIfNeeded();
    const b=await confirm.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width&&b.y>=0&&b.y+b.height<=844);
    assert.ok(Number(await dialog.getByRole("button",{name:"取消",exact:true}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize)))>=12,"cancel text must remain visible on narrow screens");
    await page.screenshot({path:`artifacts/segment-consistency/restore-${width}.png`});
  }
  await dialog.getByRole("button",{name:"取消",exact:true}).click();assert.equal(await page.evaluate(()=>window.__rangeCalls.length),2);
  await page.getByRole("button",{name:"恢复删除的片段",exact:true}).click();
  await dialog.getByRole("button",{name:"生成无重叠草稿并核对"}).click();
  await page.waitForFunction(()=>window.__rangeCalls.length===3);
  const request=await page.evaluate(()=>window.__rangeCalls.at(-1));assert.equal(request.status,"pending");
  assert.deepEqual(request.segments.filter(s=>!s.deleted).map(s=>[s.startFrame,s.endFrame]),[[0,9],[10,19],[20,29]]);
  await page.reload();assert.equal(await page.getByLabel("片段范围重叠",{exact:true}).count(),0);
  await page.getByRole("button",{name:"通过",exact:true}).click();await page.waitForFunction(()=>window.__proofCompletion==="approved");
  assert.deepEqual(errors,[]);
});

test("overlapping emergency approval is backed up, shown as pending and cannot submit via Enter",async t=>{
  const {page,errors}=await fixture(t,"overlap");
  const notice=page.getByLabel("片段范围重叠",{exact:true});await notice.waitFor();
  assert.equal(await page.getByRole("button",{name:"通过",exact:true}).isDisabled(),true);
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(()=>window.__rangeCalls.some(r=>r.status==="approved")),false);
  await page.waitForFunction(()=>window.__rangeCalls.length===1);
  assert.equal(await page.evaluate(()=>window.__rangeCalls[0].status),"pending");
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes(":preserved:")).length),1);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:844});await notice.scrollIntoViewIfNeeded();
    const locate=notice.getByRole("button").last();await locate.scrollIntoViewIfNeeded();const b=await locate.boundingBox();
    assert.ok(b.x>=0&&b.x+b.width<=width);await page.screenshot({path:`artifacts/segment-consistency/overlap-${width}.png`});
  }
  await notice.getByRole("button").last().click();
  await page.getByLabel("复核起始帧",{exact:true}).fill("10");
  await notice.waitFor({state:"detached"});
  assert.deepEqual(errors,[]);
});

test("emergency draft from a replaced source never overwrites the freshly loaded segments",async t=>{
  const {page,errors}=await fixture(t,"stale");
  await page.getByText(/应急草稿属于已变化的机标来源/).waitFor();
  assert.equal(await page.evaluate(()=>window.__rangeCalls.length),0);
  assert.equal(await page.getByLabel("片段范围重叠",{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes(":preserved:")).length),1);
  assert.deepEqual(errors,[]);
});
