#!/usr/bin/env node

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import {
  chmod,
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(repositoryRoot, "user-center.config.json");
const DEFAULT_DATA_ROOT = path.join(homedir(), "Library/Application Support/DOHC User Center");
const CLIENT_CONFIG_SCHEMA_VERSION = 1;
const DATA_SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_USERS = 10_000;
const MAX_AUDIT_EVENTS = 200_000;
const MAX_TASK_DETAILS = 500;
const AUDIT_ACTIONS = new Set([
  "annotation_started", "task_changed", "description_changed", "clip_changed",
  "segment_split", "segment_template_selected", "segment_note_changed",
  "segment_deleted", "annotation_saved", "export_started", "export_finished",
  "annotation_ended",
]);

function parseArguments(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    dataRoot: process.env.DOHC_USER_CENTER_DATA_ROOT || DEFAULT_DATA_ROOT,
    clientConfigPath: null,
    init: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--init") {
      options.init = true;
      continue;
    }
    if (["--config", "--data-root", "--client-config"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--config") options.configPath = path.resolve(value);
      if (argument === "--data-root") options.dataRoot = path.resolve(value);
      if (argument === "--client-config") options.clientConfigPath = path.resolve(value);
      continue;
    }
    if (argument === "--help") {
      console.log(`Usage: node scripts/user-center-server.mjs [options]

  --init                         Generate service state, TLS and client config, then exit
  --config <path>                Public service configuration
  --data-root <path>             Service-owned private data directory
  --client-config <path>         Client configuration export path for --init
`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !["", "/"].includes(url.pathname)) {
    throw new Error("publicBaseUrl must be a bare HTTPS origin");
  }
  const host = url.hostname;
  if (!isPrivateLanHost(host)) {
    throw new Error("publicBaseUrl must use a private LAN IP address");
  }
  return url.origin;
}

function isPrivateLanHost(host) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function normalizeConfiguration(raw) {
  const config = requirePlainObject(raw, "user center configuration");
  if (config.schemaVersion !== 1) throw new Error("unsupported user center schemaVersion");
  if (typeof config.listenHost !== "string" || !config.listenHost) {
    throw new Error("listenHost is required");
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) {
    throw new Error("listenPort is invalid");
  }
  if (!Number.isInteger(config.sessionTtlSeconds)
    || config.sessionTtlSeconds < 300 || config.sessionTtlSeconds > 86_400) {
    throw new Error("sessionTtlSeconds must be between 300 and 86400");
  }
  return {
    ...config,
    publicBaseUrl: normalizeBaseUrl(config.publicBaseUrl),
  };
}

export async function loadUserCenterConfiguration(configPath = DEFAULT_CONFIG_PATH) {
  return normalizeConfiguration(JSON.parse(await readFile(configPath, "utf8")));
}

function nowMs() {
  return Date.now();
}

function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/.test(username)) {
    throw new Error("账号需为 3-32 位小写字母、数字、点、下划线或连字符，且首尾为字母或数字");
  }
  return username;
}

function normalizeDisplayName(value) {
  const displayName = String(value ?? "").trim();
  if (!displayName || [...displayName].length > 40 || /[\x00-\x1f\x7f]/.test(displayName)) {
    throw new Error("显示名称需为 1-40 个可见字符");
  }
  return displayName;
}

function requirePassword(value) {
  const password = String(value ?? "");
  const count = [...password].length;
  if (count < 8 || count > 128) throw new Error("密码需为 8-128 个字符");
  return password;
}

function passwordRecord(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { algorithm: "scrypt-n16384-r8-p1", salt: salt.toString("base64"), digest: digest.toString("base64") };
}

function passwordMatches(password, record) {
  if (!record || record.algorithm !== "scrypt-n16384-r8-p1") return false;
  try {
    const actual = scryptSync(password, Buffer.from(record.salt, "base64"), 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    });
    const expected = Buffer.from(record.digest, "base64");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function clientConfigPathFor(dataRoot) {
  return path.join(dataRoot, "DOHC-User-Center-Client.json");
}

function statePath(dataRoot) {
  return path.join(dataRoot, "users.json");
}

function auditPath(dataRoot) {
  return path.join(dataRoot, "annotation-audit.jsonl");
}

async function appendAuditEvent(dataRoot, event) {
  await appendFile(auditPath(dataRoot), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(auditPath(dataRoot), 0o600);
}

async function readAuditEvents(dataRoot) {
  if (!existsSync(auditPath(dataRoot))) return [];
  const lines = (await readFile(auditPath(dataRoot), "utf8")).split("\n").filter(Boolean);
  if (lines.length > MAX_AUDIT_EVENTS) throw new Error("监管事件数量超过安全上限");
  return lines.map((line) => JSON.parse(line));
}

function certificatePath(dataRoot) {
  return path.join(dataRoot, "tls", "server.crt");
}

function keyPath(dataRoot) {
  return path.join(dataRoot, "tls", "server.key");
}

function caCertificatePath(dataRoot) {
  return path.join(dataRoot, "tls", "ca.crt");
}

function caKeyPath(dataRoot) {
  return path.join(dataRoot, "tls", "ca.key");
}

async function writePrivateAtomic(filePath, value) {
  const temporary = `${filePath}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readState(dataRoot) {
  const raw = JSON.parse(await readFile(statePath(dataRoot), "utf8"));
  if (raw.schemaVersion !== DATA_SCHEMA_VERSION || typeof raw.serviceId !== "string"
    || !Array.isArray(raw.users) || raw.users.length > MAX_USERS
    || (raw.taskDetails !== undefined && (!Array.isArray(raw.taskDetails) || raw.taskDetails.length > MAX_TASK_DETAILS))) {
    throw new Error("用户中心数据文件无效");
  }
  for (const user of raw.users) validateStoredUser(user);
  for (const detail of raw.taskDetails ?? []) validateTaskDetail(detail);
  return raw;
}

function normalizeTaskDetailText(value, label, maximum) {
  const text = String(value ?? "").trim();
  if (!text || [...text].length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new Error(`${label}不能为空且最多 ${maximum} 个字符`);
  }
  return text;
}

function validateTaskDetail(detail) {
  requirePlainObject(detail, "task detail");
  normalizeTaskDetailText(detail.task, "任务名称", 100);
  normalizeTaskDetailText(detail.detail, "任务详情", 4000);
  if (!["imported", "admin"].includes(detail.source)
    || !Number.isSafeInteger(detail.updatedAtMs) || detail.updatedAtMs <= 0
    || typeof detail.updatedBy !== "string") {
    throw new Error("任务详情记录无效");
  }
}

function upsertTaskDetails(state, entries, source, username) {
  state.taskDetails ??= [];
  for (const entry of entries) {
    const task = normalizeTaskDetailText(entry.task, "任务名称", 100);
    const detail = normalizeTaskDetailText(entry.detail, "任务详情", 4000);
    const record = { task, detail, source, updatedAtMs: nowMs(), updatedBy: username };
    const index = state.taskDetails.findIndex((existing) => existing.task.toLowerCase() === task.toLowerCase());
    if (index >= 0) state.taskDetails[index] = record;
    else state.taskDetails.push(record);
  }
  if (state.taskDetails.length > MAX_TASK_DETAILS) throw new Error("TASK_DETAIL_LIMIT_EXCEEDED: 任务详情超过 500 条");
}

function validateStoredUser(user) {
  requirePlainObject(user, "user");
  normalizeUsername(user.username);
  normalizeDisplayName(user.displayName);
  if (!["admin", "operator"].includes(user.role)
    || (user.assignedTasks !== undefined
      && (!Number.isSafeInteger(user.assignedTasks) || user.assignedTasks < 0 || user.assignedTasks > 1_000_000))
    || !Number.isSafeInteger(user.createdAtMs) || user.createdAtMs <= 0
    || !user.password?.salt || !user.password?.digest) {
    throw new Error("用户中心账号记录无效");
  }
}

function clientConfig(config, state, certificatePem) {
  return {
    schemaVersion: CLIENT_CONFIG_SCHEMA_VERSION,
    serviceId: state.serviceId,
    serverUrl: config.publicBaseUrl,
    certificatePem,
    issuedAtMs: nowMs(),
  };
}

async function ensureTls(dataRoot, publicBaseUrl) {
  const certificate = certificatePath(dataRoot);
  const key = keyPath(dataRoot);
  const caCertificate = caCertificatePath(dataRoot);
  const caKey = caKeyPath(dataRoot);
  if (existsSync(certificate) && existsSync(key)
    && existsSync(caCertificate) && existsSync(caKey)) return;
  await mkdir(path.dirname(certificate), { recursive: true, mode: 0o700 });
  const host = new URL(publicBaseUrl).hostname;
  if (!existsSync(caCertificate) && !existsSync(caKey)
    && existsSync(certificate) && existsSync(key)) {
    await rename(certificate, caCertificate);
    await rename(key, caKey);
  }
  if (!existsSync(caCertificate) || !existsSync(caKey)) {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "3650",
      "-keyout", caKey, "-out", caCertificate, "-subj", "/CN=DOHC User Center Local CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ], { stdio: "ignore" });
  }
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const request = path.join(path.dirname(certificate), `.server-${nonce}.csr`);
  const extensions = path.join(path.dirname(certificate), `.server-${nonce}.ext`);
  try {
    execFileSync("openssl", [
      "req", "-new", "-newkey", "rsa:3072", "-sha256", "-nodes",
      "-keyout", key, "-out", request, "-subj", `/CN=${host}`,
    ], { stdio: "ignore" });
    await writeFile(extensions, [
      `subjectAltName=IP:${host},DNS:localhost`,
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
    execFileSync("openssl", [
      "x509", "-req", "-in", request, "-CA", caCertificate, "-CAkey", caKey,
      "-CAcreateserial", "-out", certificate, "-days", "825", "-sha256",
      "-extfile", extensions,
    ], { stdio: "ignore" });
  } finally {
    await rm(request, { force: true });
    await rm(extensions, { force: true });
  }
  await chmod(caKey, 0o600);
  await chmod(caCertificate, 0o644);
  await chmod(key, 0o600);
  await chmod(certificate, 0o644);
}

export async function initializeUserCenter(configuration, dataRoot, outputClientConfigPath = null) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
  await ensureTls(dataRoot, configuration.publicBaseUrl);
  let state;
  if (existsSync(statePath(dataRoot))) {
    state = await readState(dataRoot);
  } else {
    state = { schemaVersion: DATA_SCHEMA_VERSION, serviceId: randomUUID(), users: [] };
    await writePrivateAtomic(statePath(dataRoot), state);
  }
  const certificatePem = await readFile(caCertificatePath(dataRoot), "utf8");
  const client = clientConfig(configuration, state, certificatePem);
  const destination = outputClientConfigPath ?? clientConfigPathFor(dataRoot);
  await writePrivateAtomic(destination, client);
  return { state, clientConfigPath: destination };
}

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendHtml(response, status, body) {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

async function parseJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  try {
    return requirePlainObject(JSON.parse(Buffer.concat(chunks, total).toString("utf8")), "request");
  } catch (error) {
    throw new Error(error.message === "request must be an object" ? error.message : "请求 JSON 无效");
  }
}

function isLoopback(request) {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function bearerToken(request) {
  const value = request.headers.authorization;
  if (typeof value !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(value);
  return match?.[1] ?? null;
}

function sessionIdentity(sessions, request) {
  const token = bearerToken(request);
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAtMs <= nowMs()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session;
}

function publicUser(user) {
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    assignedTasks: user.assignedTasks ?? 0,
    createdAtMs: user.createdAtMs,
  };
}

function auditEvent(body, user) {
  const action = String(body.action ?? "");
  if (!AUDIT_ACTIONS.has(action)) throw new Error("AUDIT_ACTION_INVALID: 行为类型无效");
  const taskId = String(body.taskId ?? "");
  const trajectoryCode = String(body.trajectoryCode ?? "");
  if (taskId.length > 100 || trajectoryCode.length > 100) throw new Error("AUDIT_FIELD_INVALID: 监管字段无效");
  const occurredAtMs = Number(body.occurredAtMs);
  if (!Number.isSafeInteger(occurredAtMs) || Math.abs(nowMs() - occurredAtMs) > 86_400_000) {
    throw new Error("AUDIT_TIME_INVALID: 行为时间无效");
  }
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    username: user.username,
    displayName: user.displayName,
    taskId,
    trajectoryCode,
    action,
    occurredAtMs,
    receivedAtMs: nowMs(),
  };
}

function localDay(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function auditSummary(events, accounts, currentTimeMs = nowMs()) {
  const users = new Map(accounts.map((account) => [account.username, {
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    assignedTasks: account.assignedTasks ?? 0,
    completedToday: new Set(),
    totalCompleted: new Set(),
    completionDurationsMs: [],
    starts: new Map(),
  }]));
  const currentDay = localDay(currentTimeMs);
  for (const event of events) {
    const row = users.get(event.username);
    if (!row) continue;
    const completionKey = event.trajectoryCode;
    if (event.action === "annotation_started") row.starts.set(completionKey, event.occurredAtMs);
    if (event.action === "annotation_saved" && !row.totalCompleted.has(completionKey)) {
      row.totalCompleted.add(completionKey);
      if (localDay(event.receivedAtMs) === currentDay) row.completedToday.add(completionKey);
      const startedAt = row.starts.get(completionKey);
      if (startedAt !== undefined && event.occurredAtMs >= startedAt) {
        row.completionDurationsMs.push(event.occurredAtMs - startedAt);
      }
    }
    users.set(event.username, row);
  }
  return [...users.values()].map((row) => ({
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    assignedTasks: row.assignedTasks,
    completedToday: row.completedToday.size,
    totalCompleted: row.totalCompleted.size,
    averageCompletionMs: row.completionDurationsMs.length
      ? Math.round(row.completionDurationsMs.reduce((sum, value) => sum + value, 0) / row.completionDurationsMs.length)
      : null,
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function adminPage({ setupRequired, serviceId }) {
  const title = setupRequired ? "初始化管理员" : "用户中心";
  const setup = setupRequired
    ? `<form id="setup"><label>管理员账号<input name="username" required minlength="3" maxlength="32"></label><label>显示名称<input name="displayName" required maxlength="40"></label><label>密码<input type="password" name="password" required minlength="8" maxlength="128"></label><button>创建管理员</button></form>`
    : `<form id="login"><label>账号<input name="username" required></label><label>密码<input type="password" name="password" required></label><button>登录</button></form><section id="admin" hidden><header><strong id="identity"></strong><button id="logout" type="button">退出</button></header><h2>标注监管</h2><div id="metrics"></div><table><thead><tr><th>用户</th><th>已保存任务</th><th>操作数</th><th>首次活动</th><th>最近活动</th><th>质量评分</th></tr></thead><tbody id="audit-users"></tbody></table><h3>最近操作</h3><ul id="audit-events"></ul><h2>账号</h2><ul id="users"></ul><h2>创建账号</h2><form id="create"><label>账号<input name="username" required minlength="3" maxlength="32"></label><label>显示名称<input name="displayName" required maxlength="40"></label><label>初始密码<input type="password" name="password" required minlength="8" maxlength="128"></label><button>创建账号</button></form></section>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DOHC 用户中心</title><style>body{font:14px system-ui,sans-serif;margin:32px;max-width:1100px;color:#111}label{display:grid;gap:6px;margin:12px 0}input,button{font:inherit;padding:8px}button{width:max-content}header{display:flex;gap:12px;align-items:center}li{margin:6px 0}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #ccc;text-align:left}#notice{min-height:20px;color:#a00}</style><main><h1>${title}</h1><p>服务 ID：<code>${escapeHtml(serviceId)}</code></p><p id="notice" role="alert"></p>${setup}</main><script>const notice=document.querySelector('#notice');let token=sessionStorage.getItem('dohc-user-center-token')||'';const request=async(path,body,method='POST')=>{const r=await fetch(path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||'请求失败');return j};const formData=f=>Object.fromEntries(new FormData(f));const show=e=>notice.textContent=e instanceof Error?e.message:String(e);const time=v=>v?new Date(v).toLocaleString():'—';const setup=document.querySelector('#setup');if(setup)setup.onsubmit=async e=>{e.preventDefault();try{await request('/api/v1/setup',formData(setup));location.reload()}catch(x){show(x)}};const login=document.querySelector('#login');const admin=document.querySelector('#admin');const refresh=async()=>{const me=await request('/api/v1/auth/me',null,'GET');document.querySelector('#identity').textContent=me.user.displayName+' (@'+me.user.username+')';const users=await request('/api/v1/admin/users',null,'GET');document.querySelector('#users').replaceChildren(...users.users.map(u=>{const li=document.createElement('li');li.textContent=u.displayName+' (@'+u.username+') · '+u.role;return li}));const audit=await request('/api/v1/admin/audit',null,'GET');document.querySelector('#metrics').textContent='监管用户 '+audit.users.length+' 人 · 最近事件 '+audit.events.length+' 条';document.querySelector('#audit-users').replaceChildren(...audit.users.map(u=>{const tr=document.createElement('tr');[u.displayName+' (@'+u.username+')',u.completedTasks,u.operationCount,time(u.firstActivityAtMs),time(u.lastActivityAtMs),u.qualityScore??'待检测'].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td)});return tr}));document.querySelector('#audit-events').replaceChildren(...audit.events.slice(0,50).map(e=>{const li=document.createElement('li');li.textContent=time(e.occurredAtMs)+' · '+e.displayName+' · '+e.action+' · '+(e.taskId||'—');return li}));login.hidden=true;admin.hidden=false};if(login){login.onsubmit=async e=>{e.preventDefault();try{const r=await request('/api/v1/auth/login',formData(login));token=r.token;sessionStorage.setItem('dohc-user-center-token',token);await refresh()}catch(x){show(x)}};document.querySelector('#create').onsubmit=async e=>{e.preventDefault();try{await request('/api/v1/admin/users',formData(document.querySelector('#create')));document.querySelector('#create').reset();await refresh()}catch(x){show(x)}};document.querySelector('#logout').onclick=()=>{sessionStorage.removeItem('dohc-user-center-token');location.reload()};if(token)refresh().catch(()=>sessionStorage.removeItem('dohc-user-center-token'))}</script></html>`;
}

function supervisionPage(serviceId) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DOHC 标注监管</title><style>:root{color:#111;background:#f5f5f5;font:14px system-ui,sans-serif}*{box-sizing:border-box}body{margin:0}main{max-width:1280px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #111;padding-bottom:18px}.muted{color:#666}.panel{margin-top:18px;padding:20px;background:#fff;border:1px solid #ccc;border-radius:6px}form{max-width:420px;display:grid;gap:12px}label{display:grid;gap:6px}input,button{font:inherit;padding:9px;border:1px solid #999;border-radius:4px}button{width:max-content;background:#111;color:#fff}table{width:100%;border-collapse:collapse}th,td{padding:10px 8px;border-bottom:1px solid #ddd;text-align:left}#notice{color:#a00}.metrics{font-size:18px;font-weight:700}li{margin:8px 0}</style><main><header><div><small class="muted">ADMIN SUPERVISION</small><h1>标注监管</h1><span class="muted">服务 ID：${escapeHtml(serviceId)}</span></div><button id="logout" hidden>退出</button></header><p id="notice" role="alert"></p><section class="panel" id="login-panel"><h2>管理员登录</h2><form id="login"><label>账号<input name="username" required></label><label>密码<input type="password" name="password" required></label><button>进入监管页</button></form></section><section id="dashboard" hidden><div class="panel"><div class="metrics" id="metrics"></div></div><div class="panel"><h2>用户任务量</h2><table><thead><tr><th>用户</th><th>已保存任务</th><th>操作数</th><th>首次活动</th><th>最近活动</th><th>质量评分</th></tr></thead><tbody id="users"></tbody></table></div><div class="panel"><h2>最近操作</h2><ul id="events"></ul></div></section></main><script>const notice=document.querySelector('#notice');let token=sessionStorage.getItem('dohc-supervision-token')||'';const req=async(path,body,method='POST')=>{const r=await fetch(path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||'请求失败');return j};const time=v=>v?new Date(v).toLocaleString():'—';const show=e=>notice.textContent=e instanceof Error?e.message:String(e);const refresh=async()=>{const audit=await req('/api/v1/admin/audit',null,'GET');document.querySelector('#metrics').textContent='监管用户 '+audit.users.length+' 人 · 最近事件 '+audit.events.length+' 条';document.querySelector('#users').replaceChildren(...audit.users.map(u=>{const tr=document.createElement('tr');[u.displayName+' (@'+u.username+')',u.completedTasks,u.operationCount,time(u.firstActivityAtMs),time(u.lastActivityAtMs),u.qualityScore??'待检测'].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td)});return tr}));document.querySelector('#events').replaceChildren(...audit.events.slice(0,100).map(e=>{const li=document.createElement('li');li.textContent=time(e.occurredAtMs)+' · '+e.displayName+' · '+e.action+' · '+(e.taskId||'—');return li}));document.querySelector('#login-panel').hidden=true;document.querySelector('#dashboard').hidden=false;document.querySelector('#logout').hidden=false};document.querySelector('#login').onsubmit=async e=>{e.preventDefault();try{const body=Object.fromEntries(new FormData(e.currentTarget));const r=await req('/api/v1/auth/login',body);token=r.token;sessionStorage.setItem('dohc-supervision-token',token);await refresh()}catch(x){show(x)}};document.querySelector('#logout').onclick=()=>{sessionStorage.removeItem('dohc-supervision-token');location.reload()};if(token)refresh().catch(x=>{sessionStorage.removeItem('dohc-supervision-token');show(x)})</script></html>`;
}

export async function createUserCenter(inputConfiguration, dataRoot, logger = console) {
  const configuration = normalizeConfiguration(inputConfiguration);
  const initialized = await initializeUserCenter(configuration, dataRoot);
  const sessions = new Map();
  const attempts = new Map();

  async function writeState(state) {
    await writePrivateAtomic(statePath(dataRoot), state);
  }

  function authorize(request, requireAdmin = false) {
    const session = sessionIdentity(sessions, request);
    if (!session || (requireAdmin && session.user.role !== "admin")) return null;
    return session;
  }

  function canAttempt(request) {
    const key = request.socket.remoteAddress ?? "unknown";
    const record = attempts.get(key);
    if (!record || record.untilMs <= nowMs()) return true;
    return record.count < 5;
  }

  function recordFailedAttempt(request) {
    const key = request.socket.remoteAddress ?? "unknown";
    const current = attempts.get(key);
    const windowStart = current?.untilMs > nowMs() ? current.untilMs : nowMs() + 60_000;
    attempts.set(key, { count: (current?.untilMs > nowMs() ? current.count : 0) + 1, untilMs: windowStart });
  }

  async function handler(request, response) {
    try {
      const url = new URL(request.url, configuration.publicBaseUrl);
      if (request.method === "GET" && url.pathname === "/healthz") {
        const state = await readState(dataRoot);
        return sendJson(response, 200, { status: "ready", serviceId: state.serviceId, setupRequired: state.users.length === 0 });
      }
      if (request.method === "GET" && url.pathname === "/client-config") {
        return createReadStream(initialized.clientConfigPath).pipe(response);
      }
      if (request.method === "GET" && url.pathname === "/") {
        const state = await readState(dataRoot);
        if (state.users.length === 0 && !isLoopback(request)) {
          return sendJson(response, 403, { error: "首次管理员初始化只能在服务主机本机完成" });
        }
        return sendHtml(response, 200, adminPage({ setupRequired: state.users.length === 0, serviceId: state.serviceId }));
      }
      if (request.method === "GET" && url.pathname === "/supervision") {
        const state = await readState(dataRoot);
        return sendHtml(response, 200, supervisionPage(state.serviceId));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/setup") {
        if (!isLoopback(request)) return sendJson(response, 403, { error: "首次管理员初始化只能在服务主机本机完成" });
        const state = await readState(dataRoot);
        if (state.users.length !== 0) return sendJson(response, 409, { error: "INITIAL_ADMIN_ALREADY_EXISTS" });
        const body = await parseJsonBody(request);
        const user = {
          username: normalizeUsername(body.username),
          displayName: normalizeDisplayName(body.displayName),
          role: "admin",
          password: passwordRecord(requirePassword(body.password)),
          createdAtMs: nowMs(),
        };
        state.users.push(user);
        await writeState(state);
        return sendJson(response, 201, { user: publicUser(user) });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
        if (!canAttempt(request)) return sendJson(response, 429, { error: "AUTH_RATE_LIMITED: 请稍后再试" });
        const body = await parseJsonBody(request);
        const username = normalizeUsername(body.username);
        const password = requirePassword(body.password);
        const state = await readState(dataRoot);
        const user = state.users.find((candidate) => candidate.username === username);
        if (!user || !passwordMatches(password, user.password)) {
          recordFailedAttempt(request);
          return sendJson(response, 401, { error: "AUTH_INVALID: 账号或密码错误" });
        }
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, { user: publicUser(user), expiresAtMs: nowMs() + configuration.sessionTtlSeconds * 1000 });
        return sendJson(response, 200, { token, user: publicUser(user), expiresAtMs: sessions.get(token).expiresAtMs });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/auth/me") {
        const session = authorize(request);
        return session ? sendJson(response, 200, { user: session.user, expiresAtMs: session.expiresAtMs }) : sendJson(response, 401, { error: "AUTH_REQUIRED" });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") {
        const token = bearerToken(request);
        if (token) sessions.delete(token);
        return sendJson(response, 204, {});
      }
      if (request.method === "POST" && url.pathname === "/api/v1/audit/events") {
        const session = authorize(request);
        if (!session) return sendJson(response, 401, { error: "AUTH_REQUIRED" });
        const event = auditEvent(await parseJsonBody(request), session.user);
        await appendAuditEvent(dataRoot, event);
        return sendJson(response, 201, { eventId: event.eventId });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/admin/audit") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "SUPERVISOR_REQUIRED" });
        const events = await readAuditEvents(dataRoot);
        const state = await readState(dataRoot);
        return sendJson(response, 200, {
          users: auditSummary(events, state.users),
          events: events.slice(-500).reverse(),
          taskDetails: state.taskDetails ?? [],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/admin/users") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const state = await readState(dataRoot);
        return sendJson(response, 200, { users: state.users.map(publicUser) });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/users") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const body = await parseJsonBody(request);
        const state = await readState(dataRoot);
        if (state.users.length >= MAX_USERS) return sendJson(response, 409, { error: "USER_LIMIT_EXCEEDED" });
        const username = normalizeUsername(body.username);
        if (state.users.some((candidate) => candidate.username === username)) {
          return sendJson(response, 409, { error: "ACCOUNT_EXISTS: 账号已存在" });
        }
        const user = {
          username,
          displayName: normalizeDisplayName(body.displayName),
          role: body.role === "admin" ? "admin" : "operator",
          password: passwordRecord(requirePassword(body.password)),
          createdAtMs: nowMs(),
          createdBy: session.user.username,
        };
        state.users.push(user);
        await writeState(state);
        return sendJson(response, 201, { user: publicUser(user) });
      }
      const assignmentMatch = /^\/api\/v1\/admin\/users\/([^/]+)\/assignment$/.exec(url.pathname);
      if (request.method === "PUT" && assignmentMatch) {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const username = normalizeUsername(decodeURIComponent(assignmentMatch[1]));
        const body = await parseJsonBody(request);
        const assignedTasks = Number(body.assignedTasks);
        if (!Number.isSafeInteger(assignedTasks) || assignedTasks < 0 || assignedTasks > 1_000_000) {
          return sendJson(response, 400, { error: "ASSIGNED_TASKS_INVALID: 分配任务数必须是 0-1000000 的整数" });
        }
        const state = await readState(dataRoot);
        const user = state.users.find((candidate) => candidate.username === username);
        if (!user) return sendJson(response, 404, { error: "ACCOUNT_NOT_FOUND: 账号不存在" });
        if (user.role !== "operator") return sendJson(response, 409, { error: "OPERATOR_REQUIRED: 只能给普通账户分配任务" });
        user.assignedTasks = assignedTasks;
        await writeState(state);
        return sendJson(response, 200, { user: publicUser(user) });
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/admin/task-details") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const body = await parseJsonBody(request);
        const state = await readState(dataRoot);
        upsertTaskDetails(state, [{ task: body.task, detail: body.detail }], "admin", session.user.username);
        await writeState(state);
        return sendJson(response, 200, { taskDetails: state.taskDetails });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/task-details/import") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const body = await parseJsonBody(request);
        if (!Array.isArray(body.tasks) || !body.tasks.length || body.tasks.length > MAX_TASK_DETAILS) {
          return sendJson(response, 400, { error: "TASK_DETAIL_IMPORT_INVALID: 导入内容无效" });
        }
        const state = await readState(dataRoot);
        upsertTaskDetails(state, body.tasks, "imported", session.user.username);
        await writeState(state);
        return sendJson(response, 200, { taskDetails: state.taskDetails });
      }
      return sendJson(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      logger.error(`[user-center] request failed: ${error.message}`);
      return sendJson(response, 400, { error: error.message || "请求失败" });
    }
  }

  let server;
  return {
    async start() {
      if (server) return;
      server = createServer({ key: await readFile(keyPath(dataRoot)), cert: await readFile(certificatePath(dataRoot)) }, handler);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(configuration.listenPort, configuration.listenHost, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger.log(`[user-center] listening at ${configuration.publicBaseUrl}`);
    },
    async stop() {
      if (!server) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    },
    configuration,
    clientConfigPath: initialized.clientConfigPath,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const configuration = await loadUserCenterConfiguration(options.configPath);
  if (options.init) {
    const initialized = await initializeUserCenter(configuration, options.dataRoot, options.clientConfigPath);
    console.log(`DOHC User Center initialized. Client configuration: ${initialized.clientConfigPath}`);
    return;
  }
  const service = await createUserCenter(configuration, options.dataRoot);
  await service.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[user-center] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
