
export type Copy = readonly [zh: string, en: string];
export type StepAction = "click" | "change" | "read" | "drag" | "open";
export interface Step {
  target: string;
  label: Copy;
  action: StepAction;
  detail?: Copy;
  after?: string;
}
export interface Lesson {
  id: string;
  area: string;
  title: Copy;
  steps: Step[];
  needs?: Copy;
  wiki?: string;
  writes?: boolean;
}

export const step = (action: StepAction, target: string, zh: string, en: string, detail?: Copy, after?: string): Step =>
  ({ action, target, label: [zh, en], detail, after });

export const c = (target: string, zh: string, en: string, detail?: Copy, after?: string) => step("click", target, zh, en, detail, after);
export const f = (target: string, zh: string, en: string, detail?: Copy) => step("change", target, zh, en, detail);
export const r = (target: string, zh: string, en: string, detail?: Copy) => step("read", target, zh, en, detail);
export const d = (target: string, zh: string, en: string, detail?: Copy) => step("drag", target, zh, en, detail);

export const areas = [
  ["start", "上手与账号", "Getting started"],
  ["device", "设备连接与配置", "Device connection and setup"],
  ["support", "检测、支持与设备升级", "Diagnostics, support and device updates"],
  ["play", "数据载入与回放", "Loading and playback"],
  ["edit", "校对与标注", "Proofreading and annotation"],
  ["export", "检查与导出", "Validation and export"],
  ["local", "本地任务与写回", "Local tasks and writeback"],
  ["cloud", "云端 QC", "Cloud QC"],
  ["outbound", "外发审核", "Outbound review"],
  ["admin", "审核监管与账号管理", "Supervision and account management"],
  ["text", "文字勘误", "Text corrections"],
  ["updates", "版本与更新", "Versions and updates"],
] as const;

const loaded: Copy = ["打开一条有画面的练习录制。", "Open a practice recording with camera frames."];
const edit: Copy = ["先打开可编辑的练习录制，并确认处于「校对」页。", "Open an editable practice recording on the Proofreading tab."];
const managed: Copy = ["进入联网工作区并登录测试审核账号。", "Sign in to the managed workspace with a test reviewer account."];
const device: Copy = ["连接一台测试 D1。可用控件取决于连接方式和设备固件。", "Connect a test D1. Available controls depend on the connection and firmware."];
const manager: Copy = ["请在测试环境以有管理权限的账号进入管理模式。", "Enter Management mode with an authorized account in the test environment."];
const nas: Copy = ["用测试审核账号进入任务中心，并挂载含测试数据的 NAS 目录。", "Open Task Center with a test reviewer account and mount the test NAS directory."];
const cloud: Copy = ["用测试账号打开已配置的云端 QC，准备可访问的测试批次。", "Open configured Cloud QC with a test account and an accessible test batch."];
const outbound: Copy = ["用测试账号打开外发审核，准备已领取且媒体可读的测试批次。", "Open Outbound Review with a test account and a claimed test batch with readable media."];
const dataTab = c(".workspace-navigation button:last-child", "数据工作区", "Data workspace");
const homeTab = c(".workspace-navigation button:first-child", "设备管理区", "Device workspace");
const proofread = c(".view-tabs button", "校对", "Proofread");
const checks = c(".view-tabs button", "检查", "Checks");
const exports = c(".view-tabs button", "导出", "Export");
const task = c(".personal-task-trigger", "任务中心", "Task Center");
const cloudTab = c(".task-center-tabs button", "云端 QC", "Cloud QC");
const outboundTab = c(".task-center-tabs button", "外发审核", "Outbound review");
const adminTab = (zh: string, en: string) => c(".review-supervision nav button", zh, en);
const on = (zh: string, en: string, detail?: Copy, after?: string) => c("button", zh, en, detail, after);
const field = (zh: string, en: string, detail?: Copy) => f("input,select,textarea", zh, en, detail);
const observe = (selector: string, zh: string, en: string, detail?: Copy) => r(selector, zh, en, detail);
const menu = (zh: string, en: string) => c("summary", zh, en);
const library = on("标签库", "Label library");
const reason = on("不通过", "Reject");
const stop = on("取消任务", "Cancel task");
const finishNote: Copy = ["请等待软件显示实际结果。关闭对话框或提交失败不代表操作成功。", "Wait for the actual result. Closing a dialog or a failed submission does not indicate success."];
const nativePicker: Copy = ["在系统弹窗中完成选择，再返回软件。", "Complete the selection in the system dialog, then return to the app."];
const lessonsByArea: Record<string, Lesson[]> = {};
function lesson(area: string, id: string, zh: string, en: string, steps: Step[], options: Pick<Lesson, "needs" | "wiki" | "writes"> = {}) {
  (lessonsByArea[area] ??= []).push({ id, area, title: [zh, en], steps, ...options });
}

lesson("start", "offline", "进入离线模式并找到两大工作区", "Enter offline mode and find the two workspaces", [
  c(".workspace-mode-options button:first-child,.auth-offline-entry", "离线模式", "Offline mode", ["离线模式用本机身份，不计入公司统计。", "Offline mode uses a local identity and is excluded from company statistics."], ".workspace-navigation"),
  dataTab, homeTab,
], { wiki: "Quick-Start", needs: ["请从启动页或「切换工作模式」回到模式选择页。", "Start at launch or return to the mode chooser with Switch workspace mode."] });
lesson("start", "login", "配置用户中心并登录", "Configure the user center and sign in", [
  c(".workspace-mode-options button:last-child", "登录工作区", "Sign in to workspace", undefined, ".auth-panel form,.auth-connect"),
  on("导入用户中心配置", "Import user center configuration", nativePicker, ".auth-panel form"),
  f(".auth-panel input[autocomplete=username]", "账号", "Username"),
  f("#auth-password", "密码", "Password"),
  c(".auth-password-toggle", "显示密码", "Show password"), c(".auth-password-toggle", "隐藏密码", "Hide password"),
  c(".auth-panel button[type=submit]", "登录", "Sign in", undefined, ".workspace-navigation,.review-supervision-header"),
], { wiki: "Accounts-and-Annotations", needs: ["准备管理员配置文件及测试账号。已配置时可使用单独的「使用已有配置登录」课程。", "Have the admin configuration and a test account. Use Sign in with an existing configuration if already configured."] });
lesson("start", "existing-login", "使用已有配置登录", "Sign in with an existing configuration", [
  f(".auth-panel input[autocomplete=username]", "账号", "Username"), f("#auth-password", "密码", "Password"),
  c(".auth-panel button[type=submit]", "登录", "Sign in", undefined, ".workspace-navigation,.review-supervision-header"),
], { wiki: "Accounts-and-Annotations", needs: ["回到已配置用户中心的登录页。", "Open the sign-in page with a configured user center."] });
lesson("start", "register", "注册审核员账号", "Register a reviewer account", [
  on("注册审核员账号", "Register a reviewer account"), f(".auth-panel input[autocomplete=name]", "显示名称", "Display name"),
  f(".auth-panel input[autocomplete=username]", "账号", "Username"), f("#auth-password", "密码", "Password"),
  f(".auth-panel input[autocomplete=new-password]:not(#auth-password)", "确认密码", "Confirm password"),
  c(".auth-panel button[type=submit]", "创建并登录", "Create and sign in", undefined, ".workspace-navigation"),
], { wiki: "Accounts-and-Annotations", writes: true, needs: ["打开已配置用户中心的测试登录页。请使用新的测试账号名称。", "Use a configured test user center and a new test username."] });
lesson("start", "auth-recovery", "重试、切换表单与重新导入配置", "Recover sign-in and reimport configuration", [
  on("重新导入用户中心配置", "Reimport user center configuration", nativePicker),
  observe(".auth-panel", "登录、注册及模式选择", "Sign-in, registration and mode choice", ["启动失败时可点「重试」或进入离线模式。登录、注册间切换会清空密码字段。", "If startup fails, retry or enter offline mode. Switching sign-in forms clears passwords."]),
  on("选择工作模式", "Choose workspace mode", undefined, ".workspace-mode-options"),
], { wiki: "Accounts-and-Annotations" });
lesson("start", "identity", "查看身份与更改显示名称", "View identity and change display name", [
  c(".account-summary-button", "修改当前显示名称", "Edit display name"), f(".profile-editor-dialog input", "显示名称", "Display name"),
  c(".profile-editor-dialog button[type=submit]", "保存", "Save", undefined, ".account-summary-button:not([aria-expanded=true])"),
], { needs: managed, writes: true });
lesson("start", "language-mode", "中英文、退出与工作模式", "Language, sign-out and workspace mode", [
  c(".language-toggle", "English / 中文", "English / 中文"), on("切换工作模式", "Change workspace mode", undefined, ".workspace-mode-options"),
  observe(".workspace-mode-options", "工作模式", "Workspace modes", ["登录后可在工具栏用「退出登录」返回登录页。", "After signing in, use Sign out in the toolbar to return to sign-in."]),
], { wiki: "Quick-Start" });
lesson("start", "logout", "退出登录", "Sign out", [
  on("退出登录", "Sign out", undefined, ".auth-panel"), observe(".auth-panel", "登录页", "Sign-in page"),
], { needs: managed });
lesson("start", "management", "切换管理模式与测试模式", "Switch Management and Test modes", [
  on("管理模式", "Management mode", undefined, ".review-supervision-header"),
  observe(".review-supervision-header", "管理工作区", "Management workspace", ["管理员可回 D1 Manager 首页；有管理权限的普通审核员可打开「测试模式」。", "Return to D1 Manager Home, or use Test Mode if you are a reviewer with delegated management access."]),
], { needs: manager });

lesson("device", "usb", "Type-C 自动连接与网卡选择", "Type-C discovery and network adapter", [
  homeTab, c(".manager-navigation button:first-child", "首页", "Home"), on("Type-C 连接", "Type-C connection"),
  observe(".manager-connect-bar", "USB 网络连接", "USB network connection", ["使用数据线连接设备。多网卡时选择正确的连接；Windows 会在符合条件时尝试恢复 USB 地址。Type-C 占用时扩展双目可能断开。", "Connect a data cable. Pick the correct adapter if several are offered. Windows can recover eligible USB addresses. The extension stereo camera may be disconnected while Type-C is in use."]),
], { wiki: "Device-Management" });
lesson("device", "hotspot", "连接设备热点", "Connect to the device hotspot", [
  homeTab, c(".manager-navigation button:first-child", "首页", "Home"), on("设备热点（AP）", "Device hotspot (AP)"),
  observe(".manager-wifi", "可用 Wi-Fi", "Available Wi-Fi", ["Windows 可刷新、选热点、看信号并选默认或手动密码。Ubuntu 等平台先在系统 Wi-Fi 连接设备。", "On Windows refresh, choose the network, and use the default password or enter one. On Ubuntu and other platforms connect through system Wi-Fi first."]),
  c(".manager-connect-bar button", "连接设备", "Connect device"),
  observe(".manager-device-access", "连接状态与设备入口", "Connection status and device access"),
], { wiki: "Device-Management", needs: device });
lesson("device", "hotspot-windows", "Windows 扫描和加入热点", "Discover and join a hotspot on Windows", [
  on("刷新 Wi-Fi", "Refresh Wi-Fi"), c(".manager-wifi-list button:not(:disabled)", "D1 热点", "D1 hotspot"),
  c(".manager-wifi-form button[type=submit]", "连接热点或确认连接", "Join hotspot or confirm connection"),
], { wiki: "Device-Management", needs: ["在 Windows 进入设备热点页，打开网卡并让测试 D1 进入 AP 模式。", "On Windows, open the hotspot tab, enable Wi-Fi and put a test D1 in AP mode."] });
lesson("device", "hotspot-password", "手动填写热点密码", "Enter a hotspot password manually", [
  on("手动输入密码", "Enter password manually"), f("#d1-wifi-password", "热点密码", "Hotspot password"),
  c(".manager-wifi-form button[type=submit]", "连接热点", "Connect hotspot"),
], { wiki: "Device-Management", needs: ["在 Windows 先选中一个尚未连接的 D1 热点。", "On Windows select an unconnected D1 hotspot first."] });
lesson("device", "lan", "使用设备 IP 连接", "Connect using the device IP", [
  homeTab, c(".manager-navigation button:first-child", "首页", "Home"), on("局域网 IP", "LAN IP"), f("#d1-lan-ip", "设备 IP", "Device IP", ["填入设备播报的 IP。", "Enter the IP announced by the device."]),
  c(".manager-ap-form button[type=submit]", "连接设备", "Connect device"), observe(".manager-device-access", "设备工作区与连接状态", "Device access and connection state"),
], { wiki: "Device-Management", needs: device });
lesson("device", "device-page", "打开、刷新和返回设备原生页", "Open, refresh and leave the native device page", [
  c(".manager-access-card", "设备管理", "Device management", undefined, ".manager-device-page"),
  observe(".manager-device-page header", "设备地址与实际连接方式", "Device address and connection mode"),
  c(".manager-device-page header button:last-child", "刷新设备页面", "Refresh device page"),
  c(".manager-device-page header button:first-child", "返回设备管理", "Back to device management", undefined, ".manager-device-access"),
], { wiki: "Device-Management", needs: device });
lesson("device", "provision", "提交配网、核验新 IP 与失败重试", "Provision Wi-Fi, verify the new IP and retry", [

  f("frame:wifi-name", "Wi-Fi 名称", "Wi-Fi network name"),
  f("frame:wifi-password", "Wi-Fi 密码", "Wi-Fi password"),
  c("frame:wifi-submit", "提交配网", "Submit Wi-Fi configuration", ["按设备网页提示提交，等待设备连接。", "Follow the device page instructions, then wait for it to connect."]),

  r("frame:wifi-result", "设备网页或语音给出的配网结果", "The provisioning result on the device page or voice prompt", ["热点断开后请以设备的联网语音为准。", "If the hotspot disconnects, listen to the device for the network result."]),
  c(".manager-device-page header button:first-child", "返回设备管理", "Back to device management"),
  on("局域网 IP", "LAN IP"),
  f("#d1-lan-ip", "设备 IP", "Device IP", ["填写设备联网后播报的新 IP。", "Enter the new IP announced by the device."]),
  c(".manager-ap-form button[type=submit]", "连接设备", "Connect device"),
], { wiki: "Device-Management", needs: device, writes: true });
lesson("device", "configuration", "选择并保存设备名字与任务", "Choose and save a device name and task", [
  f("frame:display-name", "设备名字", "Device name"), c("frame:save-name", "保存设备名字", "Save device name"),
  f("frame:device-task", "设备任务", "Device task"), c("frame:save-task", "保存设备任务", "Save device task"),
], { wiki: "Device-Management", needs: device, writes: true });
lesson("device", "configuration-add", "新增设备名字和用户任务", "Add a device name and task", [
  f("frame:new-name", "新增用户名字", "New name"), c("frame:add-name", "新增名字", "Add name"),
  f("frame:new-task", "新增用户任务", "New task"), c("frame:add-task", "新增任务", "Add task"),
], { wiki: "Device-Management", needs: device, writes: true });
lesson("device", "configuration-camera", "调整相机配置并保存", "Adjust camera configuration and save", [
  f("frame:camera-field", "相机配置", "Camera configuration", ["按固件提供的字段修改练习值。", "Change a practice value in a field provided by the firmware."]),
  c("frame:camera-save", "保存并重启采集", "Save and restart capture", finishNote),
], { wiki: "Device-Management", needs: device, writes: true });
lesson("device", "configuration-runtime", "打开运行配置并修改可用参数", "Open runtime configuration and edit available settings", [
  c("frame:runtime-link", "运行配置", "Runtime configuration"),
  f("frame:runtime-category", "配置方向", "Configuration category"),
  f("frame:runtime-field", "采集模式、存储模式或队列", "Capture mode, storage mode or queue", ["只修改课程所用测试设备支持的字段。", "Edit a field supported by the test device."]),
  c("frame:runtime-save", "保存并重启相关服务", "Save and restart related services", finishNote),
], { wiki: "Device-Management", needs: device, writes: true });

lesson("device", "runtime", "查看设备身份、运行状态与相机存储", "Inspect identity, runtime, cameras and storage", [
  c(".manager-navigation button", "设备信息", "Device information"), observe(".manager-runtime,.manager-device-card", "设备状态", "Device status",
    ["核对 IP、版本、观测时间、相机与帧率、SD/eMMC、采集写入、灯色及已有自检或压力测试结果。固件未返回的字段显示未知。", "Review IP, versions, observation time, cameras and FPS, SD/eMMC, capture, LEDs and reported self-test or stress-test results. Missing fields are unknown."]),
  on("刷新状态", "Refresh status"), on("查看完整检测结果", "View full diagnostics"),
], { wiki: "Device-Management", needs: device });

lesson("support", "diagnostics", "运行设备检测并查看告警证据", "Run device diagnostics and inspect alert evidence", [
  c(".manager-navigation button", "检测排障", "Diagnostics"), on("运行设备检测", "Run diagnostics", undefined, ".manager-run-summary"),
  observe(".manager-run-summary", "检测状态和分类计数", "Diagnostic results and counts"),
  observe(".manager-checks,.manager-runtime-alerts", "检测项目、建议与设备证据", "Checks, suggestions and device evidence", ["展开实际存在的证据。检测只读设备报告。", "Expand available evidence. Diagnostics reads the device report."]),
], { wiki: "Device-Management", needs: device });
lesson("support", "cancel-diagnostics", "取消设备检测", "Cancel device diagnostics", [
  on("运行设备检测", "Run diagnostics"), on("取消检测", "Cancel diagnostics"),
], { needs: device });
lesson("support", "diagnostic-bundle", "预览并导出本地诊断包", "Preview and export a diagnostic bundle", [
  c(".manager-navigation button", "日志与支持", "Logs and support"), on("预览检测包", "Preview diagnostics bundle", undefined, ".manager-package-preview"),
  observe(".manager-package-preview", "文件、大小和 SHA-256", "Files, sizes and SHA-256"),
  on("导出到本机", "Export locally", nativePicker, ".manager-export-success"),
  on("打开所在位置", "Open location"),
], { wiki: "Device-Management", needs: ["先完成测试设备检测。", "Complete diagnostics on a test device first."] });
lesson("support", "support-upload", "预览并上传售后诊断日志", "Preview and send diagnostics to support", [
  c(".manager-navigation button", "日志与支持", "Logs and support"),
  c(".manager-support-upload button:first-child", "预览检测与日志", "Preview diagnostics and logs", nativePicker, ".manager-log-preview"),
  observe(".manager-log-preview", "设备 CID、版本、事件数和级别", "Device CID, version, event totals and levels"),
  on("上传到售后", "Upload to support", finishNote, ".manager-upload-state .manager-ota-success,.manager-support-upload .manager-ota-success"),
], { wiki: "Device-Management", needs: ["准备测试设备 CID、采集目录和已配置的测试售后服务。", "Have a test device CID, capture directory and configured test support service."], writes: true });
lesson("support", "support-reselect", "重选采集目录并重新预览", "Choose a different capture folder and preview again", [
  on("选择其他采集目录", "Choose another capture folder"), on("预览检测与日志", "Preview diagnostics and logs", nativePicker, ".manager-log-preview"),
  on("重新预览", "Preview again"),
], { needs: ["先完成一次日志预览。", "Preview a log source first."] });
lesson("support", "ota-check", "检查设备应用版本", "Check the device application release", [
  on("应用升级", "Application update"), on("检查最新版本", "Check latest release"),
  observe(".manager-ota", "当前与目标版本、包大小及检查详情", "Current and target versions, package size and check details"),
], { wiki: "Device-Management", needs: device });
lesson("support", "ota-submit", "确认设备升级并查看进度", "Confirm a device update and read its progress", [
  observe(".manager-ota-caution", "升级前条件", "Before updating", ["核对测试设备供电、温度、连接，以及录制、自检和压力测试是否停止。", "Verify test-device power, temperature and connectivity, and stop recording, self-test and stress tests."]),
  on("开始升级", "Start update"), observe(".manager-ota", "操作编号、观测时间和最终结果", "Operation ID, observation time and final result", finishNote),
], { wiki: "Device-Management", needs: ["仅在可升级的测试设备上操作，先完成版本检查。", "Use an eligible test device and complete the release check first."], writes: true });
lesson("support", "ota-history", "查看升级明细及售后上传", "Inspect update history and upload to support", [
  c(".manager-ota-history > summary", "升级日志与售后上传", "Update logs and support upload"), menu("查看本次日志", "View logs for this update"),
  on("上传本次升级日志到售后", "Send update logs to support"),
  on("预览本次升级日志", "Preview this update log"), observe(".manager-log-preview", "日志预览与售后回执", "Log preview and support receipt"),
], { needs: ["准备测试设备的一条升级记录。", "Have an update record from a test device."], writes: true });

lesson("play", "open-recording", "选择目录、打开录制并播放", "Choose a folder, open a recording and play", [
  dataTab,
  c(".topbar-actions .button:has(svg.lucide-folder-open),.main-content .empty-workspace button", "选择 SD 卡 / 选择数据目录", "Select SD card / Choose data folder", nativePicker, "event:d1-guide-source-selected"),
  observe(".episode-list", "录制列表和当前所选条目", "Recording list and current selection", ["单击选择，双击或聚焦后按 Enter/空格加载。选择目录后通常自动打开第一条。", "Click to select. Double-click or press Enter/Space on a focused row to open. The first recording normally opens after the folder is selected."]),
  c(".transport-buttons .play-button", "全局播放", "Global playback", undefined, ".transport-buttons .play-button:has(svg.lucide-pause)"),
  c(".transport-buttons .play-button", "暂停", "Pause", undefined, ".transport-buttons .play-button:has(svg.lucide-play)"),
], { wiki: "Quick-Start", needs: ["进入离线模式，准备一个含录制的目录。", "Enter Offline mode and have a folder containing a recording."] });
lesson("play", "record-list", "选中、打开和重新扫描录制列表", "Select, open and rescan recordings", [
  c(".episode-list button[aria-pressed]", "选择一条录制", "Select a recording"),
  observe(".episode-list button[aria-pressed=true]", "打开当前录制", "Open the selected recording", ["双击选中条目，或聚焦后按 Enter / Space。核对右侧加载路径以及首帧。", "Double-click the selected row or press Enter/Space while it is focused. Check the loaded path and first frame."]),
  on("重新扫描", "Rescan"), observe(".sidebar-footer", "目录读取状态与文件统计", "Directory status and file counts"),
], { wiki: "Quick-Start", needs: loaded });
lesson("play", "list-display", "收起、展开、缩放和跳过录制", "Collapse, expand, resize and skip recordings", [
  on("收起目录", "Collapse directory"), on("展开目录", "Expand directory"), f(".sidebar-zoom input", "目录缩放", "Directory zoom"),
  c(".episode-skip", "跳过数据", "Skip recording"), on("恢复跳过的数据", "Restore skipped recordings"),
], { needs: loaded });
lesson("play", "source-details", "来源路径、列表状态与错误历史", "Source path, row status and operation history", [
  observe(".source-display", "源路径或批次", "Source path or batch"),
  observe(".episode-list", "相机、审核、草稿和待写状态", "Camera, review, draft and writeback status"),
  on("操作错误历史", "Operation errors", undefined, ".operation-history"),
  observe(".operation-history", "错误时间、操作、路径和详情", "Error time, operation, path and details"),
  on("关闭错误历史", "Close error history"),
], { wiki: "Troubleshooting", needs: loaded });
lesson("play", "batch-rename", "修改批次文件夹名称", "Rename a batch folder", [
  on("修改批次名称", "Rename batch"), field("新文件夹名称", "New folder name", ["保留原采集日期。使用可写练习目录。", "Keep the capture date. Use a writable practice folder."]),
  on("确认更名", "Confirm rename", finishNote, ".alert-notice"),
], { needs: loaded, writes: true });
lesson("play", "play-controls", "播放、逐帧、拖动、倍速与帧率", "Play, step, seek and adjust speed and FPS", [
  proofread, c(".transport-buttons .play-button", "全局播放", "Global playback", undefined, ".transport-buttons .play-button:has(svg.lucide-pause)"),
  c(".transport-buttons .play-button", "暂停", "Pause", undefined, ".transport-buttons .play-button:has(svg.lucide-play)"),
  c(".transport-buttons button:first-child", "上一帧", "Previous frame"), c(".transport-buttons button:last-child", "下一帧", "Next frame"),
  d(".quality-timeline input[type=range],.review-timeline input[type=range]", "校对播放帧", "Proofreading playhead"),
  f(".speed-control select", "播放速度", "Playback speed", ["本地提供 0.25×、0.5×、1×、2×、3×、4×、6×、8×；外发另有细分档位。实际速度取决于读取与解码能力。", "Local playback offers 0.25×, 0.5×, 1×, 2×, 3×, 4×, 6× and 8×; outbound has finer increments. Reading and decoding determine the actual rate."]),
  f(".fps-control select", "播放帧率", "Playback FPS", ["可选自动、15、24、30 或 60 FPS。", "Choose automatic, 15, 24, 30 or 60 FPS."]),
], { wiki: "Playback-and-Clipping", needs: loaded });
lesson("play", "camera-status", "查看相机、分辨率与渲染状态", "Read cameras, resolution and rendering status", [
  observe(".camera-grid", "相机画面与未接入占位", "Camera views and disconnected slots", ["本地布局预留七个位置。每路脚注显示相机名称、分辨率与就绪或错误状态。", "The local layout reserves seven slots. The caption shows camera, resolution and readiness or failure."]),
  observe(".frame-render-track", "已渲染路数", "Rendered camera count", ["暂停或定位后等待各路完成。", "Pause or seek and wait for the cameras to settle."]),
], { wiki: "Playback-and-Clipping", needs: loaded });
lesson("play", "quality", "选择预览清晰度和原片", "Choose preview quality and original video", [
  f(".preview-quality", "播放清晰度", "Playback quality", ["可在自动、可用档位与原片之间选择。校验或解码失败可回退原片。", "Choose Auto, an available rendition or Original. Failed verification or decoding can fall back to the original."]),
  observe(".frame-panel:has(.preview-quality)", "分辨率与回退提示", "Resolution and fallback notices"),
], { wiki: "Adaptive-Playback", needs: ["打开提供自适应预览的练习录制。", "Open a practice recording with adaptive previews."] });
lesson("play", "preview-settings", "设置原始数据与预览根目录", "Set original and preview root directories", [
  on("预览设置（开发）", "Preview settings (development)"),
  f(".preview-settings input:first-of-type", "原始数据根目录", "Original data root"),
  f(".preview-settings label:nth-of-type(2) input,.preview-settings .preview-path:nth-of-type(2) input", "预览根目录", "Preview root"),
  c(".preview-settings button", "保存", "Save"), on("预览设置（开发）", "Preview settings (development)"),
  on("恢复自动", "Restore automatic configuration"),
], { wiki: "Adaptive-Playback", needs: loaded, writes: true });
lesson("play", "cached-playback", "使用本地流畅播放", "Cache a recording for smooth local playback", [
  c(".local-playback-button", "本地流畅播放", "Smooth local playback"),
  observe(".camera-grid", "本地播放状态", "Local playback status", ["等待缓存就绪后播放。审核仍针对原来的存储路径。", "Play once the cache is ready. Reviews still belong to the original storage path."]),
], { wiki: "Adaptive-Playback", needs: ["打开 NAS 上的视频练习录制。", "Open a practice video recording on the NAS."] });
lesson("play", "telemetry", "查看位置、速度、欧拉角和角速度", "Inspect position, velocity, Euler angles and angular velocity", [
  ...[["位置","Position"],["速度","Velocity"],["欧拉角","Euler angles"],["角速度","Angular velocity"]].map(([zh,en]) => c(".metric-switcher button",zh,en)),
  observe(".telemetry-chart", "当前帧数值与曲线游标", "Current values and chart cursor"),
], { needs: loaded });
lesson("play", "skeleton", "旋转、缩放和同步观察 3D 骨架", "Orbit, zoom and inspect the synchronized 3D skeleton", [
  d(".skeleton-side-panel canvas", "旋转骨架视图", "Rotate the skeleton view", ["拖动旋转，滚轮缩放，可平移查看；视频与骨架共享当前帧。", "Drag to orbit, scroll to zoom, and pan to inspect. Video and skeleton share the current frame."]),
  f(".skeleton-side-panel select", "骨架追赶速度", "Skeleton catch-up speed"),
  observe(".skeleton-side-panel", "关节数、时间轴和估计地面", "Joint count, timeline and estimated floor"),
], { wiki: "Playback-and-Clipping", needs: ["打开包含可读骨架的练习录制。", "Open a practice recording with a readable skeleton."] });

lesson("edit", "annotation-source", "切换机标来源、查看 JSON 和重新读取", "Switch annotation sources, read JSON and reload", [
  f(".quality-workspace select", "机标来源", "Annotation source"), on("查看原始 JSON", "View raw JSON"),
  observe("dialog[open]", "机标 JSON", "Annotation JSON"), on("关闭 JSON", "Close JSON"),
  on("重新读取机标", "Reload annotation"),
], { wiki: "Accounts-and-Annotations", needs: edit });
lesson("edit", "segment-bounds", "选择片段、回放并编辑起止帧", "Select, preview and adjust a segment", [
  c(".review-span", "选择动作片段", "Choose an action segment"),
  d(".review-edge", "拖动片段边界", "Drag a segment edge"), field("复核起始帧", "Review start frame"),
  field("复核结束帧", "Review end frame", ["结束值不含该帧，前后连续段可共用这个边界值。", "The end frame is exclusive. Adjacent segments may share that boundary value."]),
  observe(".quality-timeline", "片段时间轴", "Segment timeline", ["上下键切换片段；左右键按当前焦点调整；空格控制播放。", "Up/Down select a segment, Left/Right act on the focused control, and Space toggles playback."]),
], { wiki: "Playback-and-Clipping", needs: edit });
lesson("edit", "segment-create", "新增、分割、删除和恢复片段", "Add, split, delete and restore segments", [
  on("新增片段", "Add segment"), d(".quality-timeline input[type=range]", "定位到片段内部", "Seek inside the segment"),
  c(".quality-timeline button:has(svg.lucide-scissors)", "剪切片段", "Split segment", ["也可以按 X。", "You can also press X."]),
  c(".machine-segment-list button:has(svg.lucide-trash-2),button[aria-label*='删除机标片段'],button[aria-label*='Delete annotation segment']", "删除片段", "Delete segment"),
  c("button", "恢复删除的片段", "Restore deleted segments"),
], { wiki: "Accounts-and-Annotations", needs: edit, writes: true });
lesson("edit", "segment-overlap", "定位重叠与恢复删除历史", "Locate overlaps and restore deletion history", [
  c(".machine-boundary-warning button", "定位重叠片段", "Locate overlapping segment"),
  d(".review-edge", "调整重叠边界", "Adjust overlapping boundary"),
  observe(".quality-timeline", "结束帧不包含在片段内", "Segment end is exclusive", ["恢复删除历史如有重叠，可从确认框生成无重叠草稿，再逐段核对。", "If deletion history overlaps, the confirmation dialog can create a non-overlapping draft for review." ]),
], { needs: ["准备一条含重叠片段的练习录制。", "Use a practice recording containing overlapping segments."] });
lesson("edit", "description", "填写动作描述和应用文字建议", "Edit descriptions and apply text suggestions", [
  field("中文动作描述", "Chinese action description"),
  observe(".quality-workspace", "本机草稿与文字提示", "Local draft and text suggestions", ["有疑似术语时可点建议应用，也可撤销本次修正。", "If a terminology suggestion appears, apply it or undo the correction."]),
], { wiki: "Accounts-and-Annotations", needs: edit, writes: true });
lesson("edit", "label-library", "保存、使用、排序和删除常用描述", "Save, apply, reorder and delete common descriptions", [
  library, on("保存当前描述", "Save current description"),
  c(".label-library .label-library-index", "使用常用描述", "Apply a saved description", ["数字键可使用界面标明的标签。", "Number keys apply labels where indicated."]),
  observe(".label-library", "标签排序和移除", "Reorder or remove labels", ["拖动条目排序，也可使用按键提示。删除只影响标签库。", "Drag to reorder, or use the shown shortcuts. Deleting affects the library entry."]),
  on("关闭标签库", "Close label library"),
], { needs: ["先选中一个片段，并填好一条练习描述。", "Select a segment and enter a practice description."], writes: true });
lesson("edit", "special-tags", "添加特殊标签并保存为常用", "Add a special tag and save it as a favorite", [
  on("添加标签", "Add tag"), c(".episode-tags-dialog input[type=checkbox],.special-tag-editor input[type=checkbox],dialog[open] input[type=checkbox]", "选择相机", "Select a camera"),
  field("特殊标签说明", "Special tag description"), c("label", "存为常用", "Save as favorite"),
  on("添加", "Add"), observe("[id=episode-special-tags]", "整条录制的特殊标签", "Recording-level special tags"),
], { needs: edit, writes: true });
lesson("edit", "manage-special-tags", "修改标签、管理常用项与删除标签", "Edit tags, manage favorites and delete tags", [
  c("#episode-special-tags button:has(svg.lucide-pencil)", "修改标签", "Edit tag"),
  field("特殊标签说明", "Special tag description"), on("保存", "Save"),
  c("#episode-special-tags button:has(svg.lucide-trash-2)", "删除标签", "Delete tag"),
  observe("#episode-special-tags", "常用标签管理", "Favorite tag management", ["进入添加标签窗口后点「管理」，可移除常用项。", "Open Add tag and select Manage to remove favorites."]),
], { needs: ["打开已添加特殊标签的练习录制。", "Open a practice recording with a special tag."], writes: true });
lesson("edit", "skeleton-source", "选择骨架标注来源", "Select a skeleton annotation source", [
  on("骨架片段", "Skeleton segments"),
  f(".machine-source-picker select", "骨架标注来源", "Skeleton annotation source", ["选择文件名含 skeleton 的 JSON 来源。人工增删改统一保存到 skeleton.description.json，来源文件保持原样。", "Select a JSON source whose filename contains skeleton. Human edits always save to skeleton.description.json; source files stay unchanged."]),
  observe(".quality-output", "唯一人工输出文件", "Single human output file"),
], { wiki: "Accounts-and-Annotations", needs: edit });
lesson("edit", "skeleton-segments", "新增并保存骨架片段", "Add and save a skeleton segment", [
  on("骨架片段", "Skeleton segments"), on("新增片段", "Add segment"),
  field("中文动作描述", "Chinese action description"), observe(".quality-save-state", "骨架描述自动保存状态", "Skeleton description autosave", ["修改后等待「人工结果已保存」或本机待写回提示。", "Wait for the saved or queued writeback status after editing."]),
  on("重新读取骨架描述", "Reload skeleton description"),
], { needs: edit, writes: true });
lesson("edit", "out-of-range", "核对机标越界、保留范围并确认", "Inspect annotation bounds and confirm the retained range", [
  on("查看越界片段并处理", "View and resolve out-of-range segments"),
  observe(".video-range-dialog", "受影响片段、原范围和描述", "Affected segments, original ranges and descriptions"),
  c(".video-range-dialog input[type=checkbox]", "确认已核对视频内容", "Confirm that you checked the video"),
  on("应用处理并保存待审核草稿", "Apply and save a review draft", undefined, ".machine-boundary-warning"),
  c("input[type=checkbox]", "我已回放核对保留片段的动作与边界", "I checked the retained actions and boundaries"),
], { needs: ["用一条机标帧数与视频不一致的练习录制。", "Use a practice recording whose annotation frame count differs from its video."], writes: true });
lesson("edit", "missing-end", "核对机标推定的结束帧", "Verify inferred annotation end frames", [
  on("定位原片段", "Locate original segment"), field("复核结束帧", "Review end frame"),
  c("input[type=checkbox]", "我已人工核对上述片段边界", "I verified these segment boundaries"),
], { needs: ["用一条机标缺少结束帧的练习录制。", "Use a practice recording with missing annotation end frames."] });
lesson("edit", "approve", "通过审核并打开下一条", "Approve a review and open the next recording", [
  on("通过", "Approve", ["点击会提交练习录制的结论。如果出现文字检查窗口，确认核对后继续。", "This submits the practice recording. If the text-check dialog appears, verify its suggestions before continuing."], "event:d1-guide-review-saved"),
  observe(".alert-notice,.quality-save-state", "实际保存状态", "Actual save status", finishNote),
], { wiki: "Accounts-and-Annotations", needs: edit, writes: true });
lesson("edit", "reject", "不通过、选择原因并提交", "Reject a recording and submit a reason", [
  reason, c(".rejection-options button:not(:disabled)", "选择不通过原因", "Choose a rejection reason"),
  on("确认不通过", "Confirm rejection", finishNote, "event:d1-guide-review-saved"),
  observe(".alert-notice,.quality-workspace", "保存结果与下一条", "Saved result and next recording"),
], { wiki: "Accounts-and-Annotations", needs: edit, writes: true });
lesson("edit", "custom-reason", "填写其他原因及维护常用原因", "Enter another reason and manage common reasons", [
  reason, on("其他原因", "Other reason"), field("其他原因内容", "Other reason details"),
  on("常用原因", "Common reasons"),
  on("添加常用原因", "Add common reason"), field("常用原因名称", "Common reason name"), on("保存常用原因", "Save common reason"),
  on("调整顺序", "Reorder"), observe(".rejection-options", "拖动排序、移除与恢复默认", "Drag to reorder, remove or restore defaults"),
  on("取消", "Cancel"),
], { needs: edit, writes: true });
lesson("edit", "reopen-draft", "重开待写结论、恢复草稿和重试保存", "Reopen a queued decision, recover and retry saving", [
  on("重新编辑片段", "Edit segments again"), observe("dialog[open]", "重新编辑影响说明", "Reopen confirmation details"),
  on("确认重新编辑", "Confirm reopening"), observe(".quality-workspace", "待复审草稿", "Draft awaiting re-review", ["若有保存失败的提示，可用「重试保存」。", "If saving fails, use Retry save."]),
], { needs: ["打开有待写回结论的练习录制。", "Open a practice recording with a queued decision."], writes: true });

lesson("export", "validate", "运行数据检查并阅读结果", "Run data validation and read its results", [
  checks, c(".check-heading-actions .button-primary", "运行数据检查", "Run data validation", undefined, ".stream-checks .status-mark.status-ok,.stream-checks .status-mark.status-pass,.stream-checks .status-mark.status-warning,.stream-checks .status-mark.status-error,.check-summary-band"),
  observe(".stream-checks", "总帧、抽检、解码及分流结果", "Frame totals, samples, decoding and stream results", ["JPEG 图像抽检选 1%、25%、50%、73% 和 99% 的位置。", "JPEG sample positions are 1%, 25%, 50%, 73% and 99%."]),
  observe(".issue-list", "错误与警告", "Errors and warnings"),
], { wiki: "Data-Validation", needs: loaded });
lesson("export", "locate-errors", "从检查问题定位画面与设置范围", "Locate a validation issue and set a range", [
  checks, c(".issue-list button:not(:disabled)", "定位检查问题的帧", "Locate the issue frame", undefined, ".play-button"),
  observe(".quality-timeline", "复核与导出帧范围", "Review and export frame range", ["问题定位后的复核视图可用 [ 和 ] 以当前帧设置导出起止；回到导出页核对范围。", "After locating an issue, use [ and ] to set export bounds at the current frame. Verify them on Export."]),
  exports, observe(".export-source-band", "裁剪范围与片段状态", "Trim range and clip state"),
], { wiki: "Playback-and-Clipping", needs: ["准备一条已检查且含可定位问题的练习录制。", "Use a validated practice recording with a locatable issue."] });
lesson("export", "validation-report", "导出检查报告", "Export a validation report", [
  checks, on("导出报告", "Export report", nativePicker),
  observe(".main-content", "报告位置及检查状态", "Report location and validation status", ["检查页显示自动后台报告；手动导出位置由你选择。", "Checks can show the background report. You choose the manual export location."]),
], { wiki: "Data-Validation", needs: ["先完成一次数据检查。", "Complete data validation first."] });
lesson("export", "single-export", "选择格式、确认导出并打开结果", "Choose a format, export, and open the result", [
  exports, f(".format-picker", "目标导出格式", "Target export format", ["按用途选 MCAP、HDF5 或 LeRobot v2.1。", "Choose MCAP, HDF5 or LeRobot v2.1." ]),
  on("选择目录并导出", "Choose folder and export", nativePicker, ".export-result"),
  observe(".export-result", "文件数、输出和元数据", "Output, file count and metadata"),
  on("在文件管理器中显示", "Show in file manager"),
], { wiki: "Data-Export", needs: ["打开已检查的 JPEG 类练习录制，准备可写输出目录。", "Open a validated JPEG-based recording and have a writable destination."], writes: true });
lesson("export", "batch-export", "筛选源可用项、全选并批量导出", "Select available sources and export in a batch", [
  c(".view-tabs button,.empty-workspace button", "批量", "Batch"), on("刷新本地标注", "Refresh local annotations"),
  c(".batch-toolbar input[type=checkbox],.batch-actions input[type=checkbox],.batch-view input[type=checkbox]", "全选可用项", "Select all available"),
  c(".batch-format-picker", "批量导出格式", "Batch export format"),
  on("选择目录并批量导出", "Choose folder and batch export", nativePicker, ".batch-result"),
  observe(".batch-result", "成功、失败和日志", "Successes, failures and logs"),
], { wiki: "Data-Export", needs: ["准备至少一条已有本机标注、源可用的练习录制。", "Have a reachable practice recording with a saved local annotation."], writes: true });
lesson("export", "cancel-operation", "取消耗时操作并检查已完成结果", "Cancel an operation and review completed output", [
  stop, observe(".main-content", "取消状态及已完成项", "Cancellation status and completed items"),
], { needs: ["先启动一个可取消的检查、导出或载入操作。", "Start a cancellable validation, export or load operation first."] });

lesson("local", "task-discovery", "打开任务中心、设置根目录并检索批次", "Open Task Center, set the root and find batches", [
  task, on("更改目录", "Change folder", nativePicker), on("刷新任务进度", "Refresh task progress"),
  field("姓名 / 账号 / 未领取", "Name / username / unclaimed"),
  field("输入名称关键词", "Batch name keyword"), f(".task-date-filter:first-of-type input,.task-filters input[type=date]", "采集日期范围", "Capture date range"),
  on("清空查询", "Clear search"), observe(".task-scan-status", "服务器统计、进度与上次结果", "Server statistics, progress and last result"),
], { wiki: "Task-Center", needs: nas });
lesson("local", "task-claim", "展开批次、领取、进入和释放", "Expand, claim, enter and release a batch", [
  c(".task-tree .task-node-name,.task-tree button:has(svg.lucide-chevron-right)", "展开测试批次", "Expand a test batch"),
  on("仅未审核", "Unreviewed only"), on("显示全部", "Show all"), on("领取", "Claim"),
  on("进入审核", "Open review"), observe(".episode-list,.task-tree", "批次录制与 QC 状态", "Batch recordings and QC status"),
], { wiki: "Task-Center", needs: nas, writes: true });
lesson("local", "task-admin", "立即统计、转交和释放本地批次", "Rebuild statistics, transfer and release local batches", [
  on("立即统计", "Rebuild now"), on("转交", "Transfer"), f(".task-transfer input", "审核账号", "Reviewer account"),
  on("确认转交", "Confirm transfer"), on("释放", "Release"),
], { wiki: "Task-Center", needs: manager, writes: true });
lesson("local", "task-release", "释放本人领取的批次", "Release a batch you claimed", [
  on("释放批次", "Release batch"), observe(".task-tree", "领取状态", "Claim status", finishNote),
], { wiki: "Task-Center", needs: nas, writes: true });
lesson("local", "reject-batch", "选择“批量不通过”并检查处理回执", "Reject selected recordings and inspect results", [
  c(".episode-rejection-select", "选择练习录制", "Select a practice recording"),
  on("批量不通过", "Batch reject"),
  observe(".batch-rejection-warning", "待处理和排除项", "Pending and excluded items"),
  c(".rejection-options button:not(:disabled)", "选择不通过原因", "Choose the rejection reason"),
  c(".batch-rejection-confirm input", "确认这些未审核数据", "Confirm unreviewed recordings"),
  on("确认不通过", "Confirm rejection", finishNote), observe(".rejection-dialog", "成功、待写、跳过和失败", "Successes, queued items, skips and failures"),
], { needs: edit, writes: true });
lesson("local", "reject-folder", "整文件夹不通过和中途停止", "Reject a folder or stop the operation", [
  on("整文件夹不通过", "Reject entire folder"),
  observe(".batch-rejection-warning", "确认文件夹影响范围", "Verify the affected folder scope"),
  c(".rejection-options button:not(:disabled)", "选择不通过原因", "Choose the rejection reason"),
  c(".batch-rejection-confirm input", "确认未审核数据", "Confirm unreviewed data"),
  on("确认不通过", "Confirm rejection"), observe(".rejection-dialog", "逐项结果", "Item results", ["任务运行中可用「停止」，查看未执行数量。", "Select Stop while processing to see how many items were left."]),
], { needs: edit, writes: true });
lesson("local", "nas-writeback", "查看、复查并确认本机结果写回", "Inspect queued results, recheck and confirm NAS writeback", [
  on("查看待写结果", "View queued results"), observe("dialog[open]", "本机结论、骨架描述、时间与冲突", "Local decisions, skeleton descriptions, times and conflicts"),
  on("重新检查", "Recheck storage"), on("确认写回数据目录", "Confirm writeback to data folder", finishNote),
], { needs: ["准备一条已有待写回结果的测试录制，并确保测试 NAS 目录可用。", "Have a test recording with a queued result and a reachable test NAS."], writes: true });
lesson("local", "audit-sync", "查看待传操作、重试和重新登录", "Inspect pending activity, retry and reauthenticate", [
  on("同步详情", "Sync details"), observe(".audit-sync-notice,[aria-label='操作记录同步状态']", "待传、未落盘、拒绝与确认时间", "Pending, unsaved, rejected and confirmed status"),
  on("重试上传", "Retry upload"),
], { wiki: "Troubleshooting", needs: ["联网审核有待传操作事件时打开任务。登录失效时可用弹窗的「登录并补传」。", "Use the guide when managed activity is pending. If the session expired, use Sign in and resend in the dialog."] });
lesson("local", "audit-reauth", "原账号登录并补传", "Sign back in and resend", [
  field("当前账号密码", "Current account password"), on("登录并补传", "Sign in and resend", finishNote),
], { needs: ["用测试账号进入登录失效且有待传事件的补传弹窗。", "Open the reauthentication dialog for an expired test session with pending events."] });

lesson("cloud", "cloud-list", "查看云端批次、明细和刷新", "Browse and refresh Cloud QC plans", [
  cloudTab, on("刷新云端任务", "Refresh Cloud QC tasks"),
  observe(".cloud-qc-tasks,.task-center-cloud", "公司、批次、抽样和读取状态", "Company, batch, sample size and load state"),
  menu("批次详情", "Batch details"),
], { needs: cloud });
lesson("cloud", "cloud-open", "领取、下载并打开云端录制", "Claim, download and open a cloud recording", [
  on("领取并打开", "Claim and open", ["下载进行中可点「取消」；领取状态未核验前只可预览。", "Cancel is available while downloading. Preview remains read-only until claim checks finish."], ".quality-workspace"),
  observe(".quality-workspace", "实际机标、下载目录和草稿", "Actual annotation, download path and draft"),
], { needs: cloud, writes: true });
lesson("cloud", "cloud-resume", "打开本人已领取的云端录制", "Open a cloud recording you claimed", [
  on("打开审核", "Open review", undefined, ".quality-workspace"),
  observe(".quality-workspace", "云端校对面板", "Cloud proofreading panel", ["动作、骨架、标签和审核沿用校对区控件。可切到对应的校对课程继续。", "Actions, skeletons, tags and decisions use the proofreading controls. Continue with the relevant proofreading lesson."]),
], { needs: cloud });
lesson("cloud", "cloud-sync", "同步、重试和重新领取补传", "Sync, retry and reclaim to resend", [
  menu("更多", "More"), on("同步已保存的结论", "Sync saved decision", finishNote),
  observe(".task-center-cloud", "同步与撤回状态", "Sync and withdrawal status", ["遇到待确认状态时用「重试同步 QC」；需要恢复领取时用「领取并补传原结论」。", "Use Retry QC sync for an unconfirmed result. Use Claim and resend original decision when the claim must be restored."]),
], { needs: cloud, writes: true });
lesson("cloud", "cloud-retry", "重试云端 QC 确认", "Retry Cloud QC acknowledgement", [
  on("重试同步 QC", "Retry QC sync", finishNote),
], { needs: ["测试云端录制需要存在待确认结果。", "Use a test recording with a pending Cloud QC result."], writes: true });
lesson("cloud", "cloud-reclaim", "领取并补传原结论", "Claim and resend the original decision", [
  on("领取并补传原结论", "Claim and resend original decision", finishNote),
], { needs: ["测试云端录制有待补传结论，且账号具备领取权限。", "Use a test recording with a queued result and permission to claim."], writes: true });
lesson("cloud", "sampling", "配置公司抽样及放行规则", "Configure company sampling and release policy", [
  field("抽样策略公司", "Sampling policy company"), c(".cloud-qc-policy input[type=checkbox]", "新订单启用抽检", "Enable sampling for new orders"),
  f(".cloud-qc-policy input[type=number]", "抽样比例", "Sample percentage"),
  f(".cloud-qc-policy label:nth-of-type(3) select", "批次范围", "Batch scope"),
  f(".cloud-qc-policy label:nth-of-type(4) select", "通过后", "On passing"),
  f(".cloud-qc-policy label:nth-of-type(5) select", "不通过时", "On failure"),
  f(".cloud-qc-policy input:not([type=number]):not([type=checkbox]),.cloud-qc-policy textarea", "变更原因", "Change reason"),
  on("保存策略", "Save policy", finishNote),
], { needs: manager, writes: true });
lesson("cloud", "backfill", "回填历史 5% 抽检并转全量审查", "Backfill 5% historical sampling and escalate to full review", [
  field("历史抽检回填原因", "Historical sampling reason"), on("抽检已处理订单（5%）", "Sample processed orders (5%)"),
  menu("管理员操作", "Administrator actions"), on("转全量审查", "Escalate to full review"),
], { needs: ["在测试公司保存已启用的 5% 抽检策略，并准备符合条件的历史订单。", "Save an enabled 5% policy for a test company and use an eligible historical order."], writes: true });

lesson("outbound", "outbound-list", "查看、刷新、领取和释放外发批次", "Browse, refresh, claim and release outbound batches", [
  outboundTab, on("刷新外发批次", "Refresh outbound batches"),
  on("领取并打开", "Claim and open"), observe(".outbound-progress", "已审、有效、无效、异常和合格率", "Reviewed, valid, invalid, anomalous and pass rate"),
  on("释放批次", "Release batch", finishNote),
], { needs: ["用测试账号打开尚未领取且媒体可读的外发测试批次。", "Use a test account with an unclaimed outbound test batch and readable media."], writes: true });
lesson("outbound", "outbound-pending", "查看总进度并筛选未审核录制", "Check overall progress and filter unreviewed recordings", [
  outboundTab, observe(".outbound-queue-progress", "审核进度和已审有效率", "Review progress and valid rate", ["同一原始录制只计一次，已审有效率为有效条数除以已审条数。", "Each original recording counts once. The rate divides valid by reviewed recordings."]),
  c(".outbound-queue-overview .outbound-pending-filter[aria-pressed=false]", "未审核", "Unreviewed"),
  c(".outbound-queue-overview .outbound-pending-filter[aria-pressed=true]", "恢复完整列表", "Restore the full list"),
], { needs: outbound });
lesson("outbound", "outbound-play", "切换录制和分段、同步播放并返回任务", "Switch recordings and parts, play in sync and return", [
  c(".outbound-recordings button:not(:disabled)", "选择测试录制", "Select a test recording"),
  observe(".outbound-time", "连续录制时间轴", "Continuous recording timeline", ["各 MP4 分段已合成一条时间轴，播放会自动衔接；拖动可跨段定位，时长未读完时先等待确认。", "MP4 parts share one timeline and advance automatically. Seek across parts after the total duration is available."]),
  on("全局播放", "Global playback"), on("暂停", "Pause"),
  d(".outbound-transport input[type=range]", "视频播放位置", "Video position"),
  f(".outbound-transport select", "播放速度", "Playback speed"),
  c(".outbound-transport .icon-button", "切换主相机声音", "Toggle main camera audio"),
  on("返回任务中心", "Return to Task Center"),
], { needs: ["进入已领取的外发测试批次并打开含两段以上、各路就绪的录制。", "Open a claimed outbound test recording with at least two parts and ready videos."] });
lesson("outbound", "outbound-picture", "切换铺满 / 完整画面并放大", "Switch fit mode, zoom and exit fullscreen", [
  c(".outbound-fit", "完整画面 / 铺满画面", "Fit entire frame / Fill frame"),
  c(".outbound-expand", "放大相机", "Expand camera"),
  c(":fullscreen .outbound-expand", "退出相机全屏", "Exit camera fullscreen"),
], { needs: outbound });
lesson("outbound", "outbound-failure", "识别相机缺失和重试失败视频", "Identify missing cameras and retry failed videos", [
  observe(".outbound-video-grid,.outbound-video-stage", "就绪、加载、缺失或失败状态", "Ready, loading, missing or failed status", ["缺少 MP4 索引、网络异常和票据过期会有不同提示。有效数据必须全部视频就绪；明确缺失或读取失败可填写实际原因提交异常或无效。仅加载中不代表文件损坏。", "Missing MP4 indexes, network errors and expired tickets have different messages. Valid requires all videos ready. Confirmed missing or failed sources can be marked anomalous or invalid with an accurate reason. Loading alone does not prove corruption."]),
  on("重试失败视频", "Retry failed videos"),
], { needs: ["打开带有可重试媒体故障的外发测试录制。", "Use an outbound test recording with a retryable media failure."] });
lesson("outbound", "outbound-valid", "判为有效并核对下一条", "Mark valid and verify progression", [
  on("有效数据", "Valid data"), observe(".outbound-progress,.outbound-recordings", "结果与下一条待审", "Result and next pending recording", finishNote),
], { needs: outbound, writes: true });
for (const [id, zh, en] of [["invalid","无效","Invalid"],["anomalous","异常","Anomalous"]] as const) {
  lesson("outbound", "outbound-" + id, "判为" + zh + "、填写原因并提交", "Mark " + en.toLowerCase() + " and submit a reason", [
    on(zh + "数据", en + " data"),
    f(".outbound-one-time input", "填写一次性原因", "Enter a one-time reason", ["也可展开「常用原因」直接选择，或点选历史输入。", "You can also expand Common reasons or pick from recent reasons."]),
    c(".outbound-reason-dialog footer .button-primary", "确认提交结论", "Confirm decision"),
    observe(".outbound-progress,.outbound-recordings", "回执、统计和下一条", "Acknowledgement, counts and next recording", finishNote),
  ], { needs: id === "invalid" ? outbound : ["使用支持异常结论的测试交付服务，并打开各路媒体就绪的测试录制。", "Use a test delivery service that supports anomalous decisions and a recording with ready media."], writes: true });
}
lesson("outbound", "outbound-reasons", "保存外发常用原因", "Save a common outbound reason", [
  on("无效数据", "Invalid data"),
  on("添加常用原因", "Add common reason"),
  f(".outbound-reason-dialog .rejection-custom-editor input", "自定义常用原因", "Custom common reason"),
  c(".outbound-reason-dialog form button[type=submit]", "保存常用项", "Save as a common reason"),
  c(".outbound-reason-dialog header button", "关闭原因窗口", "Close reason dialog"),
], { needs: outbound, writes: true });

lesson("admin", "admin-overview", "扫描审核总览、筛选和导出通过数据", "Scan review overview, filter and export approved data", [
  adminTab("审核总览", "Review overview"), on("选择路径", "Choose path", nativePicker),
  on("扫描总览", "Scan overview"), observe(".reviewed-catalog,.reviewed-summary,.review-supervision", "结论、原始时长、有效时长和异常", "Decisions, original and effective durations, and anomalies"),
  field("数据状态筛选", "Data status filter"),
  on("导出通过数据", "Export approved recordings", nativePicker),
], { needs: manager, writes: true });
lesson("admin", "admin-events", "实时行为、条件筛选、详情和事件导出", "Live activity, filters, event details and export", [
  adminTab("实时行为", "Live activity"), field("审核账号筛选", "Reviewer filter"),
  field("审核日期", "Review date"), field("操作筛选", "Activity filter"),
  on("暂停实时刷新", "Pause live refresh"), on("恢复实时刷新", "Resume live refresh"),
  on("刷新", "Refresh"), on("查看记录", "View record"), observe("dialog[open],.review-operation-detail", "事件、时间与接收详情", "Event, time and receipt details"),
], { needs: manager });
lesson("admin", "admin-history", "逐条审核记录、已删除账号和导出事件", "Review history, deleted accounts and export", [
  adminTab("审核记录", "Review records"), c("input[aria-label='包含已删除账号'],input[aria-label='Include deleted accounts']", "包含已删除账号", "Include deleted accounts"),
  observe(".review-supervision", "结论、时间、交互和翻页", "Decisions, timing, interactions and pagination"),
  on("导出审核事件", "Export review events", nativePicker),
], { needs: manager });
lesson("admin", "external-overview", "打开外部审核总览", "Open the external review overview", [
  c(".supervision-workbench-trigger", "打开审核工作台", "Open review workbench", ["外部工作台另开窗口，使用其日期与审核员筛选、刷新和 CSV 导出。", "The workbench opens separately and provides its own date and reviewer filters, refresh and CSV export." ]),
], { wiki: "Task-Center", needs: managed });
lesson("admin", "admin-create", "创建审核账号", "Create a reviewer account", [
  adminTab("审核账号", "Review accounts"), field("账号", "Username"), field("显示名称", "Display name"), field("初始密码", "Initial password"),
  on("创建账号", "Create account", finishNote),
], { wiki: "User-Center-Deployment", needs: manager, writes: true });
lesson("admin", "admin-account-status", "暂停或启用审核账号", "Pause or enable reviewer accounts", [
  on("暂停账号", "Pause account"), observe(".review-supervision", "更新账号状态", "Updated account status"), on("启用账号", "Enable account"),
], { needs: manager, writes: true });
lesson("admin", "admin-delete", "确认删除测试账号", "Confirm deletion of a test account", [
  on("删除账号", "Delete account"), observe("dialog[open],.profile-editor-dialog", "删除影响和历史保留说明", "Deletion impact and retained history"),
  on("确认删除", "Confirm deletion", finishNote),
], { needs: ["只使用专门为练习创建、可删除的测试审核账号。", "Use a disposable reviewer account created specifically for this exercise."], writes: true });
lesson("admin", "admin-versions", "查看账号在线状态、上报版本与版本日志", "View presence, reported version and device logs", [
  adminTab("审核账号", "Review accounts"), on("刷新账号与版本", "Refresh accounts and versions"),
  observe(".review-supervision", "在线、离线、未上报与当前版本", "Online, offline, unreported and current version"),
  on("版本日志", "Version log"), observe("dialog[open],.version-log", "账号的历史和多设备上报", "Account history and multiple devices"),
], { needs: manager });
lesson("admin", "admin-remind", "选择目标并推送更新提醒", "Select users and send an update reminder", [
  c("input[aria-label='全选当前账号'],input[aria-label='Select all displayed accounts']", "选择测试账号", "Select test accounts"),
  c("button", "推送选中（", "Notify selected ("), observe(".review-supervision", "推送结果与客户端确认", "Notification result and client acknowledgement"),
], { needs: manager, writes: true });
lesson("admin", "admin-writeback", "下发统一写回并查看回执", "Request NAS writeback and inspect receipts", [
  adminTab("NAS 写回", "NAS writeback"),
  on("刷新回执", "Refresh receipts"), c(".writeback-actions button:first-child", "全部账号写回", "Request writeback for all eligible accounts"),
  observe("dialog[open],.writeback-dialog", "核对测试账号和执行条件", "Verify test accounts and execution conditions"),
  c("button", "确认下发写回", "Confirm writeback request"), on("执行详情", "Execution details"),
], { needs: ["只使用接入测试 NAS 的测试管理环境。统一写回会更新共享文件。", "Use a test management environment connected to a test NAS. This updates shared files."], writes: true });

lesson("text", "find-corrections", "扫描、筛选和预览文字勘误", "Scan, filter and preview text corrections", [
  adminTab("文字勘误", "Text corrections"), on("选择数据根目录", "Choose data root", nativePicker),
  on("扫描描述", "Scan descriptions"), field("查找文字", "Find text"), field("替换文字", "Replace text"),
  c(".text-quality-check input", "整词匹配", "Match whole word"),
  observe(".text-quality-dialog,.text-quality-rules,table[aria-label]", "原文、替换预览和审核信息", "Original text, replacement preview and reviewer"),
], { needs: manager });
lesson("text", "apply-corrections", "应用文字勘误或变更含义", "Apply a typo fix or change meaning", [
  c("input[aria-label='全选匹配片段'],input[aria-label='Select all matching segments']", "选择匹配片段", "Select matching segments"),
  field("修改性质", "Change type", ["文字勘误保留原审核结果；含义变更恢复待复审。", "Typo fixes retain the review; semantic changes return it to re-review."]),
  field("勘误原因", "Correction reason"), on("应用选中修正", "Apply selected corrections"),
  observe(".text-quality-dialog", "影响范围和回执说明", "Affected files and receipt details"),
  on("确认修正", "Confirm correction", finishNote),
], { needs: ["使用已经扫描出可修改片段的测试目录。", "Use a test directory with editable matches from a completed scan."], writes: true });
lesson("text", "terminology", "添加、删除、保存术语与白名单", "Add, remove and save terminology and allowlist", [
  on("术语与白名单", "Terminology and allowlist"),
  field("术语原词", "Original term"), field("术语规范词", "Preferred term"), on("添加规则", "Add rule"),
  field("加入白名单", "Allowlist word"), on("加入白名单", "Add to allowlist"),
  observe(".text-quality-rules", "规则与白名单删除入口", "Remove rules and allowlist entries"),
  on("保存术语库", "Save terminology"), on("重新读取术语库", "Reload terminology"),
], { needs: manager, writes: true });
lesson("text", "correction-history", "查看、撤销历史修正并导出清单", "Review, undo and export correction history", [
  on("修改记录", "Change history"), observe("table[aria-label='勘误历史'],table[aria-label='Correction history']", "文件、原词、新词、时间和原因", "File, old term, new term, time and reason"),
  on("导出需更新清单", "Export update list", nativePicker),
  on("撤销勘误", "Undo correction"),
], { needs: ["使用已有可撤销勘误的测试数据。", "Use test data with a reversible correction."], writes: true });

lesson("updates", "app-update", "检查软件更新并选择下载线路", "Check for app updates and choose a download source", [
  on("版本与更新", "Versions and updates"),
  field("更新下载线路", "Update download source", ["自动、公司内网和 GitHub；可查看正式或候选渠道。", "Choose automatic, company LAN or GitHub. Read stable and candidate channel information."]),
  on("检查更新", "Check for updates"), observe("dialog[open]", "当前版本、目标版本和更新说明", "Installed version, target version and release notes"),
], { wiki: "Release-Operations", needs: managed });
lesson("updates", "app-download", "下载并保存，或稍后安装", "Download, save and restart, or postpone", [
  on("下载更新", "Download update"), observe("dialog[open]", "验证状态", "Verification state", ["失败时可重试；下载验证后可选「稍后」或确认重启。", "Retry after failure. After verification, postpone or confirm restart." ]),
  on("稍后", "Later"),
], { wiki: "Release-Operations", needs: ["联网工作区需要存在可下载更新。", "A managed workspace must have an available update."] });
lesson("updates", "app-install", "保存并重启安装已验证的更新", "Save and restart to install a verified update", [
  on("保存并重启更新", "Save and restart", ["此操作会重启软件。下次打开查看版本号和更新摘要；引导进度会保留。", "This restarts the app. Check the version and release summary after launch; guide progress is retained."]),
], { wiki: "Release-Operations", needs: ["先下载并验证更新，确认当前操作已完成。", "Download and verify the update first and finish active work."], writes: true });
lesson("updates", "history-download", "查看历史版本、下载旧包和打开位置", "Read release history, download an older installer and locate it", [
  on("查看历史版本", "View version history"),
  observe(".version-history-dialog", "历史版本、摘要和回退说明", "Past versions, notes and rollback instructions"),
  c(".version-history-dialog button", "下载 / 回退", "Download / rollback"),
  c(".version-history-dialog button", "下载安装包", "Download installer", nativePicker),
  on("打开所在位置", "Open location"),
], { wiki: "Installation" });

lesson("play", "activate-recording", "手动双击或用键盘打开其他录制", "Open another recording by double-click or keyboard", [
  step("open", ".episode-list button[aria-pressed=false]", "打开另一条录制", "Open another recording", ["双击高亮的条目，或聚焦后按 Enter / Space。", "Double-click the highlighted row, or focus it and press Enter or Space."], ".loaded-label"),
  observe(".loaded-label", "当前加载的录制路径", "Path of the loaded recording"),
], { needs: ["打开一个至少含两条录制的测试目录。", "Open a test folder with at least two recordings."] });
lesson("device", "select-adapter", "选择多个候选设备网卡之一", "Select a device network adapter", [
  f(".manager-device-select select", "选择设备连接", "Choose device connection"),
  observe(".manager-device-access", "设备连接状态", "Device connection status"),
], { needs: ["连接测试设备并打开设备连接页。多个候选网卡时会出现选项。", "Connect a test device and open the connection page. The selector appears with multiple candidate adapters."] });
lesson("edit", "text-before-approve", "定位通过前的疑似文字问题", "Find terminology issues before approval", [
  on("通过", "Approve", ["用带疑似术语的练习录制进入文字检查。", "Use a practice recording with a terminology issue to open this check."], "dialog[aria-label='通过前文字检查'],dialog[aria-label='Text check before approval']"),
  c("dialog[open] .review-user-link", "定位疑似问题片段", "Locate the flagged segment"),
  field("中文动作描述", "Chinese action description"),
], { needs: edit, writes: true });
lesson("edit", "restore-conflicts", "处理交叠的删除历史", "Restore overlapping deletion history", [
  c("button[aria-label*='恢复删除'],button[aria-label*='Restore deleted']", "恢复删除历史", "Restore deleted history"),
  on("生成无重叠草稿并核对", "Create a non-overlapping draft and review"),
  observe(".quality-timeline", "恢复后的片段", "Restored segments"),
], { needs: ["准备有交叠删除历史的测试录制。", "Use a test recording with overlapping deletion history."], writes: true });
lesson("export", "batch-log", "查看失败日志或定位成功输出", "Inspect batch failures or locate successful output", [
  c(".batch-result-actions button:has(svg.lucide-file-warning),.batch-result-actions button[aria-label*='失败日志'],.batch-result-actions button[aria-label*='failure log']", "查看失败日志", "View failure log"),
  observe(".batch-failure-log", "错误详情和日志路径", "Failure details and log path"),
  on("打开日志所在位置", "Open log location"),
], { needs: ["先完成包含失败条目的测试批量导出。", "Complete a test batch export with a failed item."] });
lesson("admin", "admin-writeback-selected", "选择账号后下发写回", "Request writeback for selected accounts", [
  c(".writeback-list input[type=checkbox]", "选择测试账号", "Select a test account"),
  c(".writeback-actions button:nth-child(2)", "写回选中", "Write back selected"),
  on("确认下发写回", "Confirm writeback request"),
], { needs: manager, writes: true });
lesson("admin", "admin-remind-one", "向一个测试账号推送版本提醒", "Send a version reminder to one test account", [
  on("推送更新提醒", "Send update reminder"), observe(".review-supervision", "提醒待处理或已确认", "Reminder pending or confirmed", finishNote),
], { needs: manager, writes: true });
lesson("admin", "receive-update-reminder", "处理收到的管理员提醒", "Handle an administrator update reminder", [
  observe(".update-notice,.client-presence-notice", "管理员更新提醒", "Administrator update reminder"),
  on("查看更新", "View update"),
], { needs: ["使用收到更新提醒的测试账号。", "Use a test account with an update reminder."] });

lesson("start", "account-shortcuts", "设置当前账号的快捷键", "Customize shortcuts for your account", [
  on("快捷键设置", "Keyboard shortcuts"),
  f(".shortcut-search input", "搜索快捷键", "Search shortcuts", ["输入要查找的功能名称，例如播放；只筛选当前设置窗口，不修改数据。", "Search for an action such as playback. This filters settings without changing recordings."]),
  observe(".shortcut-row", "功能、当前按键与默认值", "Action, current key and default", ["点击按键后录入组合键；Esc 取消录入。冲突解决后才能保存，可清除、单项恢复或全部恢复默认。", "Click a key binding and press the new combination. Escape cancels capture. Resolve conflicts before saving; clear a binding or restore one or all defaults."]),
  c(".shortcut-settings footer .button-primary", "保存快捷键", "Save shortcuts", ["仅保存在此电脑，按工作模式、用户中心及账号隔离；输入、弹窗和忙碌时不触发工作区快捷键。", "Saved on this computer by workspace mode, user center and account. Workspace shortcuts do not fire while typing, using a dialog or during blocked operations."]),
], { wiki: "Accounts-and-Annotations" });
lesson("play", "navigation-shortcuts", "直接切换数据、分段及精确逐帧", "Navigate recordings, parts and exact frames", [
  observe(".episode-list,.outbound-recordings", "数据列表", "Recording list", ["默认 PageUp/PageDown 只切换上一条/下一条，不提交审核。方向键调整帧或片段，Space 播放/暂停；可在快捷键设置中修改。", "PageUp/PageDown navigate without submitting a decision. Arrow keys step frames or parts; Space plays or pauses. Change bindings in Keyboard shortcuts."]),
  observe(".transport-buttons,.outbound-transport", "暂停后逐帧", "Step frames while paused", ["外发逐帧按真实视频帧时钟定位，帧率未知时会提示；不要把不能逐帧当成视频损坏。", "Outbound stepping uses the actual video frame clock. Unknown timing is reported and does not itself mean the video is damaged."]),
], { needs: loaded });
lesson("play", "fast-browsing", "开启高速浏览并恢复精确检查", "Use fast browsing and return to precise inspection", [
  f(".speed-control select,.outbound-transport select", "播放速度", "Playback speed", ["先选择 4×、6× 或 8×。普通播放保留原来的全部档位。", "Choose 4×, 6× or 8×. Regular playback retains all existing speed options."]),
  f(".browse-control input", "高速浏览", "Fast browsing", ["默认关闭，4×及以上才生效；原清晰度、七路保留，减少展示帧并静音。不是逐帧审核模式，也不保证所有电脑或网络满速。", "Off by default and active at 4× or higher. Keeps original resolution and seven cameras, samples displayed frames and mutes audio. Use precise inspection for frame-by-frame review; full speed depends on the computer and connection."]),
  observe(".browse-control", "暂停或关闭高速浏览", "Pause or turn off fast browsing", ["暂停后可精确逐帧；关闭开关恢复普通播放。等待数据时会共同缓冲，请等待恢复或按提示重试。", "Pause to inspect exact frames or switch off to return to normal playback. Cameras buffer together when data is unavailable; wait for recovery or follow the retry message."]),
], { needs: loaded });
lesson("outbound", "outbound-revise", "修改已审核结论与原因", "Revise a saved decision or reason", [
  c(".outbound-recordings button:not(:disabled)", "选择已审核录制", "Select a reviewed recording", ["请选择带有效、异常或无效标记的测试记录。", "Choose a test recording already marked valid, anomalous or invalid."]),
  observe(".outbound-decision", "当前结论与修改入口", "Current decision and revision actions", ["重新选择有效、异常或无效；原因窗口使用「保存修改」。修改成功重算统计并留在当前条目，首次审核成功才自动进入下一条待审。", "Choose valid, anomalous or invalid again. The reason dialog uses Save changes. Successful revisions update counts and stay on this recording; first-time decisions advance to the next pending item."]),
], { needs: outbound });
for (const [category, zh, en] of [["invalid", "无效", "invalid"], ["anomalous", "异常", "anomalous"]] as const) {
  lesson("outbound", "outbound-manage-" + category, "管理" + zh + "常用原因的添加、排序和删除", "Manage common " + en + " reasons", [
    on(zh + "数据", category === "invalid" ? "Invalid data" : "Anomalous data"),
    on("常用原因", "Common reasons"),
    on("调整顺序", "Reorder"),
    observe(".outbound-reason-dialog .rejection-options", "拖动或键盘排序", "Drag or reorder with the keyboard", ["拖动原因，或聚焦原因后按 Alt+方向键；可恢复默认。异常与无效的词库和排序分别保存。", "Drag a reason or focus it and press Alt+Arrow. Restore defaults if needed. Anomalous and invalid libraries and ordering are independent."]),
    observe(".outbound-reason-dialog .rejection-sort-tools", "添加及移除常用项", "Add or remove common reasons", ["添加常用原因每类最多30项、每项80字；自定义项可在排序模式移除，移除不改变历史结论。取消关闭窗口，不提交审核。", "Add up to 30 custom reasons per category, each up to 80 characters. Remove custom entries in reorder mode; saved decisions remain intact. Cancel closes without submitting a review."]),
    c(".outbound-reason-dialog footer .button-secondary", "取消", "Cancel"),
  ], { needs: outbound });
}
lesson("outbound", "outbound-company", "核对公司范围与处理服务中断", "Check company scope and handle service interruptions", [
  observe(".outbound-review", "交付平台同步范围", "Delivery platform scope", ["在领取列表顶部选择供应商，列表和审核进度随公司切换。没有看到新完成上传时先刷新；暂时故障会保留已有列表。", "Select a supplier above the queue to filter batches and progress by delivery-platform ownership. Refresh for newly completed uploads. Temporary outages retain the list."]),
  observe(".outbound-review", "回执不明时先核对", "Verify an uncertain acknowledgement", ["不要重复提交同一结论；软件先只读核对保存结果。有效需视频全就绪，缺失或读取失败按实际原因处理。", "Do not resubmit the same decision. The app verifies uncertain saves with a read-only check. Valid requires ready videos; report confirmed missing or failed sources accurately."]),
], { needs: outbound });
lesson("updates", "current-installer", "从软件内下载当前平台安装包", "Download an installer inside the app", [
  on("版本与更新", "Versions and updates"),
  observe(".app-update-dialog", "当前版本、正式与预览渠道", "Installed version, stable and preview channels", ["检查更新用于自动更新；手动安装包下载是独立入口。预览包可能只提供已构建的平台，未提供的平台不可下载。", "Check for updates serves the updater. Manual installer download is a separate action. A preview can offer only the platforms already built; unavailable platforms cannot be downloaded."]),
  observe(".app-update-dialog", "选择安装包并保存到电脑", "Choose an installer and save it locally", ["打开下载安装包入口，选择目标平台和保存目录。下载完成可打开位置，安装由你主动执行；先保存工作。标为预览不等于正式版或性能验收通过。", "Open the installer download action, choose a platform and destination, then locate the completed file. Install only when you choose, after saving work. Preview availability does not imply a stable release or a performance guarantee."]),
], { wiki: "Installation" });

export const lessons = areas.flatMap(([id]) => lessonsByArea[id] ?? []);
