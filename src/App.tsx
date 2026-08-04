import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FileSearch,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  Images,
  ListChecks,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  PackageOpen,
  RefreshCw,
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
import { BatchExportPanel } from "./components/BatchExportPanel";
import { ChecksPanel } from "./components/ChecksPanel";
import { ExportPanel } from "./components/ExportPanel";
import { FramePanel } from "./components/FramePanel";
import { ProgressStrip } from "./components/ProgressStrip";
import { SegmentAnnotationEditor } from "./components/SegmentAnnotationEditor";
import { TelemetryChart } from "./components/TelemetryChart";
import {
  APP_VERSION,
  DEMO_ROOT,
  cancelTask,
  checkForAppUpdate,
  chooseDirectory,
  confirmAction,
  exportAnnotatedEpisodes,
  exportEpisode,
  exportValidationReport,
  getAuthStatus,
  installAppUpdate,
  isTauriRuntime,
  listAnnotatedEpisodes,
  listOperationErrors,
  listTaskDefinitions,
  loadEpisodeAnnotation,
  loadEpisode,
  logoutLocalAccount,
  recordOperationError,
  onTaskProgress,
  revealOutput,
  scanSource,
  validateEpisode,
} from "./lib/backend";
import { formatBytes, shortPath } from "./lib/format";
import { getPlaybackFrameBounds, resolveIssueLocation } from "./lib/issue-locate";
import { OperationScope, type OperationToken } from "./lib/operationScope";
import type {
  AnnotatedEpisodeSummary,
  AppUpdateInfo,
  AuthStatus,
  BatchExportResult,
  EpisodeAnnotation,
  EpisodeData,
  EpisodeSummary,
  ExportFormat,
  ExportRange,
  ExportResult,
  MetricKey,
  OperationErrorRecord,
  ScanResult,
  TaskProgress,
  TaskDefinition,
  ValidationIssue,
  ValidationReport,
} from "./types";

type View = "review" | "checks" | "export" | "batch";
type EpisodeSourceState = "available" | "loading" | "error";
type UpdatePhase = "idle" | "checking" | "available" | "current" | "downloading" | "failed";

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
  const [episodeSourceStates, setEpisodeSourceStates] = useState<Record<string, EpisodeSourceState>>({});
  const [loadedEpisodeSourceRoot, setLoadedEpisodeSourceRoot] = useState<string | null>(null);
  const [data, setData] = useState<EpisodeData | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mcap");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [annotatedEpisodes, setAnnotatedEpisodes] = useState<AnnotatedEpisodeSummary[]>([]);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [batchExportFormat, setBatchExportFormat] = useState<ExportFormat>("mcap");
  const [batchExportResult, setBatchExportResult] = useState<BatchExportResult | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
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
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateError, setUpdateError] = useState("");
  const [updateErrorVisible, setUpdateErrorVisible] = useState(false);
  const frameRef = useRef(0);
  const didAutoLoad = useRef(false);
  const operationScopeRef = useRef(new OperationScope());
  const sourcePickerOpenRef = useRef(false);
  const episodeLoadInFlight = useRef(false);
  const episodeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const episodeFocusRestoreToken = useRef(0);
  const batchSelectionInitialized = useRef(false);
  const didAutoUpdate = useRef(false);
  const estimatedFps = useMemo(() => estimateFrameRate(data?.states ?? []), [data]);
  const playbackFps = fpsOverride ?? estimatedFps;

  function beginOperation(): OperationToken | null {
    const operation = operationScopeRef.current.begin();
    if (!operation) return null;
    setBusy(true);
    setProgress(null);
    return operation;
  }

  function isCurrentOperation(operation: OperationToken): boolean {
    return operationScopeRef.current.isCurrent(operation);
  }

  function ensureOperationActive(operation: OperationToken) {
    if (
      !isCurrentOperation(operation)
      || operationScopeRef.current.isCancellationRequested(operation)
    ) {
      throw new Error("任务已取消");
    }
  }

  function resetOperationFeedback(operation: OperationToken) {
    if (!isCurrentOperation(operation)) return;
    setError("");
    setNotice("");
    setCurrentOperationError(false);
  }

  function finishOperation(operation: OperationToken) {
    if (!operationScopeRef.current.finish(operation)) return;
    setBusy(false);
    setProgress(null);
  }

  async function runAutomaticUpdate() {
    if (operationScopeRef.current.current()) return;
    setUpdatePhase("checking");
    setUpdateError("");
    setUpdateErrorVisible(false);
    let nextUpdate: AppUpdateInfo;
    try {
      nextUpdate = await checkForAppUpdate();
      setUpdateInfo(nextUpdate);
    } catch (reason) {
      setUpdatePhase("failed");
      setUpdateError(`无法自动检查更新：${presentUpdateError(toMessage(reason))}`);
      setUpdateErrorVisible(true);
      return;
    }
    if (!nextUpdate.available) {
      setUpdatePhase("current");
      return;
    }
    setUpdatePhase("available");
    await installAvailableUpdate();
  }

  async function installAvailableUpdate() {
    const owner = beginOperation();
    if (!owner) return;
    setUpdatePhase("downloading");
    try {
      const installed = await installAppUpdate(owner.id);
      ensureOperationActive(owner);
      if (!installed) {
        setUpdateInfo((current) => current ? {
          ...current,
          latestVersion: current.currentVersion,
          available: false,
        } : current);
        setUpdatePhase("current");
      }
    } catch (reason) {
      const message = toMessage(reason);
      setUpdatePhase("failed");
      setUpdateError(message.includes("任务已取消")
        ? "自动更新已取消，当前版本可继续使用"
        : `自动更新失败：${presentUpdateError(message)}`);
      setUpdateErrorVisible(true);
    } finally {
      finishOperation(owner);
    }
  }

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
    if (
      !authStatus?.currentUser
      || didAutoUpdate.current
      || busy
      || operationScopeRef.current.current()
    ) return;
    didAutoUpdate.current = true;
    void runAutomaticUpdate();
  }, [authStatus?.currentUser?.username, busy]);

  useEffect(() => {
    if (
      !authStatus?.currentUser
      || busy
      || updatePhase !== "available"
      || !updateInfo?.available
    ) return;
    void installAvailableUpdate();
  }, [authStatus?.currentUser?.username, busy, updatePhase, updateInfo?.available]);

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
    void onTaskProgress((nextProgress) => {
      const owner = operationScopeRef.current.current();
      if (owner?.id === nextProgress.operationId) setProgress(nextProgress);
    }).then((cleanup) => {
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
    const owner = beginOperation();
    if (!owner) return;
    resetOperationFeedback(owner);
    let operation = "scan_source";
    let loadingEpisode: EpisodeSummary | null = null;
    try {
      const result = await scanSource(path, owner.id);
      ensureOperationActive(owner);
      setSourcePath(result.sourceRoot);
      setScan(result);
      setEpisodeSourceStates(Object.fromEntries(
        result.episodes.map((episode) => [episode.root, "available" as const]),
      ));
      const first = result.episodes[0] ?? null;
      setSelectedEpisode(first);
      resetLoadedData();
      if (autoLoad && first) {
        operation = "load_and_validate";
        loadingEpisode = first;
        setEpisodeSourceStates((current) => ({ ...current, [first.root]: "loading" }));
        await loadAndValidate(first.root, first.root, owner);
        ensureOperationActive(owner);
        setEpisodeSourceStates((current) => ({ ...current, [first.root]: "available" }));
        setNotice(`已从源目录只读载入：${first.name}`);
      }
    } catch (reason) {
      const cancelled = toMessage(reason).includes("任务已取消");
      if (loadingEpisode) {
        const failedRoot = loadingEpisode.root;
        setEpisodeSourceStates((current) => ({
          ...current,
          [failedRoot]: cancelled ? "available" : "error",
        }));
      }
      await reportFailure(operation, reason, path, owner);
    } finally {
      finishOperation(owner);
    }
  }

  async function chooseSource() {
    if (sourcePickerOpenRef.current || operationScopeRef.current.current()) return;
    sourcePickerOpenRef.current = true;
    try {
      const path = await chooseDirectory("选择 SD 卡根目录");
      if (path) await openSource(path, true);
    } catch (reason) {
      if (!operationScopeRef.current.current()) await reportFailure("choose_source", reason);
    } finally {
      sourcePickerOpenRef.current = false;
    }
  }

  async function loadEpisodeForReview(
    episode: EpisodeSummary,
    force = false,
    restoreFocus = false,
  ) {
    if (episodeLoadInFlight.current || operationScopeRef.current.current()) return;
    selectEpisode(episode);
    if (!force && data && loadedEpisodeSourceRoot === episode.root) {
      setPlaying(false);
      setView("review");
      return;
    }
    const owner = beginOperation();
    if (!owner) return;
    const focusRestoreToken = restoreFocus ? ++episodeFocusRestoreToken.current : null;
    episodeLoadInFlight.current = true;
    resetOperationFeedback(owner);
    try {
      setEpisodeSourceStates((current) => ({ ...current, [episode.root]: "loading" }));
      await loadAndValidate(episode.root, episode.root, owner);
      ensureOperationActive(owner);
      setEpisodeSourceStates((current) => ({ ...current, [episode.root]: "available" }));
      setNotice(`已从源目录只读载入：${episode.name}`);
    } catch (reason) {
      const cancelled = toMessage(reason).includes("任务已取消");
      setEpisodeSourceStates((current) => ({
        ...current,
        [episode.root]: cancelled ? "available" : "error",
      }));
      await reportFailure("load_episode", reason, episode.root, owner);
    } finally {
      episodeLoadInFlight.current = false;
      finishOperation(owner);
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

  async function reportFailure(
    operation: string,
    reason: unknown,
    path = sourcePath,
    owner?: OperationToken,
  ) {
    if (owner && !isCurrentOperation(owner)) return;
    const message = toMessage(reason);
    if (message.includes("任务已取消")) {
      if (!owner || isCurrentOperation(owner)) setNotice("任务已取消");
      return;
    }
    if (!owner || isCurrentOperation(owner)) {
      setError(presentOperationError(message));
      setCurrentOperationError(true);
    }
    try {
      const record = await recordOperationError({
        operation,
        message,
        sourcePath: path || null,
      });
      if (!owner || isCurrentOperation(owner)) {
        setOperationErrors((current) => [
          record,
          ...current.filter((item) => item.id !== record.id),
        ].slice(0, 200));
      }
    } catch (historyError) {
      console.error("Failed to persist operation error history", historyError);
    }
  }

  async function loadAndValidate(
    root: string,
    sourceEpisodeRoot: string,
    owner: OperationToken,
  ) {
    ensureOperationActive(owner);
    const loaded = await loadEpisode(root, owner.id);
    ensureOperationActive(owner);
    const checked = await validateEpisode(root, owner.id);
    ensureOperationActive(owner);
    const savedAnnotation = await loadEpisodeAnnotation(root);
    ensureOperationActive(owner);
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
    if (operationScopeRef.current.current()) return;
    try {
      await logoutLocalAccount();
      resetLoadedData();
      setSourcePath("");
      setScan(null);
      setSelectedEpisode(null);
      setEpisodeSourceStates({});
      setOperationErrors([]);
      setHistoryOpen(false);
      setCurrentOperationError(false);
      setTasks([]);
      setAnnotatedEpisodes([]);
      setBatchSelectedIds([]);
      setBatchExportResult(null);
      setBatchLoading(false);
      batchSelectionInitialized.current = false;
      setView("review");
      setError("");
      setNotice("");
      didAutoLoad.current = false;
      setAuthStatus((current) => ({
        userCenter: current?.userCenter ?? { configured: false, endpoint: null, serviceId: null },
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

  async function runExport() {
    if (!data || operationScopeRef.current.current()) return;
    const range: ExportRange = { startFrame: clipStartFrame, endFrame: clipEndFrame };
    const rangeStatus = statusForRange(report, range);
    if (rangeStatus === "error") return;
    let acknowledgeWarnings = false;
    let destinationParent: string | null = null;
    try {
      if (rangeStatus === "warning") {
        const warningCount = report?.issues.filter((issue) => issueInRange(issue, range) && issue.severity === "warning").length ?? 0;
        acknowledgeWarnings = await confirmAction(
          `当前裁剪片段包含 ${warningCount} 条数据警告。导出不会修复这些问题，是否继续？`,
          "确认带警告导出",
        );
        if (!acknowledgeWarnings) return;
      }
      destinationParent = await chooseDirectory(`选择 ${exportFormatLabel(exportFormat)} 导出目录`);
    } catch (reason) {
      await reportFailure("export_episode", reason, data.summary.root);
      return;
    }
    if (!destinationParent) return;
    const owner = beginOperation();
    if (!owner) return;
    resetOperationFeedback(owner);
    setExportResult(null);
    try {
      const result = await exportEpisode(
        data.summary.root,
        destinationParent,
        exportFormat,
        acknowledgeWarnings,
        range,
        owner.id,
      );
      ensureOperationActive(owner);
      setExportResult(result);
      setNotice(`已导出 ${exportFormatLabel(exportFormat)}（帧 ${range.startFrame}–${range.endFrame}）：${shortPath(result.outputPath, 72)}`);
    } catch (reason) {
      await reportFailure("export_episode", reason, data.summary.root, owner);
    } finally {
      finishOperation(owner);
    }
  }

  async function refreshAnnotatedEpisodeList() {
    if (!authStatus?.currentUser) return;
    setBatchLoading(true);
    try {
      const listed = await listAnnotatedEpisodes();
      const availableIds = listed
        .filter((item) => item.sourceAvailable)
        .map((item) => item.annotation.episodeId);
      const availableSet = new Set(availableIds);
      const initializeSelection = !batchSelectionInitialized.current;
      if (initializeSelection) batchSelectionInitialized.current = true;
      setAnnotatedEpisodes(listed);
      setBatchSelectedIds((current) => initializeSelection
        ? availableIds
        : current.filter((episodeId) => availableSet.has(episodeId)));
    } catch (reason) {
      await reportFailure("list_annotated_episodes", reason, "");
    } finally {
      setBatchLoading(false);
    }
  }

  function openBatchExport() {
    setPlaying(false);
    setView("batch");
    void refreshAnnotatedEpisodeList();
  }

  function toggleBatchEpisode(episodeId: string) {
    setBatchExportResult(null);
    setBatchSelectedIds((current) => current.includes(episodeId)
      ? current.filter((candidate) => candidate !== episodeId)
      : [...current, episodeId]);
  }

  function toggleAllBatchEpisodes() {
    const availableIds = annotatedEpisodes
      .filter((item) => item.sourceAvailable)
      .map((item) => item.annotation.episodeId);
    const allSelected = availableIds.length > 0
      && availableIds.every((episodeId) => batchSelectedIds.includes(episodeId));
    setBatchExportResult(null);
    setBatchSelectedIds(allSelected ? [] : availableIds);
  }

  async function runBatchExport() {
    if (!batchSelectedIds.length || operationScopeRef.current.current()) return;
    let destinationParent: string | null = null;
    try {
      const confirmed = await confirmAction(
        `将重新检查并完整导出 ${batchSelectedIds.length} 条已标注数据。包含 warning 的数据会继续导出，包含 error 的数据会跳过，是否继续？`,
        "确认批量导出",
      );
      if (!confirmed) return;
      destinationParent = await chooseDirectory(
        `选择 ${exportFormatLabel(batchExportFormat)} 批量导出目录`,
      );
    } catch (reason) {
      await reportFailure("export_annotated_episodes", reason, "");
      return;
    }
    if (!destinationParent) return;

    const owner = beginOperation();
    if (!owner) return;
    resetOperationFeedback(owner);
    setBatchExportResult(null);
    try {
      const result = await exportAnnotatedEpisodes(
        batchSelectedIds,
        destinationParent,
        batchExportFormat,
        true,
        owner.id,
      );
      if (!isCurrentOperation(owner)) return;
      setBatchExportResult(result);
      if (isTauriRuntime()) {
        try {
          const history = await listOperationErrors();
          if (isCurrentOperation(owner)) setOperationErrors(history);
        } catch (historyError) {
          console.error("Failed to refresh batch export error history", historyError);
        }
      } else {
        await persistBatchFailures(result, owner);
      }
      if (!isCurrentOperation(owner)) return;
      if (result.cancelled) {
        setNotice(`批量导出已停止：已成功 ${result.exportedCount} 条，已完成的输出保留。`);
      } else {
        setNotice(`批量导出完成：成功 ${result.exportedCount} 条，失败 ${result.failedCount} 条。`);
      }
    } catch (reason) {
      await reportFailure("export_annotated_episodes", reason, destinationParent, owner);
    } finally {
      finishOperation(owner);
    }
  }

  async function persistBatchFailures(result: BatchExportResult, owner: OperationToken) {
    const recorded: OperationErrorRecord[] = [];
    for (const item of result.items) {
      if (
        item.status !== "failed"
        || !item.error
        || item.errorLogPath
        || !isCurrentOperation(owner)
      ) continue;
      try {
        recorded.push(await recordOperationError({
          operation: "export_annotated_episodes",
          message: item.error,
          sourcePath: item.sourcePath || null,
        }));
      } catch (historyError) {
        console.error("Failed to persist batch export error history", historyError);
      }
    }
    if (!recorded.length || !isCurrentOperation(owner)) return;
    setOperationErrors((current) => [
      ...recorded.reverse(),
      ...current.filter((item) => !recorded.some((record) => record.id === item.id)),
    ].slice(0, 200));
  }

  async function runReportExport() {
    if (!data || !report || operationScopeRef.current.current()) return;
    let destinationParent: string | null = null;
    try {
      destinationParent = await chooseDirectory("选择检查报告导出目录");
    } catch (reason) {
      await reportFailure("export_validation_report", reason, data.summary.root);
      return;
    }
    if (!destinationParent) return;
    const owner = beginOperation();
    if (!owner) return;
    resetOperationFeedback(owner);
    try {
      const result = await exportValidationReport(data.summary.root, destinationParent, owner.id);
      ensureOperationActive(owner);
      setNotice(`检查报告已导出：${shortPath(result.outputPath, 72)}`);
    } catch (reason) {
      await reportFailure("export_validation_report", reason, data.summary.root, owner);
    } finally {
      finishOperation(owner);
    }
  }

  async function cancelCurrentOperation() {
    const owner = operationScopeRef.current.current();
    if (!owner) return;
    operationScopeRef.current.requestCancellation(owner);
    try {
      await cancelTask(owner.id);
    } catch (reason) {
      await reportFailure("cancel_task", reason, sourcePath, owner);
    }
  }

  async function revealExport(path: string) {
    try {
      await revealOutput(path);
    } catch (reason) {
      await reportFailure("reveal_output", reason, path);
    }
  }

  function locateIssue(issue: ValidationIssue) {
    if (!data) return;
    const location = resolveIssueLocation(data, issue);
    if (location.kind === "unavailable") {
      setNotice(location.message);
      return;
    }

    const target = location.frameId;
    setPlaying(false);
    if (target < clipStartFrame) setClipStartFrame(target);
    if (target > clipEndFrame) setClipEndFrame(target);
    setExportResult(null);
    setNotice("");
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
  const playbackBounds = data ? getPlaybackFrameBounds(data) : { minFrame: 0, maxFrame: 0 };
  const { minFrame, maxFrame } = playbackBounds;
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
        <strong>{authStartupError ? "无法载入用户中心状态" : "正在载入用户中心状态"}</strong>
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
        userCenter={authStatus.userCenter}
        allowDemoRegistration={!isTauriRuntime()}
        onUserCenterConfigured={(status) => setAuthStatus((current) => ({
          userCenter: status,
          currentUser: current?.currentUser ?? null,
        }))}
        onAuthenticated={(user) => setAuthStatus((current) => ({
          userCenter: current?.userCenter ?? { configured: false, endpoint: null, serviceId: null },
          currentUser: user,
        }))}
      />
    );
  }

  const currentUser = authStatus.currentUser;
  const updateButtonTitle = updatePhase === "checking"
    ? "正在检查最新版本"
    : updatePhase === "downloading"
      ? `正在自动更新到 v${updateInfo?.latestVersion ?? ""}`
      : updatePhase === "failed"
        ? `${updateError}；点击重试`
        : updateInfo?.available
          ? `发现 v${updateInfo.latestVersion}；点击立即更新`
        : `当前版本 v${updateInfo?.currentVersion ?? APP_VERSION}；点击检查更新`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">D</span>
          <div>
            <strong>DOHC Viewer</strong>
            <span>v{updateInfo?.currentVersion ?? APP_VERSION}</span>
          </div>
        </div>
        <div className="source-display">
          <HardDrive size={16} />
          <span title={sourcePath}>{sourcePath ? shortPath(sourcePath, 58) : "未选择 SD 卡"}</span>
          {sourcePath ? <span className="source-dot" /> : null}
        </div>
        <div className="topbar-actions">
          <StatusBadge status={status} />
          <button
            className={`icon-button update-trigger${updatePhase === "failed" ? " update-failed" : ""}`}
            type="button"
            onClick={() => void (updateInfo?.available ? installAvailableUpdate() : runAutomaticUpdate())}
            disabled={busy || updatePhase === "checking" || updatePhase === "downloading"}
            title={updateButtonTitle}
            aria-label={updateButtonTitle}
          >
            {updatePhase === "checking" || updatePhase === "downloading" ? (
              <LoaderCircle className="spin" size={16} />
            ) : updatePhase === "failed" ? (
              <CircleAlert size={16} />
            ) : updateInfo?.available ? (
              <Download size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
          </button>
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

      {progress ? <ProgressStrip progress={progress} onCancel={() => void cancelCurrentOperation()} /> : null}
      {updatePhase === "failed" && updateErrorVisible ? (
        <div className="alert-banner alert-notice update-alert" role="status">
          <CircleAlert size={17} />
          <span>{updateError}。当前本地功能仍可使用。</span>
          <span className="alert-actions">
            <button type="button" className="text-button" onClick={() => void runAutomaticUpdate()} disabled={busy}>重试</button>
            <button type="button" className="text-button" onClick={() => setUpdateErrorVisible(false)}>关闭</button>
          </span>
        </div>
      ) : null}
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
            <button className="icon-button" type="button" onClick={() => void chooseSource()} disabled={busy} title="重新扫描" aria-label="重新扫描">
              <RotateCcw size={17} />
            </button>
          </div>
          <div className="sidebar-path" title={sourcePath}>{sourcePath ? shortPath(sourcePath, 38) : "等待 SD 卡"}</div>
          <div className="episode-list">
            {scan?.episodes.length ? (
              scan.episodes.map((episode) => {
                const sourceState = episodeSourceStates[episode.root] ?? "available";
                const activationHint = sourceState === "error"
                  ? "单击选择；双击或按 Enter/空格重试读取"
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
                      <EpisodeSourceMark state={sourceState} />
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
          {data || view === "batch" ? (
            <>
              <nav className="view-tabs" aria-label="工作区视图">
                {data ? (
                  <>
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
                  </>
                ) : null}
                <button type="button" className={view === "batch" ? "active" : ""} onClick={openBatchExport}>
                  <ListChecks size={17} />批量
                </button>
                <span className="view-tab-spacer" />
                {data ? (
                  <span className="loaded-label"><span className="source-dot" />{shortPath(data.summary.root, 52)}</span>
                ) : null}
              </nav>

              {view === "batch" ? (
                <BatchExportPanel
                  items={annotatedEpisodes}
                  tasks={tasks}
                  selectedIds={batchSelectedIds}
                  selectedFormat={batchExportFormat}
                  result={batchExportResult}
                  loading={batchLoading}
                  busy={busy}
                  onRefresh={() => void refreshAnnotatedEpisodeList()}
                  onToggle={toggleBatchEpisode}
                  onToggleAll={toggleAllBatchEpisodes}
                  onSelectFormat={(format) => {
                    setBatchExportFormat(format);
                    setBatchExportResult(null);
                  }}
                  onExport={() => void runBatchExport()}
                  onReveal={(path) => void revealExport(path)}
                />
              ) : !data ? null : view === "review" ? (
                <div className="review-view">
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
                          playbackEndFrame={clipEndFrame}
                          className={`camera-${index}`}
                        />
                      ))}
                    </div>
                    <AnnotationPanel
                      sourcePath={data.summary.root}
                      tasks={tasks}
                      annotation={annotation}
                      currentUser={currentUser}
                      busy={busy}
                      onTaskCreated={(task) => setTasks((current) => [...current, task])}
                      onSaved={setAnnotation}
                      onError={setError}
                      onNotice={setNotice}
                    />
                    <SegmentAnnotationEditor
                      data={data}
                      currentFrame={currentFrame}
                      minFrame={minFrame}
                      maxFrame={maxFrame}
                      busy={busy}
                      playbackControls={(
                        <>
                          <div className="transport-buttons">
                            <button className="icon-button" type="button" onClick={() => moveFrame(-1)} title="上一帧" aria-label="上一帧"><SkipBack size={17} /></button>
                            <button className="play-button" type="button" onClick={togglePlayback} title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
                            <button className="icon-button" type="button" onClick={() => moveFrame(1)} title="下一帧" aria-label="下一帧"><SkipForward size={17} /></button>
                          </div>
                          <span className="segment-frame-readout">帧 {currentFrame} / {maxFrame}</span>
                          <span className="time-readout">{currentState ? formatStateTime(data, currentState.captureTimeNs) : "—"}</span>
                          <label className="speed-control">
                            <Gauge size={16} />
                            <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label="播放速度">
                              <option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
                            </select>
                          </label>
                          <label className="fps-control" title="播放帧率">
                            <Timer size={16} />
                            <select value={fpsOverride ?? "auto"} onChange={(event) => setFpsOverride(event.target.value === "auto" ? null : Number(event.target.value))} aria-label="播放帧率">
                              <option value="auto">自动 {estimatedFps.toFixed(1)} FPS</option><option value={15}>15 FPS</option><option value={24}>24 FPS</option><option value={30}>30 FPS</option><option value={60}>60 FPS</option>
                            </select>
                          </label>
                        </>
                      )}
                      onFrameChange={(frame) => {
                        const next = Math.max(minFrame, Math.min(maxFrame, frame));
                        frameRef.current = next;
                        setCurrentFrame(next);
                      }}
                    />
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
              onBatch={openBatchExport}
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
  onBatch,
}: {
  selectedEpisode: EpisodeSummary | null;
  busy: boolean;
  onChoose: () => Promise<void>;
  onBatch: () => void;
}) {
  return (
      <div className="empty-workspace">
        <div className="empty-header">
        <span className="section-kicker">READ-ONLY SOURCE</span>
        <h2>从 SD 卡载入记录</h2>
        <p>记录直接从源目录只读打开，不占用额外副本空间。</p>
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
                ? "正在扫描或检查源记录"
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
      <button
        className="button button-secondary empty-batch-action"
        type="button"
        onClick={onBatch}
        disabled={busy}
      >
        <ListChecks size={16} />批量导出已标注数据
      </button>
      <div className="empty-facts">
        <span><ShieldCheck size={16} />源目录只读</span>
        <span><Activity size={16} />状态与帧序列检查</span>
        <span><Images size={16} />多路同步回放</span>
      </div>
    </div>
  );
}

function EpisodeSourceMark({ state }: { state: EpisodeSourceState }) {
  if (state === "loading") {
    return <span className="episode-source-state"><LoaderCircle className="spin" size={13} />读取中</span>;
  }
  if (state === "available") {
    return <span className="episode-source-state"><Check size={13} />可用</span>;
  }
  if (state === "error") {
    return <span className="episode-source-state state-error"><CircleAlert size={13} />失败</span>;
  }
  return null;
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
  return getPlaybackFrameBounds(data).maxFrame;
}

function getMinFrame(data: EpisodeData): number {
  return getPlaybackFrameBounds(data).minFrame;
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

function presentUpdateError(message: string): string {
  return message.replace(/^UPDATE_[A-Z_]+:\s*/, "");
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
    export_annotated_episodes: "批量导出",
    list_annotated_episodes: "读取本地标注",
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
