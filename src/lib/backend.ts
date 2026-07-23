import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  createDemoStates,
  demoEpisodeSummary,
  demoFrameUrl,
  DEMO_EPISODE_ROOT,
  loadDemoFixture,
  type DemoFixture,
} from "./demoFixture";
import type {
  AuthStatus,
  EpisodeAnnotation,
  EpisodeData,
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
} from "../types";

export const DEMO_ROOT = DEMO_EPISODE_ROOT;

const SESSION_ACTIVATION_DEMO_SOURCE_ROOT = "demo://session-activation";
const SESSION_ACTIVATION_DEMO_EPISODES = [
  { root: `${SESSION_ACTIVATION_DEMO_SOURCE_ROOT}/session-a`, name: "session-a" },
  { root: `${SESSION_ACTIVATION_DEMO_SOURCE_ROOT}/session-b`, name: "session-b" },
  { root: `${SESSION_ACTIVATION_DEMO_SOURCE_ROOT}/session-c`, name: "session-c" },
] as const;

const demoAccounts = new Map<string, { displayName: string; password: string }>();
const demoAnnotations = new Map<string, EpisodeAnnotation>();
let demoCurrentUser: UserIdentity | null = null;
let sessionActivationRetryAttempts = 0;

export async function getAuthStatus(): Promise<AuthStatus> {
  if (isTauriRuntime()) return invoke<AuthStatus>("get_auth_status");
  return { hasAccounts: demoAccounts.size > 0, currentUser: demoCurrentUser };
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
  return [
    {
      id: "close_oven",
      label: "关闭烤箱",
      codePrefix: "oven",
      defaultDescription: "关闭烤箱门，并确认烤箱门完全闭合。",
    },
  ];
}

export async function suggestTrajectoryCode(taskId: string): Promise<string> {
  if (isTauriRuntime()) return invoke<string>("suggest_trajectory_code", { taskId });
  const task = (await listTaskDefinitions()).find((item) => item.id === taskId);
  if (!task) throw new Error(`UNKNOWN_TASK: 不支持的任务 ${taskId}`);
  const used = [...demoAnnotations.values()]
    .filter((item) => item.trajectoryCode.startsWith(`${task.codePrefix}-`))
    .map((item) => Number(item.trajectoryCode.slice(task.codePrefix.length + 1)))
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
  if (!demoCurrentUser) throw new Error("AUTH_REQUIRED: 请先登录本地账号");
  const existing = demoAnnotations.get(request.sourcePath);
  const now = Date.now();
  const annotation: EpisodeAnnotation = {
    formatVersion: 1,
    episodeId: `demo-${request.sourcePath}`,
    episodeRoot: request.sourcePath,
    episodeFingerprint: "f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727",
    trajectoryCode: request.trajectoryCode,
    taskId: request.taskId,
    taskDescription: request.taskDescription.trim(),
    processedBy: demoCurrentUser,
    revision: (existing?.revision ?? 0) + 1,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  };
  demoAnnotations.set(request.sourcePath, annotation);
  return annotation;
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

export async function scanSource(path: string): Promise<ScanResult> {
  if (isTauriRuntime()) return invoke<ScanResult>("scan_source", { path });
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
  });
}

export async function listPartialImports(destinationParent: string): Promise<PartialImport[]> {
  if (!isTauriRuntime()) return [];
  return invoke<PartialImport[]>("list_partial_imports", { destinationParent });
}

export async function cleanupPartialImport(
  destinationParent: string,
  partialPath: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("cleanup_partial_import", { destinationParent, partialPath });
}

export async function importEpisode(
  sourcePath: string,
  destinationParent: string,
): Promise<ImportResult> {
  if (!isTauriRuntime()) {
    return {
      destination: sourcePath,
      totalFiles: 981,
      totalBytes: 80_531_730,
      datasetBlake3: "f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727",
      elapsedMs: 4380,
    };
  }
  return invoke<ImportResult>("import_episode", { sourcePath, destinationParent });
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
    processedBy: demoCurrentUser ?? { username: "demo", displayName: "Demo" },
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

export async function loadEpisode(path: string): Promise<EpisodeData> {
  if (isTauriRuntime()) return invoke<EpisodeData>("load_episode", { path });
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
    };
  }
  return {
    summary: demoEpisodeSummary(path, fixture),
    states: createDemoStates(fixture),
  };
}

export async function validateEpisode(path: string): Promise<ValidationReport> {
  if (isTauriRuntime()) return invoke<ValidationReport>("validate_episode", { path });
  return {
    formatVersion: 3,
    episodeRoot: path,
    parsedStateCount: 196,
    imageValidationMode: "sampled",
    imageSamplePercentages: [1, 25, 50, 73, 99],
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
}

export async function exportValidationReport(
  sourcePath: string,
  destinationParent: string,
): Promise<ReportExportResult> {
  if (isTauriRuntime()) {
    return invoke<ReportExportResult>("export_validation_report", {
      sourcePath,
      destinationParent,
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
    });
  }
  const annotation = demoAnnotations.get(sourcePath);
  const baseName = annotation?.trajectoryCode ?? "2026-07-13_07-34-12";
  const names: Record<ExportFormat, string> = {
    mcap: `${baseName}${demoRangeSuffix(range)}.mcap`,
    hdf5: `${baseName}${demoRangeSuffix(range)}.h5`,
    lerobot_v2: `${baseName}${demoRangeSuffix(range)}_lerobot_v2`,
  };
  return {
    format,
    outputPath: `${destinationParent}/${names[format]}`,
    trajectoryCode: annotation?.trajectoryCode ?? null,
    totalFiles: format === "lerobot_v2" ? 12 : 1,
    totalBytes: format === "mcap" ? 80_780_000 : format === "hdf5" ? 80_650_000 : 49_300_000,
    elapsedMs: format === "lerobot_v2" ? 18_400 : 3_200,
    range,
    stateCount: range.endFrame - range.startFrame + 1,
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

export async function cancelTask(): Promise<void> {
  if (isTauriRuntime()) await invoke("cancel_task");
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
