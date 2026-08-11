import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import packageInfo from "../../package.json";
import {
  createDemoSkeleton,
  createDemoStates,
  demoEpisodeSummary,
  demoFrameUrl,
  DEMO_EPISODE_ROOT,
  loadDemoFixture,
  type DemoFixture,
} from "./demoFixture";
import type {
  AnnotatedEpisodeSummary,
  AppUpdateInfo,
  AuthStatus,
  BatchExportResult,
  CreateTaskRequest,
  EpisodeAnnotation,
  EpisodeData,
  EpisodeValidationResult,
  ExportFormat,
  ExportRange,
  ExportResult,
  ImportPreflight,
  ImportResult,
  PartialImport,
  OperationErrorRecord,
  RecordOperationErrorRequest,
  ReportExportResult,
  SaveAnnotationRequest,
  ScanResult,
  TaskProgress,
  TaskDefinition,
  UserIdentity,
  ValidationReport,
  UserCenterStatus,
  WorkspaceMode,
} from "../types";

export const DEMO_ROOT = DEMO_EPISODE_ROOT;
export const APP_VERSION = packageInfo.version;

const SESSION_ACTIVATION_DEMO_SOURCE_ROOT = "demo://session-activation";
const SESSION_ACTIVATION_DEMO_EPISODES = [
  { root: `${SESSION_ACTIVATION_DEMO_SOURCE_ROOT}/session-a`, name: "session-a" },
  { root: `${SESSION_ACTIVATION_DEMO_SOURCE_ROOT}/session-b`, name: "session-b" },
  { root: `${SESSION_ACTIVATION_DEMO_SOURCE_ROOT}/session-c`, name: "session-c" },
] as const;

const demoAccounts = new Map<string, { displayName: string; password: string }>();
const demoAnnotations = new Map<string, EpisodeAnnotation>();
const demoTrajectoryReservations = new Map<string, string>();
const demoTaskDefinitions: TaskDefinition[] = [
  {
    id: "close_oven",
    label: "关闭烤箱",
    codePrefix: "oven",
    defaultDescription: "关闭烤箱门，并确认烤箱门完全闭合。",
    descriptionOptions: ["关闭烤箱门，并确认烤箱门完全闭合。"],
    defaultSegments: [],
  },
];
let demoCurrentUser: UserIdentity | null = null;
let demoWorkspaceMode: WorkspaceMode | null = null;
let sessionActivationRetryAttempts = 0;
const DEMO_OFFLINE_IDENTITY: UserIdentity = { username: "offline", displayName: "离线本机" };

export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  if (isTauriRuntime()) return invoke<AppUpdateInfo>("check_for_app_update");
  return {
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    available: false,
    notes: null,
    publishedAt: null,
  };
}

export async function installAppUpdate(operationId: number): Promise<boolean> {
  if (isTauriRuntime()) return invoke<boolean>("install_app_update", { operationId });
  return false;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  if (isTauriRuntime()) return invoke<AuthStatus>("get_auth_status");
  return {
    workspaceMode: demoWorkspaceMode,
    userCenter: { configured: true, endpoint: "demo://user-center", serviceId: "demo-user-center" },
    currentUser: demoCurrentUser,
  };
}

export async function selectWorkspaceMode(mode: WorkspaceMode): Promise<AuthStatus> {
  if (isTauriRuntime()) return invoke<AuthStatus>("select_workspace_mode", { mode });
  demoWorkspaceMode = mode;
  demoCurrentUser = null;
  return getAuthStatus();
}

export async function clearWorkspaceMode(): Promise<AuthStatus> {
  if (isTauriRuntime()) return invoke<AuthStatus>("clear_workspace_mode");
  demoWorkspaceMode = null;
  demoCurrentUser = null;
  return getAuthStatus();
}

export async function configureUserCenter(): Promise<UserCenterStatus> {
  if (isTauriRuntime()) {
    const selection = await open({
      directory: false,
      multiple: false,
      title: "导入管理员提供的用户中心配置",
      filters: [{ name: "DOHC User Center", extensions: ["json"] }],
    });
    if (typeof selection !== "string") throw new Error("未选择用户中心配置文件");
    return invoke<UserCenterStatus>("configure_user_center", { configPath: selection });
  }
  return { configured: true, endpoint: "demo://user-center", serviceId: "demo-user-center" };
}

export async function registerLocalAccount(
  username: string,
  displayName: string,
  password: string,
): Promise<UserIdentity> {
  if (isTauriRuntime()) {
    throw new Error("ACCOUNT_ADMIN_MANAGED: 账号只能由用户中心管理员创建");
  }
  requireDemoManagedMode();
  const normalized = username.trim().toLowerCase();
  if (demoAccounts.has(normalized)) throw new Error("ACCOUNT_EXISTS: 本地账号已存在");
  demoAccounts.set(normalized, { displayName: displayName.trim(), password });
  demoCurrentUser = { username: normalized, displayName: displayName.trim() };
  return demoCurrentUser;
}

export async function loginLocalAccount(
  username: string,
  password: string,
): Promise<UserIdentity> {
  if (isTauriRuntime()) {
    return invoke<UserIdentity>("login_account", { request: { username, password } });
  }
  requireDemoManagedMode();
  const normalized = username.trim().toLowerCase();
  const account = demoAccounts.get(normalized);
  if (!account || account.password !== password) throw new Error("AUTH_INVALID: 账号或密码错误");
  demoCurrentUser = { username: normalized, displayName: account.displayName };
  return demoCurrentUser;
}

export async function logoutLocalAccount(): Promise<void> {
  if (isTauriRuntime()) await invoke("logout_account");
  demoCurrentUser = null;
}

export async function listTaskDefinitions(): Promise<TaskDefinition[]> {
  if (isTauriRuntime()) return invoke<TaskDefinition[]>("list_task_definitions");
  return demoTaskDefinitions.map((task) => ({ ...task }));
}

export async function createTaskDefinition(request: CreateTaskRequest): Promise<TaskDefinition> {
  if (isTauriRuntime()) {
    return invoke<TaskDefinition>("create_task_definition", { request });
  }
  demoActor();
  const label = normalizeTaskLabel(request.label);
  const codePrefix = taskCodePrefix(label);
  if (demoTaskDefinitions.some((task) => (
    task.id === codePrefix
    || task.codePrefix === codePrefix
    || task.label.toLowerCase() === label.toLowerCase()
  ))) {
    throw new Error(`TASK_EXISTS: 任务名称或自动编码 ${codePrefix} 已存在`);
  }
  const task: TaskDefinition = {
    id: codePrefix,
    label,
    codePrefix,
    defaultDescription: label,
    descriptionOptions: [label],
    defaultSegments: [],
  };
  demoTaskDefinitions.push(task);
  return { ...task };
}

export async function importTaskTemplateConfig(): Promise<TaskDefinition[]> {
  if (isTauriRuntime()) {
    const selection = await open({
      directory: false,
      multiple: false,
      title: "导入任务模板配置",
      filters: [{ name: "DOHC Task Templates", extensions: ["json"] }],
    });
    if (typeof selection !== "string") throw new Error("未选择任务模板配置文件");
    return invoke<TaskDefinition[]>("import_task_template_config", { configPath: selection });
  }
  demoActor();
  const file = await chooseDemoTaskTemplateFile();
  if (file.size > 256 * 1024) {
    throw new Error("TASK_TEMPLATE_CONFIG_INVALID: 任务模板配置文件无效");
  }
  const templates = parseDemoTaskTemplateConfig(await file.text());
  const existingIds = new Set(demoTaskDefinitions.map((task) => task.id));
  const existingPrefixes = new Set(demoTaskDefinitions.map((task) => task.codePrefix));
  for (const task of templates) {
    if (existingIds.has(task.id) || existingPrefixes.has(task.codePrefix)) {
      throw new Error(`TASK_EXISTS: 任务名称或自动编码 ${task.codePrefix} 已存在`);
    }
  }
  demoTaskDefinitions.push(...templates);
  return listTaskDefinitions();
}

export async function deleteTaskDefinition(taskId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_task_definition", { taskId });
    return;
  }
  demoActor();
  const index = demoTaskDefinitions.findIndex((task) => task.id === taskId);
  if (index < 0) throw new Error(`UNKNOWN_TASK: 不支持的任务 ${taskId}`);
  if (demoTaskDefinitions[index].id === "close_oven") {
    throw new Error("TASK_BUILT_IN: 内置任务不能删除");
  }
  if ([...demoAnnotations.values()].some((annotation) => annotation.taskId === taskId)) {
    throw new Error("TASK_IN_USE: 任务已被标注引用，不能删除");
  }
  demoTaskDefinitions.splice(index, 1);
}

export async function suggestTrajectoryCode(taskId: string): Promise<string> {
  if (isTauriRuntime()) return invoke<string>("suggest_trajectory_code", { taskId });
  demoActor();
  const task = (await listTaskDefinitions()).find((item) => item.id === taskId);
  if (!task) throw new Error(`UNKNOWN_TASK: 不支持的任务 ${taskId}`);
  const used = [...demoTrajectoryReservations.values()]
    .filter((code) => code.startsWith(`${task.codePrefix}-`))
    .map((code) => Number(code.slice(task.codePrefix.length + 1)))
    .filter(Number.isFinite);
  const next = Math.max(0, ...used) + 1;
  return `${task.codePrefix}-${String(next).padStart(3, "0")}`;
}

export async function loadEpisodeAnnotation(sourcePath: string): Promise<EpisodeAnnotation | null> {
  if (isTauriRuntime()) {
    return invoke<EpisodeAnnotation | null>("load_episode_annotation", { sourcePath });
  }
  return demoAnnotations.get(sourcePath) ?? null;
}

export async function saveEpisodeAnnotation(
  request: SaveAnnotationRequest,
): Promise<EpisodeAnnotation> {
  if (isTauriRuntime()) {
    return invoke<EpisodeAnnotation>("save_episode_annotation", { request });
  }
  const actor = demoActor();
  const existing = demoAnnotations.get(request.sourcePath);
  const task = demoTaskDefinitions.find((item) => item.id === request.taskId);
  if (!task) throw new Error(`UNKNOWN_TASK: 不支持的任务 ${request.taskId}`);
  const reservationKey = `${request.sourcePath}\0${request.taskId}`;
  const trajectoryCode = demoTrajectoryReservations.get(reservationKey)
    ?? (existing?.taskId === request.taskId
      ? existing.trajectoryCode
      : await suggestTrajectoryCode(request.taskId));
  demoTrajectoryReservations.set(reservationKey, trajectoryCode);
  const now = Date.now();
  const annotation: EpisodeAnnotation = {
    formatVersion: 3,
    episodeId: `demo-${request.sourcePath}`,
    episodeRoot: request.sourcePath,
    episodeFingerprint: "f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727",
    trajectoryCode,
    taskId: request.taskId,
    taskDescription: request.taskDescription.trim(),
    processedBy: actor,
    revision: (existing?.revision ?? 0) + 1,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    editStartedAtMs: request.editStartedAtMs,
    editDurationMs: Math.max(0, now - request.editStartedAtMs),
    clipStartFrame: request.clipStartFrame,
    clipEndFrame: request.clipEndFrame,
    segments: request.segments.map((segment) => ({ ...segment })),
  };
  demoAnnotations.set(request.sourcePath, annotation);
  return annotation;
}

export async function listAnnotatedEpisodes(): Promise<AnnotatedEpisodeSummary[]> {
  if (isTauriRuntime()) {
    return invoke<AnnotatedEpisodeSummary[]>("list_annotated_episodes");
  }
  return [...demoAnnotations.values()]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .map((annotation) => ({ annotation: { ...annotation }, sourceAvailable: true }));
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function chooseDirectory(title: string): Promise<string | null> {
  if (!isTauriRuntime()) return DEMO_ROOT;
  const selection = await open({ directory: true, multiple: false, title });
  return typeof selection === "string" ? selection : null;
}

export async function confirmAction(message: string, title: string): Promise<boolean> {
  if (!isTauriRuntime()) return window.confirm(message);
  return confirm(message, {
    title,
    kind: "warning",
    okLabel: "确认",
    cancelLabel: "取消",
  });
}

export async function revealOutput(path: string): Promise<void> {
  if (isTauriRuntime()) await revealItemInDir(path);
}

export async function scanSource(path: string, operationId: number): Promise<ScanResult> {
  if (isTauriRuntime()) return invoke<ScanResult>("scan_source", { path, operationId });
  if (isSessionActivationDemoScenario()) {
    sessionActivationRetryAttempts = 0;
    return buildSessionActivationDemoScan(await loadDemoFixture());
  }
  const episode = demoEpisodeSummary(path, await loadDemoFixture());
  return {
    sourceRoot: path,
    episodes: [episode],
    totalFiles: episode.totalFiles,
    totalBytes: episode.totalBytes,
    volume: {
      root: path,
      filesystem: "exFAT",
      driveType: "removable",
      totalBytes: 256_000_000_000,
      availableBytes: 174_000_000_000,
    },
  };
}

export async function inspectImportDestination(
  sourcePath: string,
  destinationParent: string,
  operationId: number,
): Promise<ImportPreflight> {
  if (!isTauriRuntime()) {
    return {
      canImport: true,
      sourceBytes: 80_531_730,
      requiredBytes: 81_580_306,
      largestFileBytes: 1_024_000,
      volume: {
        root: destinationParent,
        filesystem: "NTFS",
        driveType: "fixed",
        totalBytes: 1_000_000_000_000,
        availableBytes: 600_000_000_000,
      },
      issues: [],
      partials: [],
    };
  }
  return invoke<ImportPreflight>("inspect_import_destination", {
    sourcePath,
    destinationParent,
    operationId,
  });
}

export async function listPartialImports(destinationParent: string): Promise<PartialImport[]> {
  if (!isTauriRuntime()) return [];
  return invoke<PartialImport[]>("list_partial_imports", { destinationParent });
}

export async function cleanupPartialImport(
  destinationParent: string,
  partialPath: string,
  operationId: number,
): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("cleanup_partial_import", { destinationParent, partialPath, operationId });
}

export async function importEpisode(
  sourcePath: string,
  destinationParent: string,
  operationId: number,
): Promise<ImportResult> {
  if (!isTauriRuntime()) {
    return {
      destination: sourcePath,
      totalFiles: 981,
      totalBytes: 80_531_730,
      datasetBlake3: "f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727",
      elapsedMs: 4380,
      validationReport: (await validateEpisode(sourcePath, operationId)).report,
    };
  }
  return invoke<ImportResult>("import_episode", { sourcePath, destinationParent, operationId });
}

export async function prepareImportWorkspace(sourcePath: string): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("prepare_import_workspace", { sourcePath });
  }
  return `${sourcePath}/.dohc-viewer-imports`;
}

const DEMO_OPERATION_ERRORS = "dohc-viewer:demo-operation-errors";

export async function recordOperationError(
  request: RecordOperationErrorRequest,
): Promise<OperationErrorRecord> {
  if (isTauriRuntime()) {
    return invoke<OperationErrorRecord>("record_operation_error", { request });
  }
  const now = Date.now();
  const record: OperationErrorRecord = {
    formatVersion: 1,
    id: `demo-${now}-${Math.random().toString(16).slice(2)}`,
    occurredAtMs: now,
    operation: request.operation,
    code: classifyDemoError(request.message),
    message: request.message,
    sourcePath: request.sourcePath,
    processedBy: demoActor(),
  };
  const records = await listOperationErrors();
  window.localStorage.setItem(DEMO_OPERATION_ERRORS, JSON.stringify([record, ...records].slice(0, 200)));
  return record;
}

export async function listOperationErrors(): Promise<OperationErrorRecord[]> {
  if (isTauriRuntime()) {
    return invoke<OperationErrorRecord[]>("list_operation_errors");
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DEMO_OPERATION_ERRORS) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed as OperationErrorRecord[] : [];
  } catch {
    return [];
  }
}

function classifyDemoError(message: string): string {
  const normalized = message.toLowerCase();
  if (message.includes("DEMO_FIXTURE_UNAVAILABLE")) return "DEMO_FIXTURE_UNAVAILABLE";
  return normalized.includes("operation not allowed")
    || normalized.includes("operation not permitted")
    || normalized.includes("permission denied")
    ? "PERMISSION_DENIED"
    : "OPERATION_FAILED";
}

function requireDemoManagedMode(): void {
  if (demoWorkspaceMode === "managed") return;
  if (demoWorkspaceMode === "offline") {
    throw new Error("MANAGED_MODE_REQUIRED: 当前为离线模式，不能使用账号");
  }
  throw new Error("WORKSPACE_MODE_REQUIRED: 请选择统一管理模式或离线模式");
}

function demoActor(): UserIdentity {
  if (demoWorkspaceMode === "offline") return DEMO_OFFLINE_IDENTITY;
  if (demoWorkspaceMode === "managed" && demoCurrentUser) return demoCurrentUser;
  throw new Error("AUTH_REQUIRED: 请先选择工作模式并登录用户中心账号");
}

function normalizeTaskLabel(value: string): string {
  if (/\p{Cc}/u.test(value)) {
    throw new Error("INVALID_TASK_NAME: 任务名称不能包含控制字符");
  }
  const label = value.trim().split(/\s+/u).filter(Boolean).join(" ");
  const length = Array.from(label).length;
  if (length < 1 || length > 64) {
    throw new Error("INVALID_TASK_NAME: 任务名称需为 1-64 个字符");
  }
  return label;
}

function taskCodePrefix(label: string): string {
  let prefix = "";
  let separatorPending = false;
  for (const character of label) {
    if (/^[\p{L}\p{N}]$/u.test(character)) {
      if (separatorPending && prefix) prefix += "-";
      prefix += character.toLowerCase();
      separatorPending = false;
    } else {
      separatorPending = true;
    }
  }
  prefix = Array.from(prefix).slice(0, 48).join("").replace(/^-+|-+$/gu, "");
  if (!prefix) throw new Error("INVALID_TASK_NAME: 任务名称必须包含文字或数字");
  return prefix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDemoDescription(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`TASK_TEMPLATE_CONFIG_INVALID: ${field} 必须是文本`);
  }
  const description = value.trim();
  const length = Array.from(description).length;
  if (length < 1 || length > 500 || /\p{Cc}/u.test(description.replace(/[\n\r\t]/gu, ""))) {
    throw new Error(`TASK_TEMPLATE_CONFIG_INVALID: ${field} 需为 1-500 个不含控制字符的文本`);
  }
  return description;
}

function appendDemoDescription(options: string[], value: unknown, field: string): void {
  const description = validateDemoDescription(value, field);
  if (!options.includes(description)) options.push(description);
}

function parseDemoTaskTemplateConfig(contents: string): TaskDefinition[] {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("TASK_TEMPLATE_CONFIG_INVALID: 任务模板配置不是有效 JSON");
  }
  if (!isRecord(value) || value.formatVersion !== 1 || !Array.isArray(value.tasks)
    || value.tasks.length < 1 || value.tasks.length > 500) {
    throw new Error("TASK_TEMPLATE_CONFIG_INVALID: 任务模板配置格式无效");
  }

  const ids = new Set<string>();
  const prefixes = new Set<string>();
  return value.tasks.map((rawTask, index) => {
    if (!isRecord(rawTask)) {
      throw new Error(`TASK_TEMPLATE_CONFIG_INVALID: tasks[${index}] 必须是对象`);
    }
    if (typeof rawTask.label !== "string") {
      throw new Error(`TASK_TEMPLATE_CONFIG_INVALID: tasks[${index}].label 必须是文本`);
    }
    const label = normalizeTaskLabel(rawTask.label);
    const codePrefix = taskCodePrefix(label);
    if (ids.has(codePrefix) || prefixes.has(codePrefix)) {
      throw new Error(`TASK_EXISTS: 任务名称或自动编码 ${codePrefix} 已存在`);
    }
    ids.add(codePrefix);
    prefixes.add(codePrefix);

    const descriptions: string[] = [];
    if (rawTask.description !== undefined && rawTask.description !== null) {
      appendDemoDescription(descriptions, rawTask.description, `tasks[${index}].description`);
    }
    if (rawTask.descriptions !== undefined) {
      if (!Array.isArray(rawTask.descriptions)) {
        throw new Error(`TASK_TEMPLATE_CONFIG_INVALID: tasks[${index}].descriptions 必须是数组`);
      }
      rawTask.descriptions.forEach((description, descriptionIndex) => {
        appendDemoDescription(descriptions, description, `tasks[${index}].descriptions[${descriptionIndex}]`);
      });
    }
    if (!descriptions.length) {
      throw new Error("TASK_TEMPLATE_DESCRIPTION_REQUIRED: 每个任务模板至少需要一个 description 或 descriptions 条目");
    }

    const rawSegments = rawTask.segments === undefined ? [] : rawTask.segments;
    if (!Array.isArray(rawSegments) || rawSegments.length > 100) {
      throw new Error(`TASK_TEMPLATE_CONFIG_INVALID: tasks[${index}].segments 无效`);
    }
    const defaultSegments = rawSegments.map((segment, segmentIndex) => {
      const title = validateDemoDescription(segment, `tasks[${index}].segments[${segmentIndex}]`);
      if (Array.from(title).length > 100 || title.includes("\n") || title.includes("\r")) {
        throw new Error("TASK_TEMPLATE_SEGMENT_INVALID: 默认片段名称需为 1-100 个单行字符");
      }
      return title;
    });
    return {
      id: codePrefix,
      label,
      codePrefix,
      defaultDescription: descriptions[0],
      descriptionOptions: descriptions,
      defaultSegments,
    };
  });
}

function chooseDemoTaskTemplateFile(): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    document.body.append(input);
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      if (file) resolve(file);
      else reject(new Error("未选择任务模板配置文件"));
    };
    input.addEventListener("change", () => finish(input.files?.item(0) ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.click();
  });
}

export async function loadEpisode(path: string, operationId: number): Promise<EpisodeData> {
  if (isTauriRuntime()) return invoke<EpisodeData>("load_episode", { path, operationId });
  const fixture = await loadDemoFixture();
  const sessionActivationEpisode = sessionActivationDemoEpisode(path);
  if (sessionActivationEpisode) {
    if (path.endsWith("/session-c")) {
      sessionActivationRetryAttempts += 1;
      await delay(180);
      throw new Error(`DEMO_RETRY_FAILURE_${sessionActivationRetryAttempts}`);
    }
    if (path.endsWith("/session-b")) await delay(180);
    return {
      summary: sessionActivationDemoSummary(sessionActivationEpisode, fixture),
      states: createDemoStates(fixture),
      skeleton: createDemoSkeleton(fixture),
      skeletonError: null,
    };
  }
  return {
    summary: demoEpisodeSummary(path, fixture),
    states: createDemoStates(fixture),
    skeleton: createDemoSkeleton(fixture),
    skeletonError: null,
  };
}

export async function validateEpisode(path: string, operationId: number): Promise<EpisodeValidationResult> {
  if (isTauriRuntime()) return invoke<EpisodeValidationResult>("validate_episode", { path, operationId });
  const fixture = await loadDemoFixture();
  const sessionActivationEpisode = sessionActivationDemoEpisode(path);
  const report: ValidationReport = {
    formatVersion: 6,
    episodeRoot: path,
    parsedStateCount: 196,
    imageValidationMode: "sampled",
    imageSamplePercentages: [1, 25, 50, 73, 99],
    stateFrameRate: {
      expectedFps: 30,
      measuredFps: 29.5,
      tolerancePercent: 5,
      intervalCount: 195,
      stabilityPercent: 91.8,
      stable: true,
    },
    autoReportPath: "/DOHC Viewer/reports/2026-07-13_07-34-12.health.json",
    status: "warning",
    checkedFiles: 26,
    elapsedMs: 214,
    issues: [
      {
        severity: "warning",
        code: "TIMESTAMP_GAP",
        scope: "states",
        message: "末尾状态帧检测到明显的时间戳间隔异常",
        frameId: 180,
      },
    ],
    streams: ["cam0", "cam1", "cam2", "t265_left", "t265_right"].map((name) => ({
      name,
      checkedFrames: 5,
      decodeFailures: 0,
      status: "ok" as const,
    })),
  };
  return {
    report,
    summary: sessionActivationEpisode
      ? sessionActivationDemoSummary(sessionActivationEpisode, fixture)
      : demoEpisodeSummary(path, fixture),
  };
}

export async function exportValidationReport(
  sourcePath: string,
  destinationParent: string,
  operationId: number,
): Promise<ReportExportResult> {
  if (isTauriRuntime()) {
    return invoke<ReportExportResult>("export_validation_report", {
      sourcePath,
      destinationParent,
      operationId,
    });
  }
  return {
    outputPath: `${destinationParent}/2026-07-13_07-34-12.health.json`,
    totalBytes: 4_096,
    elapsedMs: 12,
  };
}

export async function exportEpisode(
  sourcePath: string,
  destinationParent: string,
  format: ExportFormat,
  acknowledgeWarnings: boolean,
  range: ExportRange,
  operationId: number,
): Promise<ExportResult> {
  if (isTauriRuntime()) {
    return invoke<ExportResult>("export_episode", {
      request: {
        sourcePath,
        destinationParent,
        format,
        acknowledgeWarnings,
        range,
      },
      operationId,
    });
  }
  const annotation = demoAnnotations.get(sourcePath);
  const baseName = annotation?.trajectoryCode ?? "2026-07-13_07-34-12";
  const names: Record<ExportFormat, string> = {
    mcap: `${baseName}${demoRangeSuffix(range)}.mcap`,
    hdf5: `${baseName}${demoRangeSuffix(range)}.h5`,
    lerobot_v2: `${baseName}${demoRangeSuffix(range)}_lerobot_v2`,
  };
  const outputPath = `${destinationParent}/${names[format]}`;
  return {
    format,
    outputPath,
    metadataPath: annotation
      ? format === "lerobot_v2"
        ? `${outputPath}/metadata.json`
        : `${destinationParent}/${names[format].replace(/\.[^.]+$/, "")}.metadata.json`
      : null,
    trajectoryCode: annotation?.trajectoryCode ?? null,
    totalFiles: format === "lerobot_v2" ? (annotation ? 13 : 12) : (annotation ? 2 : 1),
    totalBytes: format === "mcap" ? 80_780_000 : format === "hdf5" ? 80_650_000 : 49_300_000,
    elapsedMs: format === "lerobot_v2" ? 18_400 : 3_200,
    range,
    stateCount: range.endFrame - range.startFrame + 1,
  };
}

export async function exportAnnotatedEpisodes(
  episodeIds: string[],
  destinationParent: string,
  format: ExportFormat,
  acknowledgeWarnings: boolean,
  operationId: number,
): Promise<BatchExportResult> {
  if (isTauriRuntime()) {
    return invoke<BatchExportResult>("export_annotated_episodes", {
      request: {
        episodeIds,
        destinationParent,
        format,
        acknowledgeWarnings,
      },
      operationId,
    });
  }

  const started = performance.now();
  const items: BatchExportResult["items"] = [];
  for (const episodeId of episodeIds) {
    const annotation = [...demoAnnotations.values()]
      .find((candidate) => candidate.episodeId === episodeId);
    if (!annotation) {
      items.push({
        episodeId,
        trajectoryCode: episodeId,
        sourcePath: "",
        status: "failed",
        validationStatus: null,
        result: null,
        error: `ANNOTATION_NOT_FOUND: 找不到本地标注 ${episodeId}`,
        errorLogPath: null,
      });
      continue;
    }
    if (!acknowledgeWarnings) {
      items.push({
        episodeId,
        trajectoryCode: annotation.trajectoryCode,
        sourcePath: annotation.episodeRoot,
        status: "failed",
        validationStatus: "warning",
        result: null,
        error: "EXPORT_WARNING_CONFIRMATION_REQUIRED: 请确认数据警告后再导出",
        errorLogPath: null,
      });
      continue;
    }
    const result = await exportEpisode(
      annotation.episodeRoot,
      destinationParent,
      format,
      true,
      { startFrame: 0, endFrame: 195 },
      operationId,
    );
    items.push({
      episodeId,
      trajectoryCode: annotation.trajectoryCode,
      sourcePath: annotation.episodeRoot,
      status: "exported",
      validationStatus: "warning",
      result,
      error: null,
      errorLogPath: null,
    });
  }
  const exported = items.filter((item) => item.result !== null);
  return {
    format,
    destinationParent,
    requestedCount: episodeIds.length,
    exportedCount: exported.length,
    failedCount: items.length - exported.length,
    cancelled: false,
    totalFiles: exported.reduce((total, item) => total + (item.result?.totalFiles ?? 0), 0),
    totalBytes: exported.reduce((total, item) => total + (item.result?.totalBytes ?? 0), 0),
    elapsedMs: Math.round(performance.now() - started),
    items,
  };
}

function demoRangeSuffix(range: ExportRange): string {
  return range.startFrame === 0 && range.endFrame === 195
    ? ""
    : `_frames_${range.startFrame}-${range.endFrame}`;
}

export async function frameUrl(root: string, stream: string, frameId: number): Promise<string> {
  if (!isTauriRuntime()) {
    return demoFrameUrl(stream, frameId);
  }
  const payload = await invoke<{ mimeType: string; data: string }>("read_frame", {
    root,
    stream,
    frameId,
  });
  return `data:${payload.mimeType};base64,${payload.data}`;
}

export async function cancelTask(operationId: number): Promise<boolean> {
  if (isTauriRuntime()) return invoke<boolean>("cancel_task", { operationId });
  return false;
}

export async function onTaskProgress(
  callback: (progress: TaskProgress) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => undefined;
  return listen<TaskProgress>("task-progress", (event) => callback(event.payload));
}

function isSessionActivationDemoScenario(): boolean {
  return !isTauriRuntime()
    && new URLSearchParams(window.location.search).get("demoScenario") === "session-activation";
}

function sessionActivationDemoEpisode(root: string) {
  return SESSION_ACTIVATION_DEMO_EPISODES.find((episode) => episode.root === root);
}

function buildSessionActivationDemoScan(fixture: DemoFixture): ScanResult {
  const episodes = SESSION_ACTIVATION_DEMO_EPISODES.map((episode) => (
    sessionActivationDemoSummary(episode, fixture)
  ));
  const totalFiles = episodes.reduce((total, episode) => total + episode.totalFiles, 0);
  const totalBytes = episodes.reduce((total, episode) => total + episode.totalBytes, 0);
  return {
    sourceRoot: SESSION_ACTIVATION_DEMO_SOURCE_ROOT,
    episodes,
    totalFiles,
    totalBytes,
    volume: {
      root: SESSION_ACTIVATION_DEMO_SOURCE_ROOT,
      filesystem: "memory",
      driveType: "ramdisk",
      totalBytes: 1_000_000,
      availableBytes: 800_000,
    },
  };
}

function sessionActivationDemoSummary(
  episode: (typeof SESSION_ACTIVATION_DEMO_EPISODES)[number],
  fixture: DemoFixture,
) {
  return {
    ...demoEpisodeSummary(episode.root, fixture),
    name: episode.name,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
