import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  CircleAlert,
  FileSearch,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  Images,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  PackageOpen,
  RotateCcw,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Timer,
  UserRound,
  X,
} from "lucide-react";
import { AnnotationPanel } from "./components/AnnotationPanel";
import { AuthScreen } from "./components/AuthScreen";
import { ChecksPanel } from "./components/ChecksPanel";
import { ExportPanel } from "./components/ExportPanel";
import { FramePanel } from "./components/FramePanel";
import { ProgressStrip } from "./components/ProgressStrip";
import { TelemetryChart } from "./components/TelemetryChart";
import { TrimControls } from "./components/TrimControls";
import {
  DEMO_ROOT,
  cancelTask,
  chooseDirectory,
  cleanupPartialImport,
  confirmAction,
  exportEpisode,
  exportValidationReport,
  getAuthStatus,
  importEpisode,
  inspectImportDestination,
  isTauriRuntime,
  listOperationErrors,
  listPartialImports,
  listTaskDefinitions,
  loadEpisodeAnnotation,
  loadEpisode,
  logoutLocalAccount,
  prepareImportWorkspace,
  recordOperationError,
  onTaskProgress,
  revealOutput,
  scanSource,
  validateEpisode,
} from "./lib/backend";
import { formatBytes, shortPath } from "./lib/format";
import type {
  AuthStatus,
  EpisodeAnnotation,
  EpisodeData,
  EpisodeSummary,
  ExportFormat,
  ExportRange,
  ExportResult,
  MetricKey,
  OperationErrorRecord,
  PartialImport,
  ScanResult,
  TaskProgress,
  TaskDefinition,
  ValidationReport,
} from "./types";

type View = "review" | "checks" | "export";
const LAST_MANAGED_IMPORT_ROOT = "dohc-viewer:last-managed-import-root";
type EpisodeImportState = "pending" | "importing" | "ready" | "error";

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "position", label: "位置" },
  { key: "velocity", label: "速度" },
  { key: "euler", label: "欧拉角" },
  { key: "omega", label: "角速度" },
];

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authStartupError, setAuthStartupError] = useState("");
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [annotation, setAnnotation] = useState<EpisodeAnnotation | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<EpisodeSummary | null>(null);
  const [importedEpisodeRoots, setImportedEpisodeRoots] = useState<Record<string, string>>({});
  const [episodeImportStates, setEpisodeImportStates] = useState<Record<string, EpisodeImportState>>({});
  const [loadedEpisodeSourceRoot, setLoadedEpisodeSourceRoot] = useState<string | null>(null);
  const [data, setData] = useState<EpisodeData | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mcap");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [view, setView] = useState<View>("review");
  const [metric, setMetric] = useState<MetricKey>("position");
  const [currentFrame, setCurrentFrame] = useState(0);
  const [clipStartFrame, setClipStartFrame] = useState(0);
  const [clipEndFrame, setClipEndFrame] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [currentOperationError, setCurrentOperationError] = useState(false);
  const [operationErrors, setOperationErrors] = useState<OperationErrorRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const frameRef = useRef(0);
  const didAutoLoad = useRef(false);
  const didCheckPartials = useRef(false);
  const episodeLoadInFlight = useRef(false);
  const episodeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const episodeFocusRestoreToken = useRef(0);
  const estimatedFps = useMemo(() => estimateFrameRate(data?.states ?? []), [data]);
  const playbackFps = fpsOverride ?? estimatedFps;

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  useEffect(() => {
    if (!authStatus?.currentUser) {
      setTasks([]);
      return;
    }
    void listTaskDefinitions()
      .then(setTasks)
      .catch((reason) => setError(`无法加载任务目录：${toMessage(reason)}`));
  }, [authStatus?.currentUser?.username]);

  useEffect(() => {
    if (!authStatus?.currentUser) {
      setOperationErrors([]);
      return;
    }
    void listOperationErrors()
      .then(setOperationErrors)
      .catch(() => undefined);
  }, [authStatus?.currentUser?.username]);

  useEffect(() => {
    frameRef.current = currentFrame;
  }, [currentFrame]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onTaskProgress((nextProgress) => setProgress(nextProgress)).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (didAutoLoad.current || isTauriRuntime() || !authStatus?.currentUser) return;
    didAutoLoad.current = true;
    void openSource(DEMO_ROOT, true);
  }, [authStatus?.currentUser?.username]);

  useEffect(() => {
    if (didCheckPartials.current || !isTauriRuntime() || !authStatus?.currentUser) return;
    didCheckPartials.current = true;
    const destination = window.localStorage.getItem(LAST_MANAGED_IMPORT_ROOT);
    if (!destination) return;
    void (async () => {
      try {
        const partials = await listPartialImports(destination);
        if (partials.length) await maybeCleanupPartials(destination, partials);
      } catch (reason) {
        await reportFailure("cleanup_partial_import", reason, destination);
      }
    })();
  }, [authStatus?.currentUser?.username]);

  useEffect(() => {
    if (!playing || !data) return;
    const playbackEnd = Math.min(clipEndFrame, getMaxFrame(data));
    const interval = window.setInterval(() => {
      const next = frameRef.current + 1;
      if (next > playbackEnd) {
        setPlaying(false);
        return;
      }
      frameRef.current = next;
      setCurrentFrame(next);
    }, Math.max(4, Math.round(1000 / (playbackFps * speed))));
    return () => window.clearInterval(interval);
  }, [clipEndFrame, data, playbackFps, playing, speed]);

  async function openSource(path: string, autoLoad = false) {
    setError("");
    setNotice("");
    setCurrentOperationError(false);
    setBusy(true);
    let operation = "scan_source";
    try {
      const result = await scanSource(path);
      setSourcePath(result.sourceRoot);
      setScan(result);
      setImportedEpisodeRoots({});
      setEpisodeImportStates(Object.fromEntries(
        result.episodes.map((episode) => [episode.root, "pending" as const]),
      ));
      const first = result.episodes[0] ?? null;
      setSelectedEpisode(first);
      resetLoadedData();
      if (autoLoad && first) {
        operation = "import_source";
        const importedRoots = await importDiscoveredEpisodes(result);
        const firstReady = result.episodes.find((episode) => importedRoots[episode.root]) ?? null;
        if (firstReady) {
          setSelectedEpisode(firstReady);
          operation = "load_and_validate";
          await loadAndValidate(importedRoots[firstReady.root], firstReady.root);
        }
      }
    } catch (reason) {
      await reportFailure(operation, reason, path);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function chooseSource() {
    try {
      const path = await chooseDirectory("选择 SD 卡根目录");
      if (path) await openSource(path, true);
    } catch (reason) {
      await reportFailure("choose_source", reason);
    }
  }

  async function loadEpisodeForReview(
    episode: EpisodeSummary,
    force = false,
    restoreFocus = false,
  ) {
    if (episodeLoadInFlight.current) return;
    selectEpisode(episode);
    if (!force && data && loadedEpisodeSourceRoot === episode.root) {
      setPlaying(false);
      setView("review");
      return;
    }
    const focusRestoreToken = restoreFocus ? ++episodeFocusRestoreToken.current : null;
    episodeLoadInFlight.current = true;
    setError("");
    setNotice("");
    setCurrentOperationError(false);
    setBusy(true);
    try {
      let root = importedEpisodeRoots[episode.root] ?? episode.root;
      if (isTauriRuntime() && !importedEpisodeRoots[episode.root]) {
        const destinationParent = await prepareImportDestination(scan?.sourceRoot ?? episode.root);
        const imported = await importOneEpisode(episode, destinationParent);
        root = imported.destination;
        setImportedEpisodeRoots((current) => ({ ...current, [episode.root]: root }));
        setNotice(`已自动导入本地，BLAKE3 ${imported.datasetBlake3.slice(0, 16)}…`);
      }
      await loadAndValidate(root, episode.root);
    } catch (reason) {
      setEpisodeImportStates((current) => ({ ...current, [episode.root]: "error" }));
      await reportFailure("load_episode", reason, episode.root);
    } finally {
      episodeLoadInFlight.current = false;
      setBusy(false);
      setProgress(null);
      if (focusRestoreToken !== null) restoreEpisodeFocus(episode.root, focusRestoreToken);
    }
  }

  function selectEpisode(episode: EpisodeSummary) {
    setSelectedEpisode(episode);
    if (loadedEpisodeSourceRoot !== episode.root) resetLoadedData();
  }

  function restoreEpisodeFocus(episodeRoot: string, token: number) {
    window.requestAnimationFrame(() => {
      if (episodeFocusRestoreToken.current !== token) return;
      episodeButtonRefs.current.get(episodeRoot)?.focus();
    });
  }

  async function importDiscoveredEpisodes(result: ScanResult): Promise<Record<string, string>> {
    if (!isTauriRuntime()) {
      const demoRoots = Object.fromEntries(result.episodes.map((episode) => [episode.root, episode.root]));
      setImportedEpisodeRoots(demoRoots);
      setEpisodeImportStates(Object.fromEntries(
        result.episodes.map((episode) => [episode.root, "ready" as const]),
      ));
      return demoRoots;
    }

    const destinationParent = await prepareImportDestination(result.sourceRoot);
    const importedRoots: Record<string, string> = {};
    let failed = 0;
    let importedBytes = 0;
    let cancelled = false;
    for (const [index, episode] of result.episodes.entries()) {
      setNotice(`正在自动导入 ${index + 1}/${result.episodes.length}：${episode.name}`);
      try {
        const imported = await importOneEpisode(episode, destinationParent);
        importedRoots[episode.root] = imported.destination;
        importedBytes += imported.totalBytes;
        setImportedEpisodeRoots((current) => ({
          ...current,
          [episode.root]: imported.destination,
        }));
      } catch (reason) {
        if (toMessage(reason).includes("任务已取消")) {
          setNotice("自动导入已取消");
          cancelled = true;
          break;
        }
        failed += 1;
        setEpisodeImportStates((current) => ({ ...current, [episode.root]: "error" }));
        await reportFailure("import_episode", reason, episode.root);
      }
    }

    if (cancelled) {
      setError(`自动导入已取消，已完成 ${Object.keys(importedRoots).length}/${result.episodes.length} 个 session。`);
    } else if (failed) {
      setError(`自动导入完成，但有 ${failed}/${result.episodes.length} 个 session 失败；详细信息已保存到错误历史。`);
    } else {
      setNotice(`已自动导入 ${result.episodes.length} 个 session（${formatBytes(importedBytes)}）`);
    }
    return importedRoots;
  }

  async function prepareImportDestination(sourceRoot: string): Promise<string> {
    const destinationParent = await prepareImportWorkspace(sourceRoot);
    window.localStorage.setItem(LAST_MANAGED_IMPORT_ROOT, destinationParent);
    const partials = await listPartialImports(destinationParent);
    if (partials.length) await maybeCleanupPartials(destinationParent, partials);
    return destinationParent;
  }

  async function importOneEpisode(
    episode: EpisodeSummary,
    destinationParent: string,
  ) {
    setEpisodeImportStates((current) => ({ ...current, [episode.root]: "importing" }));
    const preflight = await inspectImportDestination(episode.root, destinationParent);
    if (!preflight.canImport) {
      throw new Error(preflight.issues.map((issue) => `${issue.code}: ${issue.message}`).join("；"));
    }
    const imported = await importEpisode(episode.root, destinationParent);
    setEpisodeImportStates((current) => ({ ...current, [episode.root]: "ready" }));
    return imported;
  }

  async function reportFailure(operation: string, reason: unknown, path = sourcePath) {
    const message = toMessage(reason);
    if (message.includes("任务已取消")) {
      setNotice("任务已取消");
      return;
    }
    setError(presentOperationError(message));
    setCurrentOperationError(true);
    try {
      const record = await recordOperationError({
        operation,
        message,
        sourcePath: path || null,
      });
      setOperationErrors((current) => [
        record,
        ...current.filter((item) => item.id !== record.id),
      ].slice(0, 200));
    } catch (historyError) {
      console.error("Failed to persist operation error history", historyError);
    }
  }

  async function loadAndValidate(root: string, sourceEpisodeRoot: string) {
    const loaded = await loadEpisode(root);
    const checked = await validateEpisode(root);
    const savedAnnotation = await loadEpisodeAnnotation(root);
    setData(loaded);
    setReport(checked);
    setAnnotation(savedAnnotation);
    setLoadedEpisodeSourceRoot(sourceEpisodeRoot);
    setExportResult(null);
    setFpsOverride(null);
    const loadedMinFrame = getMinFrame(loaded);
    const loadedMaxFrame = getMaxFrame(loaded);
    setClipStartFrame(loadedMinFrame);
    setClipEndFrame(loadedMaxFrame);
    setCurrentFrame(loadedMinFrame);
    frameRef.current = loadedMinFrame;
    setView("review");
  }

  function resetLoadedData() {
    setData(null);
    setReport(null);
    setAnnotation(null);
    setPlaying(false);
    setExportResult(null);
    setCurrentFrame(0);
    setClipStartFrame(0);
    setClipEndFrame(0);
    setLoadedEpisodeSourceRoot(null);
  }

  async function refreshAuthStatus() {
    setAuthStartupError("");
    try {
      setAuthStatus(await getAuthStatus());
    } catch (reason) {
      setAuthStartupError(toMessage(reason));
    }
  }

  async function logout() {
    if (busy) return;
    try {
      await logoutLocalAccount();
      resetLoadedData();
      setSourcePath("");
      setScan(null);
      setSelectedEpisode(null);
      setImportedEpisodeRoots({});
      setEpisodeImportStates({});
      setOperationErrors([]);
      setHistoryOpen(false);
      setCurrentOperationError(false);
      setTasks([]);
      setError("");
      setNotice("");
      didAutoLoad.current = false;
      didCheckPartials.current = false;
      setAuthStatus((current) => ({
        hasAccounts: current?.hasAccounts ?? true,
        currentUser: null,
      }));
    } catch (reason) {
      await reportFailure("logout", reason);
    }
  }

  function moveFrame(delta: number) {
    if (!data) return;
    const next = Math.max(clipStartFrame, Math.min(clipEndFrame, currentFrame + delta));
    frameRef.current = next;
    setCurrentFrame(next);
  }

  function togglePlayback() {
    if (!data) return;
    if (!playing && currentFrame >= clipEndFrame) {
      frameRef.current = clipStartFrame;
      setCurrentFrame(clipStartFrame);
    }
    setPlaying((value) => !value);
  }

  function updateClipStart(value: number) {
    if (!data) return;
    const next = Math.max(getMinFrame(data), Math.min(Math.round(value), clipEndFrame));
    setClipStartFrame(next);
    if (currentFrame < next) {
      frameRef.current = next;
      setCurrentFrame(next);
    }
    setPlaying(false);
    setExportResult(null);
  }

  function updateClipEnd(value: number) {
    if (!data) return;
    const next = Math.min(getMaxFrame(data), Math.max(Math.round(value), clipStartFrame));
    setClipEndFrame(next);
    if (currentFrame > next) {
      frameRef.current = next;
      setCurrentFrame(next);
    }
    setPlaying(false);
    setExportResult(null);
  }

  function resetClipRange() {
    if (!data) return;
    const start = getMinFrame(data);
    const end = getMaxFrame(data);
    setClipStartFrame(start);
    setClipEndFrame(end);
    const next = Math.max(start, Math.min(currentFrame, end));
    frameRef.current = next;
    setCurrentFrame(next);
    setExportResult(null);
  }

  async function runExport() {
    if (!data) return;
    const range: ExportRange = { startFrame: clipStartFrame, endFrame: clipEndFrame };
    const rangeStatus = statusForRange(report, range);
    if (rangeStatus === "error") return;
    let acknowledgeWarnings = false;
    if (rangeStatus === "warning") {
      const warningCount = report?.issues.filter((issue) => issueInRange(issue, range) && issue.severity === "warning").length ?? 0;
      acknowledgeWarnings = await confirmAction(
        `当前裁剪片段包含 ${warningCount} 条数据警告。导出不会修复这些问题，是否继续？`,
        "确认带警告导出",
      );
      if (!acknowledgeWarnings) return;
    }
    const destinationParent = await chooseDirectory(`选择 ${exportFormatLabel(exportFormat)} 导出目录`);
    if (!destinationParent) return;
    setError("");
    setNotice("");
    setCurrentOperationError(false);
    setBusy(true);
    setExportResult(null);
    try {
      const result = await exportEpisode(
        data.summary.root,
        destinationParent,
        exportFormat,
        acknowledgeWarnings,
        range,
      );
      setExportResult(result);
      setNotice(`已导出 ${exportFormatLabel(exportFormat)}（帧 ${range.startFrame}–${range.endFrame}）：${shortPath(result.outputPath, 72)}`);
    } catch (reason) {
      await reportFailure("export_episode", reason, data.summary.root);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function runReportExport() {
    if (!data || !report) return;
    const destinationParent = await chooseDirectory("选择检查报告导出目录");
    if (!destinationParent) return;
    setError("");
    setNotice("");
    setCurrentOperationError(false);
    setBusy(true);
    try {
      const result = await exportValidationReport(data.summary.root, destinationParent);
      setNotice(`检查报告已导出：${shortPath(result.outputPath, 72)}`);
    } catch (reason) {
      await reportFailure("export_validation_report", reason, data.summary.root);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function revealExport(path: string) {
    try {
      await revealOutput(path);
    } catch (reason) {
      await reportFailure("reveal_output", reason, path);
    }
  }

  async function maybeCleanupPartials(
    destinationParent: string,
    partials: PartialImport[],
  ): Promise<void> {
    const confirmed = await confirmAction(
      `在该目录发现 ${partials.length} 个由 DOHC Viewer 标记的未完成导入。是否安全清理？`,
      "清理未完成导入",
    );
    if (!confirmed) return;
    for (const partial of partials) {
      await cleanupPartialImport(destinationParent, partial.path);
    }
    setNotice(`已清理 ${partials.length} 个未完成导入`);
  }

  function locateIssue(frameId: number) {
    if (!data) return;
    const target = Math.max(getMinFrame(data), Math.min(getMaxFrame(data), frameId));
    setPlaying(false);
    if (target < clipStartFrame) setClipStartFrame(target);
    if (target > clipEndFrame) setClipEndFrame(target);
    setExportResult(null);
    frameRef.current = target;
    setCurrentFrame(target);
    setView("review");
  }

  const stateByFrame = useMemo(() => {
    const index = new Map<number, EpisodeData["states"][number]>();
    for (const state of data?.states ?? []) index.set(state.frameId, state);
    return index;
  }, [data]);
  const currentState = stateByFrame.get(currentFrame) ?? null;
  const maxFrame = data ? getMaxFrame(data) : 0;
  const minFrame = data ? getMinFrame(data) : 0;
  const status = currentOperationError ? "error" : report?.status ?? (data ? "warning" : "idle");
  const clipRange: ExportRange = { startFrame: clipStartFrame, endFrame: clipEndFrame };
  const clipStateCount = useMemo(
    () => data
      ? data.states.filter((state) => state.frameId >= clipStartFrame && state.frameId <= clipEndFrame).length
      : 0,
    [clipEndFrame, clipStartFrame, data],
  );
  const clipDurationMs = useMemo(
    () => data ? durationBetweenFrames(data, clipStartFrame, clipEndFrame) : null,
    [clipEndFrame, clipStartFrame, data],
  );
  const clipStatus = useMemo(
    () => statusForRange(report, clipRange),
    [clipEndFrame, clipStartFrame, report],
  );

  if (!authStatus) {
    return (
      <main className="auth-shell auth-loading">
        <LoaderCircle className={authStartupError ? undefined : "spin"} size={24} />
        <strong>{authStartupError ? "无法载入本地账号" : "正在载入本地账号"}</strong>
        {authStartupError ? <span>{authStartupError}</span> : null}
        {authStartupError ? (
          <button className="button button-secondary" type="button" onClick={() => void refreshAuthStatus()}>
            重试
          </button>
        ) : null}
      </main>
    );
  }

  if (!authStatus.currentUser) {
    return (
      <AuthScreen
        hasAccounts={authStatus.hasAccounts}
        onAuthenticated={(user) => setAuthStatus({ hasAccounts: true, currentUser: user })}
      />
    );
  }

  const currentUser = authStatus.currentUser;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">D</span>
          <div>
            <strong>DOHC Viewer</strong>
            <span>recording workspace</span>
          </div>
        </div>
        <div className="source-display">
          <HardDrive size={16} />
          <span title={sourcePath}>{sourcePath ? shortPath(sourcePath, 58) : "未选择 SD 卡"}</span>
          {sourcePath ? <span className="source-dot" /> : null}
        </div>
        <div className="topbar-actions">
          <StatusBadge status={status} />
          <button className="button button-secondary" type="button" onClick={() => void chooseSource()} disabled={busy}>
            <FolderOpen size={16} />
            选择 SD 卡
          </button>
          <button
            className="icon-button history-trigger"
            type="button"
            onClick={() => setHistoryOpen((current) => !current)}
            title="操作错误历史"
            aria-label="操作错误历史"
            aria-expanded={historyOpen}
          >
            <History size={16} />
            {operationErrors.length ? <span>{Math.min(operationErrors.length, 99)}</span> : null}
          </button>
          <div className="account-summary" title={`@${currentUser.username}`}>
            <UserRound size={16} />
            <span><strong>{currentUser.displayName}</strong><small>@{currentUser.username}</small></span>
          </div>
          <button className="icon-button" type="button" onClick={() => void logout()} disabled={busy} title="退出登录" aria-label="退出登录">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {historyOpen ? (
        <OperationHistoryPanel
          records={operationErrors}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {progress ? <ProgressStrip progress={progress} onCancel={() => void cancelTask()} /> : null}
      {error ? (
        <div className="alert-banner alert-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <span className="alert-actions">
            <button type="button" className="text-button" onClick={() => setHistoryOpen(true)}>错误历史</button>
            <button type="button" className="text-button" onClick={() => setError("")}>关闭</button>
          </span>
        </div>
      ) : null}
      {notice ? (
        <div className="alert-banner alert-notice" role="status">
          <Check size={17} />
          <span>{notice}</span>
          <button type="button" className="text-button" onClick={() => setNotice("")}>关闭</button>
        </div>
      ) : null}

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="section-kicker">SOURCE</span>
              <h1>记录</h1>
            </div>
            <button className="icon-button" type="button" onClick={() => void chooseSource()} title="重新扫描" aria-label="重新扫描">
              <RotateCcw size={17} />
            </button>
          </div>
          <div className="sidebar-path" title={sourcePath}>{sourcePath ? shortPath(sourcePath, 38) : "等待 SD 卡"}</div>
          <div className="episode-list">
            {scan?.episodes.length ? (
              scan.episodes.map((episode) => {
                const importState = episodeImportStates[episode.root] ?? "pending";
                const activationHint = importState === "error"
                  ? "单击选择；双击或按 Enter/空格重试导入"
                  : "单击选择；双击或按 Enter/空格进入回放";
                return (
                  <button
                    type="button"
                    className={`episode-item${selectedEpisode?.root === episode.root ? " selected" : ""}`}
                    key={episode.root}
                    ref={(element) => {
                      if (element) episodeButtonRefs.current.set(episode.root, element);
                      else episodeButtonRefs.current.delete(episode.root);
                    }}
                    aria-pressed={selectedEpisode?.root === episode.root}
                    disabled={busy}
                    title={activationHint}
                    aria-label={`${episode.name}：${activationHint}`}
                    onClick={() => selectEpisode(episode)}
                    onDoubleClick={() => void loadEpisodeForReview(episode, false, true)}
                    onKeyDown={(event) => {
                      if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      void loadEpisodeForReview(episode, false, true);
                    }}
                  >
                    <span className="episode-item-top">
                      <Images size={16} />
                      <strong>{episode.name}</strong>
                      <EpisodeImportMark state={importState} />
                      <ChevronRight size={15} />
                    </span>
                    <span className="episode-item-meta">
                      {episode.stateCount} states · {formatBytes(episode.totalBytes)}
                    </span>
                    <span className="stream-dots">
                      {episode.streams.map((stream) => (
                        <i className={stream.frameCount ? "dot-ok" : "dot-error"} key={stream.name} title={stream.label} />
                      ))}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="sidebar-empty">
                <HardDrive size={23} />
                <span>未加载记录</span>
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            <div><span>文件</span><strong>{selectedEpisode?.totalFiles ?? "—"}</strong></div>
            <div><span>容量</span><strong>{selectedEpisode ? formatBytes(selectedEpisode.totalBytes) : "—"}</strong></div>
            <div><span>介质</span><strong>{scan ? driveTypeLabel(scan.volume.driveType) : "—"}</strong></div>
            <div><span>文件系统</span><strong>{scan?.volume.filesystem ?? "未知"}</strong></div>
          </div>
        </aside>

        <main className="main-content">
          {data ? (
            <>
              <nav className="view-tabs" aria-label="工作区视图">
                <button type="button" className={view === "review" ? "active" : ""} onClick={() => setView("review")}>
                  <Images size={17} />回放
                </button>
                <button type="button" className={view === "checks" ? "active" : ""} onClick={() => setView("checks")}>
                  <ShieldCheck size={17} />检查
                  {report?.status === "warning" ? <span className="tab-alert" /> : null}
                </button>
                <button type="button" className={view === "export" ? "active" : ""} onClick={() => setView("export")}>
                  <PackageOpen size={17} />导出
                </button>
                <span className="view-tab-spacer" />
                <span className="loaded-label"><span className="source-dot" />{shortPath(data.summary.root, 52)}</span>
              </nav>

              {view === "review" ? (
                <div className="review-view">
                  <AnnotationPanel
                    sourcePath={data.summary.root}
                    tasks={tasks}
                    annotation={annotation}
                    currentUser={currentUser}
                    busy={busy}
                    onSaved={setAnnotation}
                    onError={setError}
                    onNotice={setNotice}
                  />
                  <section className="camera-section">
                    <div className="section-heading compact-heading">
                      <div>
                        <span className="section-kicker">SYNCHRONIZED FRAMES</span>
                        <h2>多路回放</h2>
                      </div>
                      <span className="frame-counter">帧 {currentFrame} / {maxFrame}</span>
                    </div>
                    <div className="camera-grid">
                      {data.summary.streams.map((stream, index) => (
                        <FramePanel
                          key={stream.name}
                          root={data.summary.root}
                          stream={stream}
                          frameId={currentFrame}
                          playing={playing}
                          className={`camera-${index}`}
                        />
                      ))}
                    </div>
                    <TrimControls
                      minFrame={minFrame}
                      maxFrame={maxFrame}
                      currentFrame={currentFrame}
                      range={clipRange}
                      stateCount={clipStateCount}
                      durationMs={clipDurationMs}
                      disabled={busy}
                      onStartChange={updateClipStart}
                      onEndChange={updateClipEnd}
                      onMarkStart={() => updateClipStart(currentFrame)}
                      onMarkEnd={() => updateClipEnd(currentFrame)}
                      onReset={resetClipRange}
                    />
                    <div className="timeline-controls">
                      <div className="transport-buttons">
                        <button className="icon-button" type="button" onClick={() => moveFrame(-1)} title="上一帧" aria-label="上一帧"><SkipBack size={17} /></button>
                        <button className="play-button" type="button" onClick={togglePlayback} title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"}>
                          {playing ? <Pause size={17} /> : <Play size={17} />}
                        </button>
                        <button className="icon-button" type="button" onClick={() => moveFrame(1)} title="下一帧" aria-label="下一帧"><SkipForward size={17} /></button>
                      </div>
                      <input
                        className="timeline-slider"
                        type="range"
                        min={clipStartFrame}
                        max={clipEndFrame}
                        value={Math.max(clipStartFrame, Math.min(clipEndFrame, currentFrame))}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          frameRef.current = next;
                          setCurrentFrame(next);
                        }}
                        aria-label="播放帧位置"
                      />
                      <span className="time-readout">{currentState ? formatStateTime(data, currentState.captureTimeNs) : "—"}</span>
                      <label className="speed-control">
                        <Gauge size={16} />
                        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label="播放速度">
                          <option value={0.25}>0.25×</option>
                          <option value={0.5}>0.5×</option>
                          <option value={1}>1×</option>
                          <option value={2}>2×</option>
                        </select>
                      </label>
                      <label className="fps-control" title="播放帧率">
                        <Timer size={16} />
                        <select
                          value={fpsOverride ?? "auto"}
                          onChange={(event) => {
                            setFpsOverride(event.target.value === "auto" ? null : Number(event.target.value));
                          }}
                          aria-label="播放帧率"
                        >
                          <option value="auto">自动 {estimatedFps.toFixed(1)} FPS</option>
                          <option value={15}>15 FPS</option>
                          <option value={24}>24 FPS</option>
                          <option value={30}>30 FPS</option>
                          <option value={60}>60 FPS</option>
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="telemetry-section">
                    <div className="section-heading compact-heading">
                      <div>
                        <span className="section-kicker">STATE TELEMETRY</span>
                        <h2>状态数据</h2>
                      </div>
                      <div className="metric-switcher" role="tablist" aria-label="状态数据类型">
                        {METRICS.map((item) => (
                          <button key={item.key} type="button" className={metric === item.key ? "active" : ""} onClick={() => setMetric(item.key)}>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <TelemetryChart states={data.states} metric={metric} frameId={currentFrame} />
                  </section>
                </div>
              ) : view === "checks" ? (
                <ChecksPanel
                  data={data}
                  report={report}
                  busy={busy}
                  onExportReport={() => void runReportExport()}
                  onLocateIssue={locateIssue}
                />
              ) : (
                <ExportPanel
                  data={data}
                  annotation={annotation}
                  range={clipRange}
                  rangeStatus={clipStatus}
                  rangeStateCount={clipStateCount}
                  rangeDurationMs={clipDurationMs}
                  selectedFormat={exportFormat}
                  result={exportResult}
                  busy={busy}
                  onSelectFormat={(format) => {
                    setExportFormat(format);
                    setExportResult(null);
                  }}
                  onExport={() => void runExport()}
                  onReveal={(path) => void revealExport(path)}
                />
              )}
            </>
          ) : (
            <EmptyWorkspace
              selectedEpisode={selectedEpisode}
              busy={busy}
              onChoose={chooseSource}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function EmptyWorkspace({
  selectedEpisode,
  busy,
  onChoose,
}: {
  selectedEpisode: EpisodeSummary | null;
  busy: boolean;
  onChoose: () => Promise<void>;
}) {
  return (
    <div className="empty-workspace">
      <div className="empty-header">
        <span className="section-kicker">IMPORT QUEUE</span>
        <h2>从 SD 卡载入记录</h2>
        <p>选择 SD 卡后，全部记录会自动复制到本机工作区。</p>
      </div>
      {selectedEpisode ? (
        <div className="selected-episode-line">
          <div className="selected-episode-icon">
            {busy ? <LoaderCircle className="spin" size={20} /> : <FileSearch size={20} />}
          </div>
          <div>
            <strong>{selectedEpisode.name}</strong>
            <span>
              {busy
                ? "正在自动导入全部记录"
                : `${selectedEpisode.stateCount} 条状态 · ${formatBytes(selectedEpisode.totalBytes)} · ${selectedEpisode.streams.length} 路流`}
            </span>
          </div>
        </div>
      ) : (
        <button className="empty-action" type="button" onClick={() => void onChoose()} disabled={busy}>
          <HardDrive size={30} />
          <span>选择 SD 卡目录</span>
          <small>支持包含一个或多个记录目录的卷</small>
        </button>
      )}
      <div className="empty-facts">
        <span><ShieldCheck size={16} />大小 + BLAKE3 校验</span>
        <span><Activity size={16} />状态与帧序列检查</span>
        <span><Images size={16} />多路同步回放</span>
      </div>
    </div>
  );
}

function EpisodeImportMark({ state }: { state: EpisodeImportState }) {
  if (state === "importing") {
    return <span className="episode-import-state"><LoaderCircle className="spin" size={13} />导入中</span>;
  }
  if (state === "ready") {
    return <span className="episode-import-state"><Check size={13} />已导入</span>;
  }
  if (state === "error") {
    return <span className="episode-import-state state-error"><CircleAlert size={13} />失败</span>;
  }
  return <span className="episode-import-state">等待</span>;
}

function OperationHistoryPanel({
  records,
  onClose,
}: {
  records: OperationErrorRecord[];
  onClose: () => void;
}) {
  return (
    <section className="operation-history" aria-label="操作错误历史">
      <header>
        <span><History size={17} /><strong>操作错误历史</strong></span>
        <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭错误历史">
          <X size={16} />
        </button>
      </header>
      {records.length ? (
        <div className="operation-history-list">
          {records.map((record) => (
            <article className="operation-history-row" key={record.id}>
              <span className="history-time">{formatHistoryTime(record.occurredAtMs)}</span>
              <span className="history-code">{operationErrorLabel(record.code)}</span>
              <span className="history-operation">{operationLabel(record.operation)}</span>
              <span className="history-message" title={record.message}>{record.message}</span>
              <span className="history-source" title={record.sourcePath ?? undefined}>
                {record.sourcePath ? shortPath(record.sourcePath, 48) : "—"}
              </span>
              <span className="history-user">{record.processedBy.displayName}</span>
            </article>
          ))}
        </div>
      ) : (
        <div className="operation-history-empty"><Check size={16} />暂无操作错误</div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: "ok" | "warning" | "error" | "idle" }) {
  const labels = { ok: "检查通过", warning: "有警告", error: "有错误", idle: "未载入" };
  return <span className={`top-status top-status-${status}`}><span />{labels[status]}</span>;
}

function getMaxFrame(data: EpisodeData): number {
  let maximum = -1;
  for (const state of data.states) {
    if (state.frameId >= 0) maximum = Math.max(maximum, state.frameId);
  }
  if (maximum >= 0) return maximum;
  for (const stream of data.summary.streams) maximum = Math.max(maximum, stream.lastFrame ?? -1);
  return Math.max(0, maximum);
}

function getMinFrame(data: EpisodeData): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const state of data.states) {
    if (state.frameId >= 0) minimum = Math.min(minimum, state.frameId);
  }
  if (Number.isFinite(minimum)) return minimum;
  for (const stream of data.summary.streams) {
    if (stream.firstFrame !== null) minimum = Math.min(minimum, stream.firstFrame);
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

function formatStateTime(data: EpisodeData, captureTimeNs: string): string {
  try {
    const first = data.states[0]?.captureTimeNs;
    if (!first) return "—";
    const deltaNs = BigInt(captureTimeNs) - BigInt(first);
    return `${(Number(deltaNs) / 1_000_000).toFixed(1)} ms`;
  } catch {
    return "—";
  }
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function presentOperationError(message: string): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("operation not allowed")
    || normalized.includes("operation not permitted")
    || normalized.includes("permission denied")
    || normalized.includes("access is denied")
    || message.includes("权限")
    || message.includes("不允许")
  ) {
    return `系统拒绝访问所选卷或目录。请确认当前账号和 DOHC Viewer 可以读取该卷，并允许写入本机应用数据目录。原始错误：${message}`;
  }
  return message;
}

function formatHistoryTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function operationErrorLabel(code: string): string {
  const labels: Record<string, string> = {
    DEMO_FIXTURE_UNAVAILABLE: "演示样例不可用",
    PERMISSION_DENIED: "权限错误",
    INSUFFICIENT_SPACE: "空间不足",
    PATH_NOT_FOUND: "路径失效",
    OPERATION_FAILED: "操作失败",
  };
  return labels[code] ?? code;
}

function operationLabel(operation: string): string {
  const labels: Record<string, string> = {
    choose_source: "选择 SD 卡",
    scan_source: "扫描 SD 卡",
    import_source: "准备导入",
    import_episode: "导入 session",
    load_episode: "加载 session",
    load_and_validate: "加载与检查",
    cleanup_partial_import: "清理未完成导入",
    export_episode: "导出数据",
    export_validation_report: "导出报告",
    reveal_output: "打开导出位置",
    logout: "退出登录",
  };
  return labels[operation] ?? operation;
}

function exportFormatLabel(format: ExportFormat): string {
  return format === "mcap" ? "MCAP" : format === "hdf5" ? "HDF5" : "LeRobot v2.1";
}

function driveTypeLabel(driveType: ScanResult["volume"]["driveType"]): string {
  const labels = {
    removable: "可移动",
    fixed: "本地磁盘",
    remote: "网络磁盘",
    optical: "光盘",
    ramdisk: "内存盘",
    unknown: "未知",
  };
  return labels[driveType];
}

function estimateFrameRate(states: EpisodeData["states"]): number {
  const deltas: bigint[] = [];
  for (let index = 1; index < states.length; index += 1) {
    try {
      const delta = BigInt(states[index].captureTimeNs) - BigInt(states[index - 1].captureTimeNs);
      if (delta > 0n) deltas.push(delta);
    } catch {
      // Validation reports invalid timestamps; playback falls back to 30 FPS.
    }
  }
  if (!deltas.length) return 30;
  deltas.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const medianNs = deltas[Math.floor(deltas.length / 2)];
  const fps = 1_000_000_000 / Number(medianNs);
  return Number.isFinite(fps) ? Math.max(1, Math.min(240, fps)) : 30;
}

function issueInRange(
  issue: ValidationReport["issues"][number],
  range: ExportRange,
): boolean {
  return issue.frameId === null
    || issue.frameId < 0
    || (issue.frameId >= range.startFrame && issue.frameId <= range.endFrame);
}

function statusForRange(
  report: ValidationReport | null,
  range: ExportRange,
): "ok" | "warning" | "error" {
  if (!report) return "warning";
  const relevant = report.issues.filter((issue) => issueInRange(issue, range));
  if (relevant.some((issue) => issue.severity === "error")) return "error";
  if (relevant.some((issue) => issue.severity === "warning")) return "warning";
  return "ok";
}

function durationBetweenFrames(
  data: EpisodeData,
  startFrame: number,
  endFrame: number,
): number | null {
  const selected = data.states.filter(
    (state) => state.frameId >= startFrame && state.frameId <= endFrame,
  );
  const first = selected[0]?.captureTimeNs;
  const last = selected.at(-1)?.captureTimeNs;
  if (!first || !last) return null;
  try {
    const durationNs = BigInt(last) - BigInt(first);
    return durationNs >= 0n ? Number(durationNs) / 1_000_000 : null;
  } catch {
    return null;
  }
}

export default App;
