import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("task center shows QC tree, enforces claim states, refreshes without collapsing and fits small screens", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{ name: "task-center-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
    if (request.url !== "/__task-center-test") return next();
    response.setHeader("content-type", "text/html");
    response.end(await server.transformIndexHtml(request.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {TaskCenter} from '/src/components/TaskCenter.tsx'; import '/src/styles.css';
      const root = createRoot(document.getElementById('root'));
      window.hideTask = () => root.render(null);
      window.showTask = (role='operator') => root.render(React.createElement('div', {className:'personal-task-overlay'}, React.createElement(TaskCenter, {currentUser:{username:'alice',displayName:'审核甲',role},onClose:()=>{},onOpen:async(root)=>{window.openedTask=root;}})));
      window.showTask();
    </script></body></html>`));
    });
  } }] });
  await server.listen();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync) ?? chromium.executablePath();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.addInitScript(() => {
      const leaf = (name, status) => ({ name, relativePath: `2026-09-03-Fridge2/${name}`, batchKey: "c".repeat(64), session: true, status, error: "", total: 1, reviewed: status === "pending" ? 0 : 1, approved: Number(status === "approved"), rejected: Number(status === "rejected"), errors: 0, incomplete: false, children: [] });
      const batch = (name, key, reviewed, total, children = []) => ({ name, relativePath: name, batchKey: key.repeat(64), session: false, status: "pending", error: "", total, reviewed, approved: reviewed, rejected: 0, errors: 0, incomplete: false, children });
      const tree = batch("Delta-D1", "f", 5, 7, [batch("2026-09-02-Fridge", "a", 2, 2), batch("2026-09-02-Oven", "b", 1, 1), batch("2026-09-03-Fridge2", "c", 2, 4, [leaf("Fridge2_001", "approved"), leaf("Fridge2_002", "rejected"), leaf("Fridge2_003", "pending"), leaf("Fridge2_004", "pending")])]);
      tree.relativePath = "";
      const root = "\\\\10.1.40.2\\Datasets\\Delta-D1";
      const claims = { ["a".repeat(64)]: { batchKey: "a".repeat(64), username: "bob", displayName: "审核乙", claimedAtMs: Date.now() } };
      window.taskFixture = { tree, claims, offline: false, calls: [], nodeCalls: [], serverError: '', running: false };
      window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
        window.taskFixture.calls.push(command);
        if (command === "get_task_center_root") return root;
        if (command === "read_task_index") {
          if (window.taskFixture.delayListing) await new Promise((resolve) => { window.taskFixture.finishListing = resolve; });
          window.taskFixture.nodeCalls.push(args.relativePath);
          const listing = structuredClone(args.relativePath ? tree.children.find((node) => node.relativePath === args.relativePath) : tree);
          listing.childrenLoaded = true;
          listing.children = listing.children.map((child) => ({ ...child, childrenLoaded: child.session, children: [] }));
          return { catalog: { sourceRoot: root, tree: listing }, server: { completedAtMs: Date.UTC(2026,8,19,15,18), updatedAtMs: Date.UTC(2026,8,19,15,18), heartbeatAtMs: Date.now(), running: window.taskFixture.running, sessions: 5418, error: window.taskFixture.serverError, schedule: '23:00 Asia/Shanghai' } };
        }
        if (command === "plugin:dialog|message") return '确认';
        if (command === "rebuild_task_index") return;
        if (command === "task_center_claims") {
          if (window.taskFixture.offline) throw Error("用户中心连接中断");
          if (args.action === "lookup") return { claims: Object.values(claims) };
          if (claims[args.body.batchKey]) throw Error("该批次已被领取");
          const claim = { batchKey: args.body.batchKey, username: "alice", displayName: "审核甲", claimedAtMs: Date.now() };
          claims[claim.batchKey] = claim; return { claim };
        }
        throw Error(`Unexpected command ${command}`);
      }};
    });
    await page.goto(`${server.resolvedUrls.local[0]}__task-center-test`);
    await page.getByRole("button", { name: "已被领取", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "2026-09-03-Fridge2", exact: true }).isVisible(), true);
    await page.waitForFunction(() => document.querySelector('.task-tree').getAttribute('aria-busy') === 'false');
    assert.match(await page.locator('.task-scan-status').innerText(), /服务器最近统计完成.*2026\/9\/19 23:18/);
    assert.deepEqual(await page.evaluate(() => window.taskFixture.nodeCalls), [''], 'opening reads one summary and no session directories');
    assert.equal(await page.getByRole('button', {name:'立即统计', exact:true}).count(), 0);
    assert.equal(await page.getByRole("button", { name: "已被领取", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "领取", exact: true }).count(), 2);
    await page.getByRole("button", { name: "2026-09-03-Fridge2", exact: true }).click();
    await page.getByRole("button", { name: "Fridge2_001", exact: true }).waitFor();
    assert.equal(await page.getByText("已审核 · 不通过", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "领取", exact: true }).first().click();
    await page.getByRole("button", { name: "已领取", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "已领取", exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.hideTask(); window.taskFixture.delayListing = true; });
    await page.locator(".task-center").waitFor({ state: "detached" });
    await page.evaluate(() => window.showTask());
    await page.waitForFunction(() => typeof window.taskFixture.finishListing === "function");
    assert.equal(await page.getByRole("button", { name: "2026-09-03-Fridge2", exact: true }).isVisible(), true, "cached batches must display before NAS listing responds");
    assert.equal(await page.getByText('领取人：审核乙 (@bob)', {exact:true}).isVisible(), true);
    await page.evaluate(() => { window.taskFixture.delayListing = false; window.taskFixture.finishListing(); });
    await page.waitForFunction(() => document.querySelector('.task-tree').getAttribute('aria-busy') === 'false');
    await page.getByRole("button", { name: "2026-09-03-Fridge2", exact: true }).click();
    await page.getByRole("button", { name: "刷新任务进度", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.task-tree').getAttribute('aria-busy') === 'false');
    assert.equal(await page.getByRole("button", { name: "Fridge2_001", exact: true }).isVisible(), true);
    await page.getByRole("button", { name: "Fridge2_001", exact: true }).click();
    assert.match(await page.evaluate(() => window.openedTask), /Fridge2_001$/);
    await page.waitForFunction(() => document.querySelector('.task-tree').getAttribute('aria-busy') === 'false');
    await page.getByRole("button", { name: "刷新任务进度", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.task-tree').getAttribute('aria-busy') === 'false');
    await mkdir("artifacts/task-center", { recursive: true });
    await page.screenshot({ path: "artifacts/task-center/desktop.png", fullPage: true });
    for (const width of [960, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      const overflow = await page.locator(".task-center").evaluate((element) => element.scrollWidth > element.clientWidth);
      assert.equal(overflow, false);
      for (const button of await page.locator(".task-center button").all()) {
        assert.equal(await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "button text must fit");
      }
    }
    await page.screenshot({ path: "artifacts/task-center/mobile.png", fullPage: true });
    await page.evaluate(() => { window.taskFixture.running = true; });
    await page.getByRole('button', { name: '刷新任务进度', exact: true }).click();
    await page.getByText('服务器正在统计 · 已统计 5418 条 · 显示上次结果', {exact:true}).waitFor();
    assert.equal(await page.getByRole('button', {name:'领取',exact:true}).isDisabled(), false, 'background rebuild does not block existing batches');
    await page.evaluate(() => { window.taskFixture.running = false; window.taskFixture.serverError = '统计失败：权限不足'; });
    await page.getByRole('button', { name: '刷新任务进度', exact: true }).click();
    await page.getByText('统计失败：权限不足；保留上次成功结果', {exact:true}).waitFor();
    assert.match(await page.locator('.task-scan-status').innerText(), /2026\/9\/19 23:18/);
    await page.evaluate(() => { window.taskFixture.serverError = ''; window.showTask('admin'); });
    await page.getByRole('button', {name:'立即统计',exact:true}).click();
    await page.getByText('已请求服务器统计', {exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.taskFixture.calls.filter((cmd) => cmd === 'rebuild_task_index').length), 1);
    await page.evaluate(() => window.showTask());
    await page.evaluate(() => { window.taskFixture.offline = true; });
    await page.getByRole("button", { name: "刷新任务进度", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "领取", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Fridge2_001", exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => window.taskFixture.calls.includes('scan_task_center')), false, 'open/refresh/expand must never invoke a full source scan');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
