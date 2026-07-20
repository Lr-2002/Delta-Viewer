# DOHC Viewer 开发指南

本文件适用于整个仓库。所有开发者和自动化编码 agent 在修改代码前都必须阅读 `prd.md`；产品范围、字段语义和验收标准以 `prd.md` 为准。

## 1. 不可破坏的产品约束

1. 源 SD 卡是只读数据源。不得在源路径创建、修改、重命名或删除任何文件。
2. 应用运行时只处理本机目录，不增加 SSH、HTTP、云存储或遥测路径。
3. 正常工作流是“扫描 -> 本地导入并校验 -> 健康检查 -> 回放/导出”。不要绕过本地校验直接把 SD 卡当作长期工作目录。
4. 完整导入必须验证目标端的文件大小和 BLAKE3，不能只信任复制时的源端 hash。
5. `capture_time_ns` 在 Rust/磁盘中为 int64，在 TypeScript 中必须保持十进制字符串；涉及差值时使用 `BigInt`。
6. 五个标准流名称固定为 `cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`。
7. Warning 数据可以在明确提示后导出；error 数据不能通过 UI 或 IPC 绕过阻断。
8. LeRobot 数据不得虚构源数据中不存在的 action。规范化时间轴时必须保留原始纳秒时间。
9. 正式输出必须先写 partial 路径，成功后再原子 rename；不得覆盖已有输出。
10. 私有原始数据、构建产物、FFmpeg 二进制和签名凭据不得提交到 Git。

## 2. 仓库结构

```text
DOHC_Viewer/
  prd.md                         产品需求和验收基线
  README.md                      用户/构建入口
  AGENTS.md                      本开发指南
  src/                           React/TypeScript UI
    App.tsx                      顶层工作流和视图状态
    components/                  回放、检查、进度和导出组件
    lib/backend.ts               所有 Tauri IPC/browser demo 适配
    types.ts                     前端共享数据类型
  src-tauri/
    src/lib.rs                   Tauri commands 和长任务调度
    src/model.rs                 Rust/IPC 数据模型
    src/source.rs                episode 发现、扫描、状态/帧读取
    src/importer.rs              复制、BLAKE3、manifest、命名清理
    src/validation.rs            数据健康检查和 issue code
    src/export/                  导出 adapter
      mod.rs                     adapter dispatch 和公共输出规则
      mcap.rs                    MCAP
      hdf5.rs                    HDF5
      lerobot.rs                 LeRobot v2.1 和 FFmpeg
    capabilities/default.json    Tauri 权限
    tauri.conf.json              通用桌面配置
    tauri.windows.conf.json      Win10+/NSIS/离线依赖配置
    windows/installer-hooks.nsh  Win10 最低版本检查
  scripts/stage-ffmpeg.ps1       Windows FFmpeg staging
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
- 文件遍历、哈希、解码和导出必须在 Rust 中执行。
- Export UI 不知道格式内部结构；格式差异只能进入 adapter。
- Browser demo 仅用于视觉开发，必须和真实样例统计、warning 和类型保持一致。它不能被当作后端验收。

## 4. 环境与常用命令

要求：Node.js、pnpm 10、稳定 Rust、平台对应的 Tauri 构建依赖。LeRobot smoke test 还需要 FFmpeg。

```bash
pnpm install
pnpm dev
pnpm tauri:dev
pnpm build
pnpm check
```

Rust 单独检查：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
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
- MCAP 为 6 channels/1 schema。
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
- 名称必须经过 `importer::sanitize_name`；保持 Windows 保留名测试。
- 取消或失败时不得出现正式输出名。
- 如果新增自动清理，只能删除本应用可证明创建的 partial 路径，不能使用宽泛 glob 或递归删除用户目录。

### 6.3 数据模型

- Rust 对外结构使用 `#[serde(rename_all = "camelCase")]`。
- 原始 `capture_time_ns` 可用 `i64` 解析，`StateRecord` 对前端必须是 `String`。
- 数组宽度是契约的一部分，不要把固定数组改成无约束 `Vec`。
- 新 issue code 必须稳定、全大写下划线，并同步更新 `prd.md`、前端显示和 fixture 测试。
- 破坏 manifest/HDF5 schema 时提高对应格式版本，不能只提高应用版本。

### 6.4 Validation

- 健康检查应报告事实，不自动修复源数据。
- Warning 表示数据可读取但存在质量风险；error 表示缺失、损坏或语义不可用。
- 新检查必须说明 severity、scope、code、消息和导出影响。
- 保持全量 JPEG 解码；仅读 header 不能满足编码损坏检查。
- 导出后端必须最终具备 error hard gate，不能只依赖按钮 disabled。

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

格式专属约束：

- MCAP 使用原始 `capture_time_ns` 作为 log/publish time。
- HDF5 使用 `hdf5-pure`；不要引入需要用户安装的 HDF5 DLL。
- LeRobot 标准 `timestamp` 必须与恒定 FPS 视频一致；原始时钟写入 `observation.capture_time_ns`。
- LeRobot 没有源 action 时保持没有 action，不能填零数组伪装真实数据。
- FFmpeg 错误必须包含 stderr 摘要；取消时先 kill/wait 子进程。

## 8. Frontend 开发规则

- 数据类型集中在 `src/types.ts`，不要在组件内重复定义后端 payload。
- Tauri/browser 分支集中在 `src/lib/backend.ts`。
- 状态时间差使用 `BigInt`；禁止 `Number(captureTimeNs)` 后再计算。
- 操作按钮在 busy/error 状态下必须正确 disabled。
- 进度、错误、warning 和成功结果都必须有可见状态，不能只写 console。
- 图像面板使用稳定尺寸；加载或错误不能改变 grid 布局。
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
| Validation | fixture 测试 + 真实全量 JPEG smoke test |
| Export adapter | Clippy + 三格式真实 export/readback smoke test |
| Tauri config | `pnpm tauri build --debug --no-bundle`；平台配置在目标平台验证 |
| Windows release | Win10/Win11 x64 断网安装、导入、检查、回放、三导出、卸载 |

提交前默认运行：

```bash
pnpm check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

真实样例 smoke test约 70 秒且读取私有数据，因此保持 `#[ignore]`，但任何 import/validation/export 行为改动都必须显式运行。

## 10. Windows 发布指南

Windows 正式构建只能在 Windows x64 构建机完成。macOS 构建成功不能替代 Windows 验收。

```powershell
pnpm install --frozen-lockfile
.\scripts\stage-ffmpeg.ps1 -Source C:\path\to\ffmpeg.exe
pnpm check
cargo clippy --manifest-path src-tauri\Cargo.toml --all-targets -- -D warnings
pnpm tauri:build
```

发布检查：

1. `src-tauri/resources/bin/ffmpeg.exe` 存在且 `-version` 可执行。
2. 记录 FFmpeg 下载来源、版本、SHA-256、构建选项和许可证。
3. NSIS 包含离线 WebView2，不依赖安装时网络。
4. Installer hook 在 Win10 以下中止安装。
5. 应用和安装器完成代码签名和时间戳。
6. 在断网的干净 Win10/Win11 x64 VM 中运行完整 smoke test。
7. 确认安装包不包含 `data/raw`、`data/imports`、测试输出或开发路径。

不要把 staging 的 `ffmpeg.exe` 或签名材料加入 Git。

## 11. 依赖管理

- 优先使用仓库已有库和纯 Rust 实现。
- 增加依赖前说明它解决的具体问题、二进制大小、许可证和 Windows 支持。
- 解析 JSON、Parquet、MCAP、HDF5 时使用结构化库，不写 ad-hoc string parser。
- `pnpm-lock.yaml` 和 `Cargo.lock` 是可重复构建的一部分，依赖变更必须同步提交 lockfile。
- 不进行无关的大版本升级；格式库升级必须重跑真实 export/readback。
- FFmpeg 是受控 sidecar，不假设用户 PATH 中存在。

## 12. Git 与工作区纪律

- 保留用户已有修改，不重置或覆盖无关文件。
- 不使用 `git reset --hard`、宽泛递归删除或不受控清理命令。
- 原始数据只保存在 ignored 目录；需要共享测试数据时创建最小、脱敏、明确许可的 fixture。
- 不提交 `dist/`、`node_modules/`、`src-tauri/target/`、generated schemas 或临时截图。
- 除非任务明确要求，不自动创建 commit、tag 或 release。
- 修改行为时同步更新相关文档；不要把“已实现”状态提前写入 PRD。

## 13. 完成工作时的报告格式

交付说明至少包含：

- 改了什么以及用户可见行为。
- 关键文件路径。
- 实际运行过的构建、测试和样例验证。
- 没有运行的目标平台测试及原因。
- 已知风险、数据 warning 和下一发布门槛。

Windows 安装包未在 Windows 构建机验证时，必须明确写出，不能用 macOS Tauri build 代替。
