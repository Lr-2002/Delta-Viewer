import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

const root = process.cwd();
const browserExecutable = findBrowserExecutable();

if (!browserExecutable) {
  test("browser demo flow", { skip: "No supported Chromium executable is installed" }, () => {});
} else {
  let browser;
  let server;
  let baseUrl;

  before(async () => {
    const port = await findAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(pnpmCommand(), ["exec", "vite", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: root,
      stdio: "ignore",
    });
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  });

  after(async () => {
    await browser?.close();
    if (!server || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  });

  test("registration loads the packaged browser demo without /@fs requests", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    const page = await context.newPage();
    const fileSystemResponses = [];
    const fixtureStatuses = [];
    page.on("response", (response) => {
      if (response.url().includes("/@fs")) fileSystemResponses.push(response.status());
      if (response.url().endsWith("/demo/fixture.json")) fixtureStatuses.push(response.status());
    });

    await registerDemoAccount(page, baseUrl, "clean");
    await page.getByText("多路回放", { exact: true }).waitFor();
    await page.locator('img[alt="Camera 0 frame 0"]').waitFor();

    assert.deepEqual(fileSystemResponses, []);
    assert.ok(fixtureStatuses.includes(200));
    if (process.env.DEMO_FLOW_CLEAN_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_CLEAN_SCREENSHOT), fullPage: true });
    }
    await context.close();
  });

  test("a missing fixture reports an actionable error before demo import", async () => {
    const context = await browser.newContext({ viewport: { width: 960, height: 680 } });
    const page = await context.newPage();
    await page.route("**/demo/fixture.json", (route) => route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    }));

    await registerDemoAccount(page, baseUrl, "missing");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    const message = await alert.textContent();

    assert.match(message ?? "", /DEMO_FIXTURE_UNAVAILABLE/);
    assert.match(message ?? "", /public\/demo\/fixture\.json/);
    assert.equal(await page.getByText("多路回放", { exact: true }).count(), 0);
    if (process.env.DEMO_FLOW_MISSING_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_MISSING_SCREENSHOT), fullPage: true });
    }
    await context.close();
  });
}

async function registerDemoAccount(page, url, suffix) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByLabel("显示名称").fill("Demo Test");
  await page.locator('input[autocomplete="username"]').fill(`demo-${suffix}`);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill("demo-password-123");
  await passwords.nth(1).fill("demo-password-123");
  await page.getByRole("button", { name: "创建并登录" }).click();
}

async function findAvailablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once("error", rejectPort);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("Unable to reserve a local test port"));
        return;
      }
      listener.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Vite exited before the demo test server became available");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite has not started listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Timed out waiting for the demo test server");
}

function findBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_EXECUTABLE,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
