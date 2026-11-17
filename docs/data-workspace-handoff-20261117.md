# 数据工作区维护交接（2026-11-17）

本文件交给新的 Manager 数据工作区对话。用户已将原对话定位为设备管理区维护，本次只交接、不发布、不提交生产审核。先读本工作树 `AGENTS.md`，再按本文最新状态继续；用户本会话的最新要求优先于历史条目。

## 1. 职责及独立工作目录

- **新对话：数据工作区**。负责本地/云端数据加载、回放、任务中心、外发审核、有效/无效、自动下一条、相机/分段、标注、特殊标签、用户中心会话及这些功能依赖的交付平台接口。
- **原对话：设备管理区**。负责三种连接、设备管理/信息/检测排障、SSH 升级、Device 售后诊断上传，以及 D1 固件 AP 灯光和语音反馈。不要由数据对话接手或改写这些功能。
- 数据独立工作树：`/home/descfly/Delta-Viewer-data-workspace-20261117`。
- 数据分支：`work/data-workspace-maintenance-20261117`。
- 原设备工作树：`/home/descfly/Delta-Viewer-pr85-release-20261112`，分支 `fix/manager-1105-outbound-response`。后续不要在这个目录编辑数据代码。
- 仓库：`https://github.com/Lr-2002/Delta-Viewer.git`。
- 两棵工作树共同基础 HEAD：`8763e8a81e66a2246078981ea1c883bd8c577f72`（正式 1.10.6）。当前 **1.11.3 候选所有修改尚未提交**，已完整复制到数据工作树；不是只有 HEAD 的干净旧版。
- 独立工作树已应用完整 tracked binary diff，并复制五个未跟踪源码/文档和预览所用的十个生成前端文件。585 个预览清单文件逐项 SHA-256 一致。没有复制 node_modules、Rust target、原始视频、私有截图或原生二进制。
- `node_modules` 尚未准备。需要构建时按锁文件安装依赖，不要误认为代码缺失；不要把依赖、dist、artifacts、FFmpeg staging 或私有证据提交到 Git。
- 拆分证据与原始 diff：`/home/descfly/diagnostics/manager-workspace-handoff-20261117/`，含 `handoff-state.json`、`manager-1113-tracked-baseline.patch`、`source-files-1113.json`。这是交接基线，后续勿覆盖。

两边维护的是同一个软件和 Release。业务代码在各自工作树开发；`src/App.tsx`、`src/lib/backend.ts`、`src-tauri/src/lib.rs`、`src/styles.css`、身份/配置、四处版本、CHANGELOG、PRD、AGENTS、CI 属于共享文件，修改前核对另一工作树的新变化，只合并自己的相关片段，不能整文件覆盖。当前 1.11.3 候选的验收与发布由数据对话继续收尾；设备对话不要抢用同一候选版本发布。后续两个区域的改动整合为一个应用版本后，仍需整体检查和 Windows 用户验收。

## 2. 用户要求与不可丢失的约束

最高优先级是完整业务线：**任务中心 → 外发审核 → 领取并打开 → 全部七路视频 → 有效/无效 → 自动下一条**，要实时、准确、稳定、响应快。不能只改错误提示，不能用接口探针或独立浏览器夹具替代 Windows 编译产物真实播放。

还须保留：

- 单批次独立 busy 状态：领取一个任务不能让所有按钮转圈；同批重复点击只发一次，其他批次可交互。
- 星炬新上传的数据及时对齐交付平台。列表轻量快照与后台同步保持，不能每次点击同步全量统计。
- 五/七路根据真实清单全展示，主相机更大、其余较小；长录制全部分段可选，不能丢弃镜头或分段。真实缺文件须如实阻断审核，不能伪造就绪。
- 同步播放/暂停/拖动/倍速/主路声音；连续播放不反复 seek。
- 提交回执不明只读核对，不能自动重放审核写入；确认已保存后再下一条。
- 用户中心登录保持、短暂断网恢复，不能几分钟无操作就清除本机身份。不得将进程内令牌持久化来绕过现有会话设计。
- 本地快速进入、按需后台检查、用户常用自定义特殊标签等既有功能已在历史代码中，不要因重做外发覆盖它们。
- 用户要求每次交付不同内容的预览都使用新版本和中文摘要，及时在 Windows 打开。**用户明确合格后才能合并 Manager main / 正式 Release**。登录回复不等于验收合格。
- 不代领、释放、提交任何生产审核结论。可以只读打开本人已领取批次、切录制、播放、暂停、拖动。不要让用户重复领取本来已有的任务。
- 不向生产 Device 诊断接口 POST，不操作设备升级/配网，不关闭任何已有窗口，不清账号、队列、草稿、旧媒体或同事 overlay。
- 交付平台 PR 完整 CI 通过后，用户已授权无需别人审核直接合并；相关外发服务修复上线也已授权。权限仅覆盖相关修复，不代表可重启所有业务服务。
- 不创建子代理。工具 approval=never，不传 sandbox_permissions。

## 3. 当前最重要的新故障：连续切换后失败，尚未解决

**不要根据三条脚本测试通过就发布 1.11.3。交接时发现真实连续操作仍失败。**

2026-11-17 15:52–15:53 CST 只读采集到用户验收窗口：

- 用户先切换零基录制序号 1、7、12 并播放，随后依次切到 8、3、2、1、0。
- 前几次七路约 1.5–2 秒就绪；到序号 8 开始，共同失败。
- 后续每次切换很快出现一个错误区，七路 readyState=0，视频 duration 未知；未捕捉到媒体解码错误码。
- 错误原文为各相机路径加：`外发审核暂不可用：OUTBOUND_REQUEST_FAILED: OUTBOUND_RESPONSE_INVALID`，cam0/cam1/cam2、extension 左右、t265 左右全部相同。
- 这次没有记录有效/无效提交，reviewed=0；自动下一条尚无生产实机验收结果。
- **尚未定位这次错误根因**。不要写成 T265 文件缺失、网络慢、公钥或上次播放问题已证实。先查共用 video-url/用户中心转发的状态码、响应契约、会话/限流/上游连接等证据，保留权限与响应大小边界，不能直接吞掉错误或无限重试。
- 未替用户点击重试、重新登录、返回任务中心或关闭窗口，现场状态仍保留。

证据：

- `/home/descfly/diagnostics/outbound-isolation-20261117/acceptance-1113-handoff-20261117.json`
- `/home/descfly/diagnostics/outbound-isolation-20261117/acceptance-1113-handoff-alert-20261117.json`（含错误文本）
- `window.__d1Acceptance1113.events` 是只读 DOM 观察记录，15:37:55 CST 开始，15 分钟自动停止；已保存的事件仍在内存，但新对话应确认是否需要重新建立观察，不要将已停止观察当作持续监控。

这是接手后的第一优先级，其次是短片开头短暂解码等待，再完成用户实际判断一条后的自动下一条验证。

## 4. 已完成并上线的服务端修复，不要重复部署

交付平台工作树：`/home/descfly/Delta-jiaofu-outbound-isolation-20261117`。

PR #159 已合并：`https://github.com/Delta-data-Delivery/Delta-jiaofu/pull/159`。

- 正式 main 合并提交：`b7b7d7f215cb09933b32cb4a47a7b58de850ef46`，平台版本 1.4.19。
- 该工作树本地 HEAD 是 PR 内容提交 `fc387431dfc768c8821a2a2d14800baf155ee96c`，不要误当已部署 main SHA。
- 合并提交完整 CI：`44019403381`，结论 success。PR 页面旧 hosted 检查曾失败，不等于当前 main 完整 CI 失败，查具体 run/head SHA。
- 已运行独立 `delta-outbound.service`，端口 8798，WorkingDirectory `/opt/delta/outbound-candidates/main-b7b7d7f215cb`。
- 交接只读核对仍 active/running，MainPID 1951195，自 2026-11-17 12:58:49 CST 运行。保留其他业务服务与 overlay。
- 已用 BOS 原生条件 Range 替代媒体路径的 FUSE 冷读。部署证据：`/home/descfly/diagnostics/outbound-isolation-20261117/native-deploy/`。
- 服务器已有可用 SSH 配置，使用 `/home/descfly/.ssh/id_cloud_delivery_20261021` 的已授权密钥登录 `root@114.111.19.219`，BatchMode / IdentitiesOnly；不要反复试 codex_work。远端没有 rg。

用户中心已有单独外发转发与截止时间机制，生产运行与本地源码必须分别核对，不把本地补丁当作已部署。

## 5. Manager 1.11.1–1.11.3 未提交实现

主要文件：

| 文件 | 内容 |
| --- | --- |
| `src/components/OutboundReviewTasks.tsx` | 外发列表/工作区、相机与结论/下一条，保留 memo 与独立交互 |
| `src/components/outbound-review.css` | 已有七路主次布局 |
| `src/lib/outbound-review.ts` | 外发前端协议与严格本机媒体地址校验 |
| `src/lib/outbound-playback.ts` | 独立同步 transport、waiting 恢复、启动缓冲 |
| `src-tauri/src/outbound_review.rs` | 固定用户中心请求、已认证 video-url 转本机地址 |
| `src-tauri/src/outbound_media.rs` | 新增未跟踪的原生媒体读取服务，正式提交不能遗漏 |
| `src-tauri/src/lib.rs` | 注册媒体状态并接线 outbound_review_call；共享文件 |
| `scripts/outbound-review-bridge.mjs` | 用户中心外发中继、有限队列/截止时间/取消 |
| `scripts/outbound-review-bridge.test.mjs` | 新增未跟踪桥接测试，正式提交不能遗漏 |
| `scripts/outbound-review.test.mjs` | 浏览器业务流/五七路/结论/下一条/缓冲回归 |
| `scripts/user-center-server.mjs` | 外发转发与连接处理 |
| `src/styles.css`、`scripts/source-writeback-browser.test.mjs` | 写回通知下移、避免遮挡任务中心 |

本地/云端其他数据功能从 `src/components/TaskCenter.tsx`、`FramePanel.tsx`、`MachineAnnotationPanel.tsx`、`CloudMachineAnnotationPanel.tsx`、`AnnotationPanel.tsx` 和 `src/lib/backend.ts` 进入，沿用现有 IPC 与只读数据边界，不为解决外发重写这些已稳定流程。

原生媒体服务只接受已认证返回的固定 `https://114.111.19.219/api/platform/manager-outbound/media/<64hex>`。普通 TLS/IP 证书校验、HTTP/1.1、no_proxy、禁重定向；没有新增信任证书或部署用户中心。诊断中 PEM 是公共根 CA bundle，不能误称平台自签证书。

浏览器接收 127.0.0.1 随机端口与 256 位随机路由。每窗最多 4MiB、每块 1MiB，验证后的总长与 ETag 仅用于让四块同时请求并按序输出；首次未知总长仍核对真实响应。每块验证 206、范围、总长、声明/实际长度、ETag（如提供），后续带 If-Match。最多16本机活动连接，有界堆缓冲；断连、退出、账号变化取消。平台仍逐块核对领取和源身份，不能缓存授权、公开 BOS URL、写媒体或降质。

播放器 waiting 时仅暂停健康相机，缺数据解码器保留播放意图，canplay 立即核对恢复；持续同步用轻微调速，不反复 seek。1.11.3 在开始/主动 seek 时储备 1.25×speed 秒，额外储备等待上限2秒；pause立即取消，持续 waiting 恢复不重复储备。

三份新增说明同样尚未跟踪，正式提交须包括：`docs/outbound-native-media-20261117.md`、`docs/outbound-first-block-20261117.md`、`docs/outbound-start-buffer-20261117.md`。

完整基线还含设备区的 `src-tauri/src/d1_page.rs` / `src/components/ManagerWorkspace.tsx` AP 能力与说明修复；数据对话应保留，后续不要覆盖或扩展这些设备实现。

## 6. 已运行检查和性能证据

1.11.3 完整检查已通过，无需仅因交接重复构建：

- `/home/descfly/diagnostics/outbound-isolation-20261117/manager-1113-full-check-2.log`
- 原树报告 `artifacts/release-check/2026-11-17T07-27-13-508Z-linux-x64.json`。
- Rust 365 passed /17 ignored，Clippy、前端、原生 debug 构建通过；浏览器定向测试通过，日志 `manager-1113-ui-tests.log`。
- 第一次 full 的失败是检查中新增文档触发工作树 guard；第二次在源码不变下完整通过。后续 full 检查过程中不要改源码/文档。
- Windows cargo build 与 `cargo test --lib outbound_media` 均通过。原生回归包含真实 HTTP 屏障，证明四块确实同时发出，而非实现镜像断言。
- 如接手后修改行为，按 AGENTS 重跑相应回归与完整门禁，并用新版本预览。不能把这些旧结果当新修改的通过结果。

实际 Windows 对比：

| 版本/样本 | 七路就绪 | 实际播放观察 | 限制 |
| --- | --- | --- | --- |
| 1.11.0 | 32.786秒 | 观察11秒仅推进约3秒 | 明显不合格 |
| 1.11.1 长片 | 5.491秒 | 29.7秒播到约29秒 | 另一短片仍需15.3秒播9.7秒 |
| 1.11.2 短片/长片 | 2.111 /3.638秒 | 11.178 /31.317秒 | 开头仍短暂等待 |
| 1.11.3 9.7秒短片 | 3.098秒 | 11.246秒，含开始缓冲 | 开头一次解码等待，最大观测差约0.270秒 |
| 1.11.3 29秒长片 | 2.005秒 | 31.170秒，含开始缓冲 | 500ms采样未捕捉到中途暂停，最大差约0.102秒 |
| 1.11.3 6秒短片 | 2.201秒 | 8.066秒，含开始缓冲 | 500ms采样未捕捉到中途暂停，最大差约0.080秒 |

三条 1.11.3 探针当时列表约211–351ms、无媒体错误或错误区。点击播放后储备约1–2秒。不能由此保证其他录制或连续操作通过；第3节已记录之后实际连续切换故障。

汇总：`/home/descfly/diagnostics/outbound-isolation-20261117/windows-1113-playback-measurements.json`。原始 `live-review-1113-native-short-1.json`、`live-review-1113-native-long-1.json`、`live-review-1113-native-six-second-1.json` 同目录。截图含真实私有画面，只留本地，不提交或外传。

## 7. Windows 当前产物、会话和工具

- 测试机：`lenovo@10.1.41.119`。
- 当前 1.11.3 根目录：`C:\Users\lenovo\codex-work\d1-manager-preview-1113-20261117`。
- 进程 PID9296、交互 session1、窗口标题 `D1 Manager 1.11.3`、CDP127.0.0.1:9223。**已登录，不需要新对话一开始再要求登录。**
- 二进制 `app-ready\d1-manager-preview.exe`，SHA-256 `b694bbf823867c864e86b721bc3bd8b152f309ab9a17b067f1474d13b7624844`。
- source archive SHA-256 `1ba766cbc78c16e7a2c78bbdfb12189015afc36eb30d46ebe03eecdc4678233e`，585文件。
- 15:52 CST 核对旧1.11.1 PID5780/CDP9221、1.11.2 PID10884/CDP9222也仍在。保留，不关闭、不覆盖；新预览使用新目录/版本/独立 WebView2/CDP。
- `build-result.json`、`open-result.json`、源码清单、build/open PowerShell 已保存在 `/home/descfly/diagnostics/outbound-isolation-20261117/windows-preview-1113/`。
- 当前无未完成的1.11.3构建任务；旧exec41604已完成，不要继续轮询或重复启动构建。
- Windows helper：`/home/descfly/diagnostics/manager-198-window-title-20261112/win_tools.py`，提供 `win(PowerShell, timeout=45)` / `upload(local,remote)`，通过已配SSH访问测试机。PowerShell末尾不要加 `exit 0`吞输出；Cargo正常stderr常被包装为NativeCommandError，以真实退出码和结果JSON为准。
- 原生缓存固定 `C:\Users\lenovo\codex-work\d1-manager-cloud-qc-taskfix-173-20261111\target`。生成新脚本时精确替换版本与root，不要全局替换数字破坏缓存日期。
- 使用交互 ScheduledTask 开新预览，沿用旧任务 Principal/Settings；先核对任务是否已存在，避免重复开窗。当前任务名 `Codex-D1Manager-1113-Preview`，桌面快捷方式只写 `D1 Manager {version}`。

诊断脚本位于 `/home/descfly/diagnostics/outbound-isolation-20261117/`：

- `probe-review-1113.mjs`：D1_CDP_PORT=9223，D1_PROBE_PHASE为唯一小写短横线名字，D1_RECORDING_INDEX为零基序号。只打开已有领取批次/播放/暂停/切录制，finally返回任务中心；**当前用户可能正在操作，接手先只读，不要立即运行这个会改变导航的探针**。同一UI不可并发控制。
- `prepare-acceptance-1113.mjs`：会切到第一待审记录，装只读observer并保持窗口供用户验收。已有输出文件采用wx，不覆盖；重用应改唯一证据文件名。
- `collect-acceptance-1113.mjs` / `collect-handoff-alert-1113.mjs`：只读采集内存事件、就绪/错误；D1_ACCEPTANCE_PHASE必填且唯一。后者附脱敏错误文本，不点击UI。
- 隧道临时占本机19329转发CDP9223，finally断开CDP/关闭自己SSH tunnel。不要误杀别人的隧道/进程。
- 这些脚本的 Playwright import 当前指向原工作树 node_modules，诊断脚本可继续读取；新工作树业务依赖应按锁文件单独准备。

## 8. 新对话执行顺序与发布门槛

1. 核对新工作树分支、diff、Windows实际进程/登录/当前错误，读取第3节最新证据。原用户验收问题尚未得到“合格”回复；用户现在要求交接，不能视为放行发布。
2. 优先定位连续切换后的 OUTBOUND_RESPONSE_INVALID：分清 Tauri、用户中心、交付平台对应请求/响应，不输出凭据、完整媒体票据或私有路径。只读保留现场，先拿证据再改。
3. 保留已有加速与安全校验，修复根因，增加能真实复现该故障的必要回归。不要简单延长超时、关闭校验、统一重试写入或隐藏错误。
4. 若行为有变，使用尚未交付的新版本（1.11.3已交付，不能再用同号不同内容；先核对另一工作树/最新发布，避免版本冲突）。完整门禁和Windows原生构建后打开预览，保留旧窗口。
5. 实测连续切换、短片/长片七路、开始/暂停/拖动/倍速、长时间空闲/恢复及已有领取批次。真实有效/无效由用户判断和提交，核对结论准确、自动下一条与七路加载的耗时。
6. 用户明确验收通过后，将所有保留修改与必要文档整理为单一release-ready commit。核对设备对话后续共享变更是否需整合；任何整合后的行为改变仍须再预览验收。
7. 按 `pnpm check:full`、main CI、自动 annotated tag、三平台Release构建与校验流程。禁止手工tag、覆盖既有资产、提前推main/发布或只发Windows。当前正式GitHub最新仍v1.10.6（最近核对main CI43822282532、Release43823981508均success）。
8. GitHub hosted billing 曾限制任务，必要时按既有合法隔离runner执行完整CI；不能跳过测试或把本地通过冒称GitHub成功。

## 9. 设备区保留事项（仅供边界识别）

设备对话仍持有 `/home/descfly/DOHC_workspace-ap-feedback-20261117`，提交 `815f046751a2c8ae94f01902c84c8b78ed43a5e7`，1288项回归通过，debug包SHA256 `572e2968819941826af19d0b8d0aa6a10200b68170e559926ba3ddb721d2fe16`，未push/PR/merge/release、未装实体完整包。用户已允许在原D1（CID末8位82f01c00）恢复AP后安装可回退debug包并重启应用验收；该授权不用于数据区操作。

数据区不得因这份历史授权执行设备升级。AP灯光/语音、低电量/已是最新版本播报、三模式SSH升级、售后日志等后续问题留给设备对话。
