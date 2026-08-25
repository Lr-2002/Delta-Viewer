import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
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
  AssignedTask,
  AssignedTaskActivity,
  AssignmentPlan,
  AssignmentTransferResult,
  AnnotationAuditRequest,
  AppUpdateInfo,
  AuthStatus,
  BatchAccountInput,
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
  OperationsAlertStatus,
  QualityReview,
  QualityReviewRequest,
  SaveAnnotationRequest,
  ScanResult,
  VideoSource,
  SupervisionDashboardData,
  SupervisionReportExportResult,
  SupervisionReportFormat,
  SupervisionReportKind,
  SupervisionAccount,
  SupervisionAnnotationCatalog,
  SupervisionTaskCatalog,
  SupervisionTaskDetail,
  SupervisionTaskImportResult,
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
let demoOperationsData: SupervisionDashboardData | null = null;
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
  if (isOperationsCockpitDemoScenario()) {
    demoWorkspaceMode = "managed";
    demoCurrentUser = { username: "demo-admin", displayName: "演示管理员", role: "admin" };
  }
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
    return invoke<UserIdentity>("register_account", {
      request: { username, displayName, password },
    });
  }
  requireDemoManagedMode();
  const normalized = username.trim().toLowerCase();
  if (demoAccounts.has(normalized)) throw new Error("ACCOUNT_EXISTS: 本地账号已存在");
  demoAccounts.set(normalized, { displayName: displayName.trim(), password });
  demoCurrentUser = { username: normalized, displayName: displayName.trim(), role: "operator" };
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
  demoCurrentUser = { username: normalized, displayName: account.displayName, role: "operator" };
  return demoCurrentUser;
}

export async function updateCurrentDisplayName(displayName: string): Promise<UserIdentity> {
  if (isTauriRuntime()) {
    return invoke<UserIdentity>("update_current_display_name", {
      request: { displayName },
    });
  }
  requireDemoManagedMode();
  if (!demoCurrentUser || demoCurrentUser.role !== "operator") {
    throw new Error("OPERATOR_REQUIRED: 只有标注员可以修改自己的显示名称");
  }
  const normalized = displayName.trim();
  if (!normalized || [...normalized].length > 40 || /[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error("DISPLAY_NAME_INVALID: 显示名称必须为 1 至 40 个可见字符");
  }
  const account = demoAccounts.get(demoCurrentUser.username);
  if (account) account.displayName = normalized;
  demoCurrentUser = { ...demoCurrentUser, displayName: normalized };
  return demoCurrentUser;
}

export async function getSupervisionDashboard(): Promise<SupervisionDashboardData> {
  if (isTauriRuntime()) return invoke<SupervisionDashboardData>("get_supervision_dashboard");
  if (isOperationsCockpitDemoScenario()) return structuredClone(demoOperationsData ??= createDemoOperationsDashboard());
  throw new Error("SUPERVISOR_REQUIRED: 演示模式没有监管账户");
}

export async function batchCreateSupervisionAccounts(accounts: BatchAccountInput[]): Promise<SupervisionAccount[]> {
  if (isTauriRuntime()) return invoke<SupervisionAccount[]>("batch_create_supervision_accounts", { accounts });
  throw new Error("SUPERVISOR_REQUIRED: 批量账号只能在桌面监管端创建");
}

export async function setSupervisionAccountStatus(usernames: string[], status: "active" | "paused"): Promise<SupervisionAccount[]> {
  if (isTauriRuntime()) return invoke<SupervisionAccount[]>("set_supervision_account_status", { usernames, status });
  if (isOperationsCockpitDemoScenario()) {
    const dashboard = demoOperationsData ??= createDemoOperationsDashboard();
    const selected = dashboard.accounts.filter((account) => usernames.includes(account.username));
    selected.forEach((account) => { account.accountStatus = status; });
    dashboard.users.filter((user) => usernames.includes(user.username)).forEach((user) => { user.accountStatus = status; });
    return structuredClone(selected);
  }
  throw new Error("SUPERVISOR_REQUIRED: 演示模式没有监管账户");
}

export async function setSupervisionAssignedTasks(
  username: string,
  assignedTaskQuantities: Record<string, number>,
  assignmentPlans?: AssignmentPlan[],
): Promise<SupervisionAccount> {
  if (isTauriRuntime()) {
    return invoke<SupervisionAccount>("set_supervision_assigned_tasks", { username, assignedTaskQuantities, assignmentPlans });
  }
  if (isOperationsCockpitDemoScenario()) {
    const dashboard = demoOperationsData ??= createDemoOperationsDashboard();
    const account = dashboard.accounts.find((item) => item.username === username);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND: 账号不存在");
    const plans = (assignmentPlans ?? Object.entries(assignedTaskQuantities).map(([task, quantity], order) => ({ task, quantity, startIndex: 0, priority: "normal" as const, deadlineAtMs: null, status: "active" as const, order }))).map((plan, order) => ({ ...plan, startIndex: order * plan.quantity, order }));
    account.assignmentPlans = plans;
    account.assignedTaskNames = plans.map((plan) => plan.task);
    account.assignedTaskQuantities = Object.fromEntries(plans.map((plan) => [plan.task, plan.quantity]));
    account.assignedTasks = plans.reduce((sum, plan) => sum + plan.quantity, 0);
    const summary = dashboard.users.find((item) => item.username === username);
    if (summary) Object.assign(summary, { assignmentPlans: plans, assignedTaskNames: account.assignedTaskNames, assignedTaskQuantities: account.assignedTaskQuantities, assignedTasks: account.assignedTasks });
    return structuredClone(account);
  }
  throw new Error("SUPERVISOR_REQUIRED: 演示模式没有监管账户");
}

export async function updateOperationsAlert(alertId: string, status: OperationsAlertStatus, note: string): Promise<void> {
  if (isTauriRuntime()) return invoke("update_operations_alert", { alertId, status, note });
  if (isOperationsCockpitDemoScenario()) {
    const alert = (demoOperationsData ??= createDemoOperationsDashboard()).alerts.find((item) => item.alertId === alertId);
    if (alert) Object.assign(alert, { status, note, updatedAtMs: Date.now(), updatedBy: "demo-admin" });
    return;
  }
  throw new Error("SUPERVISOR_REQUIRED: 演示模式没有监管账户");
}

export async function transferSupervisionAssignment(fromUsername: string, toUsername: string, task: string): Promise<AssignmentTransferResult> {
  if (isTauriRuntime()) return invoke<AssignmentTransferResult>("transfer_supervision_assignment", { fromUsername, toUsername, task });
  throw new Error("SUPERVISOR_REQUIRED: 演示模式没有监管账户");
}

export async function createQualityReview(request: QualityReviewRequest): Promise<QualityReview> {
  if (isTauriRuntime()) return invoke<QualityReview>("create_quality_review", { request });
  if (isOperationsCockpitDemoScenario()) {
    const item: QualityReview = { reviewId: `demo-review-${Date.now()}`, ...request, reviewer: "demo-admin", reviewedAtMs: Date.now(), reworkAssignmentCreated: request.outcome === "rework" };
    (demoOperationsData ??= createDemoOperationsDashboard()).qualityReviews.unshift(item);
    return item;
  }
  throw new Error("SUPERVISOR_REQUIRED: 演示模式没有监管账户");
}

export async function chooseAndScanSupervisionTasks(): Promise<SupervisionTaskCatalog | null> {
  if (!isTauriRuntime()) throw new Error("监管任务目录只能在桌面应用中读取");
  const selection = await open({
    directory: true,
    multiple: false,
    title: "选择 NAS 导出的任务根目录（例如 Seed_sample）",
  });
  if (typeof selection !== "string") return null;
  return invoke<SupervisionTaskCatalog>("scan_supervision_tasks", {
    sourcePath: selection,
    operationId: Date.now(),
  });
}

export async function updateSupervisionTaskDetail(task: string, detail: string): Promise<SupervisionTaskDetail[]> {
  if (isTauriRuntime()) return invoke<SupervisionTaskDetail[]>("update_supervision_task_detail", { task, detail });
  throw new Error("SUPERVISOR_REQUIRED: 演示模式没有监管账户");
}

export async function importSupervisionTaskDetails(): Promise<SupervisionTaskImportResult | null> {
  if (!isTauriRuntime()) throw new Error("监管任务详情只能在桌面应用中导入");
  const selection = await open({
    directory: false,
    multiple: false,
    title: "导入任务详情 JSON",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof selection !== "string") return null;
  return invoke<SupervisionTaskImportResult>("import_supervision_task_details", { configPath: selection });
}

export async function importSupervisionAnnotations(): Promise<SupervisionAnnotationCatalog | null> {
  if (!isTauriRuntime()) throw new Error("监管标注 JSON 只能在桌面应用中导入");
  const selection = await open({
    directory: false,
    multiple: false,
    title: "导入标注汇总 JSON",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof selection !== "string") return null;
  return invoke<SupervisionAnnotationCatalog>("import_supervision_annotations", { configPath: selection });
}

export async function logoutLocalAccount(): Promise<void> {
  if (isTauriRuntime()) await invoke("logout_account");
  demoCurrentUser = null;
}

export async function listTaskDefinitions(): Promise<TaskDefinition[]> {
  if (isTauriRuntime()) return invoke<TaskDefinition[]>("list_task_definitions");
  return demoTaskDefinitions.map((task) => ({ ...task }));
}

export async function listAssignedTaskDefinitions(): Promise<TaskDefinition[]> {
  if (isTauriRuntime()) return invoke<TaskDefinition[]>("list_assigned_task_definitions");
  return listTaskDefinitions();
}

export async function getAssignedTasks(): Promise<AssignedTask[]> {
  if (isTauriRuntime()) return invoke<AssignedTask[]>("get_assigned_tasks");
  return [];
}

export async function getAssignedTaskActivity(date: string): Promise<AssignedTaskActivity> {
  if (isTauriRuntime()) return invoke<AssignedTaskActivity>("get_assigned_task_activity", { date });
  return { date, events: [] };
}

export async function getAssignedSourceRoot(): Promise<string | null> {
  if (isTauriRuntime()) return invoke<string | null>("get_assigned_source_root");
  return null;
}

export async function setAssignedSourceRoot(sourcePath: string): Promise<string> {
  if (isTauriRuntime()) return invoke<string>("set_assigned_source_root", { sourcePath });
  return sourcePath;
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

const AUDIT_QUEUE_KEY = "dohc-viewer.pending-audits.v1";
type AuditRequestInput = Omit<AnnotationAuditRequest, "eventId"> & { eventId?: string };

export async function recordAnnotationAudit(input: AuditRequestInput): Promise<void> {
  if (!isTauriRuntime()) return;
  const request: AnnotationAuditRequest = { ...input, eventId: input.eventId ?? crypto.randomUUID() };
  try {
    await invoke("record_annotation_audit", { request });
  } catch (error) {
    enqueueAnnotationAudit(request);
    throw error;
  }
}

export async function flushPendingAnnotationAudits(): Promise<number> {
  if (!isTauriRuntime()) return 0;
  const queue = readAnnotationAuditQueue();
  const pending: AnnotationAuditRequest[] = [];
  for (const request of queue) {
    try {
      await invoke("record_annotation_audit", { request });
    } catch {
      pending.push(request);
    }
  }
  writeAnnotationAuditQueue(pending);
  return pending.length;
}

export function pendingAnnotationAuditCount(): number {
  return readAnnotationAuditQueue().length;
}

function enqueueAnnotationAudit(request: AnnotationAuditRequest) {
  const queue = readAnnotationAuditQueue();
  if (!queue.some((item) => item.eventId === request.eventId)) queue.push(request);
  writeAnnotationAuditQueue(queue.slice(-500));
}

function readAnnotationAuditQueue(): AnnotationAuditRequest[] {
  try {
    const value = JSON.parse(localStorage.getItem(AUDIT_QUEUE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is AnnotationAuditRequest => (
      typeof item?.eventId === "string" && typeof item?.action === "string"
      && typeof item?.taskId === "string" && typeof item?.trajectoryCode === "string"
      && Number.isSafeInteger(item?.occurredAtMs)
    )) : [];
  } catch { return []; }
}

function writeAnnotationAuditQueue(queue: AnnotationAuditRequest[]) {
  try {
    if (queue.length) localStorage.setItem(AUDIT_QUEUE_KEY, JSON.stringify(queue));
    else localStorage.removeItem(AUDIT_QUEUE_KEY);
  } catch { /* The current audit call still reports the upload failure. */ }
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

export async function openOutput(path: string): Promise<void> {
  if (isTauriRuntime()) await openPath(path);
}

export async function exportSupervisionReport(
  destinationParent: string,
  kind: SupervisionReportKind,
  format: SupervisionReportFormat,
  reportDate: string,
  generatedAtMs: number,
  content: string,
): Promise<SupervisionReportExportResult> {
  if (!isTauriRuntime()) {
    return { outputPath: `${destinationParent}/dohc-${kind}-report-${reportDate}.${format}`, totalBytes: new Blob([content]).size, elapsedMs: 0 };
  }
  return invoke<SupervisionReportExportResult>("export_supervision_report", {
    destinationParent, kind, format, reportDate, generatedAtMs, content,
  });
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

export async function videoSource(root: string, stream: string): Promise<VideoSource | null> {
  if (!isTauriRuntime()) return null;
  try {
    const source = await invoke<VideoSource>("get_video_source", { root, stream });
    return {
      ...source,
      paths: source.paths.map((path) => (
        path.startsWith("http://127.0.0.1:") ? path : convertFileSrc(path)
      )),
    };
  } catch {
    return null;
  }
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

function isOperationsCockpitDemoScenario(): boolean {
  return !isTauriRuntime()
    && new URLSearchParams(window.location.search).get("demoScenario") === "operations-cockpit";
}

function createDemoOperationsDashboard(): SupervisionDashboardData {
  const now = Date.now();
  const plans: AssignmentPlan[][] = [[
    { task: "BedMaking", quantity: 20, startIndex: 0, priority: "urgent", deadlineAtMs: now + 4 * 60 * 60_000, status: "active", order: 0, completed: 8, remaining: 12, estimatedCompletionAtMs: now + 5_040_000 },
    { task: "Bedsheet", quantity: 12, startIndex: 0, priority: "normal", deadlineAtMs: null, status: "active", order: 1, completed: 2, remaining: 10, estimatedCompletionAtMs: now + 4_600_000 },
  ], [
    { task: "BedMaking", quantity: 18, startIndex: 20, priority: "normal", deadlineAtMs: now + 6 * 60 * 60_000, status: "active", order: 0, completed: 9, remaining: 9, estimatedCompletionAtMs: now + 5_940_000 },
  ]];
  const users: SupervisionDashboardData["users"] = [
    { username: "operator1", displayName: "标注员 1111", role: "operator", assignedTasks: 32, assignedTaskNames: ["BedMaking", "Bedsheet"], assignedTaskQuantities: { BedMaking: 20, Bedsheet: 12 }, assignmentPlans: plans[0], completedToday: 8, totalCompleted: 22, remainingTasks: 10, averageCompletionMs: 420_000, completionRatePerHour: 7.1, estimatedCompletionAtMs: now + 4_200_000, firstActivityAtMs: now - 6 * 60 * 60_000, lastActivityAtMs: now - 8 * 60_000, lastLoginAtMs: now - 7 * 60 * 60_000, operationCount: 96, possibleStagnation: false, accountStatus: "active" },
    { username: "operator2", displayName: "标注员 2222", role: "operator", assignedTasks: 18, assignedTaskNames: ["BedMaking"], assignedTaskQuantities: { BedMaking: 18 }, assignmentPlans: plans[1], completedToday: 3, totalCompleted: 9, remainingTasks: 9, averageCompletionMs: 660_000, completionRatePerHour: 3.2, estimatedCompletionAtMs: now + 5_940_000, firstActivityAtMs: now - 5 * 60 * 60_000, lastActivityAtMs: now - 2 * 60 * 60_000, lastLoginAtMs: now - 6 * 60 * 60_000, operationCount: 41, possibleStagnation: true, accountStatus: "active" },
  ];
  const accounts: SupervisionDashboardData["accounts"] = users.map((user) => ({ username: user.username, displayName: user.displayName, role: user.role, assignedTasks: user.assignedTasks, assignedTaskNames: user.assignedTaskNames, assignedTaskQuantities: user.assignedTaskQuantities, assignmentPlans: user.assignmentPlans, assignmentUpdatedAtMs: now - 24 * 60 * 60_000, lastLoginAtMs: user.lastLoginAtMs, createdAtMs: now - 30 * 24 * 60 * 60_000, accountStatus: user.accountStatus }));
  return {
    users,
    accounts,
    events: [],
    taskDetails: [
      { task: "BedMaking", detail: "整理床铺并标注完整动作片段。", source: "admin", updatedAtMs: now, updatedBy: "demo-admin" },
      { task: "Bedsheet", detail: "整理床单并检查片段覆盖。", source: "admin", updatedAtMs: now, updatedBy: "demo-admin" },
    ],
    overview: { completedToday: 11, totalCompleted: 31, assigned: 50, remaining: 19, activeOperators: 1, possibleStagnation: 1, averageCompletionMs: 491_613 },
    taskSummaries: [
      { task: "BedMaking", assigned: 38, completedToday: 9, totalCompleted: 25, remaining: 13, operatorCount: 2, averageCompletionMs: 510_000 },
      { task: "Bedsheet", assigned: 12, completedToday: 2, totalCompleted: 6, remaining: 6, operatorCount: 1, averageCompletionMs: 460_000 },
    ],
    hourlyTrend: Array.from({ length: 24 }, (_, hour) => ({ hour, completed: hour >= 8 && hour <= 16 ? [1, 2, 1, 0, 3, 1, 2, 1, 0][hour - 8] : 0 })),
    dailyTrend: Array.from({ length: 7 }, (_, index) => ({ date: new Date(now - (6 - index) * 86_400_000).toLocaleDateString("sv-SE"), completed: [18, 21, 17, 24, 20, 27, 11][index] })),
    alerts: [{ alertId: "possible-stagnation:operator2", type: "possible_stagnation", severity: "medium", status: "open", username: "operator2", taskId: "", message: "标注员 2222 长时间没有可见进展，请先确认工作状态", detectedAtMs: now - 2 * 60 * 60_000, updatedAtMs: now - 2 * 60 * 60_000, note: "", updatedBy: null }],
    qualityReviews: [{ reviewId: "demo-quality-1", taskId: "BedMaking", trajectoryCode: "bed-007", outcome: "passed", errorType: "", note: "边界清晰。", reviewer: "demo-admin", reviewedAtMs: now - 60 * 60_000, annotatorUsername: "operator1", annotationRevision: 2, segmentIndex: 0, startFrame: 1, endFrame: 195, parentReviewId: null, reworkAssignmentCreated: false }],
    generatedAtMs: now,
  };
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
