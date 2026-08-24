import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  BookOpenText,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  EyeOff,
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
  Pencil,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Timer,
  UserRound,
  Workflow,
  X,
} from "lucide-react";
import { AnnotationPanel } from "./components/AnnotationPanel";
import { AuthScreen } from "./components/AuthScreen";
import { BatchExportPanel } from "./components/BatchExportPanel";
import { ChecksPanel } from "./components/ChecksPanel";
import { ExportPanel } from "./components/ExportPanel";
import { FramePanel } from "./components/FramePanel";
import { ProgressStrip } from "./components/ProgressStrip";
import { PersonalTaskPanel } from "./components/PersonalTaskPanel";
import { SegmentAnnotationEditor } from "./components/SegmentAnnotationEditor";
import { SkeletonViewer } from "./components/SkeletonViewer";
import { SupervisionDashboard } from "./components/SupervisionDashboard";
import { TelemetryChart } from "./components/TelemetryChart";
import {
  APP_VERSION,
  DEMO_ROOT,
  cancelTask,
  checkForAppUpdate,
  chooseDirectory,
  clearWorkspaceMode,
  confirmAction,
  exportAnnotatedEpisodes,
  exportEpisode,
  exportValidationReport,
  getAuthStatus,
  getAssignedTaskActivity,
  getAssignedSourceRoot,
  getAssignedTasks,
  installAppUpdate,
  isTauriRuntime,
  listAnnotatedEpisodes,
  listOperationErrors,
  listTaskDefinitions,
  listAssignedTaskDefinitions,
  loadEpisodeAnnotation,
  loadEpisode,
  logoutLocalAccount,
  recordOperationError,
  recordAnnotationAudit,
  onTaskProgress,
  revealOutput,
  scanSource,
  setAssignedSourceRoot,
  selectWorkspaceMode,
  updateCurrentDisplayName,
  validateEpisode,
} from "./lib/backend";
import { assignmentFilterForSource } from "./lib/assignedEpisodes";
import { FRAME_READ_AHEAD_FRAMES } from "./lib/frame-cache";
import { formatBytes, shortPath } from "./lib/format";
import { getPlaybackFrameBounds, resolveIssueLocation } from "./lib/issue-locate";
import { OperationScope, type OperationToken } from "./lib/operationScope";
import {
  clampPlaybackFrame,
  nextFrameRenderProgress,
  nextPlaybackFrame,
  playbackAdvanceTimestamp,
  playbackBufferRatio,
  playbackBufferRequirement,
  playbackFrameDue,
  playbackFrameDurationMs,
  primaryPlaybackFrameStep,
  playbackStartFrame,
  secondaryPlaybackFrame,
} from "./lib/playback-clock";
import type {
  AnnotatedEpisodeSummary,
  AssignedTask,
  AssignedTaskActivity,
  AnnotationAuditAction,
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
  UserIdentity,
  ValidationIssue,
  ValidationReport,
  WorkspaceMode,
} from "./types";

type View = "review" | "checks" | "export" | "batch";
type EpisodeSourceState = "available" | "loading" | "error";
type UpdatePhase = "idle" | "checking" | "available" | "current" | "downloading" | "failed";
type EpisodeLoadResult = "loaded" | "confirmation_required" | "skipped";

interface PendingAnnotationConfirmation {
  data: EpisodeData;
  report: ValidationReport;
  sourceEpisodeRoot: string;
  minFrame: number;
  maxFrame: number;
}

function localDateInput(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const UNAVAILABLE_FRAME_ISSUE_CODES = new Set([
  "EMPTY_STREAM",
  "INVALID_FRAME_FILENAME",
  "DUPLICATE_FRAME_ID",
  "FRAME_ID_MISMATCH",
  "DECODE_FAILED",
  "DIMENSION_MISMATCH",
  "DUPLICATE_SEGMENT_NUMBER",
]);
const FRAME_JUMP_ISSUE_CODE = "STATE_FRAME_GAP";
const STATIC_TRAJECTORY_ISSUE_CODE = "TRAJECTORY_STATIC";
const UNAVAILABLE_TRAJECTORY_ISSUE_CODE = "TRAJECTORY_POSITION_UNAVAILABLE";

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "position", label: "位置" },
  { key: "velocity", label: "速度" },
  { key: "euler", label: "欧拉角" },
  { key: "omega", label: "角速度" },
];

interface ReleaseHistoryEntry {
  version: string;
  date: string;
  notes: string[];
}

const CHANGELOG_URL = new URL("../CHANGELOG.md", import.meta.url).href;

const RELEASE_SUMMARIES_ZH: Record<string, string> = {
  "0.17.60": "重构监管工作台视觉层级与状态反馈，强化运营指标、异常告警和窄窗口可读性。",
  "0.17.59": "支持可移动 U 盘直读、离线局域网用户中心迁移，以及 Camera 0 原生连续 MP4 回放与中间定位。",
  "0.17.58": "支持从日期顶层目录和 DOHC1TB 批量根目录直接加载混合 MP4/segment BIN 真实记录，并按 batch 时间轴同步回放。",
  "0.17.57": "新增 segment BIN 文件夹直读：数值排序并连续加载全部分段，复用 T265 位姿与 JPEG 回放，并校验记录结构和 CRC。",
  "0.17.56": "修复 NAS 网络挂载无响应时标注账号自动加载长期锁死界面的问题，失败后可继续退出、重新配置或导入数据。",
  "0.17.55": "批量任务分配新增整文件夹与多任务数量双模式，截止时间改为日期并在当日显示“今天”。",
  "0.17.54": "新增任务运营驾驶舱、批量与速度建议分配、异常处置、独立质量复核、隐私安全报表和标注员快捷任务队列。",
  "0.17.53": "支持标注员注册和当前姓名修改；监管分配重复任务时确认，并默认选择任务文件夹全部数量。",
  "0.17.52": "新增个人任务抽屉、按日期标注记录和本机任务路径配置，优化监管全量分配与紧凑任务描述输入。",
  "0.17.51": "修复桌面端与旧用户中心版本不一致时任务分配假成功和普通账号 NOT_FOUND 的问题。",
  "0.17.50": "修复监管模式下 JSON 任务分配无法保存的问题，并在分配区域即时显示保存结果和错误。",
  "0.17.49": "三维骨架按首次显示姿态确定固定朝向，兼容镜像 SMPL 脚部和 COCO 面部方向，同时保留播放中的真实转身。",
  "0.17.47": "监管账户可在本地导入标注 JSON，按最新修订查看每位标注人的任务、轨迹、片段与覆盖帧统计和明细。",
  "0.17.46": "Camera 0 满填充显示，三维骨架以接地、朝前且略微俯视的初始视角展示；JPEG 回放保持逐帧推进并让倍速控制单帧时长。",
  "0.17.45": "新增挂载源 h264-split-mp4-v1 五路同步回放，并补齐 Linux H.264 解码依赖与发布校验。",
  "0.17.44": "新增管理员监管工作台、任务分配与完成汇总，以及应用内只读历史版本查看。",
  "0.17.43": "修复登录入口浏览器回归检查，使正式发布安装包恢复自动构建。",
  "0.17.42": "修复用户中心管理页、Rustls 初始化和固定证书链，新增只读历史版本入口，并恢复仅编辑注解的片段界面。",
  "0.17.41": "新增本地任务模板 JSON 导入、手动分段标题复用及轨迹位置缺失检查。",
  "0.17.40": "完善标注警告确认流程，并修复确认结束后的 session 焦点恢复。",
  "0.17.39": "健康检查进行期间即可只读预览 episode，检查失败或取消时清除临时预览。",
  "0.17.38": "修正当前帧不可用时的回放回归测试，直接验证 FRAME_UNAVAILABLE 阻断。",
  "0.17.37": "补充运行时帧不可用时停止 session 并记录错误的回归覆盖。",
  "0.17.36": "更新浏览器回放测试，使其先通过新的警告门禁再验证同步回放。",
  "0.17.35": "将裁剪和分段写入 description.json，并增加不可用帧、静止轨迹和警告决策门禁。",
  "0.17.34": "将局域网更新镜像与用户中心固定地址迁移到 10.1.11.200。",
  "0.17.33": "以跨平台原子替换保存 description.json，并保持采集指纹和源写入边界。",
  "0.17.32": "采用浅层 session 目录扫描、快速标注预览和可复用深层索引。",
  "0.17.31": "增加有界内存源索引，健康检查后台运行时提前展示只读 episode 预览。",
  "0.17.30": "统一 SMPL 与 COCO 骨架坐标为稳定 Y-up 视图并补充交互回归测试。",
  "0.17.29": "支持安全删除未使用任务、导入前完整校验及三种格式的分段标注 metadata。",
  "0.17.28": "修复 episode 加载后的焦点恢复竞态，并在工作区重置时取消旧焦点任务。",
  "0.17.27": "追加保存连续分段修订，并为三种导出生成原子发布的 Metadata JSON。",
  "0.17.26": "引入感知五路画面加载状态的回放时钟，保持视频与骨架同步。",
  "0.17.25": "允许只读访问系统挂载的映射盘及 SMB/NFS 网络卷，同时保持导入导出在本地文件系统。",
  "0.17.24": "新增统一管理与离线工作模式，并在切换模式时清空当前工作区状态。",
  "0.17.20": "新增有界解析的本地 SMPL/骨架 NPZ，以及桌面端 Three.js 同步骨架视图。",
  "0.17.19": "恢复单轨连续时间裁剪控件，并明确分段注解不替代回放和导出闭区间。",
  "0.17.18": "将分段草稿整合到同步回放页，支持定位、连续分段、注解和紧凑标注布局。",
  "0.17.17": "新增 30 FPS 状态时间轴门禁、±5% 容差和 FRAME_RATE_MISMATCH 报告。",
  "0.17.16": "修复 GitHub latest.json 返回 404 时的镜像同步，同时保留三平台完整性与签名门禁。",
  "0.17.15": "新增局域网 HTTPS 用户中心及三种导出的处理人、编辑时长等 provenance 元数据。",
  "0.17.14": "并行测速公网与局域网更新镜像，以受限 Range 样本选择更快下载路径。",
  "0.17.13": "统一桌面与窄屏下时间裁剪轨道和范围滑块的像素边界。",
  "0.17.12": "自动更新迁移到固定公网镜像并增加局域网 fallback，继续执行大小与签名验证。",
  "0.17.11": "修复 Linux 对固定本地 HTTP 更新镜像的启动许可配置。",
  "0.17.10": "新增登录后的自动检查、下载、验签、安装和重启更新流程，覆盖三平台。",
  "0.17.8": "修复 Windows 打包时 WebView2 离线安装器缓存与审核载荷不一致的问题。",
  "0.17.7": "批量导出新增逐条失败日志、应用内错误查看及文件管理器定位。",
  "0.17.6": "停止发布 macOS Intel，发布集合调整为 Windows x64、macOS arm64 和 Ubuntu x64。",
  "0.17.5": "要求每个 Release 具有唯一、带日期且非空的 Changelog，并直接用于发布说明。",
  "0.17.4": "正常 UI 改为直接只读加载挂载源，不再自动创建应用本地 episode 副本。",
  "0.17.3": "更新经审核的 Windows WebView2 x64 离线安装器地址与 SHA-256。",
  "0.17.2": "简化 Release CD，使用 GITHUB_TOKEN 自动创建 annotated tag 并发布完整安装集合。",
  "0.17.1": "保持 Ubuntu 22.04 deb 构建安装验证，并调整历史 Flatpak 的构建宿主。",
  "0.17.0": "新增 Ubuntu 22.04+ x86_64 原生 deb 安装包。",
  "0.16.1": "同步播放时隐藏逐帧加载遮罩，暂停反馈和不可用帧错误仍保持可见。",
  "0.16.0": "新增基于 GNOME 50 runtime 的 Ubuntu Flatpak 发布路径。",
  "0.15.3": "选卡后自动创建应用管理工作区并导入全部 session，取消第二次目标目录选择。",
  "0.15.2": "保持 macOS 嵌套签名和资源封印验证，并适配 GitHub macOS 15 runner。",
  "0.15.1": "修复 macOS DMG 的无效资源 seal，避免 Gatekeeper 误报应用已损坏。",
  "0.15.0": "新增 Windows NSIS 与 macOS DMG 的 unsigned CD、安装启动 smoke 和完整集合门禁。",
  "0.14.0": "新增离线本地账号创建、登录和退出，并将处理人写入标注修订。",
  "0.13.0": "warning/error 健康检查结果自动写入本地后台报告，通过结果不生成报告。",
  "0.12.0": "选卡后自动扫描、导入、检查并加载首条 session，移除手动导入按钮。",
  "0.11.0": "将应用导航、控件、状态和导出反馈统一为黑白与中性灰视觉系统。",
  "0.10.0": "左侧列表改为 session 选择器：单击选择，双击进入回放。",
  "0.9.0": "新增单条轨迹连续闭区间裁剪、范围回放和三格式共用导出范围。",
  "0.8.0": "新增 macOS 宿主上的 Windows x64 MSVC 全目标条件编译预检。",
  "0.7.0": "新增跨平台 stress-check，串联扫描、导入、全量检查、三格式回读与源端 BLAKE3。",
  "0.6.0": "HDF5 JPEG 改为可取消的固定 1 MiB 分块流式写入。",
  "0.5.0": "新增跨平台 quick、full 和 debug bundle 检查及原子 JSON 证据报告。",
  "0.4.0": "源遍历支持取消、只读和 no-follow，并增加稀疏帧有界报告与 macOS 卷信息。",
  "0.3.0": "新增绑定源目录指纹的进程内可信检查记录，过期或缺失时阻止导出。",
  "0.2.0": "新增导入容量与文件系统预检，以及 Windows 卷识别。",
  "0.1.0": "建立 Tauri 2、Rust、React 与 TypeScript 桌面应用基础架构。",
};

function parseReleaseHistory(markdown: string): ReleaseHistoryEntry[] {
  const entries: ReleaseHistoryEntry[] = [];
  const headings = Array.from(markdown.matchAll(/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/gm));
  for (const [index, heading] of headings.entries()) {
    const bodyStart = (heading.index ?? 0) + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(bodyStart, bodyEnd).trim();
    const notes = Array.from(body.matchAll(/(?:^|\n)- ([\s\S]*?)(?=\n- |$)/g), (note) => (
      note[1].replace(/\s*\n\s*/g, " ").trim()
    ));
    entries.push({ version: heading[1], date: heading[2], notes });
  }
  return entries;
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authStartupError, setAuthStartupError] = useState("");
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [assignedTasks, setAssignedTasks] = useState<AssignedTask[]>([]);
  const [assignedSourceRoot, setAssignedSourceRootState] = useState<string | null>(null);
  const [assignedActivity, setAssignedActivity] = useState<AssignedTaskActivity | null>(null);
  const [assignedActivityDate, setAssignedActivityDate] = useState(() => localDateInput());
  const [assignedActivityLoading, setAssignedActivityLoading] = useState(false);
  const [personalTaskOpen, setPersonalTaskOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [assignedEpisodeTasks, setAssignedEpisodeTasks] = useState<Record<string, string>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [annotation, setAnnotation] = useState<EpisodeAnnotation | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<EpisodeSummary | null>(null);
  const [episodeSourceStates, setEpisodeSourceStates] = useState<Record<string, EpisodeSourceState>>({});
  const [skippedEpisodeRoots, setSkippedEpisodeRoots] = useState<Record<string, true>>({});
  const [pendingAnnotationConfirmation, setPendingAnnotationConfirmation] = useState<PendingAnnotationConfirmation | null>(null);
  const [queuedEpisodeRoot, setQueuedEpisodeRoot] = useState<string | null>(null);
  const [loadedEpisodeSourceRoot, setLoadedEpisodeSourceRoot] = useState<string | null>(null);
  const [data, setData] = useState<EpisodeData | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mcap");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [annotationTags, setAnnotationTags] = useState<Record<string, EpisodeAnnotation>>({});
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
  const [auditUploadPending, setAuditUploadPending] = useState(false);
  const [currentOperationError, setCurrentOperationError] = useState(false);
  const [operationErrors, setOperationErrors] = useState<OperationErrorRecord[]>([]);
  const workspaceMode = authStatus?.workspaceMode ?? null;
  const workspaceActive = workspaceMode !== null;
  const isManagedWorkspace = workspaceMode === "managed";
  const isOfflineWorkspace = workspaceMode === "offline";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);
  const [releaseHistory, setReleaseHistory] = useState<ReleaseHistoryEntry[]>([]);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateError, setUpdateError] = useState("");
  const [updateErrorVisible, setUpdateErrorVisible] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch(CHANGELOG_URL)
      .then((response) => response.ok ? response.text() : Promise.reject(new Error(`Changelog HTTP ${response.status}`)))
      .then((markdown) => { if (active) setReleaseHistory(parseReleaseHistory(markdown)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  const [frameRenderProgress, setFrameRenderProgress] = useState({
    root: null as string | null,
    frameId: 0,
    settled: 0,
    total: 0,
  });
  const frameRef = useRef(0);
  const settledFrameByStreamRef = useRef(new Map<string, number>());
  const playbackModeByStreamRef = useRef(new Map<string, "native" | "fallback">());
  const bufferedFramesByStreamRef = useRef(new Map<string, number>());
  const playbackPrimedRef = useRef(false);
  const [playbackPrimed, setPlaybackPrimed] = useState(false);
  const [playbackBufferPercent, setPlaybackBufferPercent] = useState(0);
  const [playbackBufferStreamLabel, setPlaybackBufferStreamLabel] = useState("Camera 0");
  const [sourceFpsByStream, setSourceFpsByStream] = useState<Record<string, number>>({});
  const didAutoLoad = useRef(false);
  const operationScopeRef = useRef(new OperationScope());
  const sourcePickerOpenRef = useRef(false);
  const episodeLoadInFlight = useRef(false);
  const episodeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const episodeFocusRestoreToken = useRef(0);
  const [episodeFocusRestoreRequest, setEpisodeFocusRestoreRequest] = useState<{
    episodeRoot: string;
    token: number;
  } | null>(null);
  const batchSelectionInitialized = useRef(false);
  const didAutoUpdate = useRef(false);
  const estimatedFps = useMemo(() => estimateFrameRate(data?.states ?? []), [data]);
  const availableStreams = useMemo(
    () => data?.summary.streams.filter((stream) => stream.frameCount > 0) ?? [],
    [data],
  );
  const primaryStreamName = availableStreams.find((stream) => stream.name === "cam0")?.name
    ?? availableStreams[0]?.name
    ?? null;
  const playbackFps = fpsOverride ?? estimatedFps;
  const primarySourceFps = primaryStreamName ? sourceFpsByStream[primaryStreamName] ?? null : null;
  const handleFrameSettled = useCallback((streamName: string, frameId: number) => {
    const root = data?.summary.root;
    if (!root) return;
    settledFrameByStreamRef.current.set(streamName, frameId);
    const settled = availableStreams.reduce(
      (count, stream) => count + (settledFrameByStreamRef.current.get(stream.name) === frameId ? 1 : 0),
      0,
    );
    setFrameRenderProgress((current) => nextFrameRenderProgress(
      current,
      { root, frameId, settled, total: availableStreams.length },
    ));
  }, [availableStreams, data?.summary.root]);
  const handlePlaybackModeChange = useCallback((streamName: string, mode: "native" | "fallback") => {
    playbackModeByStreamRef.current.set(streamName, mode);
  }, []);
  const handleBufferProgress = useCallback((streamName: string, readyFrames: number) => {
    bufferedFramesByStreamRef.current.set(streamName, readyFrames);
  }, []);
  const handleSourceFpsChange = useCallback((streamName: string, fps: number | null) => {
    setSourceFpsByStream((current) => {
      if (fps === null) {
        if (!(streamName in current)) return current;
        const next = { ...current };
        delete next[streamName];
        return next;
      }
      return current[streamName] === fps ? current : { ...current, [streamName]: fps };
    });
  }, []);

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
    if (busy || !episodeFocusRestoreRequest) return;
    const { episodeRoot, token } = episodeFocusRestoreRequest;
    setEpisodeFocusRestoreRequest(null);
    if (episodeFocusRestoreToken.current !== token) return;
    const button = episodeButtonRefs.current.get(episodeRoot);
    if (button && !button.disabled) button.focus();
  }, [busy, episodeFocusRestoreRequest]);

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  useEffect(() => {
    if (!workspaceActive || (isManagedWorkspace && !authStatus?.currentUser)) {
      setTasks([]);
      setAssignedTasks([]);
      setAssignedSourceRootState(null);
      setAssignedActivity(null);
      setPersonalTaskOpen(false);
      return;
    }
    if (isManagedWorkspace && authStatus?.currentUser?.role === "operator") {
      const date = localDateInput();
      setAssignedActivityDate(date);
      void Promise.all([listAssignedTaskDefinitions(), getAssignedTasks(), getAssignedSourceRoot(), getAssignedTaskActivity(date)])
        .then(async ([definitions, assignments, assignedRoot, activity]) => {
          setTasks(definitions);
          setAssignedTasks(assignments);
          setAssignedSourceRootState(assignedRoot);
          setAssignedActivity(activity);
          if (assignedRoot && assignments.length) await openSource(assignedRoot, true, assignments);
        })
        .catch((reason) => setError(`无法加载已分配任务：${toMessage(reason)}`));
      return;
    }
    setAssignedTasks([]);
    setAssignedSourceRootState(null);
    setAssignedActivity(null);
    void listTaskDefinitions().then(setTasks)
      .catch((reason) => setError(`无法加载任务目录：${toMessage(reason)}`));
  }, [authStatus?.currentUser?.username, isManagedWorkspace, workspaceActive]);

  async function refreshAssignedActivity(date: string) {
    if (!isManagedWorkspace || authStatus?.currentUser?.role !== "operator") return;
    setAssignedActivityLoading(true);
    try {
      setAssignedActivity(await getAssignedTaskActivity(date));
    } catch (reason) {
      setError(`无法加载标注记录：${toMessage(reason)}`);
    } finally {
      setAssignedActivityLoading(false);
    }
  }

  function changeAssignedActivityDate(date: string) {
    setAssignedActivityDate(date);
    void refreshAssignedActivity(date);
  }

  useEffect(() => {
    if (!workspaceActive || (isManagedWorkspace && !authStatus?.currentUser)) {
      setAnnotationTags({});
      return;
    }
    void refreshAnnotationTags();
  }, [authStatus?.currentUser?.username, isManagedWorkspace, workspaceActive]);

  useEffect(() => {
    if (
      !isManagedWorkspace
      || !authStatus?.currentUser
      || didAutoUpdate.current
      || busy
      || operationScopeRef.current.current()
    ) return;
    didAutoUpdate.current = true;
    void runAutomaticUpdate();
  }, [authStatus?.currentUser?.username, busy, isManagedWorkspace]);

  useEffect(() => {
    if (
      !isManagedWorkspace
      || !authStatus?.currentUser
      || busy
      || updatePhase !== "available"
      || !updateInfo?.available
    ) return;
    void installAvailableUpdate();
  }, [authStatus?.currentUser?.username, busy, isManagedWorkspace, updatePhase, updateInfo?.available]);

  useEffect(() => {
    if (!workspaceActive || (isManagedWorkspace && !authStatus?.currentUser)) {
      setOperationErrors([]);
      return;
    }
    void listOperationErrors()
      .then(setOperationErrors)
      .catch(() => undefined);
  }, [authStatus?.currentUser?.username, isManagedWorkspace, workspaceActive]);

  useEffect(() => {
    frameRef.current = currentFrame;
  }, [currentFrame]);

  useEffect(() => {
    settledFrameByStreamRef.current.clear();
    setFrameRenderProgress({
      root: data?.summary.root ?? null,
      frameId: currentFrame,
      settled: 0,
      total: availableStreams.length,
    });
  }, [availableStreams.length, currentFrame, data?.summary.root]);

  useEffect(() => {
    setSourceFpsByStream({});
  }, [data?.summary.root]);

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
    if (
      didAutoLoad.current
      || isTauriRuntime()
      || !workspaceActive
      || (isManagedWorkspace && !authStatus?.currentUser)
    ) return;
    didAutoLoad.current = true;
    void openSource(DEMO_ROOT, true);
  }, [authStatus?.currentUser?.username, isManagedWorkspace, workspaceActive]);

  useEffect(() => {
    if (!queuedEpisodeRoot || busy) return;
    const episode = scan?.episodes.find((candidate) => candidate.root === queuedEpisodeRoot);
    setQueuedEpisodeRoot(null);
    if (episode && !skippedEpisodeRoots[episode.root]) {
      void loadEpisodeForReview(episode, true);
    }
  }, [busy, queuedEpisodeRoot, scan, skippedEpisodeRoots]);

  useEffect(() => {
    if (!data || authStatus?.workspaceMode !== "managed" || !authStatus.currentUser) return;
    const taskId = selectedTaskId ?? annotation?.taskId ?? "";
    const trajectoryCode = annotation?.trajectoryCode ?? "";
    void recordAnnotationAudit({ taskId, trajectoryCode, action: "annotation_started", occurredAtMs: Date.now() })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      void recordAnnotationAudit({ taskId, trajectoryCode, action: "annotation_ended", occurredAtMs: Date.now() });
    };
  }, [data?.summary.root, authStatus?.workspaceMode, authStatus?.currentUser?.username]);

  useEffect(() => {
    if (!playing || !data) return;
    const playbackEnd = Math.min(clipEndFrame, getMaxFrame(data));
    const frameStep = primaryPlaybackFrameStep(playbackFps, primarySourceFps);
    const frameDurationMs = playbackFrameDurationMs(playbackFps / frameStep, speed);
    let lastAdvanceTimeMs = performance.now() - frameDurationMs;
    let animationFrame = 0;

    const tick = (nowMs: number) => {
      const current = frameRef.current;
      if (!playbackPrimedRef.current) {
        const fallbackStreams = availableStreams.filter(
          (stream) => playbackModeByStreamRef.current.get(stream.name) !== "native",
        );
        const primaryFallback = fallbackStreams.find((stream) => stream.name === primaryStreamName);
        const primaryRequiredFrames = primaryFallback
          ? playbackBufferRequirement(
            current,
            playbackEnd,
            primaryFallback.lastFrame,
            FRAME_READ_AHEAD_FRAMES,
          )
          : 0;
        const primaryReadyFrames = primaryFallback
          ? bufferedFramesByStreamRef.current.get(primaryFallback.name) ?? 0
          : 0;
        const primaryComplete = primaryReadyFrames >= primaryRequiredFrames;
        const percent = Math.round(
          playbackBufferRatio(primaryReadyFrames, primaryRequiredFrames) * 100,
        );
        setPlaybackBufferPercent((value) => value === percent ? value : percent);
        if (primaryFallback) {
          setPlaybackBufferStreamLabel((value) => (
            value === primaryFallback.label ? value : primaryFallback.label
          ));
        }
        // Camera 0 is the playback gate. Once its runway is decoded, start the
        // real-time clock immediately; secondary tiles continue read-ahead in
        // the background and must never strand playback at the old 50% phase.
        if (primaryComplete) {
          playbackPrimedRef.current = true;
          setPlaybackPrimed(true);
          lastAdvanceTimeMs = nowMs;
        }
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }
      const frameIntervalElapsed = playbackFrameDue(nowMs - lastAdvanceTimeMs, frameDurationMs);
      const next = nextPlaybackFrame(current, playbackEnd, frameIntervalElapsed, frameStep);
      if (next !== frameRef.current) {
        lastAdvanceTimeMs = playbackAdvanceTimestamp(
          nowMs,
          lastAdvanceTimeMs,
          frameDurationMs,
        );
        frameRef.current = next;
        setCurrentFrame(next);
      }
      if (next >= playbackEnd) {
        setPlaying(false);
        return;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [availableStreams, clipEndFrame, data, playbackFps, playing, primarySourceFps, primaryStreamName, speed]);

  async function openSource(path: string, autoLoad = false, assignment = assignedTasks) {
    const owner = beginOperation();
    if (!owner) return;
    resetOperationFeedback(owner);
    let operation = "scan_source";
    let loadingEpisode: EpisodeSummary | null = null;
    try {
      const result = await scanSource(path, owner.id);
      ensureOperationActive(owner);
      const filtered = assignmentFilterForSource(
        result.episodes,
        assignment,
        result.volume.driveType,
      );
      const visibleResult = filtered ? {
        ...result,
        episodes: filtered.episodes,
        totalFiles: filtered.episodes.reduce((sum, episode) => sum + episode.totalFiles, 0),
        totalBytes: filtered.episodes.reduce((sum, episode) => sum + episode.totalBytes, 0),
      } : result;
      setAssignedEpisodeTasks(filtered?.taskByRoot ?? {});
      setSourcePath(visibleResult.sourceRoot);
      setScan(visibleResult);
      if (assignment.length && result.volume.driveType === "removable") {
        setNotice(`已从可移动盘读取 ${visibleResult.episodes.length} 条记录；NAS 任务过滤未应用于该设备。`);
      }
      void refreshAnnotationTags();
      setSkippedEpisodeRoots({});
      setPendingAnnotationConfirmation(null);
      setQueuedEpisodeRoot(null);
      setEpisodeSourceStates(Object.fromEntries(
        visibleResult.episodes.map((episode) => [episode.root, "available" as const]),
      ));
      const first = visibleResult.episodes[0] ?? null;
      setSelectedEpisode(first);
      resetLoadedData();
      if (autoLoad && first) {
        operation = "load_and_validate";
        loadingEpisode = first;
        setEpisodeSourceStates((current) => ({ ...current, [first.root]: "loading" }));
        const loadResult = await loadAndValidate(first.root, first.root, owner);
        ensureOperationActive(owner);
        handleLoadResult(first, loadResult);
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
      if (path) {
        const selectedPath = isManagedWorkspace && authStatus?.currentUser?.role === "operator"
          ? await setAssignedSourceRoot(path)
          : path;
        if (isManagedWorkspace && authStatus?.currentUser?.role === "operator") setAssignedSourceRootState(selectedPath);
        await openSource(selectedPath, true);
      }
    } catch (reason) {
      if (!operationScopeRef.current.current()) await reportFailure("choose_source", reason);
    } finally {
      sourcePickerOpenRef.current = false;
    }
  }

  async function continueAssignedTask() {
    setPersonalTaskOpen(false);
    if (selectedEpisode) {
      await loadEpisodeForReview(selectedEpisode, true);
    } else if (assignedSourceRoot) {
      await openSource(assignedSourceRoot, true, assignedTasks);
    } else {
      await chooseSource();
    }
  }

  async function openNextAssignedTask() {
    setPersonalTaskOpen(false);
    const visible = scan?.episodes ?? [];
    const currentIndex = selectedEpisode
      ? visible.findIndex((episode) => episode.root === selectedEpisode.root)
      : -1;
    const next = visible[currentIndex + 1] ?? visible[0];
    if (next) await loadEpisodeForReview(next, true);
    else await continueAssignedTask();
  }

  async function loadEpisodeForReview(
    episode: EpisodeSummary,
    force = false,
    restoreFocus = false,
  ) {
    if (episodeLoadInFlight.current || operationScopeRef.current.current()) return;
    selectEpisode(episode);
    if (!force && data && report && loadedEpisodeSourceRoot === episode.root) {
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
      const loadResult = await loadAndValidate(episode.root, episode.root, owner);
      ensureOperationActive(owner);
      handleLoadResult(episode, loadResult);
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
    if (pendingAnnotationConfirmation?.data.summary.root !== episode.root) {
      setPendingAnnotationConfirmation(null);
    }
    setSelectedEpisode(episode);
    if (loadedEpisodeSourceRoot !== episode.root) resetLoadedData();
  }

  function updateScannedEpisode(summary: EpisodeSummary) {
    setSelectedEpisode((current) => current?.root === summary.root ? summary : current);
    setScan((current) => {
      if (!current) return current;
      const episodes = current.episodes.map((episode) => (
        episode.root === summary.root ? summary : episode
      ));
      return {
        ...current,
        episodes,
        totalFiles: episodes.reduce((total, episode) => total + episode.totalFiles, 0),
        totalBytes: episodes.reduce((total, episode) => total + episode.totalBytes, 0),
      };
    });
  }

  function restoreEpisodeFocus(episodeRoot: string, token: number) {
    setEpisodeFocusRestoreRequest({ episodeRoot, token });
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
    if (!workspaceActive) return;
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
  ): Promise<EpisodeLoadResult> {
    ensureOperationActive(owner);
    const loaded = await loadEpisode(root, owner.id);
    ensureOperationActive(owner);
    updateScannedEpisode(loaded.summary);
    const loadedMinFrame = getMinFrame(loaded);
    const loadedMaxFrame = getMaxFrame(loaded);

    // Mount the read-only preview before the health check finishes so operators
    // can start inspecting frames while validation runs in the background.
    setData(loaded);
    setReport(null);
    setAnnotation(null);
    setLoadedEpisodeSourceRoot(sourceEpisodeRoot);
    setPlaying(false);
    setExportResult(null);
    setFpsOverride(null);
    setClipStartFrame(loadedMinFrame);
    setClipEndFrame(loadedMaxFrame);
    setCurrentFrame(loadedMinFrame);
    frameRef.current = loadedMinFrame;
    setView("review");

    const validated = await validateEpisode(root, owner.id);
    ensureOperationActive(owner);
    updateScannedEpisode(validated.summary);
    if (hasUnavailableFrame(validated.report)) {
      resetLoadedData();
      throw new Error(
        `FRAME_UNAVAILABLE: ${loaded.summary.name} 存在不可用图像帧，已阻止加载。请在左侧跳过该数据后继续。`,
      );
    }

    const candidate: PendingAnnotationConfirmation = {
      data: { ...loaded, summary: validated.summary },
      report: validated.report,
      sourceEpisodeRoot,
      minFrame: loadedMinFrame,
      maxFrame: loadedMaxFrame,
    };
    if (hasUnusableTrajectory(validated.report)) return "skipped";
    if (annotationConfirmationWarnings(validated.report).length) {
      setPendingAnnotationConfirmation(candidate);
      setView("review");
      return "confirmation_required";
    }

    const savedAnnotation = await loadEpisodeAnnotation(root);
    ensureOperationActive(owner);
    applyLoadedEpisode(candidate, savedAnnotation);
    return "loaded";
  }

  function applyLoadedEpisode(
    candidate: PendingAnnotationConfirmation,
    savedAnnotation: EpisodeAnnotation | null,
  ) {
    setReport(candidate.report);
    setData(candidate.data);
    setAnnotation(savedAnnotation);
    setLoadedEpisodeSourceRoot(candidate.sourceEpisodeRoot);
    setPlaying(false);
    setExportResult(null);
    setFpsOverride(null);
    const savedStart = savedAnnotation?.clipStartFrame;
    const savedEnd = savedAnnotation?.clipEndFrame;
    const restoredStart = savedStart !== null && savedStart !== undefined
      ? Math.max(candidate.minFrame, Math.min(candidate.maxFrame, savedStart))
      : candidate.minFrame;
    const restoredEnd = savedEnd !== null && savedEnd !== undefined
      ? Math.max(restoredStart, Math.min(candidate.maxFrame, savedEnd))
      : candidate.maxFrame;
    setClipStartFrame(restoredStart);
    setClipEndFrame(restoredEnd);
    // The preview is interactive while validation runs. Preserve the live
    // playback position when validation finishes instead of snapping an
    // operator who already started reviewing back to the annotation start.
    const restoredFrame = clampPlaybackFrame(frameRef.current, restoredStart, restoredEnd);
    setCurrentFrame(restoredFrame);
    frameRef.current = restoredFrame;
    setView("review");
  }

  function handleLoadResult(episode: EpisodeSummary, result: EpisodeLoadResult) {
    if (result === "loaded") {
      setEpisodeSourceStates((current) => ({ ...current, [episode.root]: "available" }));
      setNotice(`已从源目录只读载入：${episode.name}`);
      return;
    }
    if (result === "confirmation_required") {
      setEpisodeSourceStates((current) => ({ ...current, [episode.root]: "available" }));
      setNotice(`发现数据警告：${episode.name}。请确认是否进入标注。`);
      return;
    }
    skipEpisode(episode, true, "检测到不可用或静止轨迹，不进入标注。");
  }

  async function confirmAnnotationAfterWarning() {
    const candidate = pendingAnnotationConfirmation;
    if (!candidate || operationScopeRef.current.current()) return;
    const owner = beginOperation();
    if (!owner) return;
    const focusRestoreToken = ++episodeFocusRestoreToken.current;
    setPendingAnnotationConfirmation(null);
    resetOperationFeedback(owner);
    try {
      const savedAnnotation = await loadEpisodeAnnotation(candidate.data.summary.root);
      ensureOperationActive(owner);
      applyLoadedEpisode(candidate, savedAnnotation);
      setEpisodeSourceStates((current) => ({ ...current, [candidate.data.summary.root]: "available" }));
      setNotice(`已确认数据警告，进入标注：${candidate.data.summary.name}`);
    } catch (reason) {
      setEpisodeSourceStates((current) => ({ ...current, [candidate.data.summary.root]: "error" }));
      await reportFailure("load_episode", reason, candidate.data.summary.root, owner);
    } finally {
      finishOperation(owner);
      restoreEpisodeFocus(candidate.sourceEpisodeRoot, focusRestoreToken);
    }
  }

  function skipPendingAnnotation() {
    const candidate = pendingAnnotationConfirmation;
    if (!candidate) return;
    setPendingAnnotationConfirmation(null);
    skipEpisode(candidate.data.summary, true, "未进入标注。");
  }

  function skipEpisode(episode: EpisodeSummary, loadNext = false, reason = "") {
    const nextRoot = loadNext ? nextAvailableEpisodeRoot(episode.root) : null;
    setSkippedEpisodeRoots((current) => ({ ...current, [episode.root]: true }));
    if (pendingAnnotationConfirmation?.data.summary.root === episode.root) {
      setPendingAnnotationConfirmation(null);
    }
    if (selectedEpisode?.root === episode.root) {
      setSelectedEpisode(null);
      resetLoadedData();
    }
    setEpisodeSourceStates((current) => {
      const remaining = { ...current };
      delete remaining[episode.root];
      return remaining;
    });
    if (loadNext) setQueuedEpisodeRoot(nextRoot);
    setNotice(nextRoot
      ? `已跳过：${episode.name}。${reason}正在载入下一条。`
      : `已跳过：${episode.name}。${reason}没有下一条可载入数据。`);
  }

  function nextAvailableEpisodeRoot(episodeRoot: string): string | null {
    const episodes = scan?.episodes ?? [];
    const index = episodes.findIndex((episode) => episode.root === episodeRoot);
    if (index < 0) return null;
    return episodes
      .slice(index + 1)
      .find((episode) => !skippedEpisodeRoots[episode.root])?.root ?? null;
  }

  function restoreSkippedEpisodes() {
    const count = Object.keys(skippedEpisodeRoots).length;
    setSkippedEpisodeRoots({});
    if (count) setNotice(`已恢复 ${count} 条跳过的数据。`);
  }

  const handleFrameUnavailable = useCallback((streamName: string, frameId: number) => {
    if (!data) return;
    const episode = data.summary;
    const stream = data.summary.streams.find((candidate) => candidate.name === streamName);
    const message = `FRAME_UNAVAILABLE: ${episode.name} 的 ${stream?.label ?? streamName} 帧 ${frameId} 不可用，已停止加载。请在左侧跳过该数据。`;
    setEpisodeSourceStates((current) => ({ ...current, [data.summary.root]: "error" }));
    resetLoadedData();
    void reportFailure("load_frame", new Error(message), data.summary.root);
  }, [data]);

  function resetLoadedData() {
    settledFrameByStreamRef.current.clear();
    playbackModeByStreamRef.current.clear();
    bufferedFramesByStreamRef.current.clear();
    playbackPrimedRef.current = false;
    setData(null);
    setReport(null);
    setAnnotation(null);
    setSelectedTaskId(null);
    setPlaying(false);
    setPlaybackPrimed(false);
    setPlaybackBufferPercent(0);
    setPlaybackBufferStreamLabel("Camera 0");
    setExportResult(null);
    setCurrentFrame(0);
    setClipStartFrame(0);
    setClipEndFrame(0);
    setLoadedEpisodeSourceRoot(null);
  }

  function resetWorkspaceData() {
    episodeFocusRestoreToken.current += 1;
    setEpisodeFocusRestoreRequest(null);
    resetLoadedData();
    setSourcePath("");
    setScan(null);
    setSelectedEpisode(null);
    setEpisodeSourceStates({});
    setSkippedEpisodeRoots({});
    setPendingAnnotationConfirmation(null);
    setQueuedEpisodeRoot(null);
    setOperationErrors([]);
    setHistoryOpen(false);
    setProfileEditorOpen(false);
    setCurrentOperationError(false);
    setTasks([]);
    setSelectedTaskId(null);
    setAnnotationTags({});
    setAnnotatedEpisodes([]);
    setBatchSelectedIds([]);
    setBatchExportResult(null);
    setBatchLoading(false);
    batchSelectionInitialized.current = false;
    setView("review");
    setError("");
    setNotice("");
    setUpdateInfo(null);
    setUpdatePhase("idle");
    setUpdateError("");
    setUpdateErrorVisible(false);
    didAutoLoad.current = false;
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
      resetWorkspaceData();
      setAuthStatus((current) => current ? { ...current, currentUser: null } : current);
    } catch (reason) {
      await reportFailure("logout", reason);
    }
  }

  async function saveCurrentDisplayName(displayName: string) {
    const user = await updateCurrentDisplayName(displayName);
    setAuthStatus((current) => current ? { ...current, currentUser: user } : current);
    setProfileEditorOpen(false);
  }

  async function chooseWorkspaceMode() {
    if (operationScopeRef.current.current()) return;
    try {
      const status = await clearWorkspaceMode();
      resetWorkspaceData();
      setAuthStatus(status);
    } catch (reason) {
      await reportFailure("clear_workspace_mode", reason, "");
    }
  }

  async function activateWorkspaceMode(mode: WorkspaceMode) {
    const status = await selectWorkspaceMode(mode);
    resetWorkspaceData();
    setAuthStatus(status);
  }

  function resetPlaybackPreparation() {
    bufferedFramesByStreamRef.current.clear();
    playbackPrimedRef.current = false;
    setPlaybackPrimed(false);
    setPlaybackBufferPercent(0);
  }

  function seekFrame(frame: number) {
    if (!data) return;
    const next = Math.max(clipStartFrame, Math.min(clipEndFrame, Math.round(frame)));
    setPlaying(false);
    resetPlaybackPreparation();
    frameRef.current = next;
    setCurrentFrame(next);
  }

  function moveFrame(delta: number) {
    if (!data) return;
    seekFrame(frameRef.current + delta);
  }

  function togglePlayback() {
    if (!data) return;
    // Timeline seeks update frameRef synchronously while React may not have
    // committed currentFrame yet. Reading currentFrame here can therefore
    // mistake a fresh middle seek for the previous end frame and restart the
    // first play attempt from the clip beginning.
    if (!playing) {
      const startFrame = playbackStartFrame(frameRef.current, clipStartFrame, clipEndFrame);
      if (startFrame !== frameRef.current) {
        frameRef.current = startFrame;
        setCurrentFrame(startFrame);
      }
    }
    const nextPlaying = !playing;
    resetPlaybackPreparation();
    setPlaying(nextPlaying);
  }

  useEffect(() => {
    if (!data) return;
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveFrame(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveFrame(1);
      } else if (event.key === "[") {
        event.preventDefault();
        updateClipStart(frameRef.current);
      } else if (event.key === "]") {
        event.preventDefault();
        updateClipEnd(frameRef.current);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [data, clipStartFrame, clipEndFrame, playing]);

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
    auditActivity("clip_changed");
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
    auditActivity("clip_changed");
  }

  function auditActivity(action: AnnotationAuditAction, taskId = selectedTaskId ?? annotation?.taskId ?? "", trajectoryCode = annotation?.trajectoryCode ?? "") {
    if (!data || authStatus?.workspaceMode !== "managed" || !authStatus.currentUser) return;
    void recordAnnotationAudit({
      taskId,
      trajectoryCode,
      action,
      occurredAtMs: Date.now(),
    }).then(() => setAuditUploadPending(false)).catch((reason) => {
      setAuditUploadPending(true);
      setError(`本地操作已保留，但监管记录尚未上传：${reason instanceof Error ? reason.message : String(reason)}`);
    });
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
    auditActivity("export_started");
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
      auditActivity("export_finished");
      setNotice(`已导出 ${exportFormatLabel(exportFormat)}（帧 ${range.startFrame}–${range.endFrame}）：${shortPath(result.outputPath, 72)}`);
    } catch (reason) {
      await reportFailure("export_episode", reason, data.summary.root, owner);
    } finally {
      finishOperation(owner);
    }
  }

  async function refreshAnnotatedEpisodeList() {
    if (!workspaceActive || (isManagedWorkspace && !authStatus?.currentUser)) return;
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
      setAnnotationTags(Object.fromEntries(
        listed.map((item) => [item.annotation.episodeRoot, item.annotation]),
      ));
      setBatchSelectedIds((current) => initializeSelection
        ? availableIds
        : current.filter((episodeId) => availableSet.has(episodeId)));
    } catch (reason) {
      await reportFailure("list_annotated_episodes", reason, "");
    } finally {
      setBatchLoading(false);
    }
  }

  async function refreshAnnotationTags() {
    if (!workspaceActive || (isManagedWorkspace && !authStatus?.currentUser)) return;
    try {
      const listed = await listAnnotatedEpisodes();
      setAnnotationTags(Object.fromEntries(
        listed.map((item) => [item.annotation.episodeRoot, item.annotation]),
      ));
    } catch (reason) {
      await reportFailure("list_annotation_tags", reason, "");
    }
  }

  function handleAnnotationSaved(saved: EpisodeAnnotation) {
    setAnnotation(saved);
    setAnnotationTags((current) => ({ ...current, [saved.episodeRoot]: saved }));
    setAnnotatedEpisodes((current) => {
      const next = current.filter((item) => item.annotation.episodeRoot !== saved.episodeRoot);
      return [{ annotation: saved, sourceAvailable: true }, ...next];
    });
    if (isManagedWorkspace && authStatus?.currentUser?.role === "operator") void refreshAssignedActivity(assignedActivityDate);
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
  const visibleEpisodes = scan?.episodes.filter((episode) => !skippedEpisodeRoots[episode.root]) ?? [];
  const skippedEpisodeCount = (scan?.episodes.length ?? 0) - visibleEpisodes.length;
  const selectedTaskTemplate = tasks.find((task) => task.id === (selectedTaskId ?? annotation?.taskId)) ?? null;

  useEffect(() => {
    if (!selectedEpisode) return;
    const assignedTask = assignedEpisodeTasks[selectedEpisode.root];
    if (!assignedTask) return;
    const assignedTaskKey = assignedTask.toLowerCase();
    const definition = tasks.find((task) => (
      task.label.toLowerCase() === assignedTaskKey
      || task.codePrefix.toLowerCase() === assignedTaskKey
    ));
    if (definition) setSelectedTaskId(definition.id);
  }, [assignedEpisodeTasks, selectedEpisode?.root, tasks]);

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

  if (!workspaceMode || (isManagedWorkspace && !authStatus.currentUser)) {
    return (
      <AuthScreen
        workspaceMode={workspaceMode}
        userCenter={authStatus.userCenter}
        allowDemoRegistration={!isTauriRuntime()}
        onWorkspaceModeSelected={activateWorkspaceMode}
        onChooseMode={chooseWorkspaceMode}
        onUserCenterConfigured={(status) => setAuthStatus((current) => ({
          workspaceMode: current?.workspaceMode ?? "managed",
          userCenter: status,
          currentUser: current?.currentUser ?? null,
        }))}
        onAuthenticated={(user) => setAuthStatus((current) => ({
          workspaceMode: current?.workspaceMode ?? "managed",
          userCenter: current?.userCenter ?? { configured: false, endpoint: null, serviceId: null },
          currentUser: user,
        }))}
      />
    );
  }

  const currentUser = authStatus.currentUser;
  if (isManagedWorkspace && currentUser?.role === "admin") {
    return <SupervisionDashboard currentUser={currentUser} onLogout={logout} />;
  }
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
          <button
            className="version-history-trigger"
            type="button"
            onClick={() => setReleaseHistoryOpen(true)}
            title="查看历史版本"
            aria-label="查看历史版本"
          >
            <BookOpenText size={14} />
            <span>历史版本</span>
          </button>
        </div>
        <div className="source-display">
          <HardDrive size={16} />
          <span title={sourcePath}>{sourcePath ? shortPath(sourcePath, 58) : isManagedWorkspace && currentUser?.role === "operator" ? "首次使用请配置本机 NAS 目录" : "未选择 SD 卡"}</span>
          {sourcePath ? <span className="source-dot" /> : null}
        </div>
        <div className="topbar-actions">
          <StatusBadge status={status} />
          {isManagedWorkspace && currentUser ? (
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
          ) : null}
          <button className="button button-secondary" type="button" onClick={() => void chooseSource()} disabled={busy}>
            <FolderOpen size={16} />
            {isManagedWorkspace && currentUser?.role === "operator" ? "选择数据目录" : "选择 SD 卡"}
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
          {isOfflineWorkspace ? <span className="workspace-mode-indicator">离线模式</span> : null}
          {isManagedWorkspace && currentUser ? (
            <>
              {currentUser.role === "operator" ? (
                <button
                  className="account-summary account-summary-button"
                  type="button"
                  onClick={() => setProfileEditorOpen(true)}
                  title="修改当前显示名称"
                  aria-label={`修改当前显示名称，当前为 ${currentUser.displayName}`}
                >
                  <UserRound size={16} />
                  <span><strong>{currentUser.displayName}</strong><small>@{currentUser.username}</small></span>
                  <Pencil className="account-edit-mark" size={12} />
                </button>
              ) : (
                <div className="account-summary" title={`@${currentUser.username}`}>
                  <UserRound size={16} />
                  <span><strong>{currentUser.displayName}</strong><small>@{currentUser.username}</small></span>
                </div>
              )}
              {currentUser.role === "operator" ? (
                <button className="icon-button personal-task-trigger" type="button" onClick={() => setPersonalTaskOpen((open) => !open)} title="查看个人任务详情" aria-label="查看个人任务详情" aria-expanded={personalTaskOpen}>
                  <ListChecks size={16} />
                </button>
              ) : null}
              <button className="icon-button" type="button" onClick={() => void logout()} disabled={busy} title="退出登录" aria-label="退出登录">
                <LogOut size={16} />
              </button>
            </>
          ) : null}
          <button className="icon-button" type="button" onClick={() => void chooseWorkspaceMode()} disabled={busy} title="切换工作模式" aria-label="切换工作模式">
            <Workflow size={16} />
          </button>
        </div>
      </header>

      {isManagedWorkspace && currentUser?.role === "operator" && personalTaskOpen ? (
        <div className="personal-task-overlay" role="presentation" onClick={() => setPersonalTaskOpen(false)}>
        <PersonalTaskPanel
          sourceRoot={assignedSourceRoot}
          tasks={assignedTasks}
          activity={assignedActivity}
          date={assignedActivityDate}
          loading={assignedActivityLoading}
          onDateChange={changeAssignedActivityDate}
          onRefresh={() => void refreshAssignedActivity(assignedActivityDate)}
          onChooseSource={() => void chooseSource()}
          onContinue={() => void continueAssignedTask()}
          onNext={() => void openNextAssignedTask()}
          onClose={() => setPersonalTaskOpen(false)}
        />
        </div>
      ) : null}

      {isManagedWorkspace && currentUser?.role === "operator" && profileEditorOpen ? (
        <DisplayNameDialog
          currentUser={currentUser}
          onSave={saveCurrentDisplayName}
          onClose={() => setProfileEditorOpen(false)}
        />
      ) : null}

      {releaseHistoryOpen ? (
        <ReleaseHistoryDialog
          currentVersion={updateInfo?.currentVersion ?? APP_VERSION}
          releases={releaseHistory}
          onClose={() => setReleaseHistoryOpen(false)}
        />
      ) : null}

      {historyOpen ? (
        <OperationHistoryPanel
          records={operationErrors}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {isManagedWorkspace && updatePhase === "failed" && updateErrorVisible ? (
        <div className="alert-banner alert-notice update-alert" role="status">
          <CircleAlert size={17} />
          <span>{updateError}。当前本地功能仍可使用。</span>
          <span className="alert-actions">
            <button type="button" className="text-button" onClick={() => void runAutomaticUpdate()} disabled={busy}>重试</button>
            <button type="button" className="text-button" onClick={() => setUpdateErrorVisible(false)}>关闭</button>
          </span>
        </div>
      ) : null}
      {auditUploadPending ? (
        <div className="alert-banner alert-notice" role="status">
          <CircleAlert size={17} />
          <span>本地未上传：标注与草稿仍保留在当前电脑，恢复用户中心连接后的下一次操作会重新建立监管活动。</span>
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
            <div className="sidebar-heading-actions">
              {skippedEpisodeCount ? (
                <button className="icon-button" type="button" onClick={restoreSkippedEpisodes} disabled={busy} title="恢复跳过的数据" aria-label="恢复跳过的数据">
                  <RotateCcw size={17} />
                </button>
              ) : null}
              <button
                className="icon-button"
                type="button"
                onClick={() => void (sourcePath ? openSource(sourcePath, true) : chooseSource())}
                disabled={busy}
                title="重新扫描"
                aria-label="重新扫描"
              >
                <RotateCcw size={17} />
              </button>
            </div>
          </div>
          <div className="sidebar-path" title={sourcePath}>{sourcePath ? shortPath(sourcePath, 38) : "等待 SD 卡"}</div>
          {progress ? <ProgressStrip progress={progress} onCancel={() => void cancelCurrentOperation()} /> : null}
          <div className="episode-list">
            {visibleEpisodes.length ? (
              visibleEpisodes.map((episode) => {
                const sourceState = episodeSourceStates[episode.root] ?? "available";
                const savedAnnotation = annotationTags[episode.root];
                const activationHint = sourceState === "error"
                  ? "单击选择；双击或按 Enter/空格重试读取"
                  : "单击选择；双击或按 Enter/空格进入回放";
                const episodeTitle = savedAnnotation
                  ? `已标注 · ${savedAnnotation.trajectoryCode}；${activationHint}`
                  : activationHint;
                return (
                  <div className="episode-entry" key={episode.root}>
                    <button
                      type="button"
                      className={`episode-item${selectedEpisode?.root === episode.root ? " selected" : ""}`}
                      ref={(element) => {
                        if (element) episodeButtonRefs.current.set(episode.root, element);
                        else episodeButtonRefs.current.delete(episode.root);
                      }}
                      aria-pressed={selectedEpisode?.root === episode.root}
                      disabled={busy}
                      title={episodeTitle}
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
                        {savedAnnotation ? (
                          <span
                            className="episode-annotation-tag"
                            title={`已标注 · ${savedAnnotation.trajectoryCode} · r${savedAnnotation.revision}`}
                            aria-label="已标注"
                          >
                            已标注
                          </span>
                        ) : null}
                        <EpisodeSourceMark state={sourceState} />
                        <ChevronRight size={15} />
                      </span>
                      <span className="episode-item-meta">
                        {episode.indexed
                          ? `${episode.stateCount} states · ${formatBytes(episode.totalBytes)}`
                          : episode.stateCount
                            ? `${episode.stateCount} states · 快速预览`
                            : "待读取"}
                      </span>
                      <span className="stream-dots">
                        {episode.streams.map((stream) => (
                          <i
                            className={episode.indexed
                              ? stream.frameCount ? "dot-ok" : "dot-error"
                              : stream.frameCount ? "dot-ok" : ""}
                            key={stream.name}
                            title={stream.label}
                          />
                        ))}
                      </span>
                    </button>
                    <button
                      className="icon-button episode-skip"
                      type="button"
                      onClick={() => skipEpisode(episode)}
                      disabled={busy}
                      title="跳过数据"
                      aria-label={`跳过 ${episode.name}`}
                    >
                      <EyeOff size={15} />
                    </button>
                  </div>
                );
              })
            ) : skippedEpisodeCount ? (
              <div className="sidebar-empty sidebar-skipped">
                <EyeOff size={23} />
                <span>已跳过 {skippedEpisodeCount} 条数据</span>
                <button className="text-button" type="button" onClick={restoreSkippedEpisodes}>恢复显示</button>
              </div>
            ) : (
              <div className="sidebar-empty">
                <HardDrive size={23} />
                <span>未加载记录</span>
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            <div><span>文件</span><strong>{selectedEpisode?.indexed ? selectedEpisode.totalFiles : "—"}</strong></div>
            <div><span>容量</span><strong>{selectedEpisode?.indexed ? formatBytes(selectedEpisode.totalBytes) : "—"}</strong></div>
            <div><span>介质</span><strong>{scan ? driveTypeLabel(scan.volume.driveType) : "—"}</strong></div>
            <div><span>文件系统</span><strong>{scan?.volume.filesystem ?? "未知"}</strong></div>
          </div>
        </aside>

        <main className="main-content">
          {pendingAnnotationConfirmation ? (
            <AnnotationWarningGate
              episode={pendingAnnotationConfirmation.data.summary}
              warnings={annotationConfirmationWarnings(pendingAnnotationConfirmation.report)}
              onContinue={() => void confirmAnnotationAfterWarning()}
              onSkip={skipPendingAnnotation}
            />
          ) : data || view === "batch" ? (
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
                    <div className={`replay-visual-row${data.skeleton || data.skeletonError ? " with-skeleton" : ""}`}>
                      <div className={`camera-grid stream-count-${availableStreams.length}`}>
                        {availableStreams.map((stream, index) => (
                          <FramePanel
                            key={stream.name}
                            root={data.summary.root}
                            stream={stream}
                            frameId={playing && stream.name !== primaryStreamName
                              ? secondaryPlaybackFrame(currentFrame, minFrame, playbackFps)
                              : currentFrame}
                            playing={playing}
                            nativePlaybackEnabled={playing && playbackPrimed}
                            readAheadEnabled={playing && stream.name === primaryStreamName}
                            playbackEndFrame={clipEndFrame}
                            playbackFps={playbackFps}
                            speed={speed}
                            className={`camera-${index}`}
                            onFrameSettled={playing ? undefined : handleFrameSettled}
                            onFrameUnavailable={handleFrameUnavailable}
                            onPlaybackModeChange={handlePlaybackModeChange}
                            onBufferProgress={handleBufferProgress}
                            onSourceFpsChange={handleSourceFpsChange}
                          />
                        ))}
                      </div>
                      <div className="skeleton-side-panel">
                        {data.skeleton ? <SkeletonViewer skeleton={data.skeleton} frameId={currentFrame} /> : null}
                        {!data.skeleton && data.skeletonError ? (
                          <section className="skeleton-load-error" aria-label="骨架数据">
                            <strong>骨架数据不可用</strong>
                            <span>{data.skeletonError}</span>
                          </section>
                        ) : null}
                      </div>
                    </div>
                    {!playing ? (
                      <FrameRenderProgress
                        frameId={currentFrame}
                        settled={frameRenderProgress.root === data.summary.root && frameRenderProgress.frameId === currentFrame
                          ? frameRenderProgress.settled
                          : 0}
                        total={availableStreams.length}
                      />
                    ) : null}
                    <AnnotationPanel
                      sourcePath={data.summary.root}
                      tasks={tasks}
                      annotation={annotation}
                      currentUser={currentUser}
                      offlineMode={isOfflineWorkspace}
                      busy={busy}
                      onTaskCreated={(task) => setTasks((current) => [...current, task])}
                      onTaskDeleted={(taskId) => {
                        setTasks((current) => current.filter((task) => task.id !== taskId));
                        setSelectedTaskId((current) => current === taskId ? null : current);
                        setAnnotation((current) => (current?.taskId === taskId ? null : current));
                      }}
                      onTaskSelected={setSelectedTaskId}
                      onTasksImported={setTasks}
                      onSaved={handleAnnotationSaved}
                      onError={setError}
                      onNotice={setNotice}
                      onActivity={auditActivity}
                    />
                    <SegmentAnnotationEditor
                      data={data}
                      annotation={annotation}
                      templateTaskId={selectedTaskTemplate?.id ?? null}
                      templateSegments={selectedTaskTemplate?.defaultSegments ?? []}
                      currentFrame={currentFrame}
                      minFrame={minFrame}
                      maxFrame={maxFrame}
                      clipStartFrame={clipStartFrame}
                      clipEndFrame={clipEndFrame}
                      busy={busy}
                      playbackControls={(
                        <>
                          <div className="transport-buttons">
                            <button className="icon-button" type="button" onClick={() => moveFrame(-1)} title="上一帧" aria-label="上一帧"><SkipBack size={17} /></button>
                            <button className="play-button" type="button" onClick={togglePlayback} title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
                            <button className="icon-button" type="button" onClick={() => moveFrame(1)} title="下一帧" aria-label="下一帧"><SkipForward size={17} /></button>
                          </div>
                          <span className="segment-frame-readout">帧 {currentFrame} / {maxFrame}</span>
                          {playing && !playbackPrimed ? (
                            <span className="playback-buffering">
                              预缓冲 {playbackBufferStreamLabel} {playbackBufferPercent}%
                            </span>
                          ) : null}
                          <span className="time-readout">{currentState ? formatStateTime(data, currentState.captureTimeNs) : "—"}</span>
                          <label className="speed-control">
                            <Gauge size={16} />
                            <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label="播放速度">
                              <option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×（正常速度）</option><option value={2}>2×</option>
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
                      onClipStartChange={updateClipStart}
                      onClipEndChange={updateClipEnd}
                      onClipReset={resetClipRange}
                      onSaved={handleAnnotationSaved}
                      onError={setError}
                      onNotice={setNotice}
                      onActivity={auditActivity}
                      onFrameChange={(frame) => {
                        seekFrame(Math.max(minFrame, Math.min(maxFrame, frame)));
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
                  validationReady={report !== null}
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
                : selectedEpisode.indexed
                  ? `${selectedEpisode.stateCount} 条状态 · ${formatBytes(selectedEpisode.totalBytes)} · ${selectedEpisode.streams.length} 路流`
                  : "待读取"}
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

function AnnotationWarningGate({
  episode,
  warnings,
  onContinue,
  onSkip,
}: {
  episode: EpisodeSummary;
  warnings: ValidationIssue[];
  onContinue: () => void;
  onSkip: () => void;
}) {
  return (
    <section className="annotation-warning-gate" aria-label="标注前数据警告">
      <header>
        <CircleAlert size={22} aria-hidden="true" />
        <div>
          <span className="section-kicker">ANNOTATION REVIEW</span>
          <h2>发现数据警告</h2>
          <p>{episode.name} 存在 {warnings.length} 项警告。确定要进入标注吗？</p>
        </div>
      </header>
      <div className="annotation-warning-list">
        {warnings.map((issue, index) => (
          <article key={`${issue.code}-${issue.scope}-${issue.frameId ?? "global"}-${index}`}>
            <div><code>{issue.code}</code><span>{issue.scope}</span>{issue.frameId !== null ? <span>帧 {issue.frameId}</span> : null}</div>
            <p>{issue.message}</p>
          </article>
        ))}
      </div>
      <footer>
        <button className="button button-secondary" type="button" onClick={onSkip}>不标注，跳到下一条</button>
        <button className="button button-primary" type="button" onClick={onContinue}>仍要标注</button>
      </footer>
    </section>
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

function FrameRenderProgress({
  frameId,
  settled,
  total,
}: {
  frameId: number;
  settled: number;
  total: number;
}) {
  if (!total) return null;
  const boundedSettled = Math.max(0, Math.min(total, settled));
  const percent = Math.round((boundedSettled / total) * 100);
  return (
    <div className="frame-render-progress" role="status" aria-live="polite">
      <span className="frame-render-progress-label">右侧画面</span>
      <div className="frame-render-track" aria-label={`帧 ${frameId} 已渲染 ${boundedSettled}/${total} 路`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="frame-render-progress-count">帧 {frameId} · {boundedSettled}/{total} 路</span>
    </div>
  );
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
    SOURCE_UNRESPONSIVE: "网络目录无响应",
    FRAME_UNAVAILABLE: "帧不可用",
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
    load_frame: "读取图像帧",
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

function DisplayNameDialog({
  currentUser,
  onSave,
  onClose,
}: {
  currentUser: UserIdentity;
  onSave: (displayName: string) => Promise<void>;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const normalized = displayName.trim();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalized || normalized === currentUser.displayName || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(normalized);
    } catch (reason) {
      setError(toMessage(reason));
      setSaving(false);
    }
  }

  return (
    <div className="profile-editor-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="profile-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
        <header>
          <div>
            <span className="section-kicker">ACCOUNT PROFILE</span>
            <h2 id="profile-editor-title">修改显示名称</h2>
            <p>监管端以此名称识别当前标注员工，账号 @{currentUser.username} 保持不变。</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={saving} title="关闭" aria-label="关闭显示名称编辑">
            <X size={16} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="current-display-name">显示名称</label>
          <input
            id="current-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={40}
            autoComplete="name"
            autoFocus
            required
          />
          <div className="profile-editor-meta"><span>@{currentUser.username}</span><span>{[...displayName].length} / 40</span></div>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <footer>
            <button className="button button-secondary" type="button" onClick={onClose} disabled={saving}>取消</button>
            <button className="button button-primary" type="submit" disabled={!normalized || normalized === currentUser.displayName || saving}>
              {saving ? "保存中" : "保存名称"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function ReleaseHistoryDialog({
  currentVersion,
  releases,
  onClose,
}: {
  currentVersion: string;
  releases: ReleaseHistoryEntry[];
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="version-history-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="version-history-dialog" role="dialog" aria-modal="true" aria-labelledby="version-history-title">
        <header>
          <div>
            <span className="section-kicker">发布记录</span>
            <h2 id="version-history-title">历史版本</h2>
            <p>只读展示发布记录，不会切换或降级当前应用。</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭历史版本" aria-label="关闭历史版本" autoFocus>
            <X size={16} />
          </button>
        </header>
        <div className="version-history-list">
          {releases.map((release) => (
            <article className="version-history-entry" key={release.version}>
              <div className="version-history-meta">
                <strong>v{release.version}</strong>
                {release.version === currentVersion ? <span>当前版本</span> : null}
                <time dateTime={release.date}>{release.date}</time>
              </div>
              <p className="version-history-summary">
                {RELEASE_SUMMARIES_ZH[release.version] ?? "此版本没有中文更新摘要。"}
              </p>
              {release.notes.length ? (
                <details className="version-history-details">
                  <summary>展开完整更新记录（{release.notes.length} 项）</summary>
                  <ul>
                    {release.notes.map((note, index) => <li key={`${release.version}-${index}`}>{note}</li>)}
                  </ul>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function hasUnavailableFrame(report: ValidationReport): boolean {
  return report.issues.some((issue) => UNAVAILABLE_FRAME_ISSUE_CODES.has(issue.code));
}

function hasUnusableTrajectory(report: ValidationReport): boolean {
  return report.issues.some((issue) => (
    issue.code === STATIC_TRAJECTORY_ISSUE_CODE
    || issue.code === UNAVAILABLE_TRAJECTORY_ISSUE_CODE
  ));
}

function annotationConfirmationWarnings(report: ValidationReport): ValidationIssue[] {
  return report.issues.filter((issue) => (
    issue.severity === "warning" && issue.code !== FRAME_JUMP_ISSUE_CODE
  ));
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
