# DOHC Viewer 开发指南

本文件适用于整个仓库。所有开发者和自动化编码 agent 在修改代码前都必须阅读 `prd.md`；产品范围、字段语义和验收标准以 `prd.md` 为准。

## 1. 不可破坏的产品约束

1. 源 SD 卡是只读数据源。不得在源路径创建、修改、重命名或删除任何文件。
2. 应用运行时只处理本机目录，不增加 SSH、HTTP、云存储或遥测路径。
3. 正常工作流是“选择 SD 卡 -> 自动扫描/选择首条 session -> 本地导入并校验 -> 健康检查 -> 回放/导出”。不要绕过本地校验直接把 SD 卡当作长期工作目录。
4. 完整导入必须验证目标端的文件大小和 BLAKE3，不能只信任复制时的源端 hash。
5. `capture_time_ns` 在 Rust/磁盘中为 int64，在 TypeScript 中必须保持十进制字符串；涉及差值时使用 `BigInt`。
6. 五个标准流名称固定为 `cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`。
7. Warning 数据可以在明确提示后导出；error 数据不能通过 UI 或 IPC 绕过阻断。
8. LeRobot 数据不得虚构源数据中不存在的 action。规范化时间轴时必须保留原始纳秒时间。
9. 正式输出必须先写 partial 路径，成功后再原子 rename；不得覆盖已有输出。
10. 私有原始数据、构建产物、FFmpeg 二进制和签名凭据不得提交到 Git。
11. 时间裁剪只允许单条轨迹的一个连续闭区间；不得修改源目录或本地导入副本，三个 adapter 必须使用同一范围。
12. 账号、登录会话和 episode 标注是纯本地能力。不得把账号、密码、处理人或标注发送到网络；所有数据 command 必须在 Rust 中验证当前登录会话。
13. GitHub Release 必须同时包含 Windows x64、macOS arm64 和 macOS x64 可安装产物。当前阶段允许发布明确标记为 `UNSIGNED` 的完整集合；该标记表示没有可信发布者身份。Windows 产物不得暗示 Authenticode；macOS app/main/FFmpeg 必须有结构有效的 ad-hoc seal，但不得暗示 Developer ID 或 notarization。任一平台、依赖或安装/启动检查失败时不得公开部分 Release。

## 2. 仓库结构

```text
DOHC_Viewer/
  prd.md                         产品需求和验收基线
  CHANGELOG.md                   按 tag 记录的版本历史
  README.md                      用户/构建入口
  AGENTS.md                      本开发指南
  .github/workflows/
    release.yml                 三平台安装包 CD 与原子发布门禁
    wiki.yml                    docs/wiki 到 GitHub Wiki 的同步流程
  docs/wiki/                    GitHub Wiki 的可审查唯一源文件
  src/                           React/TypeScript UI
    App.tsx                      顶层工作流和视图状态
    components/                  回放、检查、进度和导出组件
      AuthScreen.tsx             本地账号注册和登录
      AnnotationPanel.tsx        episode 任务、描述、轨迹码和处理人
    lib/backend.ts               所有 Tauri IPC/browser demo 适配
    types.ts                     前端共享数据类型
  src-tauri/
    src/lib.rs                   Tauri commands 和长任务调度
    src/model.rs                 Rust/IPC 数据模型
    src/identity.rs              本地账号、Argon2id 密码哈希和进程内会话
    src/annotations.rs           任务目录、轨迹占号和追加式标注修订
    src/source.rs                episode 发现、扫描、状态/帧读取
    src/storage.rs               卷信息、容量预检和 partial 安全清理
    src/importer.rs              复制、BLAKE3、manifest、命名清理
    src/stress.rs                exFAT/大容量正式验收与 JSON 证据
    src/validation.rs            数据健康检查和 issue code
    src/validation_cache.rs      与源目录指纹绑定的可信检查记录
    src/export/                  导出 adapter
      mod.rs                     adapter dispatch 和公共输出规则
      mcap.rs                    MCAP
      hdf5.rs                    HDF5
      lerobot.rs                 LeRobot v2.1 和 FFmpeg
    capabilities/default.json    Tauri 权限
    tauri.conf.json              通用桌面配置
    tauri.macos.conf.json        macOS app/DMG 和 FFmpeg 资源配置
    tauri.windows.conf.json      Win10+/NSIS/离线依赖配置
    windows/installer-hooks.nsh  Win10 最低版本检查
    examples/stress-check.rs     压力验收 CLI；正式模式默认开启
  scripts/release-check.mjs      跨平台 quick/full/bundle 发布检查
  scripts/verify-release.mjs     annotated tag、版本与打包契约门禁
  scripts/assemble-release.mjs   三平台产物/报告汇总与 SHA-256 manifest
  scripts/build-ffmpeg-macos.sh 固定源码构建最小 LGPL FFmpeg
  scripts/seal-macos-app-adhoc.sh macOS app 嵌套代码与资源 ad-hoc 封印
  scripts/verify-release-macos.sh DMG 封印、Gatekeeper、挂载与启动检查
  scripts/verify-release-windows.ps1 unsigned NSIS 安装启动卸载检查
  scripts/check-wiki.mjs         Wiki 页面和内部链接检查
  scripts/windows-cross-check.mjs macOS/Linux 到 Windows x64 MSVC 条件编译检查
  scripts/exfat-smoke-macos.mjs  macOS 只读虚拟 ExFAT 全链路 smoke
  scripts/make-dmg.sh            macOS 无头 DMG 内容打包
  scripts/stage-ffmpeg.sh        macOS FFmpeg 受控 staging
  scripts/stage-ffmpeg.ps1       Windows FFmpeg 受控 staging
  vendor/hdf5-pure/              固定的纯 Rust HDF5 依赖和最小流式 API 补丁
  data/README.md                 私有样例清单，不含原始数据
```

## 3. 架构边界

```text
React component
    -> src/lib/backend.ts
        -> Tauri command in src-tauri/src/lib.rs
            -> source/importer/validation/export module
                -> local filesystem
```

- React 组件不得直接调用 `invoke()`；统一经 `src/lib/backend.ts`。
- `lib.rs` 只负责 command 参数、任务状态和 blocking worker 调度，不放格式逻辑。
- 同一时间只允许一个长任务；所有新增长任务必须通过 `TaskControl` 获取 guard。
- 导出 IPC 只能使用 `ValidationCache` 中与当前源目录指纹匹配的 Rust 报告；不得接受前端回传的报告或 status 作为授权。
- 文件遍历、哈希、解码和导出必须在 Rust 中执行。
- 源目录遍历统一使用可取消的 no-follow 路径；不要重新引入会隐式跟随 symlink 的文件判断。
- Export UI 不知道格式内部结构；格式差异只能进入 adapter。
- 未登录时只允许账号状态、注册、登录和退出 commands；扫描、导入、加载、检查、读帧、标注和导出必须经 `AuthState::require_user()` 门禁。前端隐藏工作区不能替代后端门禁。
- 任务目录以 `src-tauri/src/annotations.rs` 为唯一真源。新增任务必须同时定义稳定 task ID、显示名称、轨迹前缀和默认描述，并增加轨迹冲突/adapter 回读测试。
- Browser demo 仅用于视觉开发，必须和真实样例统计、warning 和类型保持一致。其账号和标注只保存在当前页面进程内，刷新后重置；交互抽检基线是报告 format v3、26 个已检查文件、每流 5 帧、`[1,25,50,73,99]` 和非空 `autoReportPath`。它不能被当作账号安全、后端门禁或数据验收。

## 4. 环境与常用命令

要求：Node.js、pnpm 10、`rust-toolchain.toml` 固定的 Rust、平台对应的 Tauri 构建依赖。LeRobot smoke test 还需要 FFmpeg。

```bash
pnpm install
pnpm dev
pnpm tauri:dev
pnpm build
pnpm check
pnpm check:wiki
pnpm check:windows-cross
pnpm check:exfat-macos
pnpm check:full
pnpm check:bundle
```

`pnpm check` 是快速门禁，包含前端 production build、Rust format、Clippy
`-D warnings` 和常规 Rust tests。`check:full` 额外运行两个私有样例测试和
Tauri debug no-bundle build；`check:bundle` 再生成当前平台 unsigned debug
bundle；macOS 无头环境使用 `scripts/make-dmg.sh` 生成内容等价的 DMG，避免
依赖 Finder AppleScript。三者均通过 `scripts/release-check.mjs` 写入 ignored 的
`artifacts/release-check/*.json`，报告 schemaVersion 当前为 1。debug bundle
成功不能替代签名发布和目标机器验收。

`check:windows-cross` 是非 Windows 宿主上的附加预检，需要 rustup 的
`x86_64-pc-windows-msvc` target 和 `llvm-rc`。它通过 opt-in
`windows-cross-check` feature 避免调用宿主不存在的 `ml64.exe`，并仅在本次
Cargo check 中移除 Tauri bundle resources；不得把它写成链接、安装包或 Windows
运行时通过。`check:exfat-macos` 会创建真正的 ExFAT 稀疏镜像，写入私有样例后
只读重挂载并执行完整 development stress；它只能清理带本次 marker 的临时根，
报告必须保持 `physicalSdCard:false`、`formalStress:false`。两条命令分别写入
`artifacts/windows-cross-check/` 和 `artifacts/exfat-smoke/`。

Rust 单独检查：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
pnpm tauri build --debug --no-bundle
```

当前依赖 `binrw 0.15.1` 可能报告 Rust future-incompatibility warning。不要用全局 allow 隐藏项目自身 warning；升级依赖时单独验证 MCAP/HDF5 行为。

如果已有 Vite server 使用 1420 端口，不要结束用户进程；复用它或显式选择其他端口。

## 5. 私有样例与测试数据

真实样例路径：

```text
data/raw/2026-07-13_07-34-12
```

它应包含 981 个文件和 80,531,730 字节，但被 `.gitignore` 排除。不要移动、重写或“修复”此目录。测试输出必须写入测试专属临时目录，并只清理本次测试创建的明确路径。

完整 smoke test：

```bash
export DOHC_SAMPLE_ROOT="$PWD/data/raw/2026-07-13_07-34-12"
cargo test --manifest-path src-tauri/Cargo.toml \
  imports_real_sample_and_verifies_hashes -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml \
  validates_and_exports_real_sample -- --ignored --nocapture
```

预期基线：

- 每个流 196 帧，无 JPEG 解码失败。
- 健康状态为 warning，而不是 ok。
- 必须出现 `TIMESTAMP_GAP`，因为末尾帧时间间隔异常。
- 数据集 BLAKE3 为 `f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727`。
- MCAP 为 7 channels/3 schemas：1 个 JSON state、1 个官方 Foxglove
  PoseInFrame 和 5 个官方 Foxglove CompressedImage；每个 channel 196 条消息。
- HDF5 关键 dataset shape 为 196。
- LeRobot 为 30 FPS、196 行 Parquet、5 个非空 MP4，并包含 `observation.capture_time_ns`。

不要修改 browser demo 让样例显示 ok；这会掩盖真实 warning。

## 6. Rust 开发规则

### 6.1 IO 和任务

- 所有长 IO 从 Tauri command 经 `tauri::async_runtime::spawn_blocking` 执行。
- 长循环必须接收 `&AtomicBool`，在有限间隔内检查取消。
- 进度统一通过 `source::emit_progress` 发出 `task-progress`。
- Progress payload 必须提供 task、phase、current/total、bytes、path 和 elapsed time。
- 不要在生产路径使用 `unwrap()`/`expect()`；用 `AppError`/`AppResult` 添加可行动上下文。
- 大文件使用有界堆缓冲区。禁止把 MiB 级数组放在线程栈上。
- 遍历源目录时不跟随符号链接。

### 6.2 文件安全

- 写入前确认目标位于用户选择的 destination 下。
- 中间结果使用唯一 `.partial-{nonce}`，完成后 rename。
- 使用 `create_new` 防止意外覆盖。
- 最终发布必须调用 `storage::publish_noreplace`，保持 Windows/macOS/Linux 原子 no-replace；不能退回 `exists + rename` 的竞态组合。
- 导入的每个路径组件必须经过 `importer::sanitize_name`；保持 Windows 保留名、大小写折叠和清理后碰撞测试。
- Manifest 当前为 format v2：`sourcePath` 是原始相对路径，`path` 是 Windows 安全目标路径；数据集 BLAKE3 仍基于原始 `sourcePath`。
- 取消或失败时不得出现正式输出名。
- 如果新增自动清理，只能删除本应用可证明创建的 partial 路径，不能使用宽泛 glob 或递归删除用户目录。
- warning/error 后台报告只能写入 Tauri `appLocalData` 下的应用专属 `reports` 目录；不得写入源卡或 episode。保持 partial、回读和原子 no-replace，同一 episode 路径/指纹/报告版本稳定去重；不得把“后台汇报”实现为网络上传。
- 账号写入 `appLocalData/accounts`，轨迹占号写入 `appLocalData/trajectory-codes`，标注修订写入 `appLocalData/annotations/{episodeId}`。全部使用 `create_new`、回读和原子 no-replace；Unix 新文件权限为 `0600`。不得写入源 SD 卡或导入 episode。

### 6.3 数据模型

- Rust 对外结构使用 `#[serde(rename_all = "camelCase")]`。
- 原始 `capture_time_ns` 可用 `i64` 解析，`StateRecord` 对前端必须是 `String`。
- 数组宽度是契约的一部分，不要把固定数组改成无约束 `Vec`。
- 新 issue code 必须稳定、全大写下划线，并同步更新 `prd.md`、前端显示和 fixture 测试。
- 可定位的 issue 必须设置 `frameId`；新增 JSON 报告字段或破坏语义时提高 `formatVersion`。
- 破坏 manifest/HDF5 schema 时提高对应格式版本，不能只提高应用版本。
- 密码只能作为注册/登录请求的瞬时输入，不得进入 `UserIdentity`、日志、报告、标注或导出。标注必须绑定规范化 episode 路径和数据指纹，并保留不可覆盖的修订号、处理账号和时间。

### 6.4 Validation

- 健康检查应报告事实，不自动修复源数据。
- Warning 表示数据可读取但存在质量风险；error 表示缺失、损坏或语义不可用。
- 新检查必须说明 severity、scope、code、消息和导出影响。
- 交互健康检查固定解码每流排序后唯一帧序列的 `1% / 25% / 50% / 73% / 99%`，少于五个命中时去重；结构、文件名、缺帧、frame ID 集合、状态和时间轴仍全量检查。
- 正式 stress 和发布 smoke 必须调用全量 JPEG 解码，不能用交互抽检报告替代。任何报告都必须显式记录 `imageValidationMode`、`imageSamplePercentages` 和实际 `checkedFrames`；仅读 header 不能算 JPEG 解码检查。
- 抽检无法保证发现未命中帧的编码损坏。界面、报告、文档和测试不得把 sampled 结果描述成全量 JPEG 通过。
- warning/error 必须在检查 command 返回前完成本地后台报告，ok 不生成；报告字段 `autoReportPath` 与实际普通文件一致，失败必须显式返回，不能显示“已生成”。
- 导出后端必须最终具备 error hard gate，不能只依赖按钮 disabled。
- 当前稳定 issue code 还包括 `INVALID_TIMESTAMP`、`INVALID_FRAME_FILENAME`、`DUPLICATE_FRAME_ID` 和 `FRAME_ID_MISMATCH`；改变其 severity 属于契约变更。

## 7. 新增或修改导出 Adapter

新格式必须遵循以下步骤：

1. 在 `model.rs` 和 `src/types.ts` 添加一致的格式 ID。
2. 在 `export/mod.rs` 实现并接入 `ExportAdapter` dispatch。
3. 复用 `unique_file`/`unique_directory` 和 `partial_sibling`。
4. 在 adapter 内持续检查 cancellation 并发出 export progress。
5. 保留原始状态精度和时间戳，不静默丢字段。
6. 成功前重新打开输出，验证关键 schema、shape、channel 或 metadata。
7. 在 `backend.ts`、`ExportPanel.tsx` 和 browser demo 同步格式。
8. 增加真实样例 smoke test，并检查输出不是仅“文件存在”。
9. 更新 `prd.md` 的数据契约和 README。
10. 已标注 episode 必须以统一轨迹码作为三种格式的基础输出名，并在格式 metadata 中保存任务与处理人；未标注 episode 保持历史命名兼容。

格式专属约束：

- MCAP 使用原始 `capture_time_ns` 作为 log/publish time。
- MCAP 图像和位姿必须使用 Foxglove 官方 protobuf schema；生产回读保持
  summary-only 有界读取，真实样例测试再逐条解码 protobuf 和 JSON。
- 裁剪范围使用包含起止帧的闭区间。范围外逐帧 issue 不阻断导出；无 frame ID
  或负 frame ID 的全局 issue 仍然生效。输出名称与 metadata 必须记录范围。
- HDF5 使用 `hdf5-pure`；不要引入需要用户安装的 HDF5 DLL。
- HDF5 JPEG 必须经 `with_streamed_u8_data` 按固定 1 MiB chunk 写入；禁止退回 `with_u8_data` 暂存完整流或重新引入按 JPEG 总量增长的内存缓冲。
- `vendor/hdf5-pure` 固定 0.21.2，只公开其已有 lazy chunk writer 的最小接口；修改或升级前必须阅读 `DOHC_PATCH.md`，重跑跨文件/尾块测试和真实三格式回读。
- 100 GiB 逻辑 staging 测试只证明 builder 不分配等量 payload；它不能替代真实 100 GB/100,000 文件的扫描、导入、检查、三格式导出和内存基线。
- LeRobot 标准 `timestamp` 必须与恒定 FPS 视频一致；原始时钟写入 `observation.capture_time_ns`。
- LeRobot 没有源 action 时保持没有 action，不能填零数组伪装真实数据。
- FFmpeg 错误必须包含 stderr 摘要；取消时先 kill/wait 子进程。
- 标注 metadata 契约为：MCAP `dohc.dataset` metadata，HDF5 根属性和 `/annotation`，LeRobot `info.json.dohc_annotation` 与 task 文本。新增字段必须同步生产回读与真实样例回读。

## 8. Frontend 开发规则

- 数据类型集中在 `src/types.ts`，不要在组件内重复定义后端 payload。
- Tauri/browser 分支集中在 `src/lib/backend.ts`。
- 状态时间差使用 `BigInt`；禁止 `Number(captureTimeNs)` 后再计算。
- 操作按钮在 busy/error 状态下必须正确 disabled。
- 进度、错误、warning 和成功结果都必须有可见状态，不能只写 console。
- 图像面板使用稳定尺寸；加载或错误不能改变 grid 布局。
- 选择 SD 卡后自动扫描并加载第一条 session，不保留额外“导入并检查”按钮。左侧 episode 列表仍以源路径作为 session 身份：单击只选择，双击才进入回放；本地导入路径不得覆盖源 session 的选中身份。
- 登录页是唯一的工作区入口；顶栏显示当前账号并提供退出。退出必须清空当前 episode、检查和标注状态，不能让未登录用户继续调用数据 IPC。
- 回放首页顶部固定提供 episode 级数据标注。选择任务时自动填充默认描述和该任务前缀的下一个轨迹码；描述可编辑，轨迹码只读；保存结果显示修订号和最近处理人。
- 检查结果固定使用“错误/警告/通过”文本，错误优先、警告其次、通过最后；`states.jsonl` 必须从 scope 为 `states` 的 issue 推导结果。手动报告按钮使用“导出报告”，不暴露存储格式作为主标签。
- 应用 UI 色彩系统固定为黑、白和中性灰；原始相机画面保留源颜色。状态不得只靠色相表达，必须同时使用文字、图标、边框和明度层级。
- 图标使用当前 Lucide 库，陌生图标按钮提供 `title`/`aria-label`。
- 桌面工具保持紧凑、可扫描，不增加 landing page、营销 hero 或装饰性卡片。
- 卡片圆角不超过 8 px，不嵌套卡片，letter-spacing 保持 0。
- 中文是主要 UI 语言；技术 ID、format name 和 issue code 保留英文。

视觉修改至少检查：

- 1440x920 标准窗口。
- 960x680 最小桌面窗口。
- 390x844 窄视口，用于发现溢出问题，不代表移动端发布目标。
- 回放、检查、导出三个 tab。
- 五张图片 `naturalWidth > 0`。
- `documentElement.scrollWidth <= innerWidth`。
- console error、page error、失败请求均为零。

## 9. 测试门槛

| 变更类型 | 最低验证 |
| --- | --- |
| 文档-only | 检查链接、命令、字段名与代码一致；不要求重跑 70 秒样例 |
| React/CSS | `pnpm build`，相关视口截图，console/overflow 检查 |
| Rust model/IPC | `pnpm check`、Clippy，确认 camelCase 和 TS 类型 |
| Import/hash | 单元测试 + 真实 import smoke test |
| Validation | 固定百分位/全量模式 fixture + 真实交互抽检及全量 JPEG smoke test |
| Export adapter | Clippy + 三格式真实 export/readback smoke test |
| Tauri config | `pnpm tauri build --debug --no-bundle`；平台配置在目标平台验证 |
| Windows 条件源码 | `pnpm check:windows-cross`；仍需 Windows 本机构建和运行 |
| macOS ExFAT 路径 | `pnpm check:exfat-macos`；仍需真实 SD 卡和大容量 formal run |
| Windows release | Win10/Win11 x64 断网安装、导入、检查、回放、三导出、卸载 |

提交前默认运行：

```bash
pnpm check
```

真实样例会读取私有数据，因此保持 `#[ignore]`。`--all-targets` 常规 Rust suite
当前为 46 项（44 通过、2 个真实样例测试 ignored），其中包含本地账号、轨迹占号、标注修订、HDF5 属性回读、adapter 元数据和压力 CLI 参数测试；
debug 构建的三格式完整 smoke test 约需 69 秒。任何
import/validation/export 行为改动都必须显式运行对应真实样例测试。

### 9.1 exFAT 与大容量正式验收

`stress-check` 默认是 formal 模式；只有本地开发样本可以显式传
`--development-fixture`。正式运行必须同时满足：

1. 使用 `cargo run --release`，仓库 clean，HEAD 精确位于与应用版本一致的 annotated tag。
2. `DOHC_FFMPEG` 是绝对路径，指向普通文件；报告记录版本、大小和 BLAKE3。
3. `--source` 是 exFAT 上的单个 episode，至少 100,000 个文件且至少 100,000,000,000 字节。
4. `--work-root` 不得已存在，必须位于源卡之外的另一个本地卷；可用空间至少为源大小四倍加 `max(25%, 64 MiB)`。
5. 保留完整 work root 和其中原子生成的 `stress-report.json`；不要只截取终端成功文本。

macOS 命令：

```bash
export DOHC_FFMPEG=/absolute/path/to/reviewed/ffmpeg
cargo run --release --manifest-path src-tauri/Cargo.toml --example stress-check -- \
  --source /Volumes/DOHC_CARD/episode \
  --work-root /Volumes/LOCAL_WORK/dohc-stress-v0.9.0
```

Windows PowerShell 命令：

```powershell
$env:DOHC_FFMPEG = "C:\reviewed\ffmpeg.exe"
cargo run --release --manifest-path src-tauri/Cargo.toml --example stress-check -- `
  --source "E:\episode" `
  --work-root "D:\dohc-stress-v0.9.0"
```

runner 依次执行环境门禁、扫描、卷/规模/空间门禁、源元数据指纹、import
取消探针、复制与目标 BLAKE3 回读、完整检查、三 adapter 生成/回读、源端逐文件
BLAKE3 和最终元数据指纹。取消探针只在检测到受控 partial 后置位，要求 1 秒内
返回、没有正式输出，并通过 marker 校验后清理 partial。报告 schemaVersion=1，
包含平台/profile/Git、两个卷、阈值、FFmpeg、各阶段耗时/逻辑吞吐/峰值 RSS、
validation、输出大小、取消延迟以及源前后 hash。formal 失败、报告缺失或
`formal:false` 均不能关闭 GAP-003/GAP-007。

开发样本命令允许 APFS 和小数据，仅用于快速验证 runner 本身：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --example stress-check -- \
  --source "$PWD/data/raw/2026-07-13_07-34-12" \
  --work-root /tmp/dohc-stress-development \
  --development-fixture

DOHC_SAMPLE_ROOT="$PWD/data/raw/2026-07-13_07-34-12" \
  pnpm check:exfat-macos
```

## 10. 发布检查与 FFmpeg 暂存

### 10.1 共同约束

不要手工复制 FFmpeg 到 `src-tauri/resources`。平台脚本必须先验证：

1. 调用者提供的 SHA-256 与源二进制一致，复制后 hash 回读仍一致。
2. 二进制架构与目标平台一致，并可运行 `-version` 和 `-encoders`。
3. 存在 native `mpeg4` encoder，configuration 不含 `--enable-nonfree`。
4. 来源为 HTTPS，build ID 非空，并提供至少一个非空许可证文件。
5. macOS 二进制只依赖系统库；Windows x64 由 `-ReviewedPortable` 显式确认已审查为便携构建。

成功 staging 会生成三个 ignored 资源：平台 FFmpeg 二进制、
`licenses/FFmpeg.txt` 和 `ffmpeg-manifest.json`。manifest schemaVersion 当前为
1，记录平台、相对资源路径、来源、build ID、SHA-256、版本、configuration、
encoder、架构、许可证文件名、portable 和 UTC 暂存时间。bundle 检查必须回读
manifest 和二进制 hash；`portable:false` 默认阻止打包。macOS 正式构建在封印后还必须
记录 `sourceBinarySha256`、封印后 `sha256`、`codeSigned:true`、
`signatureMode:adhoc` 和 `trustedSignature:false`。

### 10.2 macOS 验证

```bash
scripts/stage-ffmpeg.sh \
  --source /path/to/ffmpeg \
  --expected-sha256 "$FFMPEG_SHA256" \
  --license /path/to/LICENSE \
  --source-url https://publisher.example/ffmpeg \
  --build-id reviewed-build-id
pnpm check:bundle
```

Homebrew FFmpeg 通常引用 `/opt/homebrew` 下的动态库，不能作为可分发 sidecar。
本机 debug 可在 staging 时显式传 `--allow-nonportable`，并用以下命令验证：

```bash
node scripts/release-check.mjs --full --bundle --allow-nonportable-bundle
```

该例外只允许验证本机 `.app`/`.dmg` 结构和运行路径，产物不得发布，也不能关闭
FFmpeg 分发审核缺口。

正式 macOS app 组装完成后必须运行 `scripts/seal-macos-app-adhoc.sh --app <path>`，
再创建 DMG。脚本按 FFmpeg、主程序、app bundle 的顺序执行 ad-hoc 封印并运行
`codesign --verify --deep --strict`。不得把 Tauri/linker 自动生成的半成品签名直接打包；
这会产生 “code has no resources” 并让 Gatekeeper 报告应用已损坏。

### 10.3 Windows 发布

Windows 正式构建只能在 Windows x64 构建机完成。macOS 构建成功不能替代 Windows 验收。

```powershell
pnpm install --frozen-lockfile
$env:DOHC_SAMPLE_ROOT = "C:\path\to\2026-07-13_07-34-12"
.\scripts\stage-ffmpeg.ps1 `
  -Source C:\path\to\ffmpeg.exe `
  -ExpectedSha256 $FfmpegSha256 `
  -LicenseFile C:\path\to\COPYING.txt `
  -SourceUrl https://publisher.example/ffmpeg `
  -BuildId reviewed-build-id `
  -ReviewedPortable
pnpm check:full
pnpm check:bundle
pnpm tauri:build
```

发布检查：

1. `check:bundle` 报告中的 staged FFmpeg、全部命令和 NSIS debug artifact 均为 passed。
2. 归档 FFmpeg 下载来源、版本、SHA-256、构建选项、许可证和 manifest。
3. NSIS 包含离线 WebView2，不依赖安装时网络。
4. Installer hook 在 Win10 以下中止安装。
5. 当前 unsigned channel 必须确认应用和安装器没有被误标为可信签名，并在文件名和发布说明中显示 `UNSIGNED`；后续 production channel 再要求代码签名和时间戳。
6. 在断网的干净 Win10/Win11 x64 VM 中运行完整 smoke test。
7. 确认安装包不包含 `data/raw`、`data/imports`、测试输出或开发路径。

不要把 staging 的 FFmpeg、许可证 bundle、manifest、JSON 检查报告或签名材料加入 Git。

### 10.4 GitHub Release CD

`.github/workflows/release.yml` 只处理已经存在的 annotated `vX.Y.Z` tag。prepare job
重新验证 tag 类型、HEAD、clean checkout、Changelog 以及四处应用版本，然后运行
`pnpm check`。Windows x64、macOS arm64 和 macOS x64 在原生 runner 上构建；所有
job 使用锁定 commit SHA 的 Actions，并固定 Node 22、pnpm 10.12.1 和 Rust 1.97.1。

当前 `0.15.x` release channel 是显式 unsigned，即没有可信发布者身份。Windows FFmpeg、许可证、构建说明和
WebView2 exact URL/SHA-256 固定在 workflow；macOS arm64/x64 从固定 archive hash 和
Git commit 的 FFmpeg 8.1.2 官方源码构建只含 JPEG -> MPEG-4 所需能力的最小 LGPL
sidecar。不得替换为 `--enable-nonfree` 或带非系统动态库的构建。macOS 的 unsigned
披露不允许省略 ad-hoc 完整性封印。

平台验证最低包括：

1. Windows 确认 DOHC 应用、NSIS 和 uninstaller 为 unsigned，同时验证 Microsoft 已签名
   的 offline WebView2、FFmpeg/许可证/manifest、silent install、启动 8 秒和 silent uninstall。
2. macOS 确认没有 Developer ID 和 notarization claim；app、主程序和 FFmpeg 必须是
   ad-hoc 且通过 `codesign --verify --deep --strict`。验证 FFmpeg 源码/封印前后 binary
   hash、架构与系统库依赖、只读 DMG、`/Applications` 链接；复制 app 并添加合成
   quarantine 后，`syspolicy_check distribution` 只能因 `Adhoc Signed App` 和
   `Notary Ticket Missing` 拒绝，不能出现 invalid signature、missing resources 或
   damaged，再执行 8 秒直接启动。
3. final job 重新读取三份 verification JSON 和安装器 hash，生成
   `release-manifest.json`、`SHA256SUMS.txt` 和 provenance；三个 installer 集合完整
   后才解除 draft。公开过的 tag 不允许 clobber。

所有安装器文件名、Release 标题/说明和 manifest 必须显示 `UNSIGNED`。加入可信签名时必须
作为单独版本恢复 Authenticode、Developer ID、timestamp、Gatekeeper 和 notarization
门禁，不得在同一 tag 上替换资产。GitHub hosted runner 不是目标机验收；CD 通过仍不得
关闭 Win10/Win11 断网、目标 Mac、真实 exFAT SD 卡或 100 GB/100,000 文件缺口。用户文档以 `docs/wiki/` 为唯一源，
修改后运行 `pnpm check:wiki`；`.github/workflows/wiki.yml` 只负责同步到已初始化的
GitHub Wiki，不直接在网页维护分叉版本。

## 11. 依赖管理

- 优先使用仓库已有库和纯 Rust 实现。
- 增加依赖前说明它解决的具体问题、二进制大小、许可证和 Windows 支持。
- 解析 JSON、Parquet、MCAP、HDF5 时使用结构化库，不写 ad-hoc string parser。
- `pnpm-lock.yaml`、`Cargo.lock` 和 `rust-toolchain.toml` 是可重复构建的一部分，依赖或工具链变更必须同步审查和提交。
- vendored 依赖必须保留上游版本、checksum、Git revision、许可证和本地 patch 清单；不得把未说明来源的源码复制进 `vendor/`。
- 不进行无关的大版本升级；格式库升级必须重跑真实 export/readback。
- FFmpeg 是受控 sidecar，不假设用户 PATH 中存在。
- `tauri-plugin-opener` 只开放 `opener:allow-reveal-item-in-dir`；不得开放 URL 或任意程序启动权限。
- Dialog capability 只开放目录选择和消息框；新增 capability 必须对应明确的用户操作。
- `argon2 0.5.3`（MIT/Apache-2.0）及其纯 Rust `password-hash`/`blake2` 依赖用于本地 Argon2id PHC 密码哈希，`rand_core` 的操作系统 CSPRNG 生成独立盐；该路径支持 Windows/macOS/Linux，不得降级为明文或快速通用哈希。`v0.14.0` macOS ARM debug 主程序相对已安装的 `v0.13.0` 增加 2,431,504 bytes（约 3.1%，包含本版本全部账号/标注代码和依赖）；Windows release 体积仍需目标构建机记录。
- `tauri-plugin-opener 2.5.4` 为 MIT/Apache-2.0 双许可的官方跨平台实现。`v0.3.0` 全部变更使 macOS ARM debug 二进制增加 1,239,152 bytes（约 2.2%）；Windows release 体积必须在目标构建机另行记录。
- `foxglove 0.26.0`（MIT）、`prost 0.14.4`（Apache-2.0）和 `bytes 1.12.1`（MIT）用于生成官方 Foxglove protobuf schema/消息；Foxglove 默认 features 保持关闭。`v0.9.0` macOS ARM debug 主程序相对 `v0.8.0` 增加 383,472 bytes（约 0.5%），Windows x64 MSVC all-target 条件编译已通过，目标机 release 体积仍需另行记录。

## 12. Git 与工作区纪律

- 保留用户已有修改，不重置或覆盖无关文件。
- 不使用 `git reset --hard`、宽泛递归删除或不受控清理命令。
- 原始数据只保存在 ignored 目录；需要共享测试数据时创建最小、脱敏、明确许可的 fixture。
- 不提交 `dist/`、`node_modules/`、`src-tauri/target/`、generated schemas 或临时截图。
- 除非任务明确要求，不自动创建 commit、tag 或 release。
- 修改行为时同步更新相关文档；不要把“已实现”状态提前写入 PRD。

当前产品开发明确要求每个应用版本都有独立 commit 和 annotated tag。创建版本时必须：

1. 保持 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的 semver 一致。
2. 更新 `CHANGELOG.md` 和 PRD 实现状态。
3. 至少运行 `pnpm check:full`；平台包变更还要运行相应 bundle 检查，并确认私有数据、staged FFmpeg、报告和构建产物未暂存。
4. 创建一个包含完整版本内容的 release commit，例如 `release: v0.2.0`。
5. 在 release commit 上运行 `node scripts/release-check.mjs --quick --require-clean`，确认版本一致且工作区干净。
6. 在该 commit 上创建 annotated tag，例如 `git tag -a v0.2.0 -m "DOHC Viewer v0.2.0"`。
7. 测试失败、报告 failed、版本不一致或工作区混入无关文件时不得打 tag。

tag 推送后，GitHub Release 只能由 `release.yml` 生成。不要手工上传或只发布单一平台；
当前 unsigned channel 必须保留全部警告和文件名标记。CD 因依赖或 smoke 失败时可重跑
同一 draft，代码修复则进入新版本和新 tag。未来签名模式的修改也必须进入新版本，
不得覆盖现有 unsigned tag。GitHub Wiki 的可编辑源保留在主仓库，Wiki Git 仓库只接收同步 commit。

正式实盘验收是 tag 后的资格测试，因为 runner 会核对 exact tag。它失败时不得
移动、覆盖或重建已有 tag；修复进入下一个版本。没有实盘条件时可以发布明确标注
GAP-003/GAP-007 未关闭的 Alpha tag，但不得据此发布 v1.0 或宣称现场验收通过。

## 13. 完成工作时的报告格式

交付说明至少包含：

- 改了什么以及用户可见行为。
- 关键文件路径。
- 实际运行过的构建、测试和样例验证。
- 没有运行的目标平台测试及原因。
- 已知风险、数据 warning 和下一发布门槛。

Windows 安装包未在 Windows 构建机验证时，必须明确写出，不能用 macOS Tauri build 代替。
