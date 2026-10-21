import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("local review results persistently show pending, prompt on recovery, require confirmation and preserve errors", async t => {
  const server = await createServer({ logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "source-review-test", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__source-review") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await vite.transformIndexHtml(req.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import React from 'react'; import {createRoot} from 'react-dom/client'; import {SourceReviewNotice} from '/src/components/SourceReviewNotice.tsx'; import '/src/styles.css';
        window.queue={pending:2,ready:false,storageError:'REVIEW_STORAGE_FULL: NAS 空间不足',items:[{name:'sample-long-name-001',sourcePath:'/sample/001',status:'approved',error:'REVIEW_STORAGE_FULL',createdAtMs:1792548000000},{name:'sample-long-name-001',sourcePath:'/sample/001',channel:'skeleton',status:'pending',error:'REVIEW_STORAGE_FULL',createdAtMs:1792548000001}]};
        window.uploads=0;window.busy=[];window.written=0;
        const root=createRoot(document.getElementById('root'));window.renderNotice=(disabled=false,key='alice')=>root.render(React.createElement(SourceReviewNotice,{key,disabled,onBusy:value=>window.busy.push(value),onWritten:()=>window.written++}));window.renderNotice();
      </script></body></html>`));
    });
  } }] });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync) ?? chromium.executablePath() });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("**/src/lib/backend.ts", route => route.fulfill({ contentType: "application/javascript", body: `
    export async function getPendingSourceReviews(){if(window.queryFail)throw Error('模拟本机读取失败');return structuredClone(window.queue);}
    export async function publishPendingSourceReviews(){window.uploads++;if(window.uploadFail)throw Error('模拟共享写入失败');if(window.conflict)return {written:1,remaining:1,errors:['共享 QC 已改变，未覆盖']};window.queue={pending:0,ready:false,items:[],storageError:''};return {written:2,remaining:0,errors:[]};}
  ` }));
  await page.clock.install();
  await page.goto(server.resolvedUrls.local[0] + "__source-review");
  await page.getByText("2 条结果已保存本机，待写回数据目录").waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.evaluate(() => window.uploads), 0);
  await page.evaluate(() => { window.queue.ready = true; window.queue.storageError = ''; });
  await page.clock.fastForward(30001);
  const dialog = page.getByRole("dialog", { name: "本机审核结果待写回" });
  await dialog.waitFor();
  assert.equal(await dialog.getByText("sample-long-name-001 · 骨架描述", {exact:true}).count(), 1);
  assert.equal(await dialog.getByText("sample-long-name-001 · 本机通过", {exact:true}).count(), 1);
  assert.equal(await page.evaluate(() => window.uploads), 0, "recovery cannot write without confirmation");
  const confirm = dialog.getByRole("button", { name: "确认写回数据目录" });
  await mkdir("artifacts/review-submit-1.1.9", { recursive: true });
  for (const width of [1440, 960, 390]) {
    await page.setViewportSize({ width, height: 920 });
    await confirm.scrollIntoViewIfNeeded();
    const box = await confirm.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    await page.screenshot({ path: `artifacts/review-submit-1.1.9/local-writeback-${width}.png` });
  }
  await page.evaluate(() => { window.uploadFail = true; });
  await confirm.click();
  await dialog.getByRole("alert").filter({ hasText: "模拟共享写入失败" }).waitFor();
  await dialog.getByRole("button", { name: "重新检查" }).click();
  assert.match(await dialog.getByRole("alert").textContent(), /模拟共享写入失败/);
  assert.equal(await page.evaluate(() => window.queue.pending), 2);
  await page.evaluate(() => { window.uploadFail = false; window.conflict = true; });
  await confirm.click();
  await dialog.getByRole("alert").filter({ hasText: "未覆盖" }).waitFor();
  assert.equal(await page.evaluate(() => window.written), 1);
  await page.evaluate(() => { window.conflict = false; });
  await confirm.click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.querySelector('.source-review-notice'));
  assert.equal(await page.evaluate(() => window.uploads), 3);
  assert.deepEqual(await page.evaluate(() => window.busy), [true, false, true, false, true, false]);
  // Remount for another account; do not show the previous account's entries.
  await page.evaluate(() => window.renderNotice(false, 'bob'));
  await page.clock.fastForward(30001);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.locator(".source-review-notice").count(), 0);
  await page.evaluate(() => { window.queryFail = true; });
  await page.clock.fastForward(30001);
  await page.getByText('本机待写结果状态未知，请重新检查').waitFor();
  assert.equal(await page.getByText(/条结果已保存本机/).count(),0,'a failed query must not claim local results were saved');
  assert.deepEqual(errors, []);
});
