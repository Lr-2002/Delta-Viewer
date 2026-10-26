import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import {
  Activity,
  BookOpenText,
  Check,
  ChevronRight,
  CircleAlert,
  EyeOff,
  FileSearch,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  Images,
  Video,
  ListChecks,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Timer,
  UserRound,
  Workflow,
  X,
} from "lucide-react";
import { AppUpdates } from "./components/AppUpdates";
import { MachineAnnotationPanel, flushMachineReviewSaves } from "./components/MachineAnnotationPanel";
import { AuthScreen } from "./components/AuthScreen";
import { AuditSyncNotice } from "./components/AuditSyncNotice";
import { SourceReviewNotice } from "./components/SourceReviewNotice";
import { BatchExportPanel } from "./components/BatchExportPanel";
import { BatchRejectionDialog, type RejectionTarget } from "./components/BatchRejectionDialog";
import { ChecksPanel } from "./components/ChecksPanel";
import { ExportPanel } from "./components/ExportPanel";
import { FramePanel } from "./components/FramePanel";
import { PreviewSettings } from "./components/PreviewSettings";
import { ProgressStrip } from "./components/ProgressStrip";
import { TaskCenter } from "./components/TaskCenter";
import { SkeletonViewer } from "./components/SkeletonViewer";
import { ClientPresence } from "./components/ClientPresence";
import { SupervisionDashboard } from "./components/SupervisionDashboard";
import { beginReviewAudit, getReviewSyncStatus, configureReviewAudit, endReviewAudit, observeReviewInteractions, pauseAndPersistReviewAudit, recordReviewInteraction, recordReviewSeek, retryReviewAudit, updateReviewFrame } from "./lib/review-audit";
import { TelemetryChart } from "./components/TelemetryChart";
import {
  APP_VERSION,
  resolveSourcePath,
  IS_DEVELOPMENT_EDITION,
  DEMO_ROOT,
  cancelTask,
  downloadAppUpdate,
  chooseDirectory,
  clearWorkspaceMode,
  confirmAction,
  exportAnnotatedEpisodes,
  exportEpisode,
  exportValidationReport,
  getAuthStatus,
  getAssignedSourceRoot,
  getAssignedTasks,
  flushPendingAnnotationAudits,
  installAppUpdate,
  isTauriRuntime,
  listAnnotatedEpisodes,
  listMyMachineReviews,
  getPendingSourceReviews,
  listOperationErrors,
  listTaskDefinitions,
  listAssignedTaskDefinitions,
  loadEpisodeAnnotation,
  loadEpisode,
  logoutLocalAccount,
  openCaptureWorkbench,
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
import {
  REMOTE_SECONDARY_READ_AHEAD_FRAMES,
} from "./lib/frame-cache";
import { formatBytes, shortPath } from "./lib/format";
import { getPlaybackFrameBounds, resolveIssueLocation } from "./lib/issue-locate";
import { OperationScope, type OperationToken } from "./lib/operationScope";
import {
  clampPlaybackFrame,
  nextFrameRenderProgress,
  nextPlaybackFrame,
  playbackAdvanceTimestamp,
  playbackFrameDue,
  playbackFrameDurationMs,
  playbackClockReady,
  primaryPlaybackFrameStep,
  playbackStartFrame,
} from "./lib/playback-clock";
import type {
  AnnotatedEpisodeSummary,
  AssignedTask,
  AnnotationAuditAction,
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

type View = "review" | "checks" | "export" | "batch" | "proofread";
type EpisodeSourceState = "available" | "loading" | "error";
type EpisodeLoadResult = "loaded" | "skipped";

interface PendingAnnotationConfirmation {
  data: EpisodeData;
  report: ValidationReport;
  sourceEpisodeRoot: string;
  minFrame: number;
  maxFrame: number;
}

interface ReviewResumeState {
  sourceRoot: string;
  episodeRoot: string;
  active: boolean;
  updatedAtMs: number;
}

const REVIEW_RESUME_KEY_PREFIX = "dohc-viewer.review-resume.v1:";

function reviewResumeKey(username: string) {
  return `${REVIEW_RESUME_KEY_PREFIX}${encodeURIComponent(username)}`;
}

function readReviewResume(username: string): ReviewResumeState | null {
  try {
    const raw = localStorage.getItem(reviewResumeKey(username));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ReviewResumeState>;
    if (!value || typeof value.sourceRoot !== "string" || !value.sourceRoot.trim() || typeof value.episodeRoot !== "string" || !value.episodeRoot.trim() || typeof value.active !== "boolean") return null;
    return { sourceRoot: value.sourceRoot, episodeRoot: value.episodeRoot, active: value.active, updatedAtMs: Number(value.updatedAtMs) || 0 };
  } catch {
    return null;
  }
}

function sameReviewPath(left: string, right: string) {
  const key = (path: string) => {
    let value = path.replaceAll("\\", "/").replace(/\/+$/, "");
    if (value.startsWith("//?/UNC/")) value = `//${value.slice(8)}`;
    else if (value.startsWith("//?/")) value = value.slice(4);
    return value.startsWith("//") || /^[a-z]:/i.test(value) ? value.toLowerCase() : value;
  };
  return key(left) === key(right);
}

function writeReviewResume(username: string, state: Omit<ReviewResumeState, "updatedAtMs">) {
  try {
    localStorage.setItem(reviewResumeKey(username), JSON.stringify({ ...state, updatedAtMs: Date.now() }));
  } catch {
    // A full local store must not block loading or saving review data.
  }
}



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
  "1.3.3": "admin 内测账号整合管理权限，顶部切换管理／测试模式；账号管理展示各设备运行版本、在线状态及最近上报，支持全部、多选和单个账号推送更新弹窗，离线提醒重新连接后补送。",
  "1.3.2": "动作片段只存本机草稿，通过后才写正式 JSON；补全多机标来源切换兼容，各来源草稿独立保存，只有已提交但尚未写回的结论才阻止跨来源重复提交。",
  "1.3.1": "动作片段的描述、边界、增删和切割只保存本机草稿，点击审核通过后才写入正式 JSON；不通过仅提交结论及原因，不发布未批准的片段修改。草稿按账号恢复，未审核草稿不能通过待写回入口发布。",
  "1.3.0": "片段边界反向拖动支持在松手保存后逐段复原原范围和描述，恢复后保持待审核；修正云端 Ubuntu 软件源下载过慢导致发布阻塞的问题。1.2.9 未生成安装包。",
  "1.2.9": "片段边界反向拖动可逐段复原被覆盖的范围和描述，松手保存后继续调整同一边界也能恢复；预览与保存一致，恢复后保持待审核。",
  "1.2.8": "包含全视频边界拖动、本机暂存审核统计、批量原因标签及账号排序；修复新增标签后旧批量交互回归入口遗漏，恢复完整三平台发布。",
  "1.2.7": "片段边界支持跨多个片段拖动，拖动预览按屏幕刷新、松手后保存；本机可靠暂存的审核结论在用户中心接收后计入审核统计，NAS 写回不重复计数；批量不通过共用单条原因标签与账号排序。",
  "1.2.6": "任务中心仅在具体批次行显示审核领取人；根目录和上级分组移除领取人、人数及已领取批次数汇总。",
  "1.2.5": "修复目录迁移映射缺失时历史领取人显示错误：使用已核实备份并在无法确认时阻止误领；分组行汇总子批次领取人。服务器全量校准期间继续更新已知数据 QC 并处理刷新请求，避免进度长时间停在旧结果。",
  "1.2.4": "修复机标片段超出当前视频时无法继续审核的问题：新增越界片段核对及人工确认处理入口，保留原始机标和本机恢复备份，保存为待审核草稿；回放核对后方可通过。不按比例缩放或虚构缺失帧。",
  "1.2.3": "修复旧分组根目录导致任务中心目录和历史领取人不显示；展示批次路径。侧栏区分本机待写结果与已写入审核，确认写回后立即刷新本人审核标记。包含独立骨架片段功能。",
  "1.2.2": "新增独立骨架片段描述入口，支持增删、裁剪、边界微调与快捷键；预置六个标签并可自定义，保存至 skeleton.description.json，不设置审核结论、不改变 QC。补齐三组目录改名后的独立批次识别及连续迁移映射。",
  "1.2.1": "包含三支线目录适配与人工审核信息精简；补齐新增目录解析接口的浏览器测试，兼容 Windows 标准路径和扩展路径，迁移前本机待写结果仍可恢复。1.2.0 因 CI 测试替身未更新而未发布安装包。",
  "1.2.0": "适配三支线分组目录，批次独立领取，保留已确认迁移前的批次归属；修复旧路径恢复、子批次加载和 desorption.json 保存。人工结果审核信息只保留结论、审核人、审核日期，恢复及并发技术记录独立保存；新增删除片段继续写入实际数组，保留本机待写及冲突保护。",
  "1.1.9": "NAS 满盘或写入失败时，审核结果先可靠保存本机，成功后可继续审核；后台检查恢复并弹窗提醒确认写回。待写结果按账号隔离、重启保留，冲突不覆盖；任务进度以 NAS 已写 QC 为准。新增容量限时检查和明确故障原因，用户中心操作记录独立补传。",
  "1.1.8": "修复未审核数据右下角误显示已通过：结论以当前目录 QC 为准，历史修订单独标注；人工结果缺失时不再把本机草稿显示为已保存，状态读取失败明确显示未知；批量不通过不再因过期草稿误报内容已改变，保留真实并发修改保护。",
  "1.1.7": "修复任务中心下滑时统计提示遮挡目录，新增领取人、采集日期范围和批次名称组合查询；刷新使用专属服务器回执及对应索引，避免 SMB 旧缓存导致长时间等待。",
  "1.1.6": "修复任务中心刷新无反馈和目录替换后统计漏更新：刷新可请求服务器核对展开或本人领取批次的 QC，明确显示等待、完成及失败；读取超时保留结果并可重试，不扫描媒体。",
  "1.1.5": "编号差异提示支持按账号和当前机标忽略、随时恢复查看；更新摘要改为平滑弹出的消息通知，自动收起且停留时暂停，完整更新记录仍可查看。",
  "1.1.4": "修复局部机标属性缺少 value 导致整条无法加载；兼容缺名、重复和异常属性，保留有效动作描述与原始字段，显示可展开核对提示。",
  "1.1.3": "目录移动、编号或指纹差异不再阻断机标；自动尝试可读来源并适配实际帧数，兼容旧人工记录及草稿，恢复前保留原记录，保存错误指出具体片段。",
  "1.1.2": "修复目录编号变更后机标无法加载：来源指纹及帧数核验一致时兼容读取，显示编号差异；无法核实仍阻止误配，保留原机标及人工结果。",
  "1.1.1": "修复 GitHub 更新检查的系统代理兼容性；短暂网络异常自动重试，取消重复清单请求，并明确显示失败环节与原因。",
  "1.1.0": "修复任务中心新增目录漏更新，已完成批次隐藏“仅未审核”；本版 1.1.0，后续末位满 9 进位。",
  "1.0.63": "更新改从 GitHub 正式 Release 获取；启动后台检查，主动下载，保存后重启安装，并显示一次新版摘要。",
  "1.0.15": "新增不通过原因选择和自定义原因，审核记录清理冗余字段，统一唯一修订编号与中文修改摘要，修复时间轴相邻片段同色。",
  "1.0.13": "补丁：收紧四区工作台布局，缩小状态图，优化右侧片段滚动和审核操作区，让更多内容在当前窗口可见。",
  "1.0.12": "补丁：将人工审核结论写入数据根目录 session.json，修复删除片段输出和网络目录复核保存。",
  "1.0.10": "补丁：新增片段与分帧，完善空格、方向键和 Enter 操作，区分片段/全局播放，并压缩状态图和右侧编辑栏。",
  "1.0.9": "补丁：调整四区回放布局，支持目录收起，人工复核输出 description.json 并记录 QC。",
  "0.17.64": "优化 NAS 上逐帧 JPEG 数据的播放：缩短中间定位后的主画面预缓冲，并为四路小画面增加有界网络预读。",
  "0.17.61": "五路 MP4 分别使用持续原生播放器，修复 Camera 1/2 首次播放需暂停后重试的问题。",
  "0.17.60": "重构监管工作台视觉层级与状态反馈，强化运营指标、异常告警和窄窗口可读性。",
  "0.17.59": "支持可移动 U 盘直读、离线局域网用户中心迁移，以及 Camera 0 原生连续 MP4 回放与中间定位。",
  "0.17.58": "支持从日期顶层目录和 DOHC1TB 批量根目录直接加载混合 MP4/segment BIN 真实记录，并按 batch 时间轴同步回放。",
  "0.17.57": "新增 segment BIN 文件夹直读：数值排序并连续加载全部分段，复用 T265 位姿与 JPEG 回放，并校验记录结构和 CRC。",
  "0.17.56": "修复 NAS 网络挂载无响应时标注账号自动加载长期锁死界面的问题，失败后可继续退出、重新配置或导入数据。",
  "0.17.55": "批量任务分配新增整文件夹与多任务数量双模式，截止时间改为日期并在当日显示“今天”。",
  "0.17.54": "新增任务运营驾驶舱、批量与速度建议分配、异常处置、独立质量复核、隐私安全报表和标注员快捷任务队列。",
  "0.17.53": "支持审核员注册和当前姓名修改；监管分配重复任务时确认，并默认选择任务文件夹全部数量。",
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
  const [managementMode, setManagementMode] = useState(false);
  useEffect(() => setManagementMode(false), [authStatus?.currentUser?.username]);
  const [authStartupError, setAuthStartupError] = useState("");
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [assignedTasks, setAssignedTasks] = useState<AssignedTask[]>([]);
  const [personalTaskOpen, setPersonalTaskOpen] = useState(false);
  const [batchReviewRevision, setBatchReviewRevision] = useState(0);
  const [batchRejection, setBatchRejection] = useState<{ folder?: string; selected?: RejectionTarget[] } | null>(null);
  const [batchRejectionSelection, setBatchRejectionSelection] = useState<Record<string, RejectionTarget>>({});
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [assignedEpisodeTasks, setAssignedEpisodeTasks] = useState<Record<string, string>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [annotation, setAnnotation] = useState<EpisodeAnnotation | null>(null);
  const [annotationReadyRoot, setAnnotationReadyRoot] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<EpisodeSummary | null>(null);
  const [episodeSourceStates, setEpisodeSourceStates] = useState<Record<string, EpisodeSourceState>>({});
  const [skippedEpisodeRoots, setSkippedEpisodeRoots] = useState<Record<string, true>>({});
  const [queuedEpisodeRoot, setQueuedEpisodeRoot] = useState<string | null>(null);
  const [loadedEpisodeSourceRoot, setLoadedEpisodeSourceRoot] = useState<string | null>(null);
  const [data, setData] = useState<EpisodeData | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mcap");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [annotationTags, setAnnotationTags] = useState<Record<string, EpisodeAnnotation>>({});
  const [pendingReviewEpisodes, setPendingReviewEpisodes] = useState<Record<string, string>>({});
  const [reviewedEpisodes, setReviewedEpisodes] = useState<Record<string, "pending" | "approved" | "rejected">>({});
  const [annotatedEpisodes, setAnnotatedEpisodes] = useState<AnnotatedEpisodeSummary[]>([]);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [batchExportFormat, setBatchExportFormat] = useState<ExportFormat>("mcap");
  const [batchExportResult, setBatchExportResult] = useState<BatchExportResult | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [view, setView] = useState<View>("proofread");
  const [pendingSourceRestore, setPendingSourceRestore] = useState<string | null>(null);
  const reviewUnsaved = useRef(false);
  const [reviewHasUnsaved, setReviewHasUnsaved] = useState(false);
  const handleReviewUnsaved = useCallback((value: boolean) => { reviewUnsaved.current = value; setReviewHasUnsaved(value); }, []);
  const [metric, setMetric] = useState<MetricKey>("position");
  const [currentFrame, setCurrentFrame] = useState(0);
  const [clipStartFrame, setClipStartFrame] = useState(0);
  const [clipEndFrame, setClipEndFrame] = useState(0);
  const [machinePreviewRange, setMachinePreviewRange] = useState<ExportRange | null>(null);
  const [speed, setSpeed] = useState(1);
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [operationBusy, setBusy] = useState(false);
  const [sourcePublishing, setSourcePublishing] = useState(false);
  const busy = operationBusy || Boolean(batchRejection) || sourcePublishing;
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [auditUploadPending, setAuditUploadPending] = useState(false);
  const [auditUploadError, setAuditUploadError] = useState("");
  const [currentOperationError, setCurrentOperationError] = useState(false);
  const [operationErrors, setOperationErrors] = useState<OperationErrorRecord[]>([]);
  const workspaceMode = authStatus?.workspaceMode ?? null;
  const workspaceActive = workspaceMode !== null;
  const isManagedWorkspace = workspaceMode === "managed";
  const isOfflineWorkspace = workspaceMode === "offline";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);
  const [releaseHistory, setReleaseHistory] = useState<ReleaseHistoryEntry[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("dohc.sidebar.collapsed") === "1");
  const [sidebarScale, setSidebarScale] = useState(() => Number(localStorage.getItem("dohc.sidebar.scale") ?? "1"));
  useEffect(() => { localStorage.setItem("dohc.sidebar.collapsed", sidebarCollapsed ? "1" : "0"); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem("dohc.sidebar.scale", String(sidebarScale)); }, [sidebarScale]);

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
  const skeletonFramePresenterRef = useRef<((frameId: number) => void) | null>(null);
  const primaryNativeClockRef = useRef(false);
  const settledFrameByStreamRef = useRef(new Map<string, number>());
  const [playbackPrimed, setPlaybackPrimed] = useState(false);
  const [primaryBuffering, setPrimaryBuffering] = useState(false);
  const [sourceFpsByStream, setSourceFpsByStream] = useState<Record<string, number>>({});
  const didAutoLoad = useRef(false);
  const operationScopeRef = useRef(new OperationScope());
  const sourcePickerOpenRef = useRef(false);
  const sourceNavigationVersion = useRef(0);
  const episodeLoadInFlight = useRef(false);
  const episodeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const episodeFocusRestoreToken = useRef(0);
  const [episodeFocusRestoreRequest, setEpisodeFocusRestoreRequest] = useState<{
    episodeRoot: string;
    token: number;
  } | null>(null);
  const batchSelectionInitialized = useRef(false);
  const estimatedFps = useMemo(() => estimateFrameRate(data?.states ?? []), [data]);
  const cameraSlots = useMemo(() => ["cam0", "cam1", "cam2", "t265_left", "t265_right", "extension_left", "extension_right"], []);
  const availableStreams = useMemo(
    () => data?.summary.streams.filter((stream) => cameraSlots.includes(stream.name) && stream.frameCount > 0) ?? [],
    [cameraSlots, data],
  );
  const primaryStreamName = availableStreams.find((stream) => stream.name === "cam0")?.name
    ?? availableStreams[0]?.name
    ?? null;
  const primaryStream = primaryStreamName
    ? availableStreams.find((stream) => stream.name === primaryStreamName) ?? null
    : null;
  const proofreading = view === "proofread" || view === "review";
  // Segment playback is temporary; global play explicitly clears this range.
  const segmentPlaying = Boolean(machinePreviewRange);
  const playbackStart = segmentPlaying ? machinePreviewRange!.startFrame : (proofreading && data ? getMinFrame(data) : clipStartFrame);
  const playbackEnd = segmentPlaying ? machinePreviewRange!.endFrame : (proofreading && data ? getMaxFrame(data) : clipEndFrame);
  const primaryPlaybackEndFrame = Math.min(
    playbackEnd,
    primaryStream?.lastFrame ?? playbackEnd,
  );
  const playbackFps = fpsOverride ?? estimatedFps;
  const secondaryReadAheadStride = Math.max(1, Math.round(playbackFps / 10));
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
  const handlePrimaryNativeClockChange = useCallback((streamName: string, active: boolean) => {
    if (streamName !== primaryStreamName) return;
    primaryNativeClockRef.current = active;
  }, [primaryStreamName]);
  const handleNativeBufferingChange = useCallback((streamName: string, buffering: boolean) => {
    if (streamName === primaryStreamName) setPrimaryBuffering(buffering);
  }, [primaryStreamName]);
  const handleSkeletonFramePresenterChange = useCallback((
    presenter: ((frameId: number) => void) | null,
  ) => {
    skeletonFramePresenterRef.current = presenter;
  }, []);
  const handlePrimaryFramePresented = useCallback((
    streamName: string,
    frameId: number,
    timelinePosition: number,
  ) => {
    if (streamName !== primaryStreamName || !primaryNativeClockRef.current) return;
    const next = Math.max(playbackStart, Math.min(primaryPlaybackEndFrame, frameId));
    const presentedPosition = Math.max(playbackStart, Math.min(primaryPlaybackEndFrame, timelinePosition));
    skeletonFramePresenterRef.current?.(presentedPosition);
    if (next !== frameRef.current) {
      frameRef.current = next;
      setCurrentFrame(next);
    }
    if (next >= primaryPlaybackEndFrame) setPlaying(false);
  }, [playbackStart, primaryPlaybackEndFrame, primaryStreamName]);

  function beginOperation(): OperationToken | null {
    if (batchRejection || sourcePublishing) return null;
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

  async function downloadAvailableUpdate() {
    if (busy || operationScopeRef.current.current()) throw new Error("正在处理数据或导出，请等待完成后再下载更新");
    const owner = beginOperation();
    if (!owner) throw new Error("当前任务尚未完成");
    try { await downloadAppUpdate(owner.id); ensureOperationActive(owner); }
    finally { finishOperation(owner); }
  }

  async function installAvailableUpdate() {
    if (busy || operationScopeRef.current.current()) throw new Error("正在处理数据或导出，请等待完成后再安装更新");
    // Capture blur/autosave work before reserving the operation slot.
    await flushMachineReviewSaves(data?.summary.root);
    if (reviewUnsaved.current) throw new Error("当前修改尚未保存，请重试保存成功后再安装更新");
    const owner = beginOperation();
    if (!owner) throw new Error("当前任务尚未完成");
    let resumeAudit: (() => void) | undefined;
    setPlaying(false);
    try {
      resumeAudit = await pauseAndPersistReviewAudit();
      await installAppUpdate(owner.id);
      ensureOperationActive(owner);
    } finally { resumeAudit?.(); finishOperation(owner); }
  }

  useEffect(() => {
    if (busy || !episodeFocusRestoreRequest) return;
    const { episodeRoot, token } = episodeFocusRestoreRequest;
    setEpisodeFocusRestoreRequest(null);
    if (episodeFocusRestoreToken.current !== token) return;
    const button = episodeButtonRefs.current.get(episodeRoot);
    if (button && !button.disabled) {
      button.scrollIntoView({ block: "nearest" });
      button.focus({ preventScroll: true });
    }
  }, [busy, episodeFocusRestoreRequest]);

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  useEffect(() => {
    if (!workspaceActive || (isManagedWorkspace && !authStatus?.currentUser)) {
      setPendingSourceRestore(null);
      setTasks([]);
      setAssignedTasks([]);
      setPersonalTaskOpen(false);
      return;
    }
    if (isManagedWorkspace && authStatus?.currentUser?.role === "operator") {
      void flushPendingAnnotationAudits()
        .then((remaining) => setAuditUploadPending(remaining > 0))
        .catch((reason) => {
          setAuditUploadPending(true);
          setAuditUploadError(toMessage(reason));
        });
      let active = true;
      const failed = (reason: unknown) => { if (active) setError(`无法加载已分配任务：${toMessage(reason)}`); };
      void listAssignedTaskDefinitions().then((value) => { if (active) setTasks(value); }).catch(failed);
      void getAssignedTasks().then((value) => { if (active) setAssignedTasks(value); }).catch(failed);
      const navigationVersion = sourceNavigationVersion.current;
      const resume = readReviewResume(authStatus.currentUser.username);
      if (resume) void resolveSourcePath(resume.episodeRoot, true).catch(() => "").then((batchRoot) => {
        if (active && sourceNavigationVersion.current === navigationVersion) setPendingSourceRestore(batchRoot || resume.sourceRoot);
      });
      else void getAssignedSourceRoot().then((root) => {
        if (!active || sourceNavigationVersion.current !== navigationVersion) return;
        setPendingSourceRestore(root);
      }).catch((reason) => { if (active && sourceNavigationVersion.current === navigationVersion) setError(`无法恢复数据目录：${toMessage(reason)}`); });
      return () => { active = false; };
    }
    setAssignedTasks([]);
    void listTaskDefinitions().then(setTasks)
      .catch((reason) => setError(`无法加载任务目录：${toMessage(reason)}`));
  }, [authStatus?.currentUser?.username, isManagedWorkspace, workspaceActive]);

  useEffect(() => {
    if (!pendingSourceRestore || !workspaceActive || !authStatus?.currentUser
      || busy || operationScopeRef.current.current()) return;
    const root = pendingSourceRestore;
    setPendingSourceRestore(null);
    void openSource(root, true);
  }, [pendingSourceRestore, busy, workspaceActive, authStatus?.currentUser?.username]);


  useEffect(() => {
    if (!workspaceActive || (isManagedWorkspace && !authStatus?.currentUser)) {
      setAnnotationTags({});
      return;
    }
    void refreshAnnotationTags();
  }, [authStatus?.currentUser?.username, isManagedWorkspace, workspaceActive]);

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
    setFrameRenderProgress({
      root: data?.summary.root ?? null,
      frameId: currentFrame,
      settled: 0,
      total: availableStreams.length,
    });
  }, [availableStreams.length, currentFrame, data?.summary.root]);

  useEffect(() => {
    setSourceFpsByStream({});
    primaryNativeClockRef.current = false;
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
    const playbackEnd = Math.min(primaryPlaybackEndFrame, getMaxFrame(data));
    const frameStep = primaryPlaybackFrameStep(playbackFps, primarySourceFps);
    const frameDurationMs = playbackFrameDurationMs(playbackFps / frameStep, speed);
    let lastAdvanceTimeMs = performance.now() - frameDurationMs;
    let animationFrame = 0;

    const tick = (nowMs: number) => {
      // Native MP4 presentation is the authoritative playback clock. Its
      // callback advances the timeline, while the skeleton reads the same
      // video's continuous currentTime without ever gating video playback.
      if (primaryNativeClockRef.current) {
        lastAdvanceTimeMs = nowMs;
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }
      const current = frameRef.current;
      const frameIntervalElapsed = playbackFrameDue(nowMs - lastAdvanceTimeMs, frameDurationMs);
      // The primary camera is the playback clock. Secondary NAS/local streams
      // keep their latest decoded frame and catch up asynchronously, so one
      // slow stream cannot pause an otherwise playable MP4.
      const frameReady = playbackClockReady(
        availableStreams.map((stream) => stream.name),
        primaryStreamName,
        settledFrameByStreamRef.current,
        current,
      );
      if (!frameReady) {
        lastAdvanceTimeMs = nowMs;
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }
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
  }, [availableStreams, data, playbackFps, playing, primaryPlaybackEndFrame, primarySourceFps, primaryStreamName, speed]);

  async function openSource(path: string, autoLoad = false, assignment = assignedTasks, propagateFailure = false, preferredEpisodeRoot?: string) {
    if (reviewUnsaved.current) {
      if (propagateFailure) throw new Error("正在保存当前修改，请稍候。");
      setNotice("正在保存当前修改，请稍候。"); return;
    }
    const owner = beginOperation();
    if (!owner) {
      if (propagateFailure) throw new Error("当前操作尚未完成，请稍后打开任务");
      return;
    }
    sourceNavigationVersion.current += 1;
    setPendingSourceRestore(null);
    resetOperationFeedback(owner);
    let operation = "scan_source";
    let loadingEpisode: EpisodeSummary | null = null;
    try {
      path = await resolveSourcePath(path);
      if (preferredEpisodeRoot) preferredEpisodeRoot = await resolveSourcePath(preferredEpisodeRoot);
      ensureOperationActive(owner);
      const result = await scanSource(path, owner.id);
      ensureOperationActive(owner);
      if (propagateFailure && autoLoad && !result.episodes.length) throw new Error("该目录未发现可加载的数据，请检查批次目录是否完整。");
      const assignmentView = assignmentFilterForSource(
        result.episodes,
        assignment,
        result.volume.driveType,
      );
      // Assignment metadata chooses the operator's work queue and default task,
      // but never hides source episodes from read-only preview/demo workflows.
      const visibleResult = result;
      setAssignedEpisodeTasks(assignmentView?.taskByRoot ?? {});
      setSourcePath(visibleResult.sourceRoot);
      setScan(visibleResult);
      setBatchRejectionSelection({});
      setBatchRejection(null);
      void refreshAnnotationTags();
      setSkippedEpisodeRoots({});
      setQueuedEpisodeRoot(null);
      setEpisodeSourceStates(Object.fromEntries(
        visibleResult.episodes.map((episode) => [episode.root, "available" as const]),
      ));
      const username = authStatus?.currentUser?.role === "operator" ? authStatus.currentUser.username : "";
      const resume = username ? readReviewResume(username) : null;
      if (resume) {
        // A missing old resume must not block opening a different, valid batch.
        const resolvedBatch = await resolveSourcePath(resume.episodeRoot, true).catch(() => "");
        resume.sourceRoot = resolvedBatch || await resolveSourcePath(resume.sourceRoot).catch(() => resume.sourceRoot);
        resume.episodeRoot = await resolveSourcePath(resume.episodeRoot).catch(() => resume.episodeRoot);
        ensureOperationActive(owner);
      }
      const lastAssignedRoot = username && !resume
        ? localStorage.getItem(`dohc-viewer.last-assigned-episode.v1:${username}`)
        : null;
      const resumeInThisBatch = resume && sameReviewPath(resume.sourceRoot, visibleResult.sourceRoot)
        ? visibleResult.episodes.find((episode) => sameReviewPath(episode.root, resume.episodeRoot))
        : null;
      const assignedInThisBatch = lastAssignedRoot
        ? visibleResult.episodes.find((episode) => sameReviewPath(episode.root, lastAssignedRoot))
        : null;
      const preferredRoot = preferredEpisodeRoot;
      const preferred = preferredRoot
        ? visibleResult.episodes.find((episode) => sameReviewPath(episode.root, preferredRoot))
        : null;
      if (preferredEpisodeRoot && !preferred) throw new Error("所选记录已不在该批次目录中，请刷新任务中心后重试。");
      let resumeCompleted = false;
      if (username && resume?.active && resumeInThisBatch && !preferred) {
        try {
          const records = await listMyMachineReviews([resumeInThisBatch.root]);
          ensureOperationActive(owner);
          resumeCompleted = records.some(record => record.status !== "pending");
        } catch (reason) {
          ensureOperationActive(owner);
          setNotice(`审核状态读取失败，恢复上次位置：${toMessage(reason)}`);
        }
      }
      let first = preferred ?? (resume?.active && !resumeCompleted ? resumeInThisBatch : null) ?? assignedInThisBatch
        ?? visibleResult.episodes[0]
        ?? null;
      // Do not wait for the whole NAS review index before restoring a known cursor.
      // Legacy/completed cursors need only bounded candidate checks, not media reads.
      if (username && first && !preferred && (!resume?.active || !resumeInThisBatch || resumeCompleted)) {
        const index = visibleResult.episodes.indexOf(first);
        const candidates = [...visibleResult.episodes.slice(index), ...visibleResult.episodes.slice(0, index)];
        try {
          for (let offset = 0; offset < candidates.length; offset += 32) {
            const group = candidates.slice(offset, offset + 32);
            const records = await listMyMachineReviews(group.map(episode => episode.root));
            ensureOperationActive(owner);
            const completed = new Set(records.filter(record => record.status !== "pending").map(record => record.sourcePath));
            const pendingEpisode = group.find(episode => !completed.has(episode.root));
            if (pendingEpisode) { first = pendingEpisode; break; }
          }
        } catch (reason) {
          ensureOperationActive(owner);
          setNotice(`审核状态读取失败，恢复上次位置：${toMessage(reason)}`);
        }
      }
      ensureOperationActive(owner);
      setSelectedEpisode(first);
      resetLoadedData();
      if (autoLoad && first) {
        if (username) writeReviewResume(username, { sourceRoot: visibleResult.sourceRoot, episodeRoot: first.root, active: true });
        restoreEpisodeFocus(first.root, ++episodeFocusRestoreToken.current);
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
      if (propagateFailure) throw reason;
    } finally {
      finishOperation(owner);
    }
  }

  async function chooseSource() {
    if (reviewUnsaved.current) { setNotice("正在保存当前修改，请稍候。"); return; }
    if (sourcePickerOpenRef.current || operationScopeRef.current.current()) return;
    sourcePickerOpenRef.current = true;
    try {
      const path = await chooseDirectory("选择 SD 卡根目录");
      if (path) {
        const selectedPath = isManagedWorkspace && authStatus?.currentUser?.role === "operator"
          ? await setAssignedSourceRoot(path)
          : path;
        await openSource(selectedPath, true);
      }
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
    if (episodeLoadInFlight.current || operationScopeRef.current.current() || reviewUnsaved.current) return;
    selectEpisode(episode);
    if (!force && data && report && loadedEpisodeSourceRoot === episode.root) {
      changeView("proofread");
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
    if (reviewUnsaved.current) { setNotice("正在保存当前修改，请稍候。"); return; }
    setSelectedEpisode(episode);
    if (authStatus?.currentUser?.role === "operator" && sourcePath) {
      writeReviewResume(authStatus.currentUser.username, { sourceRoot: sourcePath, episodeRoot: episode.root, active: true });
    }
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
    if (["scan_source", "load_and_validate", "load_episode", "load_frame", "choose_source"].includes(operation)) {
      auditActivity("source_unavailable", assignedEpisodeTasks[path] ?? "", "");
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
    // Show read-only frames immediately, but mount draft editors only after
    // validation has cached the fingerprint and saved bounds are restored.
    setData(loaded);
    setMachinePreviewRange(null);
    setReport(null);
    setAnnotation(null);
    setAnnotationReadyRoot(null);
    setSelectedTaskId(null);
    setLoadedEpisodeSourceRoot(sourceEpisodeRoot);
    setPlaying(false);
    setExportResult(null);
    setFpsOverride(null);
    setClipStartFrame(loadedMinFrame);
    setClipEndFrame(loadedMaxFrame);
    setCurrentFrame(loadedMinFrame);
    frameRef.current = loadedMinFrame;
    setView("proofread");

    const validated = await validateEpisode(root, owner.id);
    ensureOperationActive(owner);
    if (validated.report.status === "warning") auditActivity("validation_warning");
    if (validated.report.status === "error") auditActivity("validation_error");
    updateScannedEpisode(validated.summary);
    if (!validated.summary.streams.some((stream) => stream.frameCount > 0)) {
      resetLoadedData();
      throw new Error(
        `FRAME_UNAVAILABLE: ${loaded.summary.name} 未发现可读取的视频或图像，请检查数据文件是否完整。`,
      );
    }

    const candidate: PendingAnnotationConfirmation = {
      data: { ...loaded, summary: validated.summary },
      report: validated.report,
      sourceEpisodeRoot,
      minFrame: loadedMinFrame,
      maxFrame: loadedMaxFrame,
    };
    // Quality findings remain visible without discarding readable camera data.

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
    setLoadedEpisodeSourceRoot(candidate.sourceEpisodeRoot);
    setAnnotation(savedAnnotation);
    setSelectedTaskId(savedAnnotation?.taskId ?? null);
    const start = Math.max(candidate.minFrame, Math.min(candidate.maxFrame, savedAnnotation?.clipStartFrame ?? candidate.minFrame));
    const end = Math.max(start, Math.min(candidate.maxFrame, savedAnnotation?.clipEndFrame ?? candidate.maxFrame));
    setClipStartFrame(start);
    setClipEndFrame(end);
    const frame = clampPlaybackFrame(frameRef.current, start, end);
    setCurrentFrame(frame);
    frameRef.current = frame;
    setPlaying(false);
    setAnnotationReadyRoot(candidate.data.summary.root);
    setView("proofread");
  }

  function handleLoadResult(episode: EpisodeSummary, result: EpisodeLoadResult) {
    if (result === "loaded") {
      setEpisodeSourceStates((current) => ({ ...current, [episode.root]: "available" }));
      if (authStatus?.currentUser?.role === "operator") {
        localStorage.setItem(`dohc-viewer.last-assigned-episode.v1:${authStatus.currentUser.username}`, episode.root);
      }
      auditActivity("episode_opened", assignedEpisodeTasks[episode.root] ?? "", "");
      setNotice(`已从源目录只读载入：${episode.name}`);
      return;
    }
    skipEpisode(episode, true, "检测到不可用或静止轨迹，不进入标注。");
  }


  function skipEpisode(episode: EpisodeSummary, loadNext = false, reason = "") {
    if (reviewUnsaved.current) return;
    const nextRoot = loadNext ? nextAvailableEpisodeRoot(episode.root) : null;
    setSkippedEpisodeRoots((current) => ({ ...current, [episode.root]: true }));
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
    if (streamName !== primaryStreamName) return;
    const episode = data.summary;
    const stream = data.summary.streams.find((candidate) => candidate.name === streamName);
    const message = `FRAME_UNAVAILABLE: ${episode.name} 的 ${stream?.label ?? streamName} 帧 ${frameId} 暂时无法读取，已暂停播放。数据仍保留，可定位其他帧继续查看。`;
    setPlaying(false);
    resetPlaybackPreparation();
    void reportFailure("load_frame", new Error(message), data.summary.root);
  }, [data, primaryStreamName]);

  function resetLoadedData() {
    reviewUnsaved.current = false; setReviewHasUnsaved(false);
    setMachinePreviewRange(null);
    settledFrameByStreamRef.current.clear();
    setAnnotationReadyRoot(null);
    setData(null);
    setReport(null);
    setAnnotation(null);
    setSelectedTaskId(null);
    setPlaying(false);
    setPlaybackPrimed(false);
    setExportResult(null);
    setCurrentFrame(0);
    setClipStartFrame(0);
    setClipEndFrame(0);
    setLoadedEpisodeSourceRoot(null);
  }

  function resetWorkspaceData() {
    setReviewedEpisodes({});
    setBatchRejectionSelection({});
    episodeFocusRestoreToken.current += 1;
    setEpisodeFocusRestoreRequest(null);
    resetLoadedData();
    setSourcePath("");
    setScan(null);
    setSelectedEpisode(null);
    setEpisodeSourceStates({});
    setSkippedEpisodeRoots({});
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
    setView("proofread");
    setError("");
    setNotice("");
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
    if (sourcePublishing) return;
    if (reviewUnsaved.current) return;
    if (operationScopeRef.current.current()) return;
    let resumeAudit: (() => void) | undefined;
    try {
      recordReviewInteraction("closed");
      resumeAudit = await pauseAndPersistReviewAudit();
      await logoutLocalAccount();
      endReviewAudit();
      resetWorkspaceData();
      setAuthStatus((current) => current ? { ...current, currentUser: null } : current);
    } catch (reason) {
      await reportFailure("logout", reason);
    } finally {
      resumeAudit?.();
    }
  }

  async function saveCurrentDisplayName(displayName: string) {
    const user = await updateCurrentDisplayName(displayName);
    setAuthStatus((current) => current ? { ...current, currentUser: user } : current);
    setProfileEditorOpen(false);
  }

  async function chooseWorkspaceMode() {
    if (reviewUnsaved.current) return;
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
    // The current frame is already the synchronization anchor. Read-ahead is
    // opportunistic and must never delay starting playback on local or NAS data.
    setPlaybackPrimed(true);
    setPrimaryBuffering(false);
  }

  function seekFrame(frame: number) {
    if (!data) return;
    const next = Math.max(proofreading ? getMinFrame(data) : playbackStart,
      Math.min(proofreading ? getMaxFrame(data) : playbackEnd, Math.round(frame)));
    setPlaying(false);
    resetPlaybackPreparation();
    recordReviewSeek(next, Math.round(next / estimatedFps * 1000), frameRef.current);
    frameRef.current = next;
    setCurrentFrame(next);
    if (proofreading) setMachinePreviewRange(null);
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
      const startFrame = playbackStartFrame(
        frameRef.current,
        playbackStart,
        primaryPlaybackEndFrame,
      );
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
    if (!data || managementMode) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (document.querySelector("dialog[open]") || target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveFrame(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveFrame(1);
      } else if (event.key === "[" && view === "review" && !machinePreviewRange) {
        event.preventDefault();
        updateClipStart(frameRef.current);
      } else if (event.key === "]" && view === "review" && !machinePreviewRange) {
        event.preventDefault();
        updateClipEnd(frameRef.current);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [data, clipStartFrame, clipEndFrame, machinePreviewRange, playing, view, managementMode]);

  function exitMachinePreview() {
    setMachinePreviewRange(null);
    setPlaying(false);
    const frame = clampPlaybackFrame(frameRef.current, clipStartFrame, clipEndFrame);
    frameRef.current = frame;
    setCurrentFrame(frame);
    resetPlaybackPreparation();
  }
  function playGlobal() {
    if (!data) return;
    setMachinePreviewRange(null);
    const frame = playbackStartFrame(frameRef.current, getMinFrame(data), primaryStream?.lastFrame ?? getMaxFrame(data));
    frameRef.current = frame; setCurrentFrame(frame); resetPlaybackPreparation();
    setPlaying(true);
  }

  function playSegment(range: ExportRange) {
    frameRef.current = range.startFrame; setCurrentFrame(range.startFrame);
    setMachinePreviewRange(range); resetPlaybackPreparation(); setPlaying(true);
  }

  function changeView(next: View) {
    if (reviewUnsaved.current) { setNotice("正在保存当前修改，请稍候。"); return; }
    setPlaying(false);
    if (machinePreviewRange) exitMachinePreview();
    setView(next);
  }

  function updateClipStart(value: number) {
    if (!data || machinePreviewRange) return;
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
    if (!data || machinePreviewRange) return;
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
    if (authStatus?.workspaceMode !== "managed" || !authStatus.currentUser) return;
    void recordAnnotationAudit({
      taskId,
      trajectoryCode,
      action,
      occurredAtMs: Date.now(),
    }).then(() => flushPendingAnnotationAudits()).then((remaining) => setAuditUploadPending(remaining > 0)).catch((reason) => {
      setAuditUploadPending(true);
      setAuditUploadError(toMessage(reason));
    });
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


  function openBatchExport() {
    if (reviewUnsaved.current) return;
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
    setMachinePreviewRange(null);
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
  useEffect(() => {
    setReviewedEpisodes({});
  }, [authStatus?.currentUser?.username]);

  useEffect(() => {
    let active = true;
    if (!authStatus?.currentUser || !scan) return () => { active = false; };
    void listMyMachineReviews(scan.episodes.map((episode) => episode.root)).then((records) => {
      if (!active) return;
      setReviewedEpisodes((current) => ({
        ...current,
        ...Object.fromEntries(records.map((record) => [record.sourcePath, record.status])),
      }));
    }).catch((reason) => { if (active) setNotice(`账号审核记录读取失败，可重新加载目录重试：${toMessage(reason)}`); });
    return () => { active = false; };
  }, [authStatus?.currentUser?.username, scan, batchReviewRevision]);

  useEffect(() => {
    let active = true;
    let generation = 0;
    setPendingReviewEpisodes({});
    if (!authStatus?.currentUser || !scan) return;
    const refresh = async () => {
      const own = ++generation;
      try {
        const result = await getPendingSourceReviews(false, scan.episodes.map(episode => episode.root));
        if (active && own === generation) setPendingReviewEpisodes(Object.fromEntries(result.items.filter(item => item.channel !== "skeleton").map(item => [item.sourcePath, item.status])));
      } catch (cause) { if (active && own === generation) setNotice(`本机待写状态读取失败：${toMessage(cause)}`); }
    };
    void refresh();
    window.addEventListener("source-review-pending", refresh);
    return () => { active = false; window.removeEventListener("source-review-pending", refresh); };
  }, [authStatus?.currentUser?.username, scan, batchReviewRevision]);

  const visibleEpisodes = useMemo(
    () => scan?.episodes.filter((episode) => (!skippedEpisodeRoots[episode.root] || Boolean(reviewedEpisodes[episode.root]))) ?? [],
    [scan?.episodes, skippedEpisodeRoots, reviewedEpisodes],
  );
  function toggleRejection(episode: EpisodeSummary, checked: boolean) {
    setBatchRejectionSelection(previous => {
      const next = { ...previous };
      if (checked) next[episode.root] = { path: episode.root, name: episode.name };
      else delete next[episode.root];
      return next;
    });
  }
  const episodeActions = useRef({ select: selectEpisode, load: loadEpisodeForReview, skip: skipEpisode, toggleRejection });
  episodeActions.current = { select: selectEpisode, load: loadEpisodeForReview, skip: skipEpisode, toggleRejection };
  const skippedEpisodeCount = (scan?.episodes.length ?? 0) - visibleEpisodes.length;

  function startBatchRejection(folder?: string) {
    if (busy || operationScopeRef.current.current() || !scan) return;
    if (reviewUnsaved.current) {
      setNotice("请先完成当前操作并保存审核修改，再执行批量不通过。");
      return;
    }
    const selected = scan.episodes.filter(episode => batchRejectionSelection[episode.root])
      .map(episode => ({ path: episode.root, name: episode.name }));
    if (!folder && !selected.length) return;
    if (!folder && selected.length > 20000) {
      setNotice("单次最多处理 20000 条，请减少选择数量。");
      return;
    }
    setQueuedEpisodeRoot(null);
    setPlaying(false);
    setBatchRejection(folder ? { folder: scan.sourceRoot } : { selected });
  }

  function handleBatchRejectionSaved(path: string) {
    setBatchRejectionSelection((previous) => {
      const next = { ...previous };
      delete next[path];
      return next;
    });
    setReviewedEpisodes((previous) => ({ ...previous, [path]: "rejected" }));
  }

  function rejectFailedEpisode() {
    if (!selectedEpisode || busy || operationScopeRef.current.current() || reviewUnsaved.current) return;
    setPlaying(false);
    setBatchRejection({ selected: [{ path: selectedEpisode.root, name: selectedEpisode.name }] });
  }

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

  useEffect(() => {
    const user = authStatus?.currentUser;
    if (!user || user.role === "admin") return;
    return configureReviewAudit(user.username, authStatus?.userCenter.serviceId ?? "demo");
  }, [authStatus?.currentUser?.username, authStatus?.userCenter.serviceId]);
  useEffect(() => {
    if (managementMode || !data || !authStatus?.currentUser || authStatus.currentUser.role === "admin") return;
    return beginReviewAudit(data.summary.root, data.summary.name);
  }, [data?.summary.root, authStatus?.currentUser?.username, managementMode]);
  useEffect(() => observeReviewInteractions(), []);
  useEffect(() => { updateReviewFrame(currentFrame); }, [currentFrame]);
  useEffect(() => { recordReviewInteraction(playing ? "play" : "pause", { frameTo: currentFrame }); }, [playing]);
  useEffect(() => { recordReviewInteraction("view", { value: view }); }, [view]);
  const [reviewAuditError, setReviewAuditError] = useState("");
  const [reviewSyncStatus, setReviewSyncStatus] = useState(getReviewSyncStatus);
  useEffect(() => {
    const update = () => setReviewSyncStatus(getReviewSyncStatus());
    window.addEventListener("review-audit-snapshot", update);
    update();
    return () => window.removeEventListener("review-audit-snapshot", update);
  }, []);
  useEffect(() => {
    const listener = (event: Event) => setReviewAuditError((event as CustomEvent<string>).detail);
    window.addEventListener("review-audit-status", listener);
    return () => window.removeEventListener("review-audit-status", listener);
  }, []);

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
  const updateControls = (taskBusy: boolean) => !IS_DEVELOPMENT_EDITION ? <AppUpdates version={APP_VERSION}
    currentSummary={RELEASE_SUMMARIES_ZH[APP_VERSION] ?? "查看本次版本的改进与修复。"}
    currentNotes={releaseHistory.find(item => item.version === APP_VERSION)?.notes ?? []} busy={taskBusy}
    onDownload={downloadAvailableUpdate} onInstall={installAvailableUpdate} onViewHistory={() => setReleaseHistoryOpen(true)} /> : null;
  const canManage = currentUser?.canManage || currentUser?.role === "admin";
  const showManagement = Boolean(canManage && (managementMode || currentUser?.role === "admin"));
  function openManagement() {
    if (busy || reviewHasUnsaved) { setNotice("请等待当前操作和本机草稿保存完成，再切换管理模式。"); return; }
    setPlaying(false);
    setPersonalTaskOpen(false);
    setProfileEditorOpen(false);
    setManagementMode(true);
  }
  return (
    <>
      {isManagedWorkspace && currentUser && <ClientPresence key={`${authStatus.userCenter.serviceId}:${currentUser.username}`} owner={`${authStatus.userCenter.serviceId}:${currentUser.username}`} />}
      {showManagement && currentUser && <SupervisionDashboard currentUser={currentUser} onLogout={logout} updateBusy={busy} updateControls={updateControls}
        onTestMode={currentUser.role === "operator" ? () => setManagementMode(false) : undefined} />}
      {releaseHistoryOpen ? (
        <ReleaseHistoryDialog
          currentVersion={APP_VERSION}
          releases={releaseHistory}
          onClose={() => setReleaseHistoryOpen(false)}
        />
      ) : null}
      <div className="app-shell" hidden={showManagement} inert={showManagement}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">D</span>
          <div>
            <strong>Delta Viewer{IS_DEVELOPMENT_EDITION ? " Dev" : ""}</strong>
            <span>v{APP_VERSION}</span>
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
          {canManage && <button className="button button-secondary management-mode-button" disabled={busy || reviewHasUnsaved} onClick={openManagement}>管理模式</button>}
          <StatusBadge status={status} />
          {isManagedWorkspace && currentUser && !showManagement ? updateControls(busy) : null}
          <button className="button button-secondary" type="button" onClick={() => void chooseSource()} disabled={busy}>
            <FolderOpen size={16} />
            {isManagedWorkspace && currentUser?.role === "operator" ? "选择数据目录" : "选择 SD 卡"}
          </button>
          {isManagedWorkspace && currentUser ? (
            <button className="button button-secondary workbench-trigger" type="button" onClick={() => void openCaptureWorkbench().catch((reason) => setNotice(`审核总览打开失败：${toMessage(reason)}`))} title="打开审核总览">
              <Activity size={16} />审核总览
            </button>
          ) : null}
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
                <button className="button button-secondary personal-task-trigger" type="button" onClick={() => setPersonalTaskOpen((open) => !open)} title="任务中心" aria-label="任务中心" aria-expanded={personalTaskOpen}>
                  <ListChecks size={16} />任务中心
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
      <div id={showManagement ? undefined : "app-update-notices"} />

      {isManagedWorkspace && currentUser?.role === "operator" && personalTaskOpen ? (
        <div className="personal-task-overlay" role="presentation" onClick={() => setPersonalTaskOpen(false)}>
        <TaskCenter
          currentUser={currentUser}
          onOpen={async (root, episodeRoot, batchRoot) => {
            if (reviewUnsaved.current || busy) throw new Error("当前操作尚未完成，请稍后打开任务");
            await openSource(batchRoot ?? root, true, [], true, episodeRoot);
          }}
          onClose={() => setPersonalTaskOpen(false)}
        />
        </div>
      ) : null}

      {batchRejection && <BatchRejectionDialog username={currentUser?.username ?? ""} {...batchRejection} onSaved={handleBatchRejectionSaved} onClose={() => {
        setBatchRejection(null);
        setBatchReviewRevision(value => value + 1);
      }} />}

      {isManagedWorkspace && currentUser?.role === "operator" && profileEditorOpen ? (
        <DisplayNameDialog
          currentUser={currentUser}
          onSave={saveCurrentDisplayName}
          onClose={() => setProfileEditorOpen(false)}
        />
      ) : null}


      {historyOpen ? (
        <OperationHistoryPanel
          records={operationErrors}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {auditUploadPending && authStatus?.currentUser ? (
        <AuditSyncNotice key={authStatus.currentUser.username} username={authStatus.currentUser.username}
          error={auditUploadError} onError={setAuditUploadError} onPendingChange={setAuditUploadPending} />
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

      <div className={`workspace${sidebarCollapsed ? " sidebar-is-collapsed" : ""}`}>
        <aside className="sidebar" style={{ "--sidebar-scale": sidebarScale } as CSSProperties}>
          <div className="sidebar-heading">
            <div>
              <span className="section-kicker">SOURCE</span>
              <h1>记录</h1>
            </div>
            <div className="sidebar-heading-actions">
              <button className="icon-button" type="button" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? "展开目录" : "收起目录"} aria-label={sidebarCollapsed ? "展开目录" : "收起目录"}>
                {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </button>
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
          {!sidebarCollapsed ? <label className="sidebar-zoom">目录缩放<input aria-label="目录缩放" type="range" min="0.75" max="1.35" step="0.05" value={sidebarScale} onChange={(event) => setSidebarScale(event.currentTarget.valueAsNumber)} /><output>{Math.round(sidebarScale * 100)}%</output></label> : null}
          <div className="sidebar-path" title={sourcePath}>{sourcePath ? shortPath(sourcePath, 38) : "等待 SD 卡"}</div>
          {!sidebarCollapsed && isManagedWorkspace && currentUser?.role === "operator" && scan && <div className="sidebar-review-toolbar" aria-label="当前目录批量审核">
            <div className="sidebar-review-actions">
              <button type="button" className="button button-secondary" disabled={busy || !Object.keys(batchRejectionSelection).length} onClick={() => startBatchRejection()}><X size={14} />批量不通过</button>
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => startBatchRejection(scan.sourceRoot)}><FolderOpen size={14} />整文件夹不通过</button>
            </div>
            <label><input type="checkbox" aria-label="全选当前目录列表" disabled={busy || !visibleEpisodes.length} checked={visibleEpisodes.length > 0 && visibleEpisodes.every(episode => Boolean(batchRejectionSelection[episode.root]))} onChange={event => setBatchRejectionSelection(event.target.checked ? Object.fromEntries(visibleEpisodes.map(episode => [episode.root, { path: episode.root, name: episode.name }])) : {})} />全选<span>已选 {Object.keys(batchRejectionSelection).length} 条</span></label>
          </div>}
          {progress ? <ProgressStrip progress={progress} onCancel={() => void cancelCurrentOperation()} /> : null}
          <div className="episode-list">
            {visibleEpisodes.length ? (
              visibleEpisodes.map((episode) => <EpisodeListRow
                key={episode.root} episode={episode} selected={selectedEpisode?.root === episode.root}
                sourceState={episodeSourceStates[episode.root] ?? "available"}
                savedAnnotation={annotationTags[episode.root]} reviewStatus={reviewedEpisodes[episode.root]} pendingReviewStatus={pendingReviewEpisodes[episode.root]} busy={busy}
                rejectionSelectable={isManagedWorkspace && currentUser?.role === "operator"}
                rejectionSelected={Boolean(batchRejectionSelection[episode.root])}
                actions={episodeActions} buttonRefs={episodeButtonRefs}
              />)
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
          {currentUser?.role === "operator" && <SourceReviewNotice key={`source:${authStatus.userCenter.serviceId}:${currentUser.username}`} disabled={busy || reviewHasUnsaved || showManagement} onBusy={setSourcePublishing} onWritten={() => { setBatchReviewRevision(value => value + 1); setNotice("本机结果已写回数据目录，操作记录将在后台补传；任务中心等待服务器读取 QC 更新。"); }} />}
          {currentUser && (reviewSyncStatus || reviewAuditError) && <AuditSyncNotice key={`${authStatus.userCenter.serviceId}:${currentUser.username}`} status={reviewSyncStatus?.owner === `${authStatus.userCenter.serviceId ?? "demo"}:${currentUser.username}` ? reviewSyncStatus : undefined} username={currentUser.username} error={reviewAuditError} onError={setReviewAuditError} onPendingChange={() => {}} flush={retryReviewAudit} autoRetry={false} message="监管记录同步状态" />}
          {data || view === "batch" ? (
            <>
              <nav className="view-tabs" aria-label="工作区视图">
                {data ? (
                  <>
                    <button type="button" className={proofreading ? "active" : ""} onClick={() => changeView("proofread")}>
                      <FileSearch size={17} />校对
                    </button>
                    <button type="button" className={view === "checks" ? "active" : ""} onClick={() => changeView("checks")}>
                      <ShieldCheck size={17} />检查
                      {report?.status === "warning" ? <span className="tab-alert" /> : null}
                    </button>
                    <button type="button" className={view === "export" ? "active" : ""} onClick={() => changeView("export")}>
                      <PackageOpen size={17} />导出
                    </button>
                  </>
                ) : null}
                <button type="button" className={view === "batch" ? "active" : ""} onClick={() => { if (machinePreviewRange) exitMachinePreview(); openBatchExport(); }}>
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
              ) : !data ? null : view === "proofread" || view === "review" ? (
                <div className="review-view review-main-grid">
                  <section className="camera-section">
                    <div className="section-heading compact-heading">
                      <div>
                        <span className="section-kicker">SYNCHRONIZED FRAMES</span>
                        <h2>多路回放</h2>
                      </div>
                      <span className="frame-counter">帧 {currentFrame} / {maxFrame}</span>
                      <PreviewSettings />
                    </div>
                    <div className={`replay-visual-row${data.skeleton || data.skeletonError ? " with-skeleton" : ""}`}>
                      <div className="camera-grid camera-grid-expanded">
                        {cameraSlots.map((name, index) => {
                          const stream = availableStreams.find((stream) => stream.name === name);
                          return stream ? (
                          <FramePanel
                            key={stream.name}
                            root={data.summary.root}
                            stream={stream}
                            // The timeline stays exact for the primary camera;
                            // secondary playback previews may be quantized,
                            // while paused/seeking frames remain exact.
                            frameId={currentFrame}
                            isPrimary={stream.name === primaryStreamName}
                            playing={playing}
                            nativePlaybackEnabled={playing && playbackPrimed
                              && (stream.name === primaryStreamName || !primaryBuffering)}
                            readAheadEnabled={playing}
                            readAheadFrames={stream.name === primaryStreamName
                              ? 12
                              : REMOTE_SECONDARY_READ_AHEAD_FRAMES}
                            readAheadStride={stream.name === primaryStreamName
                              ? 1
                              : secondaryReadAheadStride}
                            playbackEndFrame={stream.name === primaryStreamName
                              ? primaryPlaybackEndFrame
                              : playbackEnd}
                            playbackFps={playbackFps}
                            speed={speed}
                            className={`camera-${index}`}
                            onFrameSettled={handleFrameSettled}
                            onFrameUnavailable={handleFrameUnavailable}
                            onSourceFpsChange={handleSourceFpsChange}
                            onNativeClockChange={handlePrimaryNativeClockChange}
                            onFramePresented={handlePrimaryFramePresented}
                            onBufferingChange={handleNativeBufferingChange}
                          />
                        ) : (
                          <figure key={name} className={`frame-panel camera-${index} camera-placeholder`} aria-label={`${name} 未接入`}>
                            <div className="camera-placeholder-content"><Video size={22} /><span>未接入</span></div>
                            <figcaption><span className="frame-camera-name" title={name}>{name.startsWith("cam") ? `Camera ${name.slice(3)}` : name === "t265_left" ? "T265 Left" : name === "t265_right" ? "T265 Right" : name}</span></figcaption>
                          </figure>
                        );})}
                      </div>
                      <div className="skeleton-side-panel">
                        {data.skeleton ? (
                          <SkeletonViewer
                            skeleton={data.skeleton}
                            frameId={currentFrame}
                            timelineStartFrame={primaryStream?.firstFrame ?? minFrame}
                            timelineEndFrame={primaryStream?.lastFrame ?? maxFrame}
                            playing={playing}
                            nativePlayback={primaryNativeClockRef.current}
                            onFramePresenterChange={handleSkeletonFramePresenterChange}
                          />
                        ) : null}
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
                  </section>
                    <MachineAnnotationPanel username={authStatus.currentUser?.username ?? ""} key={`machine:${data.summary.root}:${batchReviewRevision}`} data={data} suspended={showManagement} busy={busy || showManagement || annotationReadyRoot !== data.summary.root}
                      playback={{ frame: currentFrame, onSeek: seekFrame, onPause: () => setPlaying(false), onPlay: playSegment, onToggle: togglePlayback, controls: (
<>
                          <div className="transport-buttons">
                            <button className="icon-button" type="button" onClick={() => moveFrame(-1)} title="上一帧" aria-label="上一帧"><SkipBack size={17} /></button>
                            <button className="play-button" type="button" onClick={() => { if (playing && !machinePreviewRange) setPlaying(false); else playGlobal(); }} title={playing && !machinePreviewRange ? "暂停" : "全局播放"} aria-label={playing && !machinePreviewRange ? "暂停" : "全局播放"}>{playing && !machinePreviewRange ? <Pause size={17} /> : <Play size={17} />}</button>
                            <button className="icon-button" type="button" onClick={() => moveFrame(1)} title="下一帧" aria-label="下一帧"><SkipForward size={17} /></button>
                          </div>
                          <span className="segment-frame-readout">帧 {currentFrame} / {maxFrame}</span>
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
                      ) }}
                      onReviewSaved={(saved) => {
                        if (saved.pendingSourceWrite || saved.localDraft) return;
                        setReviewedEpisodes((current) => saved.status === "approved" || saved.status === "rejected" || current[data.summary.root]
                          ? { ...current, [data.summary.root]: saved.status ?? "pending" } : current);
                      }}
                      onUnsavedChange={handleReviewUnsaved} onComplete={(status, local) => {
                        const nextRoot = nextAvailableEpisodeRoot(data.summary.root);
                        setNotice(`${data.summary.name} ${local ? "审核结果已保存本机，待恢复后确认写回 NAS，任务进度暂不增加。" : `质检${status === "approved" ? "通过" : "不通过"}，review 已保存。`}${nextRoot ? "正在载入下一条。" : "已是最后一条。"}`);
                        if (!local) setReviewedEpisodes((current) => ({ ...current, [data.summary.root]: status }));
                        if (authStatus.currentUser?.role === "operator") {
                          writeReviewResume(authStatus.currentUser.username, {
                            sourceRoot: sourcePath,
                            episodeRoot: nextRoot ?? data.summary.root,
                            active: Boolean(nextRoot),
                          });
                        }
                        if (nextRoot) setQueuedEpisodeRoot(nextRoot);
                      }} />
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
              onReject={currentUser?.role === "operator" && selectedEpisode && episodeSourceStates[selectedEpisode.root] === "error" && !["approved", "rejected"].includes(reviewedEpisodes[selectedEpisode.root] ?? "") ? rejectFailedEpisode : undefined}
              onChoose={chooseSource}
              onBatch={openBatchExport}
            />
          )}
        </main>
      </div>
    </div>
    </>
  );
}

function EmptyWorkspace({
  selectedEpisode,
  busy,
  onChoose,
  onBatch,
  onReject,
}: {
  selectedEpisode: EpisodeSummary | null;
  busy: boolean;
  onChoose: () => Promise<void>;
  onBatch: () => void;
  onReject?: () => void;
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
      {onReject && <button className="button button-secondary" type="button" disabled={busy} onClick={onReject}><X size={16} />不通过</button>}
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


// Keep the NAS catalog out of the per-frame video render work. Action refs
// retain current application state without invalidating every row on a tick.
const EpisodeListRow = memo(function EpisodeListRow({
  episode, selected, sourceState, savedAnnotation, reviewStatus, pendingReviewStatus, busy, actions, buttonRefs, rejectionSelectable, rejectionSelected,
}: {
  episode: EpisodeSummary;
  selected: boolean;
  sourceState: EpisodeSourceState;
  savedAnnotation?: EpisodeAnnotation;
  reviewStatus?: "pending" | "approved" | "rejected";
  pendingReviewStatus?: string;
  busy: boolean;
  rejectionSelectable: boolean;
  rejectionSelected: boolean;
  actions: RefObject<{
    select: (episode: EpisodeSummary) => void;
    load: (episode: EpisodeSummary, imported: boolean, focus: boolean) => Promise<void>;
    skip: (episode: EpisodeSummary) => void;
    toggleRejection: (episode: EpisodeSummary, checked: boolean) => void;
  }>;
  buttonRefs: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const activationHint = sourceState === "error"
    ? "单击选择；双击或按 Enter/空格重试读取"
    : "单击选择；双击或按 Enter/空格进入回放";
  const completed = Boolean(savedAnnotation?.taskId && savedAnnotation.taskDescription.trim()
    && savedAnnotation.segments.length && savedAnnotation.clipStartFrame !== null && savedAnnotation.clipEndFrame !== null);
  const episodeTitle = completed && savedAnnotation
    ? `已标注 · ${savedAnnotation.trajectoryCode}；${activationHint}` : activationHint;
  return <div className={`episode-entry${rejectionSelectable ? " episode-entry-selectable" : ""}`}>
    {rejectionSelectable && <input type="checkbox" className="episode-rejection-select" aria-label={`选择 ${episode.name}`} checked={rejectionSelected} disabled={busy} onChange={event => actions.current.toggleRejection(episode, event.target.checked)} />}
    <button type="button" className={`episode-item${selected ? " selected" : ""}`}
      ref={(element) => {
        if (element) buttonRefs.current.set(episode.root, element);
        else buttonRefs.current.delete(episode.root);
      }}
      aria-pressed={selected} disabled={busy} title={episodeTitle}
      aria-label={`${episode.name}：${activationHint}`}
      onClick={() => actions.current.select(episode)}
      onDoubleClick={() => void actions.current.load(episode, false, true)}
      onKeyDown={(event) => {
        if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        void actions.current.load(episode, false, true);
      }}>
      <span className="episode-item-top">
        <Images size={16} /><strong>{episode.name}</strong>
        {completed && savedAnnotation ? <span className="episode-annotation-tag"
          title={`已标注 · ${savedAnnotation.trajectoryCode} · r${savedAnnotation.revision}`}
          aria-label="已标注">已标注</span> : null}
        {reviewStatus && !pendingReviewStatus ? <span className="episode-annotation-tag" aria-label="已审核">我已审·{reviewStatus === "pending" ? "待复审" : reviewStatus === "approved" ? "通过" : "不通过"}</span> : null}
        <EpisodeSourceMark state={sourceState} /><ChevronRight size={15} />
      </span>
      {pendingReviewStatus && <span className="episode-annotation-tag episode-local-pending" aria-label={pendingReviewStatus === "pending" ? "本机草稿" : "本机待写回"}>{pendingReviewStatus === "pending" ? "本机草稿 · 待审核" : `本机${pendingReviewStatus === "approved" ? "通过" : "不通过"} · 待写回 NAS`}</span>}
      <span className="episode-item-meta">{episode.indexed
        ? `${episode.stateCount} states · ${formatBytes(episode.totalBytes)}`
        : episode.stateCount ? `${episode.stateCount} states · 快速预览` : "待读取"}</span>
      <span className="stream-dots">{episode.streams.map((stream) => <i
        className={episode.indexed ? stream.frameCount ? "dot-ok" : "dot-error" : stream.frameCount ? "dot-ok" : ""}
        key={stream.name} title={stream.label} />)}</span>
    </button>
    <button className="icon-button episode-skip" type="button" onClick={() => actions.current.skip(episode)}
      disabled={busy} title="跳过数据" aria-label={`跳过 ${episode.name}`}><EyeOff size={15} /></button>
  </div>;
});

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
    return `系统拒绝访问所选卷或目录。请确认当前账号和 Delta Viewer 可以读取该卷，并允许写入本机应用数据目录。原始错误：${message}`;
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
                {RELEASE_SUMMARIES_ZH[release.version] ?? (release.notes.filter((note) => /[\u3400-\u9fff]/.test(note)).join("；") || "此版本没有中文更新摘要。")}
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
