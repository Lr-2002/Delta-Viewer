import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("audit disk failure blocks completion; retry preserves the saved conclusion and advances once", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(() => { window.auditDisk = new Map(); window.failDecisionAudit = true; window.reviewSaveCount = 0; });
  await context.route("**/src/lib/review-audit.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace(/from "[^"\n]*\/backend\.ts[^"\n]*"/, 'from "/__native-audit"');
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  await context.route("**/__native-audit", route => route.fulfill({ contentType: "application/javascript", body: `
    export const isTauriRuntime = () => true;
    export async function persistReviewAudit(username, serviceId, events) {
      if (window.failAllAudit || (window.failDecisionAudit && events.some(e => ["approved", "rejected"].includes(e.action)))) throw Error("模拟磁盘不可用");
      for (const event of events) window.auditDisk.set(event.eventId, event);
      return { pending: window.auditDisk.size, blocked: 0, error: "" };
    }
    export async function getReviewAuditQueueStatus() { return { pending: window.auditDisk.size, blocked: 0, error: "" }; }
    export async function flushReviewAuditQueue() { return { pending: window.auditDisk.size, blocked: 0, error: "offline" }; }
    export async function sendReviewAudit() { throw Error("unexpected network"); }
  ` }));
  await context.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace(/(export async function saveMachineReview\([^]*?\) \{)/, '$1\n window.reviewSaveCount++;');
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "demoScenario=session-activation&machineAnnotation=present");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    const saved = () => page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("demo://session-activation/session-a"));
    const before = await saved();
    // The preflight must not write a conclusion when even operations cannot persist.
    await page.evaluate(() => { window.failAllAudit = true; });
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    const syncNotice = page.getByLabel("操作记录同步状态", { exact: true });
    await syncNotice.getByText("操作记录未保存到本机，有丢失风险", { exact: true }).waitFor();
    assert.equal(await syncNotice.locator(".audit-sync-detail").isVisible(), false);
    await syncNotice.getByRole("button", { name: "同步详情", exact: true }).click();
    await syncNotice.getByText(/失败原因：.*模拟磁盘不可用/).waitFor();
    await syncNotice.getByRole("button", { name: "收起详情", exact: true }).click();
    assert.equal(await page.getByRole("navigation", { name: "工作区视图" }).isVisible(), true);
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await page.getByText(/尚未提交审核结论/).waitFor();
    assert.equal(await page.evaluate(() => window.reviewSaveCount), 0);
    await page.evaluate(() => { window.failAllAudit = false; });
    await page.getByRole("button", { name: "不通过", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "不通过原因" });
    await dialog.getByRole("button", { name: "镜头污渍", exact: true }).click();
    await dialog.getByRole("button", { name: "确认不通过" }).click();
    const retry = page.getByRole("button", { name: "重试保存操作记录", exact: true });
    await retry.waitFor();
    assert.equal(await dialog.count(), 0, "retry must be accessible outside the rejection modal");
    assert.match(await page.locator(".episode-item.selected").textContent(), /session-a/);
    assert.equal(await page.getByLabel("复核动作描述").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "重新读取机标", exact: true }).isDisabled(), true);
    const committed = await saved();
    assert.equal(committed.status, "rejected");
    assert.equal(committed.revision, before.revision + 1);
    assert.equal(await page.evaluate(() => window.reviewSaveCount), 1);
    for (const width of [1440, 960, 390]) {
      await page.setViewportSize({ width, height: 920 });
      await retry.scrollIntoViewIfNeeded();
      const box = await retry.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, "retry fits viewport");
      assert.ok(await retry.evaluate(button => parseFloat(getComputedStyle(button).fontSize) >= 12 && button.clientWidth >= 120), "retry text remains readable on mobile");
      await page.screenshot({ path: `artifacts/unified-proofreading/audit-retry-${width}.png` });
    }
    await page.evaluate(() => { window.failDecisionAudit = false; });
    await retry.click();
    await page.waitForFunction(() => document.querySelector(".episode-item.selected")?.textContent.includes("session-b"));
    assert.equal(await page.evaluate(() => window.reviewSaveCount), 1, "retry cannot resubmit the source conclusion");
    assert.deepEqual(await saved(), committed);
    const decisions = await page.evaluate(() => [...window.auditDisk.values()].filter(e => e.action === "rejected"));
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].details.revision, committed.revisionLabel);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


test("storage failure retains edits; slow writes stay single-flight and never claim submission", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace(/(export async function saveMachineReview\([^]*?\) \{)/, `$1
      window.storageSaveAttempts = (window.storageSaveAttempts || 0) + 1;
      if (window.holdStorageSave) await new Promise(resolve => { window.releaseStorageSave = resolve; });
      if (window.storageFull) throw Error("REVIEW_STORAGE_FULL: 数据目录所在磁盘/NAS 可用空间不足，原子保存需至少 32 MiB 临时空间。尚未开始本次写入；请管理员释放空间或扩容后重试。此问题与用户中心上传无关。");
    `);
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    await page.evaluate(() => { window.holdStorageSave = true; window.storageFull = true; });
    await page.getByLabel("复核动作描述").fill("空间不足时保留人工文字");
    await page.getByText(/保存耗时较长，正在等待本机保存或审核结论/).waitFor({ timeout: 15000 });
    assert.equal(await page.getByRole("button", { name: "通过", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "重试保存复核" }).count(), 0);
    assert.equal(await page.evaluate(() => window.storageSaveAttempts), 1);
    assert.ok(await page.evaluate(() => localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:review-test")));
    await page.evaluate(() => window.releaseStorageSave());
    const retry = page.getByRole("button", { name: "重试保存复核" });
    await retry.waitFor();
    assert.match(await page.locator(".review-save-error").textContent(), /本机应急草稿已保留/);
    assert.equal(await page.getByText(/保存耗时较长，正在等待本机保存或审核结论/).count(), 0);
    for (const width of [1440, 960, 390]) {
      await page.setViewportSize({ width, height: 920 });
      await retry.scrollIntoViewIfNeeded();
      const box = await retry.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.equal(await retry.innerText(), "重试保存");
      await page.screenshot({ path: `artifacts/unified-proofreading/storage-full-${width}.png` });
    }
    await page.evaluate(() => { window.storageFull = false; window.holdStorageSave = false; });
    await retry.click();
    await retry.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.storageSaveAttempts), 2);
    assert.equal(await page.evaluate(() => localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:review-test")), null);
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "空间不足时保留人工文字");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("NAS storage failures save a local conclusion and advance without claiming shared approval", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  await context.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace(/(export async function saveMachineReview\([^]*?\) \{)/, `$1
      const request={sourcePath,sourceHash,expectedRevision,segments,sourceName,status,rejectionReason};
      return deferMachineReview(request,durable.base,"REVIEW_STORAGE_FULL: NAS 磁盘已满",durable.audit);
    `);
    body = body.replace(/(export async function deferMachineReview\([^]*?\) \{)/, `$1
      if(window.localQueueFails) throw Error("SOURCE_REVIEW_LOCAL_STORAGE: 本机磁盘写入失败");
      window.localReviewRows ??= []; window.localReviewRows.push({request,base,audit});
      window.dispatchEvent(new Event("source-review-pending"));
      return {...base,segments:request.segments,status:request.status,pendingSourceWrite:true,published:false,sourceWriteError:error};
    `);
    body = body.replace(/export const getPendingSourceReviews = [^]*?export const publishPendingSourceReviews = [^]*?;\n/, `
      export async function getPendingSourceReviews(checkStorage=false,sourcePaths){
        const items=(window.localReviewRows??[]).filter(row=>!sourcePaths||sourcePaths.includes(row.request.sourcePath)).map(row=>({sourcePath:row.request.sourcePath,name:row.request.sourcePath,channel:'action',status:row.request.status,createdAtMs:row.audit.occurredAtMs,error:''}));
        return {pending:items.length,items,ready:false,storageError:''};
      }
      export async function publishPendingSourceReviews(){
        const rows=window.localReviewRows??[];
        const key='dohc.demo.account-reviews:review-test';
        const records=JSON.parse(localStorage.getItem(key)??'{}');
        for(const row of rows) records[row.request.sourcePath]={sourcePath:row.request.sourcePath,status:row.request.status};
        localStorage.setItem(key,JSON.stringify(records));window.localReviewRows=[];
        return {written:rows.length,remaining:0,errors:[]};
      }
    `);
    await route.fulfill({response,body});
  });
  try {
    await open(page, "demoScenario=session-activation&machineAnnotation=present");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    await page.evaluate(()=>{window.localQueueFails=true;});
    await page.getByRole("button",{name:"通过",exact:true}).click();
    await page.getByRole("button",{name:"重试保存复核"}).waitFor();
    assert.match(await page.locator(".episode-item.selected").textContent(),/session-a/);
    await page.evaluate(()=>{window.localQueueFails=false;});
    await page.getByRole("button",{name:"重试保存复核"}).click();
    await page.getByText("结果已保存本机 · 待写回数据目录").waitFor();
    assert.equal(await page.locator(".quality-output").textContent(),"description.json待审核");
    assert.equal(await page.getByRole("button",{name:"通过",exact:true}).isEnabled(),true);
    await page.getByRole("button",{name:"通过",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.episode-item.selected')?.textContent.includes('session-b'));
    const rows=await page.evaluate(()=>window.localReviewRows);
    const pendingBadge = page.locator('.episode-item').filter({hasText:'session-a'}).getByLabel('本机待写回');
    await pendingBadge.waitFor();
    assert.match(await pendingBadge.innerText(), /本机通过 · 待写回 NAS/);
    assert.equal(await page.locator('.episode-item').filter({hasText:'session-a'}).getByLabel('已审核',{exact:true}).count(),0);
    for(const width of [1440,960,390]) {
      await page.setViewportSize({width,height:920});await pendingBadge.scrollIntoViewIfNeeded();
      const box=await pendingBadge.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:`artifacts/unified-proofreading/sidebar-pending-${width}.png`});
    }
    await page.getByRole('button',{name:'查看待写结果',exact:true}).click();
    await page.getByRole('button',{name:'确认写回数据目录',exact:true}).click();
    await pendingBadge.waitFor({state:'detached'});
    await page.locator('.episode-item').filter({hasText:'session-a'}).getByLabel('已审核',{exact:true}).waitFor();
    assert.match(await page.locator('.episode-item').filter({hasText:'session-a'}).textContent(),/我已审·通过/);
    assert.equal(rows.length,2);assert.equal(rows[1].audit.action,"approved");
    assert.equal(rows[1].audit.sessionId,rows[0].audit.sessionId);
    const audit=await page.evaluate(()=>JSON.parse(localStorage.getItem("dohc.demo.review-events")??"[]"));
    assert.equal(audit.filter(e=>e.action==="approved").length,0,"do not upload a shared approval before NAS confirmation");
  } finally {await context.close();}
});

test("failed save keeps a recovery snapshot, releases navigation and survives reload", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  await context.route("**/src/lib/backend.ts", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace(/(export async function saveMachineReview\([^]*?\) \{)/,
      '$1\n if (localStorage.getItem("test.fail-review") === "1") throw new Error("MACHINE_REVIEW: 模拟写入失败");');
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    await page.evaluate(() => localStorage.setItem("test.fail-review", "1"));
    await page.getByLabel("复核动作描述").fill("人工草稿必须保留");
    await page.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "重新读取机标", exact: true }).isEnabled(), true);
    const backup = await page.evaluate(() => JSON.parse(localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:review-test")));
    assert.equal(backup.segments[0].description, "人工草稿必须保留");
    const nav = page.getByRole("navigation", { name: "工作区视图" });
    const other = nav.getByRole("button").filter({ hasText: "检查" }).first();
    await other.click();
    assert.equal(await page.getByLabel("复核动作描述").count(), 0);
    await nav.getByRole("button", { name: "校对", exact: true }).click();
    await page.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工草稿必须保留");
    await page.getByRole("button", { name: "重新读取机标", exact: true }).click();
    await page.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工草稿必须保留");
    // A fresh page has no in-memory backend reviews or account, just like restarting.
    await page.close();
    const restarted = await context.newPage();
    await open(restarted, "machineAnnotation=present");
    await restarted.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await restarted.getByLabel("复核动作描述").inputValue(), "人工草稿必须保留");
    await restarted.evaluate(() => localStorage.removeItem("test.fail-review"));
    await restarted.getByRole("button", { name: "重试保存复核" }).click();
    await restarted.waitForFunction(() => !document.querySelector('[aria-label="重试保存复核"]'));
    const saved = await restarted.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    assert.equal(saved.segments[0].description, "人工草稿必须保留");
    assert.equal(await restarted.evaluate(() => localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:review-test")), null);
    await restarted.screenshot({ path: "artifacts/unified-proofreading/recovery-desktop.png", fullPage: true });
  } finally { await context.close(); }
});

test("directory restore succeeds despite failed task services after restarting with the same account", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/src/App.tsx", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    assert.ok(original.includes("didAutoLoad.current || isTauriRuntime()"), "disable browser-only auto loading so this tests restored directories");
    const body = original.replace("didAutoLoad.current || isTauriRuntime()", "true || isTauriRuntime()");
    await route.fulfill({ response, body });
  });
  await context.route("**/src/lib/backend.ts", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    for (const name of ["listAssignedTaskDefinitions", "getAssignedTasks", "getAssignedTaskActivity"]) {
      body = body.replace(new RegExp("(export async function " + name + "\\([^]*?\\) \\{)"),
        '$1\n throw new Error("模拟任务服务断开");');
    }
    body = body.replace(/(export async function getAssignedSourceRoot\([^]*?\) \{)/,
      '$1\n return "/demo/2026-07-13_07-34-12";');
    await route.fulfill({ response, body });
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await context.newPage();
      await open(page, "machineAnnotation=present");
      await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
      assert.ok(await page.locator(".episode-list button").count() > 0);
      await page.close();
    }
  } finally { await context.close(); }
});

test("login resumes the active batch entry instead of the previously reviewed entry", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => localStorage.setItem(
      "dohc-viewer.review-resume.v1:review-test",
      JSON.stringify({
        sourceRoot: "demo://session-activation",
        episodeRoot: "demo://session-activation/session-b",
        active: true,
        updatedAtMs: Date.now(),
      }),
    ));
    await open(page, "demoScenario=session-activation&machineAnnotation=present");
    await page.waitForFunction(() => document.querySelector(".episode-item.selected")?.textContent?.includes("session-b"));
    assert.match(await page.locator(".episode-item.selected").textContent(), /session-b/);
    const resume = await page.evaluate(() => JSON.parse(localStorage.getItem("dohc-viewer.review-resume.v1:review-test")));
    assert.equal(resume.episodeRoot, "demo://session-activation/session-b");
    assert.equal(resume.active, true);
  } finally { await context.close(); }
});

test("a completed legacy cursor advances to the first unreviewed entry in its batch", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem("dohc-viewer.last-assigned-episode.v1:review-test", "demo://session-activation/session-a");
      localStorage.setItem("dohc.demo.account-reviews:review-test", JSON.stringify({
        "demo://session-activation/session-a": {
          sourcePath: "demo://session-activation/session-a", username: "review-test", reviewerName: "Review Test",
          status: "approved", rejectionReason: "", revision: "old", updatedAtMs: Date.now(),
        },
      }));
    });
    await open(page, "demoScenario=session-activation&machineAnnotation=present");
    await page.waitForFunction(() => document.querySelector(".episode-item.selected")?.textContent?.includes("session-b"));
    assert.match(await page.locator(".episode-item.selected").textContent(), /session-b/);
  } finally { await context.close(); }
});

test("restart restores the batch and current selection despite an older configured directory", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/src/App.tsx", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace("didAutoLoad.current || isTauriRuntime()", "true || isTauriRuntime()");
    await route.fulfill({ response, body });
  });
  await context.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    let body = (await response.text()).replace(/(export async function getAssignedSourceRoot\([^]*?\) \{)/, '$1\n return "/old-batch";');
    body = body.replace(/(export async function scanSource\([^]*?\) \{)/, '$1\n window.__scannedRoot = path;');
    await route.fulfill({ response, body });
  });
  try {
    let page = await context.newPage();
    await open(page, "demoScenario=session-activation&machineAnnotation=present", "resume-alice");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    await page.locator(".episode-item").filter({ hasText: "session-b" }).dblclick();
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    await page.close();
    page = await context.newPage();
    await open(page, "demoScenario=session-activation&machineAnnotation=present", "resume-alice");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    assert.equal(await page.evaluate(() => window.__scannedRoot), "demo://session-activation");
    assert.match(await page.locator(".episode-item.selected").textContent(), /session-b/);
    assert.equal(await page.locator(".episode-item").count(), 3);
    await page.close();
    page = await context.newPage();
    await open(page, "demoScenario=session-activation&machineAnnotation=present", "resume-bob");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    assert.equal(await page.evaluate(() => window.__scannedRoot), "/old-batch");
    assert.match(await page.locator(".episode-item.selected").textContent(), /session-a/);
  } finally { await context.close(); }
});


test("account review tags survive logout and restart, isolate other users and retain reviewed entries", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.route("**/src/lib/backend.ts", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(export async function getAssignedSourceRoot\([^]*?\) \{)/,
      '$1\n return "/demo/2026-07-13_07-34-12";');
    await route.fulfill({ response, body });
  });
  let page = await context.newPage();
  try {
    await open(page, "machineAnnotation=present", "alice");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    await page.getByRole("button", { name: "不通过", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "不通过原因" });
    await dialog.getByRole("button", { name: "镜头遮挡", exact: true }).click();
    await page.screenshot({ path: "artifacts/unified-proofreading/lens-occlusion.png", fullPage: true });
    await dialog.getByRole("button", { name: "确认不通过" }).click();
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·不通过");
    const record = await page.evaluate(async () => (await import("/src/lib/backend.ts")).listMyMachineReviews(["/demo/2026-07-13_07-34-12"]));
    assert.equal(record[0].username, "alice");
    assert.equal(record[0].rejectionReason, "镜头遮挡");
    await page.getByRole("button", { name: "跳过 2026-07-13_07-34-12", exact: true }).click();
    assert.equal(await page.getByLabel("已审核", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("button", { name: "返回登录", exact: true }).click();
    await page.locator('input[autocomplete="username"]').fill("alice");
    await page.locator('input[type="password"]').fill("demo-password-123");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·不通过");
    await page.close();
    page = await context.newPage();
    await open(page, "machineAnnotation=present", "bob");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    assert.equal(await page.getByLabel("已审核", { exact: true }).count(), 0);
    assert.ok(await page.locator(".episode-list .episode-item").count() > 0);
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·通过");
    await page.close();
    page = await context.newPage();
    await open(page, "machineAnnotation=present", "alice");
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·不通过");
    await page.screenshot({ path: "artifacts/unified-proofreading/account-restored.png", fullPage: true });
  } finally { await context.close(); }
});

test("new account cannot automatically save another account's recovery draft", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.addInitScript(() => localStorage.setItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:alice",
      JSON.stringify({sourceHash:"old",status:"rejected",rejectionReason:"镜头遮挡",
        segments:[{sourceIndex:0,startFrame:0,endFrame:10,description:"Alice 私有草稿",deleted:false,decision:"pending"}]})));
    await open(page, "machineAnnotation=present", "bob");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    assert.notEqual(await page.getByLabel("复核动作描述").inputValue(), "Alice 私有草稿");
    const mine = await page.evaluate(async () => (await import("/src/lib/backend.ts")).listMyMachineReviews(["/demo/2026-07-13_07-34-12"]));
    assert.deepEqual(mine, []);
    assert.ok(await page.evaluate(() => localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:alice")));
  } finally { await context.close(); }
});

test("long recording shows usable read-only video controls while checks wait and mounts audit only afterward", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  await context.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    let body = await response.text();
    const begin = body.indexOf("export async function loadEpisode(");
    const end = body.indexOf("export async function validateEpisode(", begin);
    const load = body.slice(begin, end).replaceAll("return {", "return { statesPartial: !window.previewChecksDone,");
    body = body.slice(0, begin) + load + body.slice(end);
    body = body.replace(/(export async function validateEpisode\([^]*?\) \{)/, `$1
      window.previewValidationStarted=true;
      await new Promise(resolve=>{window.finishPreviewChecks=()=>{window.previewChecksDone=true;resolve();};});
    `);
    for (const name of ["listMachineAnnotationSources", "loadMachineAnnotation", "loadMachineReview"]) {
      body = body.replace(new RegExp("(export async function " + name + "\\([^]*?\\) \\{)"),
        '$1\n window.previewEditorReads=(window.previewEditorReads??0)+1;');
    }
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    await page.getByRole("region", { name: "只读视频预览", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.previewEditorReads??0), 0);
    assert.equal(await page.getByRole("button", { name: "通过", exact: true }).count(), 0);
    const slider = page.getByRole("slider", { name: "预览播放帧", exact: true });
    await page.getByRole("button", { name: "下一帧", exact: true }).click();
    assert.equal(await slider.inputValue(), "1");
    await page.waitForFunction(() => window.previewValidationStarted);
    assert.equal(await page.evaluate(() => window.previewEditorReads??0), 0);
    await page.evaluate(() => window.finishPreviewChecks());
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    assert.ok(await page.evaluate(() => window.previewEditorReads > 0));
    assert.equal(await slider.count(), 0);
  } finally { await context.close(); }
});

let server, browser, url;
before(async () => {
  server = await createServer({ logLevel: "error", server: { host: "127.0.0.1", port: 5174, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls.local[0];
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(existsSync) ?? chromium.executablePath();
  browser = await chromium.launch({ executablePath, headless: true });
  await mkdir("artifacts/unified-proofreading", { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(page, query, username = "review-test") {
  await page.goto(`${url}?${query}`);
  if (await page.getByRole("button", { name: "登录工作区" }).count()) await page.getByRole("button", { name: "登录工作区" }).click();
  await page.getByLabel("显示名称").fill("Review Test");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[type="password"]').nth(0).fill("demo-password-123");
  await page.locator('input[type="password"]').nth(1).fill("demo-password-123");
  await page.getByRole("button", { name: "创建并登录" }).click();
  await page.getByRole("navigation", { name: "工作区视图" }).waitFor();
  // The new one-time release summary has its own update-flow coverage. Keep
  // playback layout assertions focused on the regular, acknowledged workspace.
  const acknowledgement = page.getByRole("button", { name: "知道了", exact: true });
  if (await acknowledgement.count()) { await acknowledgement.click(); await acknowledgement.waitFor({state:"detached"}); }
  await page.waitForFunction(() => document.querySelectorAll(".camera-grid .frame-panel").length === 7);
}

test("skeleton descriptions have independent empty segments, presets, custom labels and no QC", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const before = await page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    await page.getByRole("tab", { name: "骨架片段", exact: true }).click();
    await page.getByText("暂无骨架片段，点击加号新增，使用标签库或输入自定义描述。").waitFor();
    assert.equal(await page.getByRole("button", { name: "通过", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "不通过", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("机标来源", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "新增片段", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="tab"]').disabled);
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    for (const text of ["往前走", "抬肘", "踢腿", "蹲下", "顶门", "关上洗碗机"]) assert.equal(await page.getByRole("button", { name: text, exact: true }).count(), 1);
    await page.getByRole("button", { name: "往前走", exact: true }).click();
    await page.getByLabel("复核动作描述", { exact: true }).fill("骨架自定义描述");
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.getByRole("button", { name: "保存当前描述", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "骨架自定义描述", exact: true }).count(), 1);
    await page.getByRole("button", { name: "关闭标签库", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="tab"]').disabled);
    await page.getByRole("tab", { name: "骨架片段", exact: true }).click();
    await page.keyboard.press("x");
    await page.waitForFunction(() => document.querySelectorAll(".machine-segment").length === 2);
    // Numeric shortcuts apply only in the selected channel, with normal text input protected.
    await page.getByRole("button", { name: "定位机标片段 1", exact: true }).click();
    await page.keyboard.press("2");
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "抬肘");
    await page.waitForFunction(() => !document.querySelector('[role="tab"]').disabled);
    await page.getByRole("tab", { name: "动作片段", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const after = await page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    assert.deepEqual(after, before, "skeleton edits cannot mutate action segments or QC");
    await page.getByRole("tab", { name: "骨架片段", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "抬肘");
    await page.getByRole("button", { name: "删除机标片段 1", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="tab"]').disabled);
    assert.equal(await page.locator(".machine-segment").count(), 1);
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("dialog", {name:"不通过原因"}).count(), 0);
    for (const width of [1440, 960, 390]) {
      await page.setViewportSize({ width, height: 920 });
      const tab = page.getByRole("tab", {name:"骨架片段",exact:true});
      await tab.scrollIntoViewIfNeeded();
      const box = await tab.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, "tabs fit narrow screens");
      await page.screenshot({ path: `artifacts/unified-proofreading/skeleton-${width}.png` });
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("review controls support segment/global play, shortcuts, splitting and saved edits", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await open(page, "machineAnnotation=present&trajectoryWarning=static");
    const rail = page.getByLabel("校对播放帧", { exact: true });
    const seek = async (frame) => { await rail.fill(String(frame)); };
    const current = async () => Number(await rail.inputValue());
    const saved = () => page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    await page.getByRole("button", { name: "定位机标片段 2", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="校对播放帧"]').value) > 60);
    await page.keyboard.press("Space");
    const paused = await current();
    await page.waitForTimeout(150);
    assert.equal(await current(), paused);
    await page.keyboard.press("Space");
    await page.waitForFunction((value) => Number(document.querySelector('[aria-label="校对播放帧"]').value) > value, paused);
    await page.waitForFunction(() => document.querySelector('[aria-label="校对播放帧"]').value === "119");
    await page.waitForTimeout(200);
    assert.equal(await current(), 119);
    await page.getByRole("button", { name: "全局播放", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="校对播放帧"]').value) > 119);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await seek(30);
    await page.getByRole("button", { name: "下一帧", exact: true }).click();
    assert.equal(await current(), 31);
    await page.getByRole("button", { name: "上一帧", exact: true }).click();
    assert.equal(await current(), 30);
    await page.getByRole("button", { name: "定位机标片段 1", exact: true }).click();
    await seek(30);
    await page.getByRole("button", { name: "剪切片段", exact: true }).click();
    assert.equal(await page.locator(".machine-segment").count(), 4);
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "30");
    await page.getByRole("slider", { name: "微调起始帧" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "31");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "30");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "60");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "30");
    await seek(40);
    await page.getByRole("button", { name: "新增片段", exact: true }).click();
    assert.equal(await page.locator(".machine-segment").count(), 5);
    await page.getByLabel("复核动作描述").fill("人工新片段");
    await page.keyboard.press("Space");
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工新片段 ");
    await page.waitForFunction(() => !document.querySelector(".quality-save-state").textContent.includes("正在保存"));
    const state = await saved();
    assert.equal(state.segments.at(-1).description, "人工新片段 ");
    const end = page.getByRole("slider", { name: "微调结束帧" });
    const box = await end.boundingBox(), track = await page.locator(".review-track").boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();
    await page.mouse.move(track.x+track.width*55/196,box.y+box.height/2,{steps:4});
    await page.mouse.up();
    assert.equal(await page.getByLabel("复核结束帧", { exact: true }).inputValue(), "55");
    await page.getByRole("slider", { name: "微调结束帧" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(async () => {
      const backend = await import("/src/lib/backend.ts");
      return (await backend.loadMachineReview("/demo/2026-07-13_07-34-12")).status === "approved";
    });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("unified layout fits desktop and mobile with a visible interactive skeleton", async () => {
  const page = await browser.newPage();
  await open(page, "machineAnnotation=present");
  for (const [width, height] of [[1920,1080],[1440,920],[960,680],[390,844]]) {
    await page.setViewportSize({ width, height });
    const canvas = page.locator(".skeleton-canvas canvas");
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector(".skeleton-canvas canvas").width > 0);
    const pixels = () => canvas.evaluate((element) => {
      const gl = element.getContext("webgl2");
      const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);
      let bones = 0, hash = 0;
      for (let i=0;i<data.length;i+=4) { if (data[i+1]>90 && data[i+1]>data[i]*1.35) bones++; hash=(hash*31+data[i+1])>>>0; }
      return { bones, hash };
    });
    const before = await pixels();
    assert.ok(before.bones > 20);
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
    await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width/2+40,bounds.y+bounds.height/2+20,{steps:5});
    await page.mouse.up();
    assert.notEqual((await pixels()).hash, before.hash);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator(".camera-grid").evaluate((grid) => {
      const bounds = grid.getBoundingClientRect();
      const frames = [...grid.querySelectorAll(".frame-panel")].map((item) => item.getBoundingClientRect());
      return frames.every((frame, index) => frame.bottom <= bounds.bottom + 1
        && frames.slice(index + 1).every((other) => frame.right <= other.left + 1
          || other.right <= frame.left + 1 || frame.bottom <= other.top + 1 || other.bottom <= frame.top + 1));
    }), "camera frames stay within the grid without overlapping");
    if (width <= 760) {
      const brand = await page.locator(".brand-lockup").boundingBox();
      const actions = await page.locator(".topbar-actions").boundingBox();
      assert.ok(actions.y >= brand.y + brand.height, "mobile toolbar leaves room for the brand");
    }
    if (width >= 1440) {
      const replay = await page.locator(".camera-section").boundingBox();
      const telemetry = await page.locator(".telemetry-section").boundingBox();
      const timeline = await page.locator(".quality-timeline").boundingBox();
      const editor = await page.locator(".quality-inspector").boundingBox();
      assert.ok(telemetry.y >= replay.y + replay.height, "telemetry stays below replay");
      assert.ok(timeline.x >= replay.x + replay.width, "timeline stays in right column");
      assert.ok(editor.y >= timeline.y + timeline.height, "segments stay below timeline");
      assert.ok(editor.y + editor.height <= height, "approval buttons fit the window");
      assert.ok(telemetry.y + telemetry.height <= height, "compact state chart fits the window");
    }
    await page.screenshot({ path: `artifacts/unified-proofreading/layout-${width}.png`, fullPage: true });
    await page.locator(".quality-inspector").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/unified-proofreading/editor-${width}.png`, fullPage: true });
  }
  await page.close();
});

test("long segment lists scroll independently and telemetry axes fit their canvas", async () => {
  const page = await browser.newPage();
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    await page.evaluate(async () => {
      const backend = await import("/src/lib/backend.ts");
      const root = "/demo/2026-07-13_07-34-12";
      const review = await backend.loadMachineReview(root);
      const segments = Array.from({ length: 30 }, (_, sourceIndex) => ({
        sourceIndex, startFrame: sourceIndex * 6, endFrame: sourceIndex === 29 ? 194 : sourceIndex * 6 + 5,
        description: `动作片段 ${sourceIndex + 1}`, deleted: false, decision: "pending",
      }));
      await backend.saveMachineReview(root, review.sourceHash, review.revision, segments);
    });
    await page.getByRole("button", { name: "重新读取机标", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".machine-segment").length === 30);
    for (const [width, height] of [[1920, 1080], [1440, 920], [1280, 720], [960, 680], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const list = page.locator(".machine-segment-list");
      await list.scrollIntoViewIfNeeded();
      const before = await page.locator(".quality-footer").boundingBox();
      if (width >= 1440) {
        await page.screenshot({ path: `artifacts/unified-proofreading/long-list-${width}.png`, fullPage: true });
        assert.ok(before.y + before.height <= height, `long lists leave approval buttons visible: ${JSON.stringify({ width, height, footer: before })}`);
      }
      const scroll = await list.evaluate((element) => {
        const pageY = window.scrollY;
        element.scrollTop = element.scrollHeight;
        return { pageY, afterY: window.scrollY, height: element.clientHeight, total: element.scrollHeight, top: element.scrollTop };
      });
      assert.ok(scroll.total > scroll.height && scroll.top > 0, "long lists scroll within their bounded height");
      assert.equal(scroll.pageY, scroll.afterY);
      assert.deepEqual(await page.locator(".quality-footer").boundingBox(), before, "list scrolling keeps review controls fixed");
      const chart = page.locator(".telemetry-chart");
      await chart.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const container = document.querySelector(".telemetry-chart");
        const canvas = container.querySelector("canvas");
        const ratio = Math.min(devicePixelRatio, 2);
        return canvas.width === Math.floor(container.clientWidth * ratio)
          && canvas.height === Math.floor(container.clientHeight * ratio);
      });
      const bounds = await chart.boundingBox();
      assert.ok(bounds.height >= 220, "state chart keeps room for axes on small screens");
      const axes = await chart.locator("canvas").first().evaluate((canvas) => {
        const ctx = canvas.getContext("2d");
        const scale = Math.min(devicePixelRatio, 2);
        const pixels = ctx.getImageData(0, canvas.height - 25 * scale, canvas.width, 22 * scale).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0 && pixels[i] < 200) ink++;
        return ink;
      });
      assert.ok(axes > 10, "bottom axis labels are painted inside the visible canvas");
      const inset = await page.locator(".camera-section").evaluate((section) => section.getBoundingClientRect().left - section.parentElement.getBoundingClientRect().left);
      assert.ok(inset >= 12, "section headings have space from the workspace edge");
      await page.screenshot({ path: `artifacts/unified-proofreading/long-list-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.getByRole("button", { name: "定位机标片段 1", exact: true }).click();
    await page.keyboard.press("Space");
    const footer = await page.locator(".quality-footer").boundingBox();
    for (let index = 0; index < 15; index++) await page.keyboard.press("ArrowDown");
    assert.ok(await page.locator(".machine-segment-list").evaluate((list) => {
      const active = list.querySelector(".machine-segment.active").getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return list.scrollTop > 0 && active.top >= bounds.top && active.bottom <= bounds.bottom;
    }), "keyboard selection follows the active segment within the list");
    assert.deepEqual(await page.locator(".quality-footer").boundingBox(), footer);
  } finally { await page.close(); }
});

test("deleting a segment moves the next real boundary and saved review, with working undo", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const saved = () => page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    const before = await saved();
    await page.getByRole("button", { name: "删除机标片段 2", exact: true }).focus();
    await page.getByRole("button", { name: "删除机标片段 2", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".machine-segment").length === 2 && document.querySelector(".quality-save-state").textContent.includes("本机草稿已保存"));
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), String(before.segments[0].endFrame + 1));
    const after = await saved();
    assert.equal(after.segments[1].deleted, true);
    assert.equal(after.segments[2].startFrame, before.segments[0].endFrame + 1);
    assert.equal(after.segments[2].endFrame, before.segments[2].endFrame);
    await page.screenshot({ path: "artifacts/unified-proofreading/delete-aligned.png", fullPage: true });
    await page.getByRole("button", { name: "恢复删除的片段", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".machine-segment").length === 3 && document.querySelector(".quality-save-state").textContent.includes("本机草稿已保存"));
    assert.deepEqual((await saved()).segments.map((s) => [s.startFrame,s.endFrame,s.deleted]), before.segments.map((s) => [s.startFrame,s.endFrame,s.deleted]));
  } finally { await page.close(); }
});

test("history shows the installed patch and its Chinese summary", async () => {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const page = await browser.newPage();
  try {
    await open(page, "machineAnnotation=present");
    await page.getByRole("button", { name: "查看历史版本", exact: true }).click();
    await page.getByRole("dialog", { name: "历史版本" }).waitFor();
    assert.equal(await page.locator(".version-history-entry").first().locator("strong").textContent(), `v${version}`);
    assert.match(await page.locator(".version-history-summary").first().textContent(), /\p{Script=Han}/u);
  } finally { await page.close(); }
});

test("rejection uses buttons, requires other text, persists the reason and clears it on approval", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present");
    const saved = () => page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const before = await saved();
    await page.getByRole("button", { name: "不通过", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "不通过原因" });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("button", { name: "确认不通过" }).isEnabled(), false);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await saved()).revision, before.revision);
    for (const reason of ["骨架抖动", "镜头污渍", "动作错误", "画面过曝", "轨迹不动", "无效数据", "任务不符", "动作过快", "状态异常", "动作失范", "数据内容缺失", "多路视频不同步", "其他原因"]) {
      await page.getByRole("button", { name: "不通过", exact: true }).click();
      if (reason === "多路视频不同步") {
        await dialog.getByRole("button", { name: "添加常用原因", exact: true }).click();
        await dialog.getByLabel("常用原因名称").fill(reason);
        await dialog.getByLabel("常用原因名称").press("Enter");
        assert.equal((await saved()).status, "rejected", "adding a label must not submit a new decision");
      }
      await dialog.getByRole("button", { name: reason, exact: true }).click();
      let expected = reason === "多路视频不同步" ? `其他原因：${reason}` : reason;
      if (reason === "其他原因") {
        await dialog.getByLabel("其他原因内容").fill("   ");
        assert.equal(await dialog.getByRole("button", { name: "确认不通过" }).isEnabled(), false);
        await dialog.getByLabel("其他原因内容").fill("视频缺帧，需要重新采集");
        expected = "其他原因：视频缺帧，需要重新采集";
        await page.screenshot({ path: "artifacts/unified-proofreading/rejection-desktop.png" });
        await page.setViewportSize({ width: 390, height: 844 });
        const choices = await dialog.locator(".rejection-options button").evaluateAll((buttons) => buttons.map((button) => ({ fontSize: parseFloat(getComputedStyle(button).fontSize), width: button.clientWidth, text: button.textContent })));
        assert.ok(choices.every((choice) => choice.fontSize >= 12 && choice.width >= 100 && choice.text.length));
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
        await page.screenshot({ path: "artifacts/unified-proofreading/rejection-mobile.png" });
        await page.setViewportSize({ width: 1440, height: 920 });
      }
      await dialog.getByRole("button", { name: "确认不通过" }).click();
      await dialog.waitFor({ state: "detached" });
      const state = await saved();
      assert.equal(state.status, "rejected");
      assert.equal(state.rejectionReason, expected);
      assert.equal(state.revisionLabel, `${state.versionId} · 审核不通过：${expected}`);
      assert.equal(await page.locator(".review-revision").textContent(), `${state.versionId} · 历史修订（非当前结论）`);
      assert.equal(await page.locator(".review-revision").getAttribute("title"), state.revisionLabel);
    }
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await page.waitForFunction(async () => (await (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12")).status === "approved");
    assert.equal((await saved()).rejectionReason, "");
    await page.getByLabel("复核动作描述").fill("更正动作描述");
    await page.waitForFunction(async () => (await (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12")).changeSummary?.includes("修改描述"));
    assert.match((await saved()).revisionLabel, /修改描述 1 段；改为待审核/);
  } finally { await page.close(); }
});

test("timeline colors remain distinct for adjacent segments after splitting and deletion", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const distinct = async () => {
      const colors = await page.locator(".review-span").evaluateAll((spans) => spans.map((span) => getComputedStyle(span).backgroundColor));
      for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i - 1]);
    };
    await distinct();
    for (const frame of [10, 20, 30, 40, 50]) {
      await page.getByLabel("校对播放帧", { exact: true }).fill(String(frame));
      await page.getByRole("button", { name: "剪切片段", exact: true }).click();
      await distinct();
    }
    for (const index of [2, 3, 2]) {
      const button = page.getByRole("button", { name: `删除机标片段 ${index}`, exact: true });
      await button.focus(); await button.click(); await distinct();
    }
    await page.getByRole("button", { name: "恢复删除的片段", exact: true }).click();
    await distinct();
    await page.screenshot({ path: "artifacts/unified-proofreading/timeline-colors.png", fullPage: true });
  } finally { await page.close(); }
});

test("review audit links drag, label changes and successful approval to the same account and session", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present", "audit-reviewer");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const rail = page.getByLabel("校对播放帧", { exact: true });
    await rail.fill("30");
    const box = await rail.boundingBox();
    await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.getByLabel("复核动作描述").fill("审核专用动作标签");
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.getByRole("button", { name: "保存当前描述", exact: true }).click();
    await page.getByRole("button", { name: "删除标签：审核专用动作标签", exact: true }).click();
    await page.getByRole("button", { name: "关闭标签库", exact: true }).click();
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("dohc.demo.review-events") ?? "[]").some((row) => row.action === "approved"));
    const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("dohc.demo.review-events")));
    for (const action of ["loaded", "seek", "drag", "label_add", "label_delete", "segment_edit", "approved"]) assert.ok(rows.some((row) => row.action === action), action);
    assert.equal(new Set(rows.map((row) => row.sessionId)).size, 1);
    assert.ok(rows.every((row) => row.username === "audit-reviewer"));
    assert.equal(rows.find((row) => row.action === "label_add").details.value, "审核专用动作标签");
    assert.equal(rows.find((row) => row.action === "label_delete").details.value, "审核专用动作标签");
    const approved = rows.find((row) => row.action === "approved"), loaded = rows.find((row) => row.action === "loaded");
    assert.ok(approved.elapsedMs > 0);
    assert.ok(Math.abs(approved.elapsedMs - (approved.occurredAtMs - loaded.occurredAtMs)) < 100);
    assert.ok(rows.find((row) => row.action === "drag").details.durationMs > 0);
    assert.equal(await page.locator(".review-audit-error").count(), 0);
  } finally { await page.close(); }
});

test("label library keeps fixed shortcut numbers while text entries can be reordered", async () => {
  const desktopConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  assert.equal(desktopConfig.app.windows.find(window => window.label === "main").dragDropEnabled, false, "Windows native file-drop interception must be disabled for HTML5 label dragging");
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present", "label-order-reviewer");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const editor = page.getByLabel("复核动作描述");
    await editor.fill("标签一");
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.getByRole("button", { name: "保存当前描述", exact: true }).click();
    await page.getByRole("button", { name: "关闭标签库", exact: true }).click();
    await editor.fill("标签二");
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.getByRole("button", { name: "保存当前描述", exact: true }).click();
    assert.deepEqual(await page.locator(".label-library-index").allTextContents(), ["1", "2"]);
    assert.deepEqual(await page.locator(".label-library-use").allTextContents(), ["标签一", "标签二"]);
    await page.getByRole("button", { name: "使用第 2 个标签", exact: true }).click();
    assert.equal(await editor.inputValue(), "标签二");
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.locator(".label-library-use").nth(1).dragTo(page.locator(".label-library-use").nth(0));
    assert.deepEqual(await page.locator(".label-library-index").allTextContents(), ["1", "2"]);
    assert.deepEqual(await page.locator(".label-library-use").allTextContents(), ["标签二", "标签一"]);
    await page.keyboard.press("1");
    assert.equal(await editor.inputValue(), "标签二");
    await page.keyboard.press("2");
    assert.equal(await editor.inputValue(), "标签一");
    await editor.fill("普通数字：");
    await editor.press("End");
    await editor.press("1");
    assert.equal(await editor.inputValue(), "普通数字：1");
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await editor.focus();
    await editor.press("2");
    assert.equal(await editor.inputValue(), "标签一");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("dohc-viewer.machine-label-library.v1:label-order-reviewer")));
    assert.deepEqual(stored.map(item => item.text), ["标签二", "标签一"]);
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.screenshot({ path: "artifacts/unified-proofreading/label-library-numbered.png" });
  } finally { await page.close(); }
});

test("label shortcuts support multiple digits and do not alter numeric fields or modal dialogs", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.addInitScript(() => localStorage.setItem("dohc-viewer.machine-label-library.v1:label-numbers-reviewer", JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ id: `label-${index}`, text: `常用动作描述 ${index + 1}`, createdAt: index + 1 })))));
    await open(page, "machineAnnotation=present", "label-numbers-reviewer");
    const editor = page.getByLabel("复核动作描述");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.keyboard.type("12");
    assert.equal(await editor.inputValue(), "常用动作描述 12");
    await page.keyboard.press("1");
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]').value === "常用动作描述 1");
    await page.getByLabel("复核起始帧", { exact: true }).focus();
    await page.keyboard.press("2");
    assert.equal(await editor.inputValue(), "常用动作描述 1");
    await page.getByRole("button", { name: "不通过", exact: true }).click();
    await page.keyboard.press("3");
    assert.equal(await editor.inputValue(), "常用动作描述 1");
    await page.getByRole("button", { name: "关闭不通过原因", exact: true }).click();
    await page.getByRole("button", { name: "标签库", exact: true }).click();
    await page.keyboard.press("Control+2");
    assert.equal(await editor.inputValue(), "常用动作描述 1");
    await page.screenshot({ path: "artifacts/unified-proofreading/label-library-numbered-narrow.png" });
  } finally { await page.close(); }
});

test("click selects the nudged handle without jumping and X splits except in text inputs", async () => {
  const page = await browser.newPage();
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const start = page.getByLabel("复核起始帧", { exact: true });
    const end = page.getByLabel("复核结束帧", { exact: true });
    const startHandle = page.getByRole("slider", { name: "微调起始帧" });
    const endHandle = page.getByRole("slider", { name: "微调结束帧" });
    await startHandle.click();
    assert.equal(await start.inputValue(), "0");
    await page.keyboard.press("ArrowRight");
    assert.equal(await start.inputValue(), "1");
    assert.equal(await end.inputValue(), "60");
    await endHandle.click();
    assert.equal(await end.inputValue(), "60");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await end.inputValue(), "59");
    assert.equal(await start.inputValue(), "1");
    const playhead = page.getByLabel("校对播放帧");
    await playhead.fill("30");
    await playhead.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await playhead.inputValue(), "31");
    assert.equal(await end.inputValue(), "59");
    await page.keyboard.press("x");
    assert.equal(await page.locator(".machine-segment").count(), 4);
    await page.keyboard.press("x");
    assert.equal(await page.locator(".machine-segment").count(), 5, "edge-frame split clamps to the nearest interior frame");
    await page.getByLabel("复核动作描述").fill("test");
    await page.keyboard.press("x");
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "testx");
    assert.equal(await page.locator(".machine-segment").count(), 5);
    await startHandle.click();
    const beforeNudge = Number(await start.inputValue());
    await page.keyboard.press("ArrowRight");
    assert.equal(Number(await start.inputValue()), beforeNudge + 1);
    await page.waitForFunction(() => !document.querySelector(".quality-save-state").textContent.includes("正在保存"));
    await page.screenshot({ path: "artifacts/unified-proofreading/selected-handle.png", fullPage: true });
  } finally { await page.close(); }
});

test("missing machine JSON creates a full-video human segment, splits and reloads saved edits", async () => {
  const page = await browser.newPage();
  await open(page, "machineAnnotation=missing&trajectoryWarning=static");
  await page.waitForFunction(() => !document.querySelector('[aria-label="新增片段"]').disabled);
  assert.equal(await page.locator(".machine-segment").count(), 0);
  await page.getByLabel("校对播放帧").fill("80");
  await page.waitForFunction(() => document.querySelector(".frame-counter").textContent === "帧 80 / 195");
  assert.equal(await page.getByRole("button", { name: "通过", exact: true }).isEnabled(), false);
  assert.equal(await page.locator(".frame-panel").count(), 7);
  assert.equal(await page.locator(".camera-placeholder").count(), 2);
  await page.getByRole("button", { name: "新增片段", exact: true }).click();
  assert.equal(await page.locator(".machine-segment").count(), 1);
  assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "0");
  assert.equal(await page.getByLabel("复核结束帧", { exact: true }).inputValue(), "196");
  await page.getByLabel("复核动作描述").fill("人工整段");
  await page.getByLabel("校对播放帧").fill("80");
  await page.getByRole("button", { name: "剪切片段", exact: true }).click();
  await page.getByLabel("复核动作描述").fill("人工后半段");
  await page.waitForFunction(() => !document.querySelector(".quality-save-state").textContent.includes("正在保存"));
  await page.getByRole("button", { name: "重新读取机标", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="新增片段"]').disabled);
  assert.equal(await page.locator(".machine-segment").count(), 2);
  const state = await page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12", "manual"));
  assert.deepEqual(state.segments.map((row) => [row.startFrame, row.endFrame, row.description]), [[0,79,"人工整段"],[80,195,"人工后半段"]]);
  await page.screenshot({ path: "artifacts/unified-proofreading/manual-only-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "新增片段", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/unified-proofreading/manual-only-mobile.png", fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.close();
});


test("rejection reasons drag without selecting, persist per account and keep other bottom right", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  try {
    await open(page, "machineAnnotation=present", "reason-owner");
    const show = async () => { await page.getByRole("button", { name: "不通过", exact: true }).click(); };
    await show();
    const dialog = page.getByRole("dialog", { name: "不通过原因" });
    const labels = () => dialog.locator(".rejection-options button").allTextContents();
    assert.equal((await labels()).length, 13);
    await dialog.getByRole("button", { name: "调整顺序", exact: true }).click();
    await dialog.getByRole("button", { name: "动作失范", exact: true }).dragTo(dialog.getByRole("button", { name: "骨架抖动", exact: true }));
    assert.equal((await labels())[0], "动作失范");
    assert.equal(await dialog.locator('.rejection-options [aria-pressed="true"]').count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "确认不通过" }).isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "其他原因", exact: true }).getAttribute("draggable"), "false");
    await dialog.getByRole("button", { name: "完成排序", exact: true }).click();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await show();
    assert.equal((await labels())[0], "动作失范");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const other = await dialog.getByRole("button", { name: "其他原因", exact: true }).boundingBox();
      const remaining = await dialog.locator('.rejection-options button:not(.rejection-other)').evaluateAll(buttons => buttons.map(button => ({x: button.getBoundingClientRect().x, y: button.getBoundingClientRect().y})));
      assert.ok(Math.abs(other.x - Math.max(...remaining.map(box => box.x))) < 2 && other.y >= Math.max(...remaining.map(box => box.y)));
      const confirm = dialog.getByRole("button", { name: "确认不通过" });
      await confirm.scrollIntoViewIfNeeded();
      const box = await confirm.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 844);
      await page.screenshot({ path: `artifacts/unified-proofreading/reason-order-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 920 });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await open(page, "machineAnnotation=present", "reason-other");
    await show();
    assert.equal((await labels())[0], "骨架抖动");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await open(page, "machineAnnotation=present", "reason-owner");
    await show();
    assert.equal((await labels())[0], "动作失范");
  } finally { await context.close(); }
});

test("verified renamed machine identity stays visible with the original number on desktop and narrow screens", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  await page.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const warning = '当前目录 "renamed_001" 与机标编号 "original_009" 不同；已核对主相机文件列表、大小、修改时间指纹及帧数。原机标未修改，请回放核对动作内容。';
    const body = original.replace('model: "Demo model",', `model: "Demo model", identityWarning: ${JSON.stringify(warning)}, identityVerified: true,`);
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    const notice = page.getByRole("region", { name: "机标编号核对提示" });
    await notice.waitFor();
    assert.match(await notice.innerText(), /renamed_001.*original_009/);
    assert.equal(await page.getByLabel("复核动作描述").isEnabled(), true);
    for (const width of [1440, 960, 390]) {
      await page.setViewportSize({ width, height: 920 });
      await notice.scrollIntoViewIfNeeded();
      const box = await notice.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.screenshot({ path: "artifacts/unified-proofreading/verified-identity.png" });
  } finally { await page.close(); }
});

test("compatible unverified identity stays editable without claiming verification", async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 680 } });
  await page.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace('model: "Demo model",', 'model: "Demo model", identityWarning: "编号不同；已按同目录文件兼容读取，来源尚未核实。", identityVerified: false,');
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    const notice = page.getByRole("region", {name:"机标编号核对提示"});
    await notice.waitFor();
    assert.match(await notice.innerText(), /已兼容读取/);
    assert.doesNotMatch(await notice.innerText(), /核验已通过/);
    await page.getByLabel("复核动作描述").fill("人工兼容后修改动作");
    await page.waitForTimeout(500);
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工兼容后修改动作");
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  } finally { await page.close(); }
});

test("identity warning ignores only this account and source content, and can be restored", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace('model: "Demo model",', 'model: "Demo model", identityWarning: "当前目录与原机标编号不同，来源尚未核实。", identityVerified: false, timelineWarning: "当前视频帧数已适配。",');
    assert.notEqual(body, original);
    await route.fulfill({response, body});
  });
  try {
    await open(page, "machineAnnotation=present", "ignore-owner");
    const notice = page.getByRole("region", {name:"机标编号核对提示"});
    const restore = page.getByRole("button", {name:"查看已忽略的编号提示", exact:true});
    await notice.waitFor();
    for (const [width,height] of [[1440,920],[960,680],[390,844]]) {
      await page.setViewportSize({width,height});
      const ignore = notice.getByRole("button", {name:"忽略本条提示", exact:true});
      await ignore.scrollIntoViewIfNeeded();
      const box = await ignore.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path:`artifacts/unified-proofreading/identity-ignore-${width}.png`,fullPage:true});
    }
    await notice.getByRole("button", {name:"忽略本条提示", exact:true}).click();
    await restore.waitFor();
    assert.equal(await notice.count(),0);
    assert.equal(await page.getByRole("region", {name:"机标帧数适配提示"}).isVisible(),true,"unrelated warnings remain visible");
    assert.equal(await page.getByLabel("复核动作描述").isEnabled(),true);
    await open(page,"machineAnnotation=present","ignore-owner");
    await restore.waitFor();
    assert.equal(await notice.count(),0,"same account and source remain ignored after reload");
    await open(page,"machineAnnotation=present","ignore-other");
    await notice.waitFor();
    await open(page,"machineAnnotation=present","ignore-owner");
    await restore.waitFor();
    await restore.click();
    await notice.waitFor();
    await notice.getByRole("button",{name:"忽略本条提示",exact:true}).click();
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("delta.machine-identity.ignored.v1:")) {
        const signature = JSON.parse(localStorage.getItem(key));
        signature[0] = "previous-source-content";
        localStorage.setItem(key,JSON.stringify(signature));
      }
    });
    await open(page,"machineAnnotation=present","ignore-owner");
    await notice.waitFor();
    assert.equal(await restore.count(),0,"changed machine content must warn again");
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("optional attribute issues stay visible without blocking editing on desktop and narrow screens", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace('model: "Demo model",', 'model: "Demo model", attributeWarnings: ["第 2 个片段的英文属性：属性缺少 value，未猜测缺失值。可读字段及片段已保留，原机标未修改。"],');
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    const notice = page.getByLabel("机标属性兼容提示");
    await notice.locator("summary").waitFor();
    assert.match(await notice.locator("summary").innerText(), /已兼容加载/);
    await notice.locator("summary").click();
    await notice.getByText(/未猜测缺失值/).waitFor();
    const input = page.getByLabel("复核动作描述");
    await input.fill("兼容后人工核对动作");
    for (const [width, height] of [[1440,920],[960,680],[390,844]]) {
      await page.setViewportSize({width,height});
      assert.equal(await notice.locator("summary").isVisible(),true);
      assert.equal(await input.isEnabled(),true);
      assert.equal(await input.inputValue(),"兼容后人工核对动作");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      await page.screenshot({path:`artifacts/unified-proofreading/attribute-compatibility-${width}.png`,fullPage:true});
    }
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("incompatible emergency snapshot is preserved while machine rows load normally", async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 680 } });
  await page.addInitScript(() => {
    localStorage.setItem("dohc.machine-review.pending:demo://session-activation/session-a:account:review-test", JSON.stringify({segments:[{sourceIndex:0,startFrame:0,endFrame:999999,description:"需要保留的旧人工文字",decision:"pending"}],status:"pending",sourceHash:"old"}));
  });
  try {
    await open(page,"demoScenario=session-activation&machineAnnotation=present");
    const notice = page.getByRole("region",{name:"人工记录兼容恢复提示"});
    await notice.waitFor();
    assert.match(await notice.innerText(),/本机备份/);
    assert.equal(await page.getByLabel("复核动作描述").isEnabled(),true);
    assert.equal(await page.evaluate(() => Object.entries(localStorage).some(([key,value])=>key.includes(":preserved:")&&value.includes("需要保留的旧人工文字"))),true);
  } finally { await page.close(); }
});

test("inferred machine boundary stays visible and requires explicit review before approval", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  await page.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace('model: "Demo model",', 'model: "Demo model", inferredEndFrames: [1],').replace('label: "phase_walk",', 'label: "phase_walk", sourceIndex: 1,');
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    const notice = page.getByRole("region", { name: "机标边界待核对" });
    await notice.waitFor();
    const approve = page.getByRole("button", { name: "通过", exact: true });
    assert.equal(await approve.isDisabled(), true);
    await notice.getByRole("button", { name: "定位原片段 2" }).click();
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "向前行走");
    await notice.getByRole("checkbox").check();
    assert.equal(await approve.isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await notice.scrollIntoViewIfNeeded();
    const box = await notice.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    await page.screenshot({ path: "artifacts/unified-proofreading/inferred-boundary.png" });
    await page.getByRole("button", { name: "重新读取机标", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    assert.equal(await approve.isDisabled(), true);
  } finally { await page.close(); }
});


test("current QC badge stays pending despite approved historical metadata and unknown on read failure", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  await page.route("**/src/lib/backend.ts", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace(/revision: 0,\s+qcStatus: "pending",/, 'revision: 7, status: "approved", versionId: "historical-id", revisionLabel: "historical-id · 审核通过", qcStatus: window.testQcStatus ?? "pending", qcStatusError: window.testQcStatus === "unknown" ? "测试读取失败" : "",');
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    await page.locator(".quality-output span").getByText("待审核", { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator(".quality-footer").innerText(), /审核通过|已通过/);
    for (const width of [1440, 960, 390]) {
      await page.setViewportSize({ width, height: 920 });
      await page.locator(".quality-output").scrollIntoViewIfNeeded();
      assert.equal(await page.locator(".quality-output span").innerText(), "待审核");
    }
    await page.evaluate(() => { window.testQcStatus = "unknown"; });
    await page.getByRole("button", { name: "重新读取机标", exact: true }).click();
    await page.locator(".quality-output span").getByText("审核状态未知", { exact: true }).waitFor();
    assert.match(await page.locator(".quality-footer").innerText(), /当前目录审核状态读取失败/);
    assert.doesNotMatch(await page.locator(".quality-footer").innerText(), /审核通过|已通过/);
  } finally { await page.close(); }
});

test("drag crosses multiple segments smoothly and commits only when released; cancel preserves edits", async () => {
  const page=await browser.newPage({viewport:{width:1440,height:920}});
  try {
    await page.addInitScript(()=>{window.timelineSaveCount=0;});
    await page.route('**/src/lib/backend.ts',async route=>{
      const response=await route.fetch(), original=await response.text();
      const body=original.replace(/(export async function saveMachineReview\([^]*?\) \{)/,'$1\nwindow.timelineSaveCount++;');
      assert.notEqual(body,original);await route.fulfill({response,body});
    });
    await open(page,'machineAnnotation=present');
    await page.waitForFunction(()=>document.querySelector('[aria-label="复核动作描述"]')?.disabled===false);
    const edge=page.getByRole('slider',{name:'微调结束帧'}),track=page.locator('.review-track');
    const e=await edge.boundingBox(),t=await track.boundingBox();
    const before=await page.evaluate(()=>window.timelineSaveCount);
    await page.mouse.move(e.x+e.width/2,e.y+e.height/2);await page.mouse.down();
    await page.mouse.move(t.x+t.width,e.y+e.height/2,{steps:40});
    await page.waitForFunction(()=>document.querySelector('[aria-label="复核结束帧"]').value==='196');
    assert.equal(await page.locator('.review-span').count(),1);
    assert.equal(await page.evaluate(()=>window.timelineSaveCount),before,'drag preview performs no disk writes');
    await page.mouse.move(t.x+t.width*80/196,e.y+e.height/2,{steps:20});
    assert.equal(await page.locator('.review-span').count(),3,'reversing restores crossed preview rows');
    await page.mouse.move(t.x+t.width,e.y+e.height/2,{steps:20});await page.mouse.up();
    await page.waitForFunction(()=>!document.querySelector('.quality-save-state').textContent.includes('正在保存'));
    assert.equal(await page.evaluate(()=>window.timelineSaveCount),before+1);
    const backend=await page.evaluate(async()=>{const b=await import('/src/lib/backend.ts');return b.loadMachineReview('/demo/2026-07-13_07-34-12');});
    assert.equal(backend.segments.filter(s=>!s.deleted).length,1);
    assert.equal(backend.segments.find(s=>!s.deleted).endFrame,195);
    assert.equal(backend.segments.filter(s=>s.deleted).length,2);
    const e2=await edge.boundingBox();await page.mouse.move(e2.x+e2.width/2,e2.y+e2.height/2);await page.mouse.down();
    await page.mouse.move(t.x+t.width/2,e2.y+e2.height/2,{steps:10});
    await edge.dispatchEvent('pointercancel');await page.mouse.up();
    assert.equal(await page.getByLabel('复核结束帧',{exact:true}).inputValue(),'196');
    assert.equal(await page.evaluate(()=>window.timelineSaveCount),before+1);
    // A second gesture must reverse the first *saved* expansion, not only its preview.
    const original = await page.evaluate(async()=> (await import('/src/lib/backend.ts')).loadMachineAnnotation('/demo/2026-07-13_07-34-12'));
    const originalEnd = original.segments[0].endFrame;
    const restoredEdge = await edge.boundingBox();
    await page.mouse.move(restoredEdge.x+restoredEdge.width/2,restoredEdge.y+restoredEdge.height/2);await page.mouse.down();
    await page.mouse.move(t.x+t.width*(originalEnd+1)/196,restoredEdge.y+restoredEdge.height/2,{steps:30});
    await page.waitForFunction(()=>document.querySelectorAll('.review-span').length===3);
    assert.equal(await page.evaluate(()=>window.timelineSaveCount),before+1,'reverse preview also performs no writes');
    await page.mouse.up();
    await page.waitForFunction(()=>!document.querySelector('.quality-save-state').textContent.includes('正在保存'));
    const restored=await page.evaluate(async()=> (await import('/src/lib/backend.ts')).loadMachineReview('/demo/2026-07-13_07-34-12'));
    assert.deepEqual(restored.segments.map(s=>[s.startFrame,s.endFrame,s.description,s.deleted]),original.segments.map(s=>[s.startFrame,s.endFrame,s.description,false]));
    assert.equal(restored.status,'pending');
    assert.equal(await page.evaluate(()=>window.timelineSaveCount),before+2);
    for(const [width,height] of [[1440,920],[960,680],[390,844]]){
      await page.setViewportSize({width,height});await edge.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:`artifacts/unified-proofreading/full-video-drag-${width}.png`,fullPage:true});
    }
  } finally {await page.close();}
});

test("saved start-boundary expansion reverses with mouse and keyboard; later text edits survive", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await open(page, 'machineAnnotation=present');
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]')?.disabled === false);
    const saved = () => page.evaluate(async () => (await import('/src/lib/backend.ts')).loadMachineReview('/demo/2026-07-13_07-34-12'));
    const original = await saved();
    const target = original.segments.filter(s=>!s.deleted).at(-1);
    await page.getByRole('button',{name:'定位机标片段 3',exact:true}).click();
    const edge=page.getByRole('slider',{name:'微调起始帧',exact:true}),track=await page.locator('.review-track').boundingBox();
    const dragTo = async value => {
      const box=await edge.boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(track.x+track.width*value/196,box.y+box.height/2,{steps:20});await page.mouse.up();
      await page.waitForFunction(()=>!document.querySelector('.quality-save-state').textContent.includes('正在保存'));
    };
    await dragTo(0);
    assert.equal((await saved()).segments.filter(s=>!s.deleted).length,1);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>document.querySelectorAll('.review-span').length===2);
    let rows=(await saved()).segments;
    assert.equal(rows.find(s=>s.sourceIndex===target.sourceIndex).startFrame,1);
    assert.equal(rows.find(s=>s.sourceIndex===0).deleted,false,'one-frame keyboard reversal restores a covered row');
    await dragTo(target.startFrame);
    rows=(await saved()).segments;
    assert.deepEqual(rows.map(s=>[s.startFrame,s.endFrame,s.description,s.deleted]),original.segments.map(s=>[s.startFrame,s.endFrame,s.description,s.deleted]));
    await page.getByLabel('复核动作描述').fill('保留后续人工文字');
    await page.getByLabel('复核起始帧',{exact:true}).fill(String(target.startFrame-1));
    assert.equal((await saved()).segments.find(s=>s.sourceIndex===target.sourceIndex).description,'保留后续人工文字');
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});
