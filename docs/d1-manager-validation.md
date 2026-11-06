# D1 Manager 1.6.3 候选验证与发布记录

日期：2026-11-06。本报告覆盖阶段 0–5 可执行范围及本机候选检查；不表示真实设备接入或实机诊断完成。用户已明确授权在门禁通过后正式发布 1.6.3；三平台构建与 Release 结果以本报告后续追加的 workflow 记录为准。

## 1. 目标与实际结果

| 阶段 | 实际结果 | 状态 |
| --- | --- | --- |
| 0 现状审计 | 既有数据功能、身份/数据目录、更新/发布契约与真实设备能力差距已整理 | 已完成，见 `d1-manager.md` |
| 1 产品与协议契约 | 保留功能表、模块边界、操作分级、日志隐私、品牌兼容及待提供材料；OTA 仅登记 | 已完成 |
| 2 品牌与外壳 | D1 Manager 标题、五区导航、角色与工作模式保留；切离数据区先落盘、暂停播放/快捷键，切回保留草稿 | 已完成本地验证 |
| 3–4 模拟与检测 UI | Rust 固定类型目标，仅本地模拟；七个场景、五类结果、证据/时间/版本、取消/恢复；共用 TaskControl | 已完成模拟验证 |
| 5 诊断包 | 原生端只打包可信模拟运行与合成日志，范围预览、凭据过滤、hash/回读、partial 与原子 no-replace | 已完成 Rust 文件写入/回读测试；浏览器不导出 |
| 6 真实 D1/DCI | 没有正式命令/身份/认证/错误码/日志证据，未写生产命令 | 等待材料 |
| 7 OTA | `scheme:null`、`enabled:false`、`waiting_interface`，没有网络或升级入口 | 仅登记完成；实际接入未开始 |
| 8 跨平台候选 | 本机前端、Rust、交互/视口通过；完整门禁被缺少的受控 FFmpeg bundle 输入阻断 | 本机部分完成；Windows/macOS/Linux 正式构建由 Release workflow 验证 |
| 9 正式发布 | 用户已明确授权；将按 main CI 自动 annotated tag 与三平台 Release 契约执行 | 等待提交进入 main 并由 CI/Release workflow 完成 |

接手时已有 1.6.3 未提交候选改动，全部在其基础上继续；未 reset、清队列或覆盖其他任务。HEAD/分支为 `67f0177992c6bd44d9669e94163553a5e9b42c46` / `fix/nas-writeback-dialog-20261104`。只读远端核对 main 仍为该 HEAD，v1.6.2 tag 为 `a4223f50b52b8d9647f723d9aa1e06dfefc325d6`，未发现 v1.6.3 tag 或 Release。正式发布尚未执行。

## 2. 文件与目的

| 文件 | 目的 |
| --- | --- |
| `src/App.tsx` | 主品牌与导航、播放/快捷键/审计会话切换保护；浏览器演示进入数据区后才载入；管理入口保留 |
| `src/components/ManagerWorkspace.tsx`、`manager-workspace.css` | 首页、未接入状态、模拟身份与结果、时间范围和包预览/导出 UI |
| `src/styles.css` | 顶栏窄屏换行，为新增导航预留高度，保持遥测与长列表审核按钮可见 |
| `src/components/AuthScreen.tsx`、`SupervisionDashboard.tsx`、`index.html` | 可见品牌；管理员返回首页入口，不增加数据角色权限 |
| `src/lib/backend.ts`、`d1.ts`、`d1-browser-simulation.ts` | 固定 IPC 与类型；浏览器独立合成场景，前端不接受 shell/host/任意命令 |
| `src-tauri/src/d1.rs` | Rust 模拟、错误分类、内存运行归属、合成日志过滤、诊断包可信预览和不可覆盖发布；无网络/SSH/DCI 执行器 |
| `src-tauri/src/lib.rs` | 注册固定 commands、鉴权与 TaskControl；账号退出/切模式清空模拟记录 |
| `config/d1-manager.json` | OTA 原地址原样登记、scheme 未知、功能禁用、生产操作列表为空 |
| `package.json`、`src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json` | 同步 1.6.3；只改窗口标题，保留安装器身份、identifier、crate/binary；没有新增依赖 |
| `.github/workflows/ci.yml`、`scripts/d1-manager.test.mjs` | 将新增浏览器回归纳入既有 CI；只改测试步骤，未触发 workflow 或改变 Release 契约 |
| `scripts/demo-flow.test.mjs`、`unified-proofreading.test.mjs`、`session-activation.test.mjs`、`playback-rendering.test.mjs`、`skeleton-library.test.mjs`、`app-updates.test.mjs`、`concurrency-state-smoke.mjs` | 原测试显式选择“数据工作区”，品牌断言同步；保留原功能、图像与布局断言 |
| `AGENTS.md`、`prd.md`、`README.md`、`CHANGELOG.md`、`docs/d1-manager.md`、本文、Wiki 首页/导航/快速开始/账号页/设备页 | 产品范围、真实与模拟边界、版本摘要、使用方式与可审查证据 |

没有修改 updater 公钥、正式来源限制、Release 资产规则、NAS 事务或旧数据 schema。`com.dohc.viewer`、`productName: Delta Viewer`、`dohc-viewer` 与 `appLocalData`/managed/offline-local 根保持。账号配置、review-outbox、待写结果、标注与草稿没有迁移。代码不改数据路径不能代替真实覆盖安装保全测试。

## 3. 实际验证与命令

证据目录为工作树中 ignored 的 `artifacts/d1-manager/`。以下日志可直接回读；旧失败记录保留，不改写成成功。

浏览器原回归使用本机现有 Chromium：`/home/descfly/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`。设置 `PLAYWRIGHT_CHROMIUM` / `PLAYWRIGHT_BROWSER_EXECUTABLE`；并发 smoke 使用其原有变量 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。没有下载或安装浏览器。

| 命令/检查 | 退出状态与结果 | 证据 |
| --- | --- | --- |
| `pnpm build` | 0；TypeScript 与 Vite 通过 | `frontend-final.log` |
| `pnpm test:d1-manager` | 0；5 项通过，含三视口、七场景、取消、播放暂停/草稿、审核落盘失败及管理员边界 | `manager-validation.log`、`browser-report.json` |
| `node --test --test-concurrency=1 scripts/demo-flow.test.mjs scripts/session-activation.test.mjs scripts/unified-proofreading.test.mjs scripts/app-updates.test.mjs scripts/d1-manager.test.mjs` | 首轮 1；57 通过、2 布局失败、15 个原有跳过；两个失败修复后按下行复跑通过 | `workspace-regressions.log` |
| `node --test --test-name-pattern='unified layout\|long segment lists' scripts/unified-proofreading.test.mjs` | 0；两项通过，保留原窗口/图像/骨架/长列表滚动断言 | `layout-regressions.log` |
| `node --test --test-concurrency=1 scripts/playback-rendering.test.mjs scripts/skeleton-library.test.mjs` | 0；4 项通过 | `playback-and-model.log` |
| `node --test --test-concurrency=1 scripts/proofreading-playback.test.mjs scripts/review-segment-consistency.test.mjs` | 0；5 项通过，含实际合成视频帧与独立播放器 | `standalone-playback.log` |
| `node --test --test-concurrency=1 scripts/source-review-notice.test.mjs scripts/source-writeback-browser.test.mjs` | 0；4 项通过，全为隔离 fixtures | `writeback-regressions.log` |
| `node scripts/concurrency-state-smoke.mjs` | 0；任务独占、取消、失败恢复、五图/视口、批量与任务中心通过 | `concurrency-browser-2.log` |
| `pnpm check:release-scripts` | 0；7 项通过 | `release-scripts.log` |
| `pnpm check:wiki` | 0；16 页与链接通过 | `wiki.log` |
| `pnpm check:linux` | 0；Ubuntu deb 配置静态检查通过，无安装 | `linux-config.log` |
| `pnpm check:full --report artifacts/d1-manager/check-full-20261106.json` | **1**；前端、format、Clippy、fixture 检查和 Rust **294 通过/17 忽略**、3 个 example 测试通过；Tauri 构建缺受控 `resources/ffmpeg-manifest.json` 失败 | `check-full-20261106.json` |
| `pnpm tauri build --debug --no-bundle --ci --config '{"bundle":{"resources":null}}'` | 0；本机 Linux debug 应用编译通过；null bundle resource 覆盖仅用于不打包资源的本机编译，不替代完整门禁或平台安装验证 | 本轮命令输出；旧 `local-debug-build.log` 记录前一次等效覆盖构建 |
| `node --test --test-concurrency=1 scripts/client-management-browser.test.mjs` | 0；2 项通过，含管理模式打开时在线客户端自动执行写回命令 | Playwright 隔离夹具 |
| `node --test --test-concurrency=1 scripts/source-review-notice.test.mjs scripts/source-writeback-browser.test.mjs` | 0；4 项通过 | Playwright 隔离夹具 |
| `cargo test ... machine_review::tests::skeleton_descriptions_are_independent_reopenable_and_do_not_write_qc -- --exact` | 0；骨架状态迁移、旧侧车读取和单一交付文件回归通过 | Rust 临时目录 fixture |
| `git diff --check` | 0；无空白错误 | 本地 Git 查询 |

六项新增 Rust 测试覆盖：拒绝真实目标/未知 host/command 字段与无效预算；正常/异常/旧能力不支持；断连/超时/取消不冒充损坏；合成凭据和个人字段过滤；用户归属/时间范围/预览 hash/不可覆盖输出；超大/损坏/缺失文件与取消。测试实际写入临时本地目录并回读后清理自身 fixtures。

初次浏览器启动缺少 executable 的失败记录为 `browser-tests.log`；后续使用本机已存在路径修复。新边界测试迭代中的失败源于 fixture 缺少机标/路由拦截及错误文本精确匹配，最终 5 项组合通过。修复窗口布局后只复跑相关失败项，无放宽断言或重复全量门禁。

截图：`home-1440.png`、`home-960.png`、`home-390.png` 及 `diagnostics-1440.png`、`diagnostics-960.png`、`diagnostics-390.png`。新设备页三视口无横向溢出、控制台/page error 为零，受限浏览器会话的外部请求为零。旧工作区图像/骨架与长列表另见 `artifacts/unified-proofreading/`。

未运行 Windows/macOS 原生构建、安装/启动和升级数据哨兵验证：当前仅有 Linux 工具链，无用户授权安装与真实设备条件。Windows MSVC target 与 llvm-rc 也未安装，未把 Linux 编译当成 Windows 通过。未运行已删除的私有样例或实物 SD 卡测试；未做 bundle、无 FFmpeg 暂存/下载/安装，完整门禁资源缺项保留。未测试全部 CI 独立任务，不能称完整 CI 已通过。

## 4. 设备与网络操作

真实 D1 连接、设备命令、设备数据修改、真实日志读取、OTA DNS/HTTP/HTTPS/下载/上传/升级、生产用户中心写操作、NAS 读取/写入、客户通知：均未发生。2026-11-06 对用户中心写回状态/回执做了只读核对，没有重发指令或更改记录；未读取原电脑的本地队列或 NAS 文件。

发生的网络仅包括本地测试用临时 Vite/隔离服务与官方 Git 远端只读状态查询。设备模拟使用本地合成数据；OTA 地址未解析或访问。没有部署、服务重启、软件安装、推送、tag、Release 或业务服务变更。

## 5. 未解决项与依赖

- 提供正式 DCI 帮助、只读命令与成功/错误样例、超时/取消规则、输出 schema 和版本兼容表。
- 提供真实身份/型号/revision/固件/能力定义，发现/认证/主机身份与配对规则；密钥保管另行设计。
- 提供检测指标、阈值、采样时间与排障建议依据。当前 fixture-v1 仅是模拟规则。
- 提供日志路径、格式、轮转/时间基准、允许字段和隐私范围；当前过滤器只适用合成 fixture，不能用于未知真实日志。
- 提供隔离测试设备并明确只读实机授权后再验证真实接入。当前没有生产命令执行通道。
- 用户通知 OTA 开始接入并提供完整协议后另行实现；当前 scheme、方法、认证、schema、包格式、签名与设备升级前提均未知。
- 受控 FFmpeg 暂存、三平台原生构建/安装及旧账号/队列/草稿 sentinel 的覆盖升级验证尚未完成。安装器品牌与资产名继续旧名，不声称已完成安装品牌迁移。

## 6. 集中验收清单

| 验收项 | 结论 |
| --- | --- |
| 新品牌、五区入口与设备未接入/模拟提示 | 通过本地自动验证；视觉偏好待用户查看 |
| 原工作区功能/角色/离线入口仍可达，模拟不增加审核事件或时长 | 通过对应浏览器回归；生产角色/原生会话未实机复测 |
| 切离暂停播放、快捷键隔离、草稿保留、审核落盘失败阻止切换 | 通过 |
| 五类检测状态、版本能力、证据、取消、断连、超时与复检 | 通过本地模拟 |
| 合成诊断包本地写入/回读、过滤、范围、hash、取消与不可覆盖 | 通过 Rust 测试；桌面 UI 原生文件选择与导出待实测 |
| 固定 allowlist 结构与请求校验，无任意命令/host/shell | 通过代码审查及拒绝非法请求测试；生产操作为空 |
| identifier、数据目录、历史格式、现有更新公钥与发布资产名保持 | 通过差异检查；覆盖安装数据保全待实测 |
| OTA 禁用且本任务零访问、无诊断包上传 | 通过配置/源码核对及受限浏览器验证 |
| 完整 `check:full` | 本机未通过：缺少受控 FFmpeg bundle 资源；null bundle resource 覆盖的 Linux debug 编译通过 |
| 真实 D1/DCI/日志/OTA 与三平台实机 | 未执行，依赖真实资料、设备与原生安装条件 |
| 正式发布 | 用户已授权；提交进入 main 后仍须 CI 与三平台 Release workflow 成功 |

## 7. 后续计划

正式发布 1.6.3 前，本地修复及回归已完成；发布按既有 main CI、自动 annotated tag 和三平台完整 Release 执行，不手工打 tag 或重复发布。真实 DCI、设备日志、OTA 与安装品牌迁移继续等待协议材料和独立授权，不作为本次模拟功能的已完成能力声明。
