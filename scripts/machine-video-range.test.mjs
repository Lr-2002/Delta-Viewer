import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const artifacts = path.resolve("artifacts/machine-video-range");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  const ffmpeg = process.env.FFMPEG ?? (process.platform === "win32" ? path.resolve("src-tauri/resources/bin/ffmpeg.exe") : "ffmpeg");
  const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-frames:v", "15", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(artifacts,"range.mp4")], { encoding:"utf8", windowsHide:true });
  assert.equal(generated.status, 0, generated.stderr);
  server = await createServer({ logLevel:"error", server:{host:"127.0.0.1",port:0} });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","/usr/bin/google-chrome"].find(existsSync) ?? chromium.executablePath();
  browser = await chromium.launch({ executablePath, headless:true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, { failSave = false, staleCount = false } = {}) {
  const context = await browser.newContext({ viewport:{width:1440,height:920} });
  t.after(() => context.close());
  await context.route("**/favicon.ico", route => route.fulfill({status:204}));
  await context.addInitScript(({failSave,staleCount}) => {
    const segments = [[0,9],[10,19],[20,29]].map(([startFrame,endFrame],sourceIndex) => ({sourceIndex,startFrame,endFrame,description:`整理物品${sourceIndex}`,deleted:false,decision:"pending"}));
    const annotation = {sourceName:"bailian_annotation.json",sourceHash:"unchanged-source",sourceJson:JSON.stringify(segments),episodeId:"synthetic",frameCount:30,videoFrameCount:staleCount?16:15,segments,warnings:[]};
    const stream = {name:"cam0",label:"Camera 0",frameCount:15,firstFrame:0,lastFrame:14,width:320,height:180,totalBytes:1,missingFrames:[],missingFrameCount:0,channels:3};
    window.__proofData = {summary:{name:"synthetic",root:"/synthetic-range",streams:[stream]},states:[]};
    window.__rangeRaw = structuredClone(annotation);
    window.__rangeCalls = [];
    window.__rangeFail = failSave && !localStorage.getItem("range-saved");
    let state = JSON.parse(localStorage.getItem("range-saved") ?? "null") ?? {sourceHash:annotation.sourceHash,revision:0,segments,published:false,status:"pending",qcStatus:"pending"};
    window.__TAURI_INTERNALS__ = {
      convertFileSrc: p => p,
      invoke: async (command,args) => {
        if (["get_review_audit_queue_status","persist_review_audit","flush_review_audit_queue"].includes(command)) return {pending:0,blocked:0,error:""};
        if (command === "list_machine_annotation_sources") return ["bailian_annotation.json"];
        if (command === "load_machine_annotation") return structuredClone(annotation);
        if (command === "load_machine_review") return structuredClone(state);
        if (command === "get_video_source") return {fps:30,mediaFps:30,segmentSeconds:300,startFrame:0,paths:[new URL("/artifacts/machine-video-range/range.mp4",location.origin).href]};
        if (command === "save_machine_review") {
          window.__rangeCalls.push(structuredClone(args.request));
          if (window.__rangeFail) throw Error("模拟保存失败");
          assertRanges(args.request.segments);
          const draft = args.request.status === "pending";
          if (!args.localEntry || args.localEntry.audit.action !== (draft ? "saved" : args.request.status)) throw Error("missing atomic draft/audit payload");
          state = {...state,segments:args.request.segments,status:args.request.status,qcStatus:args.request.status,localDraft:draft,published:!draft,revision:state.revision+(draft?0:1),versionId:draft?"":"isolated-revision"};
          localStorage.setItem("range-saved",JSON.stringify(state));
          return structuredClone(state);
        }
        throw Error(`Unexpected IPC ${command}`);
      }
    };
    function assertRanges(rows) {
      if (rows.some(s => !s.deleted && s.endFrame >= 15)) throw Error("active overflow");
    }
  }, {failSave,staleCount});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type()==="error") errors.push(m.text()); });
  page.on("requestfailed", r => errors.push(r.failure().errorText));
  await page.goto(new URL("scripts/fixtures/proofreading.html",origin).href);
  await page.getByText("机标视频 30 帧，Camera 0 15 帧，无法可靠对齐。",{exact:true}).waitFor();
  return {page,errors};
}

test("range recovery is explicit, responsive, durable and still requires playback confirmation", async t => {
  const {page,errors} = await fixture(t);
  const open = () => page.getByRole("button",{name:"查看越界片段并处理"}).click();
  const dialog = page.getByRole("dialog",{name:"处理机标越界范围"});
  await open();
  assert.equal(await dialog.getByRole("button",{name:"应用处理并保存待审核草稿"}).isDisabled(),true);
  assert.equal(await dialog.getByRole("listitem").count(),2);
  for (const [width,height] of [[1440,920],[960,680],[390,844]]) {
    await page.setViewportSize({width,height});
    await dialog.waitFor({state:"visible"});
    const apply = dialog.getByRole("button",{name:"应用处理并保存待审核草稿"});
    await apply.scrollIntoViewIfNeeded();
    const bounds = await apply.boundingBox();
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width && bounds.y>=0 && bounds.y+bounds.height<=height);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(artifacts,`confirm-${width}.png`)});
  }
  await dialog.getByRole("button",{name:"取消",exact:true}).click();
  assert.equal(await page.evaluate(() => window.__rangeCalls.length),0);
  await open();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button",{name:"应用处理并保存待审核草稿"}).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("range-saved")??"null")?.localDraft===true);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("range-saved")));
  assert.deepEqual(saved.segments.map(s=>[s.startFrame,s.endFrame,s.deleted]),[[0,9,false],[10,14,false],[20,29,true]]);
  assert.equal(saved.status,"pending");
  assert.deepEqual(await page.evaluate(() => window.__rangeRaw.segments.map(s=>[s.startFrame,s.endFrame,s.deleted])),[[0,9,false],[10,19,false],[20,29,false]]);
  assert.equal(await page.getByRole("button",{name:"恢复删除的片段",exact:true}).isDisabled(),true);
  const approve = page.getByRole("button",{name:"通过",exact:true});
  const verify = page.getByRole("checkbox",{name:"我已回放核对保留片段的动作与边界"});
  assert.equal(await approve.isDisabled(),true);
  await verify.check();
  assert.equal(await approve.isEnabled(),true);
  await page.getByLabel("复核动作描述").fill("整理物品，放回桌面");
  assert.equal(await verify.isChecked(),false,"any edit invalidates the prior boundary confirmation");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("range-saved"))?.segments[0].description==="整理物品，放回桌面");
  await page.reload();
  await verify.waitFor();
  assert.equal(await page.getByLabel("复核动作描述").inputValue(),"整理物品，放回桌面");
  assert.equal(await approve.isDisabled(),true);
  await verify.check();
  await approve.click();
  await page.waitForFunction(() => window.__proofCompletion==="approved");
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("range-saved")))).status,"approved");
  await page.reload();
  await page.getByRole("button",{name:"不通过",exact:true}).click();
  const rejection = page.getByRole("dialog",{name:"不通过原因"});
  await rejection.getByRole("button",{name:"无效数据",exact:true}).click();
  await rejection.getByRole("button",{name:"确认不通过"}).click();
  await page.waitForFunction(() => window.__proofCompletion==="rejected");
  assert.deepEqual(errors,[]);
});

test("failed repair save retains the confirmed edits through restart and retries without resurrecting overflow", async t => {
  const {page,errors} = await fixture(t,{failSave:true});
  await page.getByRole("button",{name:"查看越界片段并处理"}).click();
  const dialog = page.getByRole("dialog",{name:"处理机标越界范围"});
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button",{name:"应用处理并保存待审核草稿"}).click();
  await page.getByRole("button",{name:"重试保存复核"}).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("range-saved")),null);
  await page.reload();
  await page.getByRole("button",{name:"重试保存复核"}).waitFor();
  await page.evaluate(() => {window.__rangeFail=false;});
  await page.getByRole("button",{name:"重试保存复核"}).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("range-saved")??"null")?.localDraft===true);
  assert.equal(await page.getByRole("button",{name:"通过",exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);
});

test("stale media counts cannot enable manual repair with the wrong bound", async t => {
  const {page,errors} = await fixture(t,{staleCount:true});
  await page.getByText(/载入后视频清单发生变化/).waitFor();
  assert.equal(await page.getByRole("button",{name:"查看越界片段并处理"}).count(),0);
  assert.equal(await page.getByRole("button",{name:"通过",exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(() => window.__rangeCalls.length),0);
  assert.deepEqual(errors,[]);
});
