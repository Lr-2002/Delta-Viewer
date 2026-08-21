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
const STRUCTURED_ASSIGNMENTS_CAPABILITY = "structuredTaskAssignmentsV1";
const OPERATOR_SELF_REGISTRATION_CAPABILITY = "operatorSelfRegistrationV1";
const OPERATOR_PROFILE_CAPABILITY = "operatorProfileV1";
const OPERATIONS_COCKPIT_CAPABILITY = "operationsCockpitV1";
const MAX_JSON_BYTES = 16 * 1024;
const MAX_USERS = 10_000;
const MAX_AUDIT_EVENTS = 200_000;
const MAX_TASK_DETAILS = 500;
const MAX_QUALITY_REVIEWS = 50_000;
const MAX_ALERT_ACTIONS = 10_000;
const STAGNATION_THRESHOLD_MS = 90 * 60_000;
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
    || (raw.taskDetails !== undefined && (!Array.isArray(raw.taskDetails) || raw.taskDetails.length > MAX_TASK_DETAILS))
    || (raw.qualityReviews !== undefined
      && (!Array.isArray(raw.qualityReviews) || raw.qualityReviews.length > MAX_QUALITY_REVIEWS))
    || (raw.alertActions !== undefined
      && (!Array.isArray(raw.alertActions) || raw.alertActions.length > MAX_ALERT_ACTIONS))) {
    throw new Error("用户中心数据文件无效");
  }
  for (const user of raw.users) validateStoredUser(user);
  for (const detail of raw.taskDetails ?? []) validateTaskDetail(detail);
  for (const review of raw.qualityReviews ?? []) validateQualityReview(review);
  for (const action of raw.alertActions ?? []) validateAlertAction(action);
  return raw;
}

function normalizeTaskDetailText(value, label, maximum) {
  const text = String(value ?? "").trim();
  if (!text || [...text].length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new Error(`${label}不能为空且最多 ${maximum} 个字符`);
  }
  return text;
}

function containsSourceReference(value) {
  return /(?:[a-z]:[\\/]|[\\/]|(?:file|smb|nfs|https?):)/i.test(String(value ?? ""));
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
    || (user.assignedTaskNames !== undefined && (!Array.isArray(user.assignedTaskNames)
      || user.assignedTaskNames.length > MAX_TASK_DETAILS
      || user.assignedTaskNames.some((task) => typeof task !== "string" || !task.trim() || [...task].length > 100)))
    || (user.assignedTaskQuantities !== undefined && (typeof user.assignedTaskQuantities !== "object"
      || Array.isArray(user.assignedTaskQuantities)
      || Object.entries(user.assignedTaskQuantities).length > MAX_TASK_DETAILS
      || Object.entries(user.assignedTaskQuantities).some(([task, quantity]) => !task.trim() || [...task].length > 100
        || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000)))
    || (user.assignedTaskStarts !== undefined && (typeof user.assignedTaskStarts !== "object"
      || Array.isArray(user.assignedTaskStarts)
      || Object.entries(user.assignedTaskStarts).some(([task, start]) => !task.trim()
        || !Number.isSafeInteger(start) || start < 0 || start > 1_000_000)))
    || (user.assignmentPlans !== undefined && (!Array.isArray(user.assignmentPlans)
      || user.assignmentPlans.length > MAX_TASK_DETAILS
      || user.assignmentPlans.some((plan) => !isValidAssignmentPlan(plan))))
    || (user.assignmentUpdatedAtMs !== undefined
      && (!Number.isSafeInteger(user.assignmentUpdatedAtMs) || user.assignmentUpdatedAtMs <= 0))
    || (user.lastLoginAtMs !== undefined
      && (!Number.isSafeInteger(user.lastLoginAtMs) || user.lastLoginAtMs <= 0))
    || !Number.isSafeInteger(user.createdAtMs) || user.createdAtMs <= 0
    || !user.password?.salt || !user.password?.digest) {
    throw new Error("用户中心账号记录无效");
  }
}

function isValidAssignmentPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
  return typeof plan.task === "string" && Boolean(plan.task.trim()) && [...plan.task].length <= 100
    && Number.isSafeInteger(plan.quantity) && plan.quantity >= 1 && plan.quantity <= 1_000_000
    && Number.isSafeInteger(plan.startIndex) && plan.startIndex >= 0 && plan.startIndex <= 1_000_000
    && ["normal", "urgent", "rework"].includes(plan.priority)
    && ["active", "paused"].includes(plan.status)
    && Number.isSafeInteger(plan.order) && plan.order >= 0 && plan.order < MAX_TASK_DETAILS
    && (plan.deadlineAtMs === null || (Number.isSafeInteger(plan.deadlineAtMs) && plan.deadlineAtMs > 0));
}

function validateQualityReview(review) {
  requirePlainObject(review, "quality review");
  normalizeTaskDetailText(review.reviewId, "复核编号", 100);
  normalizeTaskDetailText(review.taskId, "任务名称", 100);
  normalizeTaskDetailText(review.trajectoryCode, "轨迹码", 100);
  normalizeTaskDetailText(review.reviewer, "复核人", 32);
  if (!["passed", "rework"].includes(review.outcome)
    || typeof review.errorType !== "string" || [...review.errorType].length > 100
    || typeof review.note !== "string" || [...review.note].length > 1000
    || containsSourceReference(`${review.errorType}${review.note}`)
    || !Number.isSafeInteger(review.reviewedAtMs) || review.reviewedAtMs <= 0) {
    throw new Error("质量复核记录无效");
  }
}

function validateAlertAction(action) {
  requirePlainObject(action, "alert action");
  normalizeTaskDetailText(action.alertId, "预警编号", 200);
  normalizeTaskDetailText(action.updatedBy, "更新人", 32);
  if (!["open", "acknowledged", "closed"].includes(action.status)
    || typeof action.note !== "string" || [...action.note].length > 500
    || containsSourceReference(action.note)
    || !Number.isSafeInteger(action.updatedAtMs) || action.updatedAtMs <= 0) {
    throw new Error("预警处理记录无效");
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
  const assignmentPlans = assignmentPlansFor(user);
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    assignedTasks: user.assignedTasks ?? 0,
    assignedTaskNames: user.assignedTaskNames ?? [],
    assignedTaskQuantities: user.assignedTaskQuantities ?? {},
    assignedTaskStarts: user.assignedTaskStarts ?? {},
    assignmentPlans,
    assignmentUpdatedAtMs: user.assignmentUpdatedAtMs ?? user.createdAtMs,
    lastLoginAtMs: user.lastLoginAtMs ?? null,
    createdAtMs: user.createdAtMs,
  };
}

function assignmentPlansFor(user) {
  if (Array.isArray(user.assignmentPlans)) {
    return [...user.assignmentPlans].sort((left, right) => left.order - right.order);
  }
  return Object.entries(user.assignedTaskQuantities ?? {}).map(([task, quantity], order) => ({
    task,
    quantity,
    startIndex: user.assignedTaskStarts?.[task] ?? 0,
    priority: "normal",
    deadlineAtMs: null,
    status: "active",
    order,
  }));
}

function synchronizeAssignmentFields(user, plans) {
  user.assignmentPlans = plans.map((plan, order) => ({ ...plan, order }));
  user.assignedTaskNames = user.assignmentPlans.map((plan) => plan.task);
  user.assignedTaskQuantities = Object.fromEntries(user.assignmentPlans.map((plan) => [plan.task, plan.quantity]));
  user.assignedTaskStarts = Object.fromEntries(user.assignmentPlans.map((plan) => [plan.task, plan.startIndex]));
  user.assignedTasks = user.assignmentPlans.reduce((sum, plan) => sum + plan.quantity, 0);
  user.assignmentUpdatedAtMs = nowMs();
}

function availableAssignmentStart(users, excludedUsername, task, quantity) {
  const occupied = users
    .filter((candidate) => candidate.username !== excludedUsername)
    .flatMap((candidate) => assignmentPlansFor(candidate)
      .filter((plan) => plan.task.toLowerCase() === task.toLowerCase())
      .map((plan) => ({ start: plan.startIndex, end: plan.startIndex + plan.quantity })))
    .sort((left, right) => left.start - right.start);
  let start = 0;
  for (const interval of occupied) {
    if (start + quantity <= interval.start) break;
    start = Math.max(start, interval.end);
  }
  return start;
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
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function requestedLocalDay(value) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("DATE_INVALID: 日期格式应为 YYYY-MM-DD");
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new Error("DATE_INVALID: 日期无效");
  }
  const end = new Date(year, month - 1, day + 1);
  return { date, startMs: start.getTime(), endMs: end.getTime() };
}

function operationsSummary(events, accounts, alertActions = [], currentTimeMs = nowMs()) {
  const users = new Map(accounts.map((account) => [account.username, {
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    assignedTasks: account.assignedTasks ?? 0,
    assignedTaskNames: account.assignedTaskNames ?? [],
    assignedTaskQuantities: account.assignedTaskQuantities ?? {},
    assignmentPlans: assignmentPlansFor(account),
    assignmentUpdatedAtMs: account.assignmentUpdatedAtMs ?? account.createdAtMs,
    lastLoginAtMs: account.lastLoginAtMs ?? null,
    completedToday: new Set(),
    totalCompleted: new Set(),
    completedByTask: new Map(),
    completedTodayByTask: new Map(),
    completionDurationsMs: [],
    completionDurationsByTask: new Map(),
    starts: new Map(),
    firstActivityAtMs: null,
    lastActivityAtMs: null,
    operationCount: 0,
    todayFirstActivityAtMs: null,
    todayLastActivityAtMs: null,
  }]));
  const currentDay = localDay(currentTimeMs);
  const hourlyTrend = Array.from({ length: 24 }, (_, hour) => ({ hour, completed: 0 }));
  const dailyTrend = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(currentTimeMs);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return { date: localDay(date.getTime()), completed: 0 };
  });
  const dailyRows = new Map(dailyTrend.map((row) => [row.date, row]));
  for (const event of [...events].sort((left, right) => left.occurredAtMs - right.occurredAtMs)) {
    const row = users.get(event.username);
    if (!row) continue;
    row.operationCount += 1;
    row.firstActivityAtMs = row.firstActivityAtMs === null
      ? event.occurredAtMs : Math.min(row.firstActivityAtMs, event.occurredAtMs);
    row.lastActivityAtMs = row.lastActivityAtMs === null
      ? event.occurredAtMs : Math.max(row.lastActivityAtMs, event.occurredAtMs);
    if (localDay(event.receivedAtMs) === currentDay) {
      row.todayFirstActivityAtMs = row.todayFirstActivityAtMs === null
        ? event.receivedAtMs : Math.min(row.todayFirstActivityAtMs, event.receivedAtMs);
      row.todayLastActivityAtMs = row.todayLastActivityAtMs === null
        ? event.receivedAtMs : Math.max(row.todayLastActivityAtMs, event.receivedAtMs);
    }
    const taskKey = event.taskId.trim().toLowerCase();
    const completionKey = `${taskKey}\u0000${event.trajectoryCode.trim().toLowerCase()}`;
    if (event.action === "annotation_started") row.starts.set(completionKey, event.occurredAtMs);
    if (event.action === "annotation_saved" && event.trajectoryCode && !row.totalCompleted.has(completionKey)) {
      row.totalCompleted.add(completionKey);
      const taskCompleted = row.completedByTask.get(taskKey) ?? new Set();
      taskCompleted.add(completionKey);
      row.completedByTask.set(taskKey, taskCompleted);
      if (localDay(event.receivedAtMs) === currentDay) {
        row.completedToday.add(completionKey);
        const taskCompletedToday = row.completedTodayByTask.get(taskKey) ?? new Set();
        taskCompletedToday.add(completionKey);
        row.completedTodayByTask.set(taskKey, taskCompletedToday);
        hourlyTrend[new Date(event.receivedAtMs).getHours()].completed += 1;
      }
      const daily = dailyRows.get(localDay(event.receivedAtMs));
      if (daily) daily.completed += 1;
      const startedAt = row.starts.get(completionKey);
      if (startedAt !== undefined && event.occurredAtMs >= startedAt) {
        const duration = event.occurredAtMs - startedAt;
        row.completionDurationsMs.push(duration);
        const taskDurations = row.completionDurationsByTask.get(taskKey) ?? [];
        taskDurations.push(duration);
        row.completionDurationsByTask.set(taskKey, taskDurations);
      }
    }
    users.set(event.username, row);
  }
  const summaries = [...users.values()].map((row) => {
    const remainingTasks = row.assignmentPlans.reduce((sum, plan) => (
      sum + Math.max(0, plan.quantity - (row.completedByTask.get(plan.task.toLowerCase())?.size ?? 0))
    ), 0);
    const averageCompletionMs = row.completionDurationsMs.length
      ? Math.round(row.completionDurationsMs.reduce((sum, value) => sum + value, 0) / row.completionDurationsMs.length)
      : null;
    const stagnationReference = row.lastActivityAtMs ?? row.lastLoginAtMs ?? row.assignmentUpdatedAtMs;
    const possibleStagnation = row.role === "operator" && remainingTasks > 0
      && currentTimeMs - stagnationReference >= STAGNATION_THRESHOLD_MS;
    const activeSpanHours = row.todayFirstActivityAtMs !== null && row.todayLastActivityAtMs !== null
      ? Math.max(1, (row.todayLastActivityAtMs - row.todayFirstActivityAtMs) / 3_600_000)
      : 1;
    return {
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      assignedTasks: row.assignedTasks,
      assignedTaskNames: row.assignedTaskNames,
      assignedTaskQuantities: row.assignedTaskQuantities,
      assignmentPlans: row.assignmentPlans,
      completedToday: row.completedToday.size,
      totalCompleted: row.totalCompleted.size,
      remainingTasks,
      averageCompletionMs,
      completionRatePerHour: Math.round(row.completedToday.size / activeSpanHours * 10) / 10,
      estimatedCompletionAtMs: averageCompletionMs === null || remainingTasks === 0
        ? null : currentTimeMs + averageCompletionMs * remainingTasks,
      firstActivityAtMs: row.firstActivityAtMs,
      lastActivityAtMs: row.lastActivityAtMs,
      lastLoginAtMs: row.lastLoginAtMs,
      operationCount: row.operationCount,
      possibleStagnation,
    };
  });
  const taskRows = new Map();
  for (const row of users.values()) {
    for (const plan of row.assignmentPlans) {
      const key = plan.task.toLowerCase();
      const task = taskRows.get(key) ?? {
        task: plan.task, assigned: 0, completedToday: 0, totalCompleted: 0,
        operators: new Set(), durations: [],
      };
      task.assigned += plan.quantity;
      task.completedToday += row.completedTodayByTask.get(key)?.size ?? 0;
      task.totalCompleted += row.completedByTask.get(key)?.size ?? 0;
      task.operators.add(row.username);
      task.durations.push(...(row.completionDurationsByTask.get(key) ?? []));
      taskRows.set(key, task);
    }
  }
  const taskSummaries = [...taskRows.values()].map((task) => ({
    task: task.task,
    assigned: task.assigned,
    completedToday: task.completedToday,
    totalCompleted: task.totalCompleted,
    remaining: Math.max(0, task.assigned - task.totalCompleted),
    operatorCount: task.operators.size,
    averageCompletionMs: task.durations.length
      ? Math.round(task.durations.reduce((sum, value) => sum + value, 0) / task.durations.length)
      : null,
  }));
  const actions = new Map(alertActions.map((action) => [action.alertId, action]));
  const alerts = [];
  for (const summary of summaries) {
    if (summary.possibleStagnation) {
      alerts.push(operationalAlert(
        `possible-stagnation:${summary.username}`,
        "possible_stagnation",
        summary.username,
        "",
        `${summary.displayName} 长时间没有可见进展，请先确认工作状态`,
        summary.lastActivityAtMs ?? summary.lastLoginAtMs ?? currentTimeMs,
        actions,
      ));
    }
  }
  const intervals = new Map();
  for (const row of users.values()) {
    for (const plan of row.assignmentPlans.filter((item) => item.status === "active")) {
      const key = plan.task.toLowerCase();
      const existing = intervals.get(key) ?? [];
      for (const interval of existing) {
        if (plan.startIndex < interval.end && interval.start < plan.startIndex + plan.quantity) {
          const usernames = [interval.username, row.username].sort().join("+");
          const taskToken = Buffer.from(key).toString("base64url");
          alerts.push(operationalAlert(
            `duplicate-range:${taskToken}:${usernames}`,
            "duplicate_assignment",
            row.username,
            plan.task,
            `${plan.task} 的分配区间与 @${interval.username} 重叠`,
            currentTimeMs,
            actions,
          ));
        }
      }
      existing.push({ username: row.username, start: plan.startIndex, end: plan.startIndex + plan.quantity });
      intervals.set(key, existing);
    }
  }
  const assigned = summaries.filter((row) => row.role === "operator")
    .reduce((sum, row) => sum + row.assignedTasks, 0);
  const totalCompleted = summaries.reduce((sum, row) => sum + row.totalCompleted, 0);
  return {
    users: summaries,
    overview: {
      completedToday: summaries.reduce((sum, row) => sum + row.completedToday, 0),
      totalCompleted,
      assigned,
      remaining: summaries.reduce((sum, row) => sum + row.remainingTasks, 0),
      activeOperators: summaries.filter((row) => row.role === "operator" && row.lastActivityAtMs !== null
        && currentTimeMs - row.lastActivityAtMs < STAGNATION_THRESHOLD_MS).length,
      possibleStagnation: summaries.filter((row) => row.possibleStagnation).length,
    },
    taskSummaries,
    hourlyTrend,
    dailyTrend,
    alerts,
  };
}

function operationalAlert(alertId, type, username, taskId, message, detectedAtMs, actions) {
  const action = actions.get(alertId);
  return {
    alertId,
    type,
    severity: type === "duplicate_assignment" ? "high" : "medium",
    status: action?.status ?? "open",
    username,
    taskId,
    message,
    detectedAtMs,
    updatedAtMs: action?.updatedAtMs ?? detectedAtMs,
    note: action?.note ?? "",
    updatedBy: action?.updatedBy ?? null,
  };
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
  const registrations = new Map();
  let stateMutationTail = Promise.resolve();

  async function writeState(state) {
    await writePrivateAtomic(statePath(dataRoot), state);
  }

  async function serializeStateMutation(operation) {
    const mutation = stateMutationTail.then(operation, operation);
    stateMutationTail = mutation.then(() => undefined, () => undefined);
    return mutation;
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

  function recordRegistrationAttempt(request) {
    const key = request.socket.remoteAddress ?? "unknown";
    const current = registrations.get(key);
    const windowEnd = current?.untilMs > nowMs() ? current.untilMs : nowMs() + 60 * 60_000;
    const count = current?.untilMs > nowMs() ? current.count + 1 : 1;
    registrations.set(key, { count, untilMs: windowEnd });
    return count <= 20;
  }

  async function handler(request, response) {
    try {
      const url = new URL(request.url, configuration.publicBaseUrl);
      if (request.method === "GET" && url.pathname === "/healthz") {
        const state = await readState(dataRoot);
        return sendJson(response, 200, {
          status: "ready",
          serviceId: state.serviceId,
          setupRequired: state.users.length === 0,
          capabilities: [
            STRUCTURED_ASSIGNMENTS_CAPABILITY,
            OPERATOR_SELF_REGISTRATION_CAPABILITY,
            OPERATOR_PROFILE_CAPABILITY,
            OPERATIONS_COCKPIT_CAPABILITY,
          ],
        });
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
        const body = await parseJsonBody(request);
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          if (state.users.length !== 0) return sendJson(response, 409, { error: "INITIAL_ADMIN_ALREADY_EXISTS" });
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
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
        if (!canAttempt(request)) return sendJson(response, 429, { error: "AUTH_RATE_LIMITED: 请稍后再试" });
        const body = await parseJsonBody(request);
        const username = normalizeUsername(body.username);
        const password = requirePassword(body.password);
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          const user = state.users.find((candidate) => candidate.username === username);
          if (!user || !passwordMatches(password, user.password)) {
            recordFailedAttempt(request);
            return sendJson(response, 401, { error: "AUTH_INVALID: 账号或密码错误" });
          }
          user.lastLoginAtMs = nowMs();
          await writeState(state);
          const token = randomBytes(32).toString("base64url");
          const identity = publicUser(user);
          sessions.set(token, { user: identity, expiresAtMs: nowMs() + configuration.sessionTtlSeconds * 1000 });
          return sendJson(response, 200, { token, user: identity, expiresAtMs: sessions.get(token).expiresAtMs });
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/auth/register") {
        if (!recordRegistrationAttempt(request)) {
          return sendJson(response, 429, { error: "REGISTRATION_RATE_LIMITED: 注册操作过于频繁，请稍后再试" });
        }
        const body = await parseJsonBody(request);
        if (body.role !== undefined) {
          return sendJson(response, 400, { error: "REGISTRATION_ROLE_FORBIDDEN: 自助注册只能创建标注员账号" });
        }
        const username = normalizeUsername(body.username);
        const displayName = normalizeDisplayName(body.displayName);
        const password = requirePassword(body.password);
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          if (state.users.length === 0) {
            return sendJson(response, 409, { error: "USER_CENTER_SETUP_REQUIRED: 请先由管理员初始化用户中心" });
          }
          if (state.users.length >= MAX_USERS) {
            return sendJson(response, 409, { error: "USER_LIMIT_EXCEEDED" });
          }
          if (state.users.some((candidate) => candidate.username === username)) {
            return sendJson(response, 409, { error: "ACCOUNT_EXISTS: 账号已存在" });
          }
          const user = {
            username,
            displayName,
            role: "operator",
            password: passwordRecord(password),
            createdAtMs: nowMs(),
            createdBy: "self-registration",
          };
          state.users.push(user);
          await writeState(state);
          const token = randomBytes(32).toString("base64url");
          const session = { user: publicUser(user), expiresAtMs: nowMs() + configuration.sessionTtlSeconds * 1000 };
          sessions.set(token, session);
          return sendJson(response, 201, { token, user: session.user, expiresAtMs: session.expiresAtMs });
        });
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/auth/profile") {
        const session = authorize(request);
        if (!session) return sendJson(response, 401, { error: "AUTH_REQUIRED" });
        if (session.user.role !== "operator") {
          return sendJson(response, 403, { error: "OPERATOR_REQUIRED: 只有标注员可以修改自己的显示名称" });
        }
        const body = await parseJsonBody(request);
        if (Object.keys(body).some((field) => field !== "displayName")) {
          return sendJson(response, 400, { error: "PROFILE_FIELD_FORBIDDEN: 只能修改当前账号的显示名称" });
        }
        const displayName = normalizeDisplayName(body.displayName);
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          const user = state.users.find((candidate) => candidate.username === session.user.username);
          if (!user) return sendJson(response, 404, { error: "ACCOUNT_NOT_FOUND" });
          if (user.role !== "operator") {
            return sendJson(response, 409, { error: "OPERATOR_REQUIRED: 只有标注员可以修改自己的显示名称" });
          }
          user.displayName = displayName;
          await writeState(state);
          const identity = publicUser(user);
          for (const activeSession of sessions.values()) {
            if (activeSession.user.username === user.username) activeSession.user = identity;
          }
          return sendJson(response, 200, { user: identity });
        });
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
      if (request.method === "GET" && url.pathname === "/api/v1/tasks/assigned") {
        const session = authorize(request);
        if (!session) return sendJson(response, 401, { error: "AUTH_REQUIRED" });
        const state = await readState(dataRoot);
        const user = state.users.find((candidate) => candidate.username === session.user.username);
        if (!user) return sendJson(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        const details = new Map((state.taskDetails ?? []).map((entry) => [entry.task.toLowerCase(), entry.detail]));
        const tasks = assignmentPlansFor(user).map((plan) => ({
          ...plan,
          detail: details.get(plan.task.toLowerCase()) ?? plan.task,
        }));
        return sendJson(response, 200, { tasks });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks/assigned/activity") {
        const session = authorize(request);
        if (!session) return sendJson(response, 401, { error: "AUTH_REQUIRED" });
        const range = requestedLocalDay(url.searchParams.get("date"));
        const events = (await readAuditEvents(dataRoot))
          .filter((event) => event.username === session.user.username
            && event.occurredAtMs >= range.startMs && event.occurredAtMs < range.endMs)
          .slice(-500).reverse();
        return sendJson(response, 200, { date: range.date, events });
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
        const operations = operationsSummary(events, state.users, state.alertActions ?? []);
        return sendJson(response, 200, {
          ...operations,
          events: events.slice(-500).reverse(),
          taskDetails: state.taskDetails ?? [],
          qualityReviews: (state.qualityReviews ?? []).slice(-1000).reverse(),
          generatedAtMs: nowMs(),
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
        const username = normalizeUsername(body.username);
        const displayName = normalizeDisplayName(body.displayName);
        const password = requirePassword(body.password);
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          if (state.users.length >= MAX_USERS) return sendJson(response, 409, { error: "USER_LIMIT_EXCEEDED" });
          if (state.users.some((candidate) => candidate.username === username)) {
            return sendJson(response, 409, { error: "ACCOUNT_EXISTS: 账号已存在" });
          }
          const user = {
            username,
            displayName,
            role: body.role === "admin" ? "admin" : "operator",
            password: passwordRecord(password),
            createdAtMs: nowMs(),
            createdBy: session.user.username,
          };
          state.users.push(user);
          await writeState(state);
          return sendJson(response, 201, { user: publicUser(user) });
        });
      }
      const assignmentMatch = /^\/api\/v1\/admin\/users\/([^/]+)\/assignment$/.exec(url.pathname);
      if (request.method === "PUT" && assignmentMatch) {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const username = normalizeUsername(decodeURIComponent(assignmentMatch[1]));
        const body = await parseJsonBody(request);
        const assignedTaskQuantities = {};
        const requestedPlans = Array.isArray(body.assignmentPlans)
          ? body.assignmentPlans.map((rawPlan, order) => {
            const plan = requirePlainObject(rawPlan, "assignment plan");
            const task = normalizeTaskDetailText(plan.task, "任务名称", 100);
            const quantity = Number(plan.quantity);
            const priority = String(plan.priority ?? "normal");
            const status = String(plan.status ?? "active");
            const deadlineAtMs = plan.deadlineAtMs == null ? null : Number(plan.deadlineAtMs);
            const normalized = { task, quantity, startIndex: 0, priority, deadlineAtMs, status, order };
            if (!isValidAssignmentPlan(normalized)) {
              throw new Error("ASSIGNED_TASKS_INVALID: 任务计划参数无效");
            }
            return normalized;
          })
          : Object.entries(body.assignedTaskQuantities ?? {}).map(([task, quantity], order) => ({
            task: normalizeTaskDetailText(task, "任务名称", 100),
            quantity: Number(quantity),
            startIndex: 0,
            priority: "normal",
            deadlineAtMs: null,
            status: "active",
            order,
          }));
        if (requestedPlans.length > MAX_TASK_DETAILS
          || new Set(requestedPlans.map((plan) => plan.task.toLowerCase())).size !== requestedPlans.length) {
          return sendJson(response, 400, { error: "ASSIGNED_TASKS_INVALID: 任务计划存在重复或超过上限" });
        }
        for (const plan of requestedPlans) {
          const task = normalizeTaskDetailText(plan.task, "任务名称", 100);
          const quantity = Number(plan.quantity);
          if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
            return sendJson(response, 400, { error: "ASSIGNED_TASKS_INVALID: 每项任务数量必须是正整数" });
          }
          assignedTaskQuantities[task] = quantity;
        }
        const assignedTaskNames = Object.keys(assignedTaskQuantities);
        const assignedTasks = assignedTaskNames.length
          ? Object.values(assignedTaskQuantities).reduce((sum, quantity) => sum + quantity, 0)
          : Number(body.assignedTasks ?? 0);
        if (!Number.isSafeInteger(assignedTasks) || assignedTasks < 0 || assignedTasks > 1_000_000
          || assignedTaskNames.length > MAX_TASK_DETAILS) {
          return sendJson(response, 400, { error: "ASSIGNED_TASKS_INVALID: 任务分配参数无效" });
        }
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          const assignedTaskStarts = {};
          for (const task of assignedTaskNames) {
            const occupied = state.users
              .filter((candidate) => candidate.username !== username)
              .flatMap((candidate) => assignmentPlansFor(candidate)
                .filter((candidatePlan) => candidatePlan.task.toLowerCase() === task.toLowerCase())
                .map((candidatePlan) => ({
                  start: candidatePlan.startIndex,
                  end: candidatePlan.startIndex + candidatePlan.quantity,
                })))
              .sort((left, right) => left.start - right.start);
            let start = 0;
            for (const interval of occupied) {
              if (start + assignedTaskQuantities[task] <= interval.start) break;
              start = Math.max(start, interval.end);
            }
            assignedTaskStarts[task] = start;
          }
          const user = state.users.find((candidate) => candidate.username === username);
          if (!user) return sendJson(response, 404, { error: "ACCOUNT_NOT_FOUND: 账号不存在" });
          if (user.role !== "operator") return sendJson(response, 409, { error: "OPERATOR_REQUIRED: 只能给普通账户分配任务" });
          user.assignedTasks = assignedTasks;
          user.assignedTaskNames = assignedTaskNames;
          user.assignedTaskQuantities = assignedTaskQuantities;
          user.assignedTaskStarts = assignedTaskStarts;
          user.assignmentPlans = requestedPlans.map((plan) => ({
            ...plan,
            startIndex: assignedTaskStarts[plan.task],
          }));
          user.assignmentUpdatedAtMs = nowMs();
          await writeState(state);
          return sendJson(response, 200, { user: publicUser(user) });
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/assignments/transfer") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const body = await parseJsonBody(request);
        const fromUsername = normalizeUsername(body.fromUsername);
        const toUsername = normalizeUsername(body.toUsername);
        const task = normalizeTaskDetailText(body.task, "任务名称", 100);
        if (fromUsername === toUsername) {
          return sendJson(response, 400, { error: "ASSIGNMENT_TRANSFER_INVALID: 转出与转入账号不能相同" });
        }
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          const source = state.users.find((candidate) => candidate.username === fromUsername);
          const target = state.users.find((candidate) => candidate.username === toUsername);
          if (!source || !target) return sendJson(response, 404, { error: "ACCOUNT_NOT_FOUND: 账号不存在" });
          if (source.role !== "operator" || target.role !== "operator") {
            return sendJson(response, 409, { error: "OPERATOR_REQUIRED: 任务只能在标注员之间转移" });
          }
          const sourcePlans = assignmentPlansFor(source);
          const sourcePlan = sourcePlans.find((plan) => plan.task.toLowerCase() === task.toLowerCase());
          if (!sourcePlan) return sendJson(response, 404, { error: "ASSIGNMENT_NOT_FOUND: 转出账号没有该任务" });
          const targetPlans = assignmentPlansFor(target);
          if (targetPlans.some((plan) => plan.task.toLowerCase() === task.toLowerCase())) {
            return sendJson(response, 409, { error: "ASSIGNMENT_TRANSFER_CONFLICT: 转入账号已经有该任务，请先调整现有数量" });
          }
          synchronizeAssignmentFields(source, sourcePlans.filter((plan) => plan !== sourcePlan));
          const transferred = {
            ...sourcePlan,
            startIndex: availableAssignmentStart(state.users, toUsername, sourcePlan.task, sourcePlan.quantity),
            order: targetPlans.length,
          };
          synchronizeAssignmentFields(target, [...targetPlans, transferred]);
          await writeState(state);
          return sendJson(response, 200, { source: publicUser(source), target: publicUser(target) });
        });
      }
      const alertMatch = /^\/api\/v1\/admin\/alerts\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PUT" && alertMatch) {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const alertId = normalizeTaskDetailText(decodeURIComponent(alertMatch[1]), "预警编号", 200);
        const body = await parseJsonBody(request);
        const status = String(body.status ?? "");
        const note = String(body.note ?? "").trim();
        if (!["open", "acknowledged", "closed"].includes(status)
          || [...note].length > 500 || containsSourceReference(note)
          || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note)) {
          return sendJson(response, 400, { error: "ALERT_ACTION_INVALID: 预警处理参数无效" });
        }
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          state.alertActions ??= [];
          const action = { alertId, status, note, updatedAtMs: nowMs(), updatedBy: session.user.username };
          const index = state.alertActions.findIndex((candidate) => candidate.alertId === alertId);
          if (index >= 0) state.alertActions[index] = action;
          else state.alertActions.push(action);
          if (state.alertActions.length > MAX_ALERT_ACTIONS) {
            return sendJson(response, 409, { error: "ALERT_ACTION_LIMIT_EXCEEDED" });
          }
          await writeState(state);
          return sendJson(response, 200, { action });
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/quality-reviews") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const body = await parseJsonBody(request);
        const taskId = normalizeTaskDetailText(body.taskId, "任务名称", 100);
        const trajectoryCode = normalizeTaskDetailText(body.trajectoryCode, "轨迹码", 100);
        const outcome = String(body.outcome ?? "");
        const errorType = String(body.errorType ?? "").trim();
        const note = String(body.note ?? "").trim();
        if (!["passed", "rework"].includes(outcome)
          || [...errorType].length > 100 || [...note].length > 1000
          || containsSourceReference(`${errorType}${note}`)
          || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(`${errorType}${note}`)) {
          return sendJson(response, 400, { error: "QUALITY_REVIEW_INVALID: 复核参数无效" });
        }
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          state.qualityReviews ??= [];
          if (state.qualityReviews.length >= MAX_QUALITY_REVIEWS) {
            return sendJson(response, 409, { error: "QUALITY_REVIEW_LIMIT_EXCEEDED" });
          }
          const review = {
            reviewId: randomUUID(), taskId, trajectoryCode, outcome, errorType, note,
            reviewer: session.user.username, reviewedAtMs: nowMs(),
          };
          state.qualityReviews.push(review);
          await writeState(state);
          return sendJson(response, 201, { review });
        });
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/admin/task-details") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const body = await parseJsonBody(request);
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          upsertTaskDetails(state, [{ task: body.task, detail: body.detail }], "admin", session.user.username);
          await writeState(state);
          return sendJson(response, 200, { taskDetails: state.taskDetails });
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/admin/task-details/import") {
        const session = authorize(request, true);
        if (!session) return sendJson(response, 403, { error: "ADMIN_REQUIRED" });
        const body = await parseJsonBody(request);
        if (!Array.isArray(body.tasks) || !body.tasks.length || body.tasks.length > MAX_TASK_DETAILS) {
          return sendJson(response, 400, { error: "TASK_DETAIL_IMPORT_INVALID: 导入内容无效" });
        }
        return await serializeStateMutation(async () => {
          const state = await readState(dataRoot);
          upsertTaskDetails(state, body.tasks, "imported", session.user.username);
          await writeState(state);
          return sendJson(response, 200, { taskDetails: state.taskDetails });
        });
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
