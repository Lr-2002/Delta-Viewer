import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const chromeCandidates = [
  process.env.PLAYWRIGHT_BROWSER_EXECUTABLE,
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

let browser;
let server;
let baseUrl;

before(async () => {
  const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
  assert.ok(executablePath, "Set CHROME_BIN to a Chrome or Chromium executable before running this test.");
  const port = await findAvailablePort();
  server = await createServer({
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      fs: { allow: [process.cwd()] },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite did not expose a local test port.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("keyboard cross-session activation clears prior data and restores focus after success", { timeout: 30_000 }, async () => {
  const session = await openActivationScenario();
  try {
    const target = session.page.locator(sessionSelector("session-b"));
    await target.focus();
    await session.page.keyboard.press("Enter");

    await session.page.waitForFunction(() => !document.querySelector(".view-tabs"));
    await waitForDisabled(session.page, "session-b");
    assert.equal(await target.getAttribute("aria-pressed"), "true");

    await session.page.waitForFunction(() => document.querySelector(".loaded-label")?.textContent?.includes("session-b"));
    await waitForEnabled(session.page, "session-b");
    await waitForFocus(session.page, "session-b");
    assert.equal(await session.page.locator(".view-tabs").count(), 1);
    assert.deepEqual(session.consoleErrors, []);
    assert.deepEqual(session.pageErrors, []);
    assert.deepEqual(session.failedRequests, []);
  } finally {
    await session.page.close();
  }
});

test("keyboard retry failure clears prior data and restores focus to the failed session", { timeout: 30_000 }, async () => {
  const session = await openActivationScenario();
  try {
    const target = session.page.locator(sessionSelector("session-c"));
    await target.focus();
    await session.page.keyboard.press("Space");

    await session.page.waitForFunction(() => !document.querySelector(".view-tabs"));
    await waitForDisabled(session.page, "session-c");
    await session.page.getByRole("alert").filter({ hasText: "DEMO_RETRY_FAILURE_1" }).waitFor();
    await waitForEnabled(session.page, "session-c");
    await waitForFocus(session.page, "session-c");

    await session.page.keyboard.press("Space");
    await waitForDisabled(session.page, "session-c");
    await session.page.getByRole("alert").filter({ hasText: "DEMO_RETRY_FAILURE_2" }).waitFor();
    await waitForEnabled(session.page, "session-c");
    await waitForFocus(session.page, "session-c");
    assert.equal(await target.getAttribute("aria-pressed"), "true");
    assert.equal(await session.page.locator(".view-tabs").count(), 0);
    assert.deepEqual(session.consoleErrors, []);
    assert.deepEqual(session.pageErrors, []);
    assert.deepEqual(session.failedRequests, []);
  } finally {
    await session.page.close();
  }
});

test("pointer activation keeps single-click selection and double-click loading behavior", { timeout: 30_000 }, async () => {
  const session = await openActivationScenario();
  try {
    const target = session.page.locator(sessionSelector("session-b"));
    await target.click();
    assert.equal(await target.getAttribute("aria-pressed"), "true");
    assert.equal(await session.page.locator(".view-tabs").count(), 0);
    await waitForEnabled(session.page, "session-b");

    await target.dblclick();
    await waitForDisabled(session.page, "session-b");
    await session.page.waitForFunction(() => document.querySelector(".loaded-label")?.textContent?.includes("session-b"));
    await waitForEnabled(session.page, "session-b");
    await waitForFocus(session.page, "session-b");
    assert.equal(await session.page.locator(".view-tabs").count(), 1);
    assert.deepEqual(session.consoleErrors, []);
    assert.deepEqual(session.pageErrors, []);
    assert.deepEqual(session.failedRequests, []);
  } finally {
    await session.page.close();
  }
});

async function openActivationScenario() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));

  await page.goto(`${baseUrl}/?demoScenario=session-activation`, { waitUntil: "networkidle" });
  const inputs = page.locator("input");
  await inputs.nth(0).fill("Session QA");
  await inputs.nth(1).fill("session-qa");
  await inputs.nth(2).fill("Passphrase123");
  await inputs.nth(3).fill("Passphrase123");
  await page.locator("form button[type=submit]").click();

  await page.locator(sessionSelector("session-a")).waitFor();
  await page.waitForFunction(() => document.querySelector(".loaded-label")?.textContent?.includes("session-a"));
  await waitForEnabled(page, "session-b");
  await waitForEnabled(page, "session-c");
  return { page, consoleErrors, pageErrors, failedRequests };
}

function sessionSelector(name) {
  return `button[aria-label^="${name}"]`;
}

async function waitForDisabled(page, name) {
  await page.waitForFunction((selector) => {
    const button = document.querySelector(selector);
    return button instanceof HTMLButtonElement && button.disabled;
  }, sessionSelector(name));
}

async function waitForEnabled(page, name) {
  await page.waitForFunction((selector) => {
    const button = document.querySelector(selector);
    return button instanceof HTMLButtonElement && !button.disabled;
  }, sessionSelector(name));
}

async function waitForFocus(page, name) {
  await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), sessionSelector(name));
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not determine a local test port.")));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
