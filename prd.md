# DOHC Viewer 产品需求文档

| 属性 | 内容 |
| --- | --- |
| 产品名称 | DOHC Viewer |
| 文档版本 | 0.15 |
| 应用版本基线 | 0.15.2 |
| 文档状态 | 安全 Alpha，unsigned GitHub Release CD 与 macOS 完整性封印已定义，等待可信签名与目标机验收 |
| 发布平台 | Windows 10/11 x64；macOS 12+ arm64/x64 |
| 文档日期 | 2026-07-21 |
| 产品负责人 | 待指定 |
| 技术负责人 | 待指定 |

## 1. 文档目的

本文定义 DOHC Viewer 的产品边界、数据契约、用户流程、功能需求、非功能需求和发布验收标准。产品、设计、开发和测试均以本文为共同基线。

本文同时记录当前 `0.15.2` Alpha 已经验证的能力和正式发布前仍需完成的工作。标记为“已实现”不代表已经通过目标机发布验收；当前 GitHub Release 明确为没有可信发布者身份的 unsigned 通道，可信签名安装包、真实 SD 卡和长时数据测试仍是独立的生产门槛。

## 2. 背景与问题

DOHC 采集设备将一次记录写入 SD 卡。现有卡使用 ext4，macOS 和标准 Windows 环境不能直接读取。团队需要一个离线桌面工具，把数据从物理 SD 卡可靠地复制到本地，对数据质量进行检查，完成多路同步回放，并导出到机器人数据工具链需要的格式。

当前人工流程存在以下问题：

- ext4 卡不能由目标办公电脑直接读取。
- 大量 JPEG 和状态记录无法快速判断是否为空、缺帧或损坏。
- 手工复制无法证明目标文件与源文件一致。
- 五路相机与状态数据缺少统一时间轴进行检查。
- MCAP、HDF5 和 LeRobot 数据需要重复编写临时转换脚本。
- 原始记录目录名可能包含 Windows/exFAT 不允许的字符，例如冒号。
- 本地处理缺少操作员身份、任务语义和统一轨迹编号，无法可靠判断一条数据由谁处理、对应什么任务。

## 3. 已确认的产品决策

| 编号 | 决策 |
| --- | --- |
| D-001 | 产品运行时只支持本机可见的 SD 卡或本地目录，不支持 SSH、HTTP、NAS 或其他网络数据源。 |
| D-002 | 工作流必须先复制到本地，再进行全量结构/状态检查和固定百分位 JPEG 抽检，然后回放和导出；源 SD 卡始终按只读数据源处理。正式压力/发布验收仍全量解码 JPEG。 |
| D-003 | 正式安装包覆盖 Windows 10/11 x64 与 macOS 12+ arm64/x64；首个现场验收重点仍为 Windows。技术栈为 Tauri 2、Rust、React 和 TypeScript。 |
| D-004 | 推荐未来采集卡使用 exFAT，以便 Windows/macOS 直接读取；当前 ext4 卡必须先备份再格式化。 |
| D-005 | 导入完整性采用“文件大小 + BLAKE3”逐文件回读校验，并生成数据集级 BLAKE3。 |
| D-006 | 导出格式通过独立 adapter 实现，首批为 MCAP、HDF5 和 LeRobot v2.1。 |
| D-007 | 数据存在 warning 时允许导出；存在 error 时必须阻止正常导出。 |
| D-008 | 应用不依赖运行时网络，Windows 安装包必须包含离线 WebView2 安装能力和 FFmpeg。 |
| D-009 | 源数据没有 `action` 字段，LeRobot 导出不得虚构 action。 |
| D-010 | 文件和目录名必须兼容 Windows；旧数据中的非法字符由导入器确定性替换。 |
| D-011 | 100 GB 正式验收必须使用 exFAT 实卡、不同本地工作卷、release exact tag 和显式 reviewed FFmpeg；开发 fixture 结果不得替代。 |
| D-012 | macOS 上的 Windows MSVC 条件编译和虚拟 ExFAT smoke 只作为预资格证据；不能替代 Windows 链接/打包/运行、真实 SD 卡或 formal 大容量验收。 |
| D-013 | v0.9 支持对单条轨迹做连续、闭区间的帧范围裁剪；裁剪只影响本次回放和导出，源目录与本地导入副本保持不变。 |
| D-014 | v0.11 起应用界面使用黑、白和中性灰作为完整色彩系统；原始相机画面保留源颜色，状态通过文字、图标、边框和明度共同表达，不仅依赖色相。 |
| D-015 | v0.12 起选择 SD 卡目录后自动扫描、选择第一条 session，并直接进入本地目标选择、导入、检查和回放；不再要求点击“导入并检查”。其他 session 仍从左侧列表双击进入。 |
| D-016 | v0.13 起 warning/error 检查结果必须在后台自动生成本地审计报告；ok 不自动生成。报告只写入应用本地数据目录，不上传网络、不写源卡或导入副本；同一 episode 路径和数据指纹在同一报告版本下去重。 |
| D-017 | v0.14 起进入数据工作区前必须登录本地账号；账号不连接服务器、不提供远程权限体系，密码仅保存 Argon2id 哈希和系统随机盐。账号用于本机处理归因。 |
| D-018 | v0.14 起标注记录绑定规范化 episode 路径与数据指纹，使用任务目录、可编辑任务描述和 `{prefix}-{NNN}` 轨迹编码。首个任务为 `close_oven`，前缀为 `oven`；标注只写应用 local-data，并以追加修订保留处理人历史。 |
| D-019 | Release CD 只从 clean exact annotated tag 构建，并且必须同时完成 Windows x64、macOS arm64、macOS x64 安装包；当前阶段允许公开显式 `UNSIGNED` 的完整集合，但标题、说明、文件名、报告和 manifest 必须一致披露。未来签名产物必须使用新版本/tag，不覆盖 unsigned 资产。 |
| D-020 | 用户文档使用 GitHub Wiki；`docs/wiki` 是可审查的唯一源，由 workflow 同步，避免网页内容与代码版本分叉。 |
| D-021 | unsigned macOS app 仍必须对 FFmpeg、主程序和完整 bundle 生成结构有效的 ad-hoc seal；发布门禁必须在 synthetic quarantine 下区分“无可信身份/未公证”的预期策略拒绝、由已知良性 control app 复现的 runner XProtect 服务错误，以及 invalid signature/damaged 的产品包结构错误。 |

## 4. 产品目标

### 4.1 核心目标

1. 让非开发用户在一套桌面界面内完成 SD 卡数据导入、检查、回放和导出。
2. 让每次本地导入都能提供可复核的完整性证据。
3. 在导出前暴露空流、缺帧、JPEG 解码、状态解析和时间戳问题。
4. 让五路图像和状态曲线在同一帧位置同步查看。
5. 让用户像视频编辑器一样快速选择一段轨迹并预览，然后导出同一段数据。
6. 通过 adapter 降低新增数据格式的成本，并保持各格式语义清晰。
7. 在无网络环境中完成核心工作流。
8. 用本地账号、任务标注和唯一轨迹编码记录数据处理归属，并让三种导出继承同一语义。

### 4.2 成功指标

- 受支持记录的导入完整性错误检出率为 100%。
- 固定抽检位置上的已知损坏 JPEG，以及任意位置的空流、无效状态 JSON 和非单调时间戳均能被交互检查检出；正式全量检查能检出任意位置的已知损坏 JPEG。
- 每个 warning/error 检查结果都有可回读的本地后台报告；ok 不产生无意义报告，整个过程不发起网络请求。
- 标准测试记录能够成功导出三种格式并被各自读取器重新打开。
- 用户从选择源到看到第一条进度反馈不超过 1 秒。
- Windows 10/11 目标机断网时可以完成安装后的完整工作流。
- macOS 12+ Apple Silicon/Intel 目标机可通过签名并 notarized 的 DMG 安装并完成同一离线工作流。
- 现场用户无需命令行脚本即可完成主要任务。
- 相同应用数据目录中不会把一个轨迹编码分配给两个不同 episode；每次标注修订记录当前登录账号。

### 4.3 非目标

- 不直接读取 Windows 无法挂载的 ext4 分区。
- 不提供 SSH、云同步、远程上传或多人协作。
- 不在 SD 卡上修复、重命名、删除或覆盖原始文件。
- 不提供多段拼接、多轨编辑、逐帧标注或训练任务管理；当前标注范围只包含 episode 级任务、描述、轨迹码和处理人。
- 不自动推断机器人 action 或 task 语义；任务由用户从受控目录选择，描述允许人工编辑。
- 不提供云账号、远程身份验证、角色权限、跨机器账号同步或忘记密码服务。
- `v1.0` 不要求同时导入多个 episode，也不要求断点续传。

## 5. 用户与使用场景

### 5.1 主要用户

| 用户 | 目标 | 关注点 |
| --- | --- | --- |
| 采集操作员 | 从 SD 卡安全取出数据并判断采集是否有效 | 简单、进度明确、不能误删源数据 |
| 数据工程师 | 复核数据并转换为分析格式 | 完整性、时间轴、格式可验证 |
| 机器人算法工程师 | 获得可用于工具链或训练的数据 | MCAP/HDF5/LeRobot 兼容性和字段语义 |
| 发布工程师 | 构建和签发 Windows 安装包 | 离线依赖、许可证、可重复构建 |

### 5.2 典型场景

1. 操作员首次使用时创建本地账号，后续启动输入账号和密码登录。
2. 操作员插入 exFAT SD 卡并选择卡根目录，应用扫描记录并自动选择第一条 session。
3. 应用直接请求本地目标目录，随后复制数据并验证目标端文件；不需要再次点击导入按钮。
4. 应用自动运行全量结构/状态检查和固定百分位 JPEG 抽检，并给出通过、警告或失败状态。
5. 用户选择 `close_oven` 等任务，确认自动生成的 `oven-001` 轨迹码，并按需要编辑任务描述后保存；记录包含当前登录用户。
6. 用户在五路画面和状态曲线之间同步定位异常帧，并设置起止帧。
7. 用户选择目标格式和目录，生成继承轨迹码、任务和处理人的数据集并获得输出路径和统计信息。

## 6. 端到端流程与状态

```text
物理 SD 卡
   |
   v
本地注册/登录 -> 选择目录 -> 自动扫描 episode -> 自动选择首条记录 -> 选择本地目录 -> 复制到本地
                                                                    |
                                                                    v
                                                        大小/BLAKE3 回读校验
                                                                    |
                                                                    v
                                                全量结构/状态检查 + JPEG 抽检
                                                  /        \
                                             warning       error
                                                |            |
                                                v            v
                                        回放并允许导出    回放诊断、禁止导出
                                                |
                                                v
                                  任务/描述/轨迹码标注 + 选择闭区间帧范围
                                                |
                                                v
                                      MCAP / HDF5 / LeRobot
```

前台同一时间只允许一个长任务。长任务包括扫描、导入、检查和导出，共享统一进度条和取消入口。

| 状态 | 含义 | 允许操作 |
| --- | --- | --- |
| 未选择 | 没有数据源 | 选择 SD 卡目录 |
| 未登录 | 没有本地登录会话 | 登录或创建本地账号；数据 IPC 不可用 |
| 已扫描 | 已发现 episode，尚未复制 | 首条记录自动进入导入；其他记录可在侧栏选择/双击 |
| 导入中 | 正在复制或回读校验 | 查看进度、取消 |
| 检查中 | 正在全量解析结构/状态并按固定百分位解码图像 | 查看进度、取消 |
| 通过 | 没有 warning/error | 回放、导出 |
| 警告 | 存在可疑但仍可读取的数据 | 回放、确认警告后导出 |
| 失败 | 存在阻断问题 | 回放可用部分、查看问题；不允许正常导出 |
| 导出中 | adapter 正在生成目标数据 | 查看进度、取消 |
| 已导出 | 输出已完成并通过最低回读验证 | 打开输出位置、继续导出其他格式 |

导出范围语义固定为包含 `startFrame` 和 `endFrame` 的闭区间。未设置范围时使用
状态轨迹的首尾非负帧；图像流只取选中状态帧对应的 JPEG。范围外的逐帧 warning/error
不影响本次导出，未绑定帧的全局问题仍然生效。

## 7. 输入数据契约

### 7.1 Episode 目录

一个 episode 目录必须满足以下结构：

```text
episode/
  cam0/{frame_id}.jpg
  cam1/{frame_id}.jpg
  cam2/{frame_id}.jpg
  t265_left/{frame_id}.jpg
  t265_right/{frame_id}.jpg
  states.jsonl
```

规则：

- 五个流名称固定为 `cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`。
- JPEG 文件名的 stem 是十进制 `frame_id`。
- Episode 可以是用户选择的目录本身，也可以是所选目录的直接子目录。
- `v1.0` 不递归发现多层嵌套 episode。
- 扫描时不得跟随符号链接。
- 记录器应使用 `YYYY-MM-DD_HH-MM-SS` 目录名，不能使用 Windows 保留字符。

### 7.2 状态记录

`states.jsonl` 每个非空行是一条 JSON 记录：

```json
{
  "frame_id": 0,
  "capture_time_ns": 1783928052087173494,
  "position": [0.0, 0.0, 0.0],
  "velocity": [0.0, 0.0, 0.0],
  "quaternion": [0.0, 0.0, 0.0, 1.0],
  "euler": [0.0, 0.0, 0.0],
  "omega": [0.0, 0.0, 0.0],
  "confidence": 0.0
}
```

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `frame_id` | int64 | 非负，正常情况下连续递增 |
| `capture_time_ns` | int64 | 纳秒时间，严格递增 |
| `position` | float64[3] | 所有值有限 |
| `velocity` | float64[3] | 所有值有限 |
| `quaternion` | float64[4] | 所有值有限 |
| `euler` | float64[3] | 所有值有限 |
| `omega` | float64[3] | 所有值有限 |
| `confidence` | float64 | 有限值 |

`capture_time_ns` 大于 JavaScript 安全整数范围。Rust 向前端传输时必须序列化为十进制字符串，前端不得先转换为 `number`。

### 7.3 已知样例基线

本地私有样例位于 `data/raw/2026-07-13_07-34-12`，不进入 Git：

- 981 个文件，80,531,730 字节。
- 196 条状态记录。
- 每个图像流 196 帧。
- `cam0` 为 1920x1080 RGB。
- `cam1`、`cam2` 为 1280x720 RGB。
- `t265_left`、`t265_right` 为 848x800 灰度图。
- 没有缺帧和 JPEG 解码失败。
- 帧 180-195 存在 170-369 ms 的状态时间间隔，基准中位数为 33.9 ms，因此预期得到 `TIMESTAMP_GAP` warning。

## 8. 功能需求

优先级定义：P0 为首发阻断，P1 为首发后高优先级，P2 为候选需求。

### 8.1 数据源与扫描

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-SRC-001 | P0 | 用户可以选择物理 SD 卡挂载目录或本地测试目录。 | 仅接受本机目录路径，不出现 URL/SSH 输入。 | 已实现 |
| FR-SRC-002 | P0 | 扫描目录本身及其直接子目录中的 episode。 | 至少含 `states.jsonl` 或一个已知流目录时可被发现。 | 已实现 |
| FR-SRC-003 | P0 | 展示 episode 名称、文件数、总大小、状态数和五路流概况。 | 侧栏可以比较多个 episode。 | 已实现 |
| FR-SRC-004 | P0 | 扫描过程可见且可取消。 | 显示阶段、路径、计数/字节和耗时；取消后不开始导入。 | 已实现 |
| FR-SRC-005 | P0 | 源目录在整个应用流程中只读。 | 自动化测试和代码审查确认没有对源路径执行写入、重命名或删除。 | 已通过只读虚拟 ExFAT 全链路；实卡 hash 仍为发布门槛 |
| FR-SRC-006 | P1 | 明确显示卷类型、可移动介质状态和可用容量。 | UI 可以区分 SD 卡与普通本地目录。 | Windows/macOS 已实现，虚拟 ExFAT 识别通过；待实机验收 |
| FR-SRC-007 | P0 | 左侧 episode 列表只负责 session 选择和进入回放。 | 单击只更新选中项，不切换主工作区；双击未加载项时执行本地导入与检查后进入回放，双击已加载项时直接进入回放；导入后的选中高亮仍绑定源 session。 | 已实现并通过三视口交互检查 |
| FR-SRC-008 | P0 | 选择 SD 卡目录后自动加载第一条 session。 | 扫描成功后直接打开本地目标目录对话框并继续导入、检查和回放；界面没有额外“导入并检查”按钮。 | 已实现 |

### 8.2 本地导入与完整性

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-IMP-001 | P0 | 用户选择本地目标目录后才开始复制。 | 未选择或取消目录时不产生输出。 | 已实现 |
| FR-IMP-002 | P0 | 文件按稳定相对路径顺序复制。 | 相同输入产生相同 manifest 和数据集哈希。 | 已实现 |
| FR-IMP-003 | P0 | 复制时计算每个源文件的 BLAKE3。 | Manifest 包含相对路径、大小和 64 个十六进制字符的 BLAKE3 文本。 | 已实现 |
| FR-IMP-004 | P0 | 复制后重新打开目标文件，校验大小和 BLAKE3。 | 任一不一致立即失败，不发布最终目录。 | 已实现并测试 |
| FR-IMP-005 | P0 | 成功后写入 `.dohc-manifest.json`。 | Manifest 含格式版本、源名称、总文件数、总字节、数据集 BLAKE3 和文件列表。 | 已实现 |
| FR-IMP-006 | P0 | 最终目录通过同文件系统原子重命名发布。 | 处理中仅存在 `.partial-*`；成功后才出现正式目录。 | 已实现 |
| FR-IMP-007 | P0 | 不覆盖已有目录。 | 名称冲突时使用 `_2`、`_3` 等确定性后缀。 | 已实现 |
| FR-IMP-008 | P0 | 非法 Windows 文件名被安全转换。 | 冒号、斜杠、控制字符和保留设备名均被处理。 | 已实现 |
| FR-IMP-009 | P0 | 导入前检查目标剩余空间和文件系统能力。 | 空间不足或不支持大文件时，在复制前阻止任务。 | 已实现 |
| FR-IMP-010 | P1 | 取消/失败的 partial 目录可被识别和清理。 | 下次启动可提示清理，不会把 partial 当作 episode。 | 已实现 |

Manifest `formatVersion=2`。每个文件的 `sourcePath` 保存 UTF-8 原始相对路径，`path` 保存逐组件清理后的 Windows 安全目标相对路径；若清理或大小写折叠后发生碰撞，必须在复制前阻止导入。数据集 BLAKE3 的输入序列定义为：对按原始 `sourcePath` 排序的每个文件依次写入 UTF-8 原始相对路径、单个 `0x00`、小端 `u64` 文件大小、该文件 BLAKE3 的 ASCII 十六进制文本。

### 8.3 数据健康检查

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-VAL-001 | P0 | 解析 `states.jsonl` 每个非空行。 | 无效 JSON、缺字段或类型不符产生 error。 | 已实现 |
| FR-VAL-002 | P0 | 检查状态中的 NaN/Infinity。 | 任一非有限值产生 error。 | 已实现 |
| FR-VAL-003 | P0 | 检查状态帧号和时间戳顺序。 | 帧号跳变为 warning；非单调时间戳为 error。 | 已实现 |
| FR-VAL-004 | P0 | 检测明显时间戳间隔异常。 | 正 delta 的中位数存在时，超过中位数 3 倍产生 warning。 | 已实现 |
| FR-VAL-005 | P0 | 检查五路图像是否为空。 | 流目录缺失或零帧产生 error。 | 已实现 |
| FR-VAL-006 | P0 | 检查图像 frame ID 连续性。 | 首尾范围内缺失位置产生 warning，并报告数量。 | 已实现 |
| FR-VAL-007 | P0 | 交互检查按排序后帧序列的 `1% / 25% / 50% / 73% / 99%` 固定位置解码 JPEG；正式压力/发布检查解码全部 JPEG。 | 小于五帧时百分位去重；抽检或全量模式中无法解码的帧产生 error，并记录 stream/frame。 | 已实现并测试 |
| FR-VAL-008 | P0 | 检查被解码 JPEG 与该流首帧 header 尺寸是否一致。 | 交互模式覆盖五个固定抽检位置，正式模式覆盖全量；不一致产生 error。 | 已实现并测试 |
| FR-VAL-009 | P0 | 对比图像帧数和状态条数。 | 数量不一致产生 warning。 | 已实现 |
| FR-VAL-010 | P0 | 提供汇总与逐问题视图。 | 每项明确显示错误/警告/通过，按错误、警告、通过排序；展示已检查文件数、耗时、各流总帧、实际抽检/检查帧数、解码失败数和 issue code。 | 已实现 |
| FR-VAL-011 | P0 | error 在 UI 和 Rust 导出入口形成双重阻断。 | 不能通过直接调用 IPC 绕过检查。 | 已实现并测试 |
| FR-VAL-012 | P1 | 导出机器可读检查报告。 | 检查页使用“导出报告”操作，可生成包含版本、图像检查模式/百分位、issue 和统计的 JSON 文件。 | 已实现并测试 |
| FR-VAL-013 | P0 | warning/error 在检查完成后自动生成本地后台报告。 | 写入应用 local-data 的 `reports` 目录，原子发布并回读；相同 episode 路径、指纹和报告版本只保留一份，ok 不生成，任一失败不得伪装成已汇报。 | 已实现并测试 |

Issue code 和严重级别：

| Code | 严重级别 | 含义 |
| --- | --- | --- |
| `MISSING_STATES` | error | 缺少 `states.jsonl` |
| `EMPTY_STATES` | error | 没有有效状态记录 |
| `EMPTY_STATE_LINE` | warning | JSONL 中存在空行 |
| `INVALID_STATE_JSON` | error | 状态行无法解析 |
| `INVALID_FRAME_ID` | error | 状态 `frame_id` 为负数 |
| `INVALID_TIMESTAMP` | error | 状态 `capture_time_ns` 为负数 |
| `NON_FINITE_STATE` | error | 状态包含非有限数值 |
| `STATE_FRAME_GAP` | warning | 状态 frame ID 不连续 |
| `TIMESTAMP_NOT_MONOTONIC` | error | 状态时间戳没有递增 |
| `TIMESTAMP_GAP` | warning | 时间间隔超过中位数 3 倍 |
| `EMPTY_STREAM` | error | 图像流为空或缺失 |
| `INVALID_FRAME_FILENAME` | error | JPEG 文件名不能映射为非负十进制帧号 |
| `DUPLICATE_FRAME_ID` | error | 多个 JPEG 文件名映射到同一帧号 |
| `MISSING_FRAMES` | warning | 图像 frame ID 范围内缺帧 |
| `FRAME_ID_MISMATCH` | error | 数量相同时图像和状态 frame ID 集合不一致 |
| `DECODE_FAILED` | error | JPEG 无法解码 |
| `DIMENSION_MISMATCH` | error | 同一流帧尺寸不一致 |
| `COUNT_MISMATCH` | warning | 图像帧数与状态数不一致 |

机器可读报告使用 `formatVersion=3`，包含 `episodeRoot`、`parsedStateCount`、`imageValidationMode`（`sampled` 或 `full`）、`imageSamplePercentages`、`autoReportPath`、文件/流统计和完整 issue 列表。每个流的 `checkedFrames` 是实际解码数；抽检报告固定记录 `[1,25,50,73,99]`，全量报告记录空数组。可定位的 issue 附带可选 `frameId`。报告先写入隐藏 partial 文件并回读验证，再原子发布，同名时不覆盖。抽检报告不代表未抽中 JPEG 已通过解码检查。

后台报告保持离线：Windows 写入 Tauri `appLocalData/com.dohc.viewer/reports`，macOS 对应 `~/Library/Application Support/com.dohc.viewer/reports`。文件名由 Windows 安全的 episode 名、报告版本，以及 episode 路径与数据指纹的 BLAKE3 派生 ID 组成。`autoReportPath` 在 warning/error 报告中记录最终普通文件路径，在 ok 报告中为 `null`。

### 8.4 数据回放与可视化

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-VIS-001 | P0 | 同时显示五路相同 `frame_id` 的图像。 | 拖动或步进后五路同步更新，流名称和分辨率可见。 | 已实现 |
| FR-VIS-002 | P0 | 提供播放、暂停、上一帧、下一帧、时间轴和速度选择。 | 支持 0.25x、0.5x、1x、2x。 | 已实现 |
| FR-VIS-003 | P0 | 显示当前帧相对起始状态的时间。 | 使用 `BigInt` 计算纳秒差，避免精度丢失。 | 已实现 |
| FR-VIS-004 | P0 | 绘制位置、速度、欧拉角和角速度曲线。 | 当前帧在曲线上有明确定位，三个轴可区分。 | 已实现 |
| FR-VIS-005 | P0 | 不可用帧显示明确错误状态。 | 不显示上一帧冒充当前帧。 | 已实现 |
| FR-VIS-006 | P0 | UI 适配 960x680 以上桌面窗口。 | 无控件重叠和横向溢出。 | 已验证 |
| FR-VIS-007 | P1 | 播放速率根据记录 FPS 而非固定 30 FPS。 | 从状态时间戳估计并允许用户覆盖。 | 已实现 |
| FR-VIS-008 | P1 | 支持按 issue 跳转到相关帧。 | 点击解码、缺帧或时间问题可定位时间轴。 | 已实现 |
| FR-VIS-009 | P0 | 提供单条轨迹的起止帧裁剪控件。 | 起点/终点滑块、数字输入、按当前帧标记和重置均可用；起点不晚于终点。 | 已实现 |
| FR-VIS-010 | P0 | 回放和时间轴遵循选中裁剪范围。 | 播放从起点开始并在终点停止，画面、曲线和片段状态数保持一致。 | 已实现 |

### 8.5 数据导出

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-EXP-001 | P0 | 用户选择 MCAP、HDF5 或 LeRobot v2.1 adapter。 | 格式选择、目标目录和完成结果清晰可见。 | 已实现 |
| FR-EXP-002 | P0 | warning 可以导出，error 必须阻止。 | warning 明确显示；发布版要求用户确认。 | 已实现并测试 |
| FR-EXP-003 | P0 | 输出不覆盖已有文件或目录。 | 冲突时追加确定性后缀。 | 已实现 |
| FR-EXP-004 | P0 | 输出先写入隐藏 partial，再原子发布。 | 失败输出不使用正式名称。 | 已实现 |
| FR-EXP-005 | P0 | 长导出可显示进度和取消。 | adapter 定期检查取消标志并更新统一进度事件。 | 已实现 |
| FR-EXP-006 | P0 | 每种格式完成后进行最低回读验证。 | MCAP summary、HDF5 dataset、LeRobot 元数据/Parquet/视频存在性通过测试。 | 已实现并测试 |
| FR-EXP-007 | P1 | 导出完成后可在资源管理器中打开位置。 | 一次点击打开输出父目录并选中结果。 | 已实现 |
| FR-EXP-008 | P0 | 三种 adapter 都支持同一闭区间帧范围。 | 输出只包含选中状态和对应五路图像；结果返回范围与状态条数。 | 已实现并测试 |
| FR-EXP-009 | P0 | 裁剪范围内独立执行导出门禁。 | 范围外逐帧 issue 不阻断；范围内或全局 error 仍阻断，warning 仍需确认。 | 已实现并测试 |
| FR-EXP-010 | P1 | 已标注 episode 的三个 adapter 使用统一轨迹码和标注元数据。 | 输出基础名称使用轨迹码；MCAP、HDF5、LeRobot 保存任务/处理人，未标注数据兼容原名称。 | 已实现并测试 |

#### 8.5.1 MCAP 契约

- 输出为单个 `.mcap` 文件。
- `/dohc/state`：`json` 编码，使用 `dohc.State` JSON Schema，保留完整原始状态字段。
- `/dohc/pose`：`protobuf` 编码，schema 为官方 `foxglove.PoseInFrame`，由 position/quaternion 映射机器人位姿。
- `/dohc/camera/{stream}`：`protobuf` 编码，schema 为官方 `foxglove.CompressedImage`，`format=jpeg`，`data` 为原始 JPEG。
- 消息 `log_time` 和 `publish_time` 使用原始 `capture_time_ns`。
- Foxglove protobuf 的 `Timestamp` 与图像/位姿消息使用同一 capture time；`frame_id` 分别为 `dohc_base` 和流名。
- 五个图像 channel 的 metadata 包含 `mime_type`、`width` 和 `height`。
- 数据集 metadata 包含源名称、状态条数和 `clip_start_frame`/`clip_end_frame`；存在标注时增加轨迹码、任务 ID/描述和处理人账号/显示名。
- 文件必须能被 Foxglove Desktop 打开；Image panel 可选择五路图像，3D panel 可选择 `/dohc/pose`，Raw/Plot panel 可读取 `/dohc/state`。

#### 8.5.2 HDF5 契约

- 输出为单个 `.h5` 文件，根属性包括 `format=dohc-hdf5`、`format_version=1` 和 `source_name`。
- 根属性同时保存 `clip_start_frame` 和 `clip_end_frame`。
- 存在标注时，根属性保存 `trajectory_code`、`task_id`、`processed_by_username`；`/annotation` 以 UTF-8 字节 dataset 保存任务描述和处理人显示名。
- `/states` 包含 `frame_id`、`capture_time_ns`、`position`、`velocity`、`quaternion`、`euler`、`omega` 和 `confidence`。
- `/images/{stream}` 包含 `jpeg_data`、`offsets`、`sizes` 和 `frame_id`。
- 图像 group 属性包含 `mime_type=image/jpeg`、`width` 和 `height`。
- 使用纯 Rust HDF5 实现，Windows 运行时不得依赖额外 HDF5 DLL。
- `jpeg_data` 使用固定 1 MiB、无压缩 chunk；writer 根据每帧路径和长度跨文件读取，每次只持有一个 payload chunk，不暂存完整图像流。
- 取消在 chunk 读取循环内检查；源文件长度变化或读取失败时不得发布正式文件，并清理本次创建的 partial 文件。
- 100 GiB 逻辑 staging 测试和标准样例回读已经通过，但第 9.1 节真实 100 GB/100,000 文件压力测试仍是发布门槛。

#### 8.5.3 LeRobot v2.1 契约

- 输出是 `{episode}_lerobot_v2/` 目录。
- 数据文件为 `data/chunk-000/episode_000000.parquet`，使用 Snappy。
- 每个流生成 `videos/chunk-000/observation.images.{stream}/episode_000000.mp4`。
- Meta 包含 `info.json`、`tasks.jsonl`、`episodes.jsonl`、`stats.json` 和 `episodes_stats.jsonl`。
- 存在标注时，`tasks.jsonl`/`episodes.jsonl` 使用可编辑任务描述，`info.json.dohc_annotation` 保存轨迹码、任务、处理人和修订号。
- `codebase_version` 固定为 `v2.1`。
- `info.json` 保存 `clip_start_frame`、`clip_end_frame`；裁剪输出目录名包含
  `_frames_START-END`，完整导出保持原有目录名。
- 标准 `timestamp` 使用 `frame_index / fps`，与恒定帧率 MP4 对齐。
- 原始纳秒时间保存在 `observation.capture_time_ns`，类型为 int64。
- 原始状态映射为 observation；不得生成虚构的 action。
- FPS 从正时间差的中位数估算，并在 5% 内吸附到常见帧率；标准样例应得到 30 FPS。
- FFmpeg 查找顺序为 `DOHC_FFMPEG`、应用资源目录、系统 PATH。Windows 发布版必须命中应用资源目录。

### 8.6 本地账号与数据标注

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-AUTH-001 | P0 | 首次启动可创建本地账号，后续可登录和退出。 | 账号为 3-32 位安全字符；密码 8-128 字符，磁盘只保存 Argon2id PHC 哈希，不保存明文。 | 已实现并测试 |
| FR-AUTH-002 | P0 | 数据工作区和数据 IPC 要求有效进程内会话。 | 未登录直接调用扫描、导入、加载、检查、读帧或导出均返回 `AUTH_REQUIRED`；重启后需重新登录。 | 已实现 |
| FR-ANN-001 | P0 | 回放首页提供任务、任务描述、轨迹码和处理人标注。 | 选择 `close_oven` 自动带出“关闭烤箱门，并确认烤箱门完全闭合。”；描述可编辑。 | 已实现并通过三视口检查 |
| FR-ANN-002 | P0 | 轨迹码使用任务前缀和至少三位序号。 | `close_oven` 使用 `oven-001`、`oven-002`；后端规范化校验并以原子占号防止跨 episode 重复。 | 已实现并测试 |
| FR-ANN-003 | P0 | 标注记录数据身份、处理人和修订历史。 | 绑定规范化 episode 路径与指纹；每次保存追加不可覆盖的修订文件，记录账号和时间；不写 SD 卡/episode。 | 已实现并测试 |

账号文件位于 Tauri `appLocalData/accounts`，轨迹占号位于 `appLocalData/trajectory-codes`，标注修订位于 `appLocalData/annotations/{episodeId}`。本地账号只提供处理归因，不提供文件加密、操作系统用户隔离或企业权限管理。任意拥有该计算机文件权限的人仍可能访问应用数据目录。

初始任务目录：

| Task ID | 显示名 | 编码前缀 | 默认描述 |
| --- | --- | --- | --- |
| `close_oven` | 关闭烤箱 | `oven` | 关闭烤箱门，并确认烤箱门完全闭合。 |

### 8.7 任务进度与错误处理

统一进度事件 `task-progress` 必须包含：

```text
task, phase, current, total, bytesDone, totalBytes, currentPath, elapsedMs
```

要求：

- 前端根据字节或计数计算 0-100% 进度。
- 任务必须在数据块或有限帧间隔内检查取消状态。
- 取消不得产生已发布的最终目录或文件。
- partial 路径必须有唯一 nonce，不能与正常 episode 混淆。
- 错误消息应包含失败对象和原因，但不得把任意文件内容写入日志。
- `v1.0` 只支持一个前台长任务，不支持并行导入/检查/导出。

## 9. 非功能需求

### 9.1 性能

| 编号 | 要求 |
| --- | --- |
| NFR-PERF-001 | 文件 IO、JPEG 解码、哈希和导出必须在 Rust blocking worker 中执行，不阻塞 WebView UI 线程。 |
| NFR-PERF-002 | 选择有效源后 1 秒内显示扫描状态或首条进度。 |
| NFR-PERF-003 | 导入复制阶段吞吐应达到同一设备/目标直接系统复制基线的 70% 以上；完整导入另含目标回读成本。 |
| NFR-PERF-004 | 取消操作在当前 1 MiB 复制块、当前检查帧或 adapter 的下一个安全点内生效，目标体验不超过 1 秒。 |
| NFR-PERF-005 | 标准五路样例在 1x 下目标为 30 FPS，连续 60 秒丢帧率低于 1%，拖动时间轴后 300 ms 内更新首批画面。 |
| NFR-PERF-006 | Windows 发布前必须用至少 100 GB/100,000 文件记录做扫描、导入、检查和每种导出的压力测试。 |
| NFR-PERF-007 | 内存不得随 JPEG 总数据量无界增长；大数据 HDF5 导出若超过内存门槛必须改为流式写入。 |
| NFR-PERF-008 | 选择裁剪范围只建立状态/帧索引，不复制或重编码源 JPEG；回放期间不得因当前帧变化重复扫描全量状态。 |

### 9.2 可靠性与数据安全

- 源路径只读，任何写入只能发生在用户选择的本地目标或导出目录。
- 所有完整输出使用 partial + 同文件系统原子 rename 发布。
- 发布操作在 Windows/macOS/Linux 均使用原子 no-replace 语义，不覆盖用户已有文件。
- 原始时间戳和数值数据不得静默修复；规范化字段必须保留原始字段。
- 完整性失败必须阻断最终导入目录发布。
- 应用退出或断电后，正式目录应是完整版本；partial 可清理但不可当作成功结果。

### 9.3 兼容性

- 正式安装包支持 Windows 10/11 x64、macOS 12+ arm64 和 macOS 12+ x64。
- 安装器必须在 Windows 10 以下系统中停止安装。
- Windows 安装包使用 NSIS current-user 模式，不要求管理员权限作为默认路径。
- Windows 安装包包含离线 WebView2 安装器。
- macOS 支持依赖 exFAT 等系统可读文件系统，不提供 ext4 驱动。
- 源 SD 卡推荐 exFAT；本地目标推荐 NTFS。FAT32 因 4 GB 单文件限制不作为受支持导出目标。

### 9.4 离线、安全与隐私

- 核心功能不得发起网络请求。
- 不收集遥测，不上传路径、图像、状态或 hash。
- 本地账号密码使用 Argon2id 和操作系统 CSPRNG 盐；密码、盐和标注均不通过网络传输。
- 账号与标注文件使用当前用户可写的应用 local-data；Unix 新文件权限为 `0600`，Windows 继承当前用户目录 ACL。
- 文件选择仅由原生目录对话框触发。
- Tauri capability 只开放核心窗口和目录对话框需要的权限。
- Windows/macOS 发布依赖必须锁定版本并完成许可证审查；构建阶段访问依赖和签名服务不改变安装后核心功能的离线边界。

### 9.5 可维护性

- Rust 和 TypeScript 共享的字段必须有显式类型和 camelCase 序列化约定。
- 每种导出格式必须独立 adapter，不在 UI 中实现格式细节。
- 新 adapter 必须包含真实数据 smoke test 和回读验证。
- 错误、issue code 和 manifest 版本必须保持向后兼容；破坏性变更需要增加版本。
- `Cargo.lock` 和 `pnpm-lock.yaml` 必须提交。

## 10. UI 信息架构

### 10.1 全局区域

- 视觉系统：界面背景、控件、选中态、状态和 telemetry 曲线使用中性灰阶；相机画面保持原始颜色，不应用灰度滤镜。
- 顶栏：产品名、当前源路径、健康状态、选择 SD 卡、当前登录账号和退出按钮；选择后自动继续扫描、首条 session 导入与检查，不提供单独导入按钮。
- 任务条：当前阶段、路径、进度、吞吐/耗时、取消按钮。
- 左侧栏：episode 列表、选中状态、文件数、容量和五路存在状态；单击选择，双击进入回放。
- 主工作区：回放、检查、导出三个 tab。

### 10.2 回放页

- `cam0` 为主要大画面，其余四路排列在右侧或窄屏网格中。
- 页面顶部是 episode 级数据标注：左侧任务/轨迹码/处理人，右侧自动带出的可编辑任务描述和保存状态。
- 画面必须使用稳定尺寸，加载、错误和帧变化不能引发布局跳动。
- 时间轴控制位于画面下方，状态曲线位于同页后半部分。
- 时间裁剪工具显示选中起止帧、片段状态数和时长；提供双范围滑块、数字输入、
  “当前帧设为起点/终点”和重置完整轨迹操作。起止选择使用闭区间。

### 10.3 检查页

- 顶部显示总状态、已检查文件、耗时和本地后台报告状态；手动操作命名为“导出报告”。
- 每个流和 `states.jsonl` 显示总帧、实际抽检/检查帧数、解码失败和错误/警告/通过结果；按错误、警告、通过排序，抽检列提示固定百分位。
- Issue 列表按错误、警告排序，明确显示严重级别、scope、中文消息和稳定 code。

### 10.4 导出页

- 显示轨迹码（未标注时为源记录名）、任务、选中帧范围/状态数/时长、三种格式单选、当前 adapter 和导出命令。
- 当前范围存在 error 时禁用导出并说明原因。
- 完成后显示输出路径、文件数、大小和耗时。

## 11. 文件系统与 exFAT 约束

exFAT 可以解决未来 SD 卡在 Windows/macOS 间直接挂载的问题，但不等于把当前 ext4 数据原地转换为 exFAT：

1. 当前 ext4 数据必须先复制并验证。
2. 格式化为 exFAT 会清空卡。
3. 采集设备必须验证 exFAT 驱动、单文件大小、长时写入和异常断电行为。
4. exFAT 不带日志，不能把文件系统可挂载等同于数据一定完整。
5. 记录器必须停止使用冒号等 Windows 非法字符。

exFAT 上线测试至少包括：连续写入目标最长记录时长、接近满盘、突然断电、重新插拔、Win10/Win11/macOS 挂载、单文件超过 4 GB，以及 DOHC Viewer 完整导入和 hash 对比。

## 12. 发布与安装

### 12.1 Windows 包要求

- 在 Windows x64 构建机执行正式构建。
- 使用 `scripts/stage-ffmpeg.ps1` 放置审核过的 `ffmpeg.exe`。
- 附带对应 FFmpeg 和编码器许可证文本。
- 生成离线 NSIS 安装包。
- 当前 GitHub Release 允许 unsigned NSIS，但文件名、Release 和报告必须明确标记，且必须确认应用、installer 和 uninstaller 没有被误报为可信签名。
- 生产签名阶段仍需完成 Authenticode 和可信时间戳；证书不进入仓库，并使用新版本/tag 发布。
- 在干净的 Win10 和 Win11 虚拟机断网安装并执行 smoke test。

### 12.2 macOS 包要求

- 最低系统版本固定为 macOS 12.0，分别生成 arm64 和 x64 DMG，不把单架构产物命名为 universal。
- 可分发 app/DMG 必须使用只依赖 macOS 系统库的 reviewed FFmpeg；当前从固定 archive hash 和 commit 的 FFmpeg 8.1.2 官方源码构建最小 LGPL sidecar，Homebrew 动态链接版本只能标记为 local-debug。
- DMG 必须只读挂载验证 app、`/Applications` 链接、版本、架构和 FFmpeg 资源 hash，再将 app 复制到本地目录执行启动 smoke。
- 当前 GitHub Release 允许没有可信发布者身份的 unsigned DMG，但 app、主程序和 FFmpeg 必须使用本地 ad-hoc seal，并通过 `codesign --verify --deep --strict`；文件名、Release 和报告必须明确标记，且不得宣称 Developer ID 或 notarization 已通过。
- 复制后的 app 必须添加 synthetic quarantine；`syspolicy_check distribution` 正常应因 ad-hoc identity 和 missing notary ticket 拒绝。若 runner 返回内部 XProtect 错误，只有现场构建的最小 ad-hoc control app 得到相同结果时才能记录为 policy service unavailable；产品独有的 XProtect 错误、invalid signature、missing resources、damaged 或其他结构问题一律阻止发布。用户首次启动仍需通过系统设置执行一次性“仍要打开”。
- 生产签名阶段仍需让 app/FFmpeg 完成 Developer ID Application 签名和 secure timestamp，并完成 Apple notarization/stapling；证书和 Apple 凭据不进入仓库，签名产物使用新版本/tag 发布。
- GitHub hosted runner 通过后仍需在目标 Apple Silicon/Intel Mac 验收。

### 12.3 正式 CD 与 GitHub Release

- `.github/workflows/release.yml` 只接受已经存在的 annotated `vX.Y.Z` tag，并核对 HEAD、clean checkout、Changelog 和四处应用版本。
- Windows x64、macOS arm64、macOS x64 使用原生 hosted runner 构建；Node、pnpm、Rust 和全部 GitHub Actions 固定版本或 commit。
- Windows 固定 reviewed FFmpeg binary/license/build notice 与 WebView2 exact Microsoft URL/SHA-256；macOS 从固定官方 FFmpeg source archive hash/Git revision 构建两个原生架构。
- Windows 检查 DOHC 产物为 unsigned、Microsoft WebView2 签名、NSIS 内嵌 hash、silent install/startup/uninstall；macOS 检查 ad-hoc sealed nested code/resources、没有 Developer ID/notarization claim、DMG 挂载、资源 hash、synthetic-quarantine Gatekeeper 分类和复制后直接启动。
- Release 标题、说明、三个 installer 名称、verification report 和 manifest 必须显示 `UNSIGNED`；后续引入签名时恢复 Authenticode、timestamp、Developer ID、Gatekeeper 和 notarization 门禁。
- final job 重新核对三份 verification report 和安装器 SHA-256，生成 `release-manifest.json`、`SHA256SUMS.txt` 和 GitHub provenance。三平台集合完整后才解除 draft，已经公开的 tag 不允许覆盖。
- GitHub hosted runner smoke 不是 Win10/Win11 断网、目标 Mac、真实 SD 卡或 100 GB 实盘验收的替代品。

### 12.4 版本管理

- `package.json`、`Cargo.toml` 和 `tauri.conf.json` 版本必须一致。
- Manifest `format_version`、HDF5 `format_version` 和产品 semver 独立管理。
- LeRobot `codebase_version` 明确固定为 v2.1，升级需要新 adapter 行为和兼容性测试。

### 12.5 可重复验证与依赖证据

- 快速检查必须统一执行前端 production build、Rust format、Clippy warnings-as-errors 和常规 Rust tests。
- 完整检查必须额外运行真实样例导入/hash、健康检查、三个 adapter 生成与内部回读，以及 Tauri debug application build。
- 每次检查必须生成 schemaVersion=1 的本机 JSON 报告，记录应用版本、Git 状态、工具版本、各命令 exit code 和耗时；报告和本地构建产物不进入 Git。
- FFmpeg staging 必须在复制前验证期望 SHA-256、目标架构、`mpeg4` encoder、非 `--enable-nonfree` 构建、HTTPS 来源、build ID 和许可证输入。
- bundle 必须包含 FFmpeg 二进制、合并许可证和 provenance manifest，并在构建前回读 hash；标记为非可移植的依赖只能进入显式 local-debug 包。
- unsigned debug bundle 只证明本机构建和资源布局；unsigned GitHub Release 还必须通过三平台 CI 安装或挂载、直接启动、依赖和完整集合门禁，但两者都不能替代生产签名和目标机器验收。
- 大容量验收必须由 `stress-check` 统一执行扫描、取消探针、verified import、完整检查、三格式生成/回读和源端 BLAKE3 复核，并原子生成 schemaVersion=1 JSON 报告。
- formal 报告必须记录 release profile、clean exact tag、源/工作卷、100 GB/100,000 文件阈值、FFmpeg BLAKE3、阶段耗时/吞吐/峰值 RSS、取消延迟、输出大小以及源前后 hash；`formal:false` 只能作为开发证据。
- 非 Windows 宿主的 MSVC 预检必须使用同一 rustup toolchain 的 Cargo/Rustc、显式 `x86_64-pc-windows-msvc` target 和 `llvm-rc`，编译 `--all-targets` 并生成报告；报告必须明确 `linksExecutable:false`、`buildsInstaller:false`、`runsOnWindows:false`。
- macOS 虚拟 ExFAT smoke 必须在写入 fixture 后只读重挂载源卷，验证 ExFAT/只读/独立工作卷、完整 stress 结果和安全清理；报告必须明确 `physicalSdCard:false`、`formalStress:false`，不能关闭 GAP-003/GAP-007。

## 13. 验收测试

| 编号 | 场景 | 预期结果 |
| --- | --- | --- |
| AT-001 | 选择包含标准 episode 的 SD 卡根目录 | 正确发现记录并显示五路、196 状态和容量，自动打开本地目标选择并继续首条 session 的导入/检查 |
| AT-002 | 导入标准样例 | 981 个文件、80,531,730 字节校验通过，生成 format-v2 manifest 和稳定数据集 BLAKE3 |
| AT-003 | 修改目标副本中任意一个字节 | BLAKE3 回读失败，不发布正式目录 |
| AT-004 | 删除一个流目录 | `EMPTY_STREAM` error，禁止导出 |
| AT-005 | 删除中间 JPEG | `MISSING_FRAMES` warning，问题可见 |
| AT-006 | 在任一固定百分位抽检位置使用截断或随机字节 JPEG | 交互检查产生 `DECODE_FAILED` error，并定位流和帧 |
| AT-007 | 写入无效 JSON/NaN/非单调时间戳 | 对应 error 被报告 |
| AT-008 | 加载标准样例 | 五路 frame 0 同步显示，曲线可切换，时间轴可播放/步进 |
| AT-009 | 标准样例的末尾时间间隔异常 | 得到 `TIMESTAMP_GAP` warning，不被静默修复 |
| AT-010 | 导出 MCAP | 7 个 channel、3 个 schema 可被 MCAP reader 读取；官方 Foxglove protobuf 消息逐条解码，输出可在 Foxglove Image/3D/Raw/Plot panel 选择 |
| AT-011 | 导出 HDF5 | 状态/帧索引 shape 为 196，`jpeg_data` 字节 shape、offset/size 末端和首末 frame ID 回读一致 |
| AT-012 | 导出 LeRobot v2.1 | `fps=30`，Parquet 196 行，包含原始纳秒字段，五个 MP4 非空 |
| AT-013 | 目标输出重名 | 生成后缀名称，不覆盖原文件 |
| AT-014 | 复制、检查或导出时取消 | 没有正式输出；partial 不会出现在正常记录列表 |
| AT-015 | 断网的干净 Win10/Win11 机器 | 安装、启动、导入、检查、回放和三种导出均可完成 |
| AT-016 | 1440x920、960x680 桌面视口 | 无重叠、横向溢出或不可见操作 |
| AT-017 | 导入含非法/大小写冲突路径的记录 | 安全路径写入 manifest；任何目标路径碰撞在复制前阻止 |
| AT-018 | clean exact tag 上运行 exFAT 100 GB/100,000 文件 formal stress | 源/工作卷不同，取消不超过 1 秒，无 error，三格式回读通过，源端 BLAKE3 前后相同并生成 passed JSON 报告 |
| AT-019 | macOS 执行 Windows x64 MSVC all-target compile check | 条件源码通过，报告明确未链接、未打包、未在 Windows 运行 |
| AT-020 | macOS 从只读虚拟 ExFAT 卷执行开发样例完整链路 | 卷/只读/独立工作盘、取消、导入、检查、三导出回读、源 hash 和 marker 清理全部通过；报告不冒充实卡证据 |
| AT-021 | 将标准样例裁剪为帧 10-19 后导出三种格式 | MCAP/HDF5/LeRobot 均只含 10 条状态和对应五路图像；输出名称/metadata 记录范围，源目录 hash 不变 |
| AT-022 | 选中范围外存在逐帧 warning/error | 范围外 issue 不阻断本次导出；范围内或全局 issue 仍按 error hard gate/warning acknowledgement 处理 |
| AT-023 | 损坏 JPEG 只位于五个固定抽检位置之外，再运行正式全量检查 | 交互报告明确标记 `sampled` 且不声称覆盖该帧；正式 `full` 报告产生 `DECODE_FAILED` |
| AT-024 | 分别检查 warning、error、ok 数据并重复检查 warning 数据 | warning/error 在应用 local-data 自动生成 format-v3 报告，重复检查复用同一路径且源指纹不变；ok 不生成；检查页按错误/警告/通过排序并显示后台报告状态 |
| AT-025 | 首次创建账号、错误密码登录、正确登录、退出后直接调用数据 IPC | 密码文件不含明文；错误密码拒绝；正确登录成功；退出后数据 IPC 返回 `AUTH_REQUIRED` |
| AT-026 | 两个 episode 选择 `close_oven` 并保存，第一条再由另一账号编辑描述 | 依次得到 `oven-001`/`oven-002` 且不能复用；修订历史保留两个处理人；三种导出以轨迹码命名并回读标注元数据 |
| AT-027 | 推送 clean exact annotated release tag | CD 同时生成文件名带 `UNSIGNED` 的 Windows x64 NSIS、macOS arm64/x64 DMG；三者均披露无可信发布者身份并通过依赖、安装或挂载、启动和 hash 检查；macOS 还通过 strict ad-hoc seal 与 synthetic-quarantine Gatekeeper 分类后才公开 Release |
| AT-028 | 修改 `docs/wiki` 并合入 main | 页面与内部链接检查通过后同步 GitHub Wiki；网页文档与仓库源一致 |
| AT-029 | 对 macOS Release app 添加 quarantine 并执行分发策略检查 | app/main/FFmpeg 的 nested code 与 sealed resources 严格校验通过；策略报告 ad-hoc identity/missing notary ticket，或内部 XProtect 错误被独立最小 control app 同样复现并显式记录；不出现产品独有 XProtect、invalid signature、missing resources 或 damaged |

## 14. 当前实现状态

### 14.1 已完成并验证

- Tauri 2 + React + Rust 工程和 `main` Git 分支。
- SD/目录扫描、episode 发现和进度事件。
- 本地复制、逐文件 BLAKE3、目标回读和 format-v2 manifest 路径映射。
- 交互加载对五路 JPEG 执行固定百分位抽检并全量检查结构、状态和时间轴；正式压力/发布流程保留 JPEG 全量解码。
- 五路同步回放、状态曲线、单轨迹时间裁剪和检查页。
- 支持闭区间帧裁剪的 MCAP、HDF5、LeRobot v2.1 adapters 与导出 UI。
- 标准样例的完整 import smoke test。
- 标准样例三格式生成与回读 smoke test。
- macOS ARM 上的 Tauri debug 二进制构建。
- Windows 安装最低版本 hook、离线 WebView2 配置和 FFmpeg staging 脚本。
- Windows 卷类型/文件系统识别、空间预检和 FAT/FAT32 阻断。
- Rust 导出入口只接受与当前源指纹匹配的可信健康检查记录；error 硬阻断，warning 必须显式确认。
- 应用标记的未完成导入可在下次启动识别并安全清理。
- 后端只允许一个扫描、导入、检查或导出长任务同时运行。
- 可版本化的 JSON 检查报告、warning/error 本地后台报告、issue 帧定位和容错状态加载。
- 基于中位时间戳的自动 FPS 与 15/24/30/60 FPS 用户覆盖。
- 导出后在系统文件管理器中选中结果。
- Rust 可信检查缓存与源目录指纹；三格式 debug smoke test 从 276.01 秒恢复到 70.00 秒。
- 可取消且不跟随 symlink 的源遍历、稀疏帧有界报告和精确缺帧总数。
- Windows/macOS/Linux 原子 no-replace 发布，以及 macOS 卷/文件系统信息。
- Foxglove 官方 CompressedImage/PoseInFrame MCAP、三 adapter 内部回读校验；HDF5 JPEG 以 1 MiB 有界 chunk 流式写入。
- 长曲线有界降采样，以及缺失帧/状态时不复用旧画面或旧遥测。
- 跨平台 quick/full/bundle 检查和原子 JSON 证据报告。
- Windows/macOS FFmpeg hash、架构、encoder、来源、许可证与可移植性 staging 门禁。
- macOS app/DMG 和 Windows NSIS 的 FFmpeg 二进制、许可证及 provenance manifest 资源配置。
- 跨平台 `stress-check` 验收 runner、正式环境硬门禁、import 取消/partial 清理探针和原子 JSON 性能证据。
- macOS 到 Windows x64 MSVC 的 Rust all-target 条件编译预检和边界明确的原子 JSON 证据。
- macOS 只读虚拟 ExFAT 卷上的完整生产数据链路 smoke 和 marker 保护清理。
- 本地账号注册/登录/退出、Argon2id 密码哈希、后端会话门禁，以及带处理人的 episode 级任务标注与全局唯一轨迹码。
- MCAP/HDF5/LeRobot 导出继承轨迹码、任务和处理人元数据。
- 三平台正式 Release CD、完整集合发布门禁、安装器 verification report、SHA-256 manifest 和 GitHub build provenance 工作流。
- `docs/wiki` 用户/发布手册、内部链接检查和 GitHub Wiki 自动同步工作流。

### 14.2 发布前阻断项

| 编号 | 阻断项 | 完成标准 |
| --- | --- | --- |
| GAP-001 | Windows x64 生产签名与目标机验收尚未完成 | 生成 Authenticode/timestamp 签名 NSIS，并通过 Win10/Win11 断网测试 |
| GAP-002 | Windows FFmpeg 来源/hash/许可证已锁定，但尚待首次 Windows runner 和目标机证据 | 首次 Release job 与 Win10/Win11 实机均通过编码、安装和许可证检查 |
| GAP-003 | 尚未在真实 exFAT SD 卡完成现场测试 | 完成第 11 节完整测试矩阵 |
| GAP-007 | 验收 runner 已就绪，但长时/大容量实盘性能未知，尚无物理 100 GB 证据 | 用至少 100 GB/100,000 文件完成扫描、导入、检查、每种导出、取消延迟和内存/吞吐基线记录 |
| GAP-009 | unsigned CD 已实现；仓库尚未配置 Windows/Apple 签名凭据和 signed release approver，也未产出三平台可信签名 Release | 配置受保护的签名环境，恢复 Authenticode/Developer ID/notarization 门禁，以新版本生成完整 signed Release，并在 Win10/Win11 与目标 Mac 完成验收 |

### 14.3 `0.2.0` 已关闭缺口

| 编号 | 完成证据 |
| --- | --- |
| GAP-004 | 导入 IPC 和 UI 预检可用空间、目标文件系统及源/目标路径隔离；Windows FAT/FAT32 被阻断。 |
| GAP-005 | Rust command 只接受与当前源目录指纹绑定、报告格式为当前版本的进程内检查记录；记录缺失或过期时阻止导出，error fixture 证明 IPC 无法绕过。 |
| GAP-006 | warning 导出要求 UI 确认并由 Rust 再次验证确认参数。 |
| GAP-008 | partial 使用独立应用标记；启动和再次选择目标时可提示清理，未标记目录会被拒绝。 |

### 14.4 `0.3.0` 已完成 P1

- FR-VAL-012：JSON 检查报告原子导出与回读验证。
- FR-VIS-007：根据原始纳秒时间戳中位间隔推导 FPS，可手动覆盖。
- FR-VIS-008：检查 issue 可定位回放帧。
- FR-EXP-007：使用最小 Tauri opener capability 在文件管理器中显示输出。

### 14.5 `0.4.0` 安全与大数据边界

- 源扫描、加载、指纹和导入预检均可取消，不跟随文件或流目录 symlink。
- Manifest 升级为 format v2，保留原始到 Windows 安全路径映射，并在复制前拒绝大小写/清理碰撞。
- 导入检测复制期间源文件变化；目标回读测试可检出同尺寸内容篡改。
- 新增 `INVALID_TIMESTAMP`、`INVALID_FRAME_FILENAME`、`DUPLICATE_FRAME_ID` 和 `FRAME_ID_MISMATCH` fixture。
- 三个 adapter 在发布前执行格式内部回读，并使用平台原子 no-replace；FFmpeg 取消不再阻塞管道读取。
- HDF5 对 512 MiB 以上 JPEG 数据显式阻止并报告 `HDF5_STREAMING_REQUIRED`，未将该保护措施误记为 GAP-007 已关闭。

### 14.6 `0.5.0` 发布工程边界

- `pnpm check` 统一快速门禁；`check:full` 加入两个真实样例测试和 Tauri no-bundle build；`check:bundle` 生成当前平台 unsigned debug 包。
- 每次门禁都会在 ignored 目录原子发布机器可读报告，release commit 后可用 `--require-clean` 阻止脏工作区 tag。
- 两个平台 staging 都要求已知 SHA-256、来源、build ID、许可证和 `mpeg4` encoder，并拒绝 `--enable-nonfree`；Windows 额外验证 PE x64，macOS 检查非系统动态库。
- Homebrew FFmpeg 被正确标记为 `portable:false`，只能用于显式本机 debug 验证，不能作为可发布 sidecar。
- GAP-002 仍未关闭：门禁和证据格式已完成，但 Windows 最终分发二进制、完整许可证组合与编码策略仍需负责人批准并在目标构建机验证。
- macOS unsigned debug `.app`/`.dmg` 只能作为开发证据；Windows 签名 NSIS、Win10/Win11 断网验收、真实 exFAT 和 100 GB 压测仍是独立阻断项。

### 14.7 `0.6.0` HDF5 流式写入边界

- 固定 `hdf5-pure 0.21.2` 并保留上游 checksum、Git revision、MIT 许可证和本地 patch 清单；补丁只公开现有 lazy chunk writer 的受限 `u8` 接口。
- 五路 JPEG 根据 frame path、offset 和 size 建立轻量索引，写入时按 1 MiB chunk 跨文件读取；尾块在物理层补零，HDF5 shape 保持精确逻辑字节数。
- writer 直接持有共享取消令牌，payload 阶段持续报告字节进度；取消、源长度变化、写入或回读失败会删除本次 partial，不发布正式名称。
- 跨文件、尾块裁剪、取消和 100 GiB 逻辑 staging 单元测试通过；80,531,730 字节私有样例三格式回读于 macOS 完成，完整门禁耗时 69.65 秒。
- GAP-007 仍未关闭：逻辑 staging 不读取或写出 100 GiB，尚未取得物理 100 GB/100,000 文件的峰值内存、吞吐、取消延迟和完整工作流记录。

### 14.8 `0.7.0` 实盘验收工具边界

- 新增独立 `stress-check` CLI；formal 默认开启，并硬性要求 release profile、clean exact version tag、显式绝对 FFmpeg 路径、exFAT 源、不同源/工作卷、100,000 文件、100,000,000,000 字节和充足工作空间。
- runner 串行复用生产扫描、导入、检查与三个 adapter，逐阶段记录耗时、逻辑吞吐和进程峰值 RSS；完成后按 manifest 重新读取源端每个文件并核对数据集 BLAKE3 与元数据指纹。
- 新增 import 取消探针：发现应用标记的 partial 后触发取消，要求 1 秒内返回、无正式输出并在 marker 校验后清理 partial。
- macOS APFS 的 80,531,730 字节开发样本全链路于 72.551 秒通过，取消延迟 1 ms，峰值 RSS 27,394,048 字节，源前后数据集 BLAKE3 均为 `f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727`；该报告为 `formal:false`，不能关闭 GAP-003/GAP-007。
- Windows 条件编译路径使用 Process Status API 记录 peak working set，但尚未在 Windows 构建机编译或执行；真实 exFAT、100 GB/100,000 文件、Windows 包和目标机验收继续保持阻断。

### 14.9 `0.8.0` 平台预资格边界

- `pnpm check:windows-cross` 在 macOS ARM 宿主使用 rustup stable `1.97.1`、`x86_64-pc-windows-msvc` target 和 LLVM `llvm-rc 22.1.8` 完成全部 Rust target 条件编译；检查专用 feature 只为 BLAKE3 选择 intrinsic 实现，默认 Windows release 行为不变。
- 交叉检查只在检查进程中移除 Tauri bundle resource 映射，避免要求本机存在 `ffmpeg.exe`；它没有链接可执行文件、生成 NSIS 或在 Windows 运行，因此 GAP-001/GAP-002 均未关闭。
- `pnpm check:exfat-macos` 创建真实 ExFAT 稀疏镜像、写入样例、卸载并以只读方式重挂载；Rust 将源识别为 `exfat/removable`，工作卷识别为独立 `apfs/fixed`。
- 80,531,730 字节、981 文件的只读虚拟 ExFAT 全链路 stress 于 75.662 秒通过，取消延迟 5 ms、峰值 RSS 27,213,824 字节、健康检查无 error、三 adapter 回读通过，源前后 dataset BLAKE3 均为 `f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727`。
- 脚本成功卸载卷并只删除 marker 匹配的临时根；该结果仍为 `formal:false`、`physicalSdCard:false`，真实卡断电/满盘/重插拔、100 GB/100,000 文件和 Win10/Win11 完整流程继续保持阻断。

### 14.10 `0.9.0` 时间裁剪与 Foxglove MCAP

- 回放页新增单轨迹闭区间时间裁剪：起止滑块、数字输入、当前帧标记、范围摘要和重置；播放、步进和导出共用同一范围。
- Rust 导出入口重新验证范围边界，按选中状态 frame ID 过滤五路图像；逐帧 issue 只在范围内生效，全局 issue 继续生效。
- MCAP 升级为 7 channels/3 schemas：JSON state、官方 foxglove.PoseInFrame 和五路官方 foxglove.CompressedImage；生产回读保持 summary 有界读取。
- 私有样例帧 10-19 已通过三 adapter 真实导出与回读；MCAP 的 state JSON、位姿 protobuf 和五路图像 protobuf 逐消息解码通过。
- 完整 80,531,730 字节 APFS 开发样本工作流于 72.726 秒通过；MCAP 80,673,724 字节，导出/summary 回读 177 ms，源前后指纹与 BLAKE3 一致。
- Foxglove Desktop 2.57.0 已在交互式桌面会话打开完整 196 帧 MCAP：五个 Image panel 均解码出画面，Raw panel 可读取 state；Topics 面板识别 5 个 `foxglove.CompressedImage`、1 个 `foxglove.PoseInFrame` 和 1 个 `dohc.State`，每个 topic 均为 196 条、约 18.97 Hz。macOS 上失效的最近文件句柄会独立报 `Permission denied`，重新通过 Open local file(s) 选择文件后可正常读取。

### 14.11 `0.10.0` session 选择与回放入口

- 左侧 episode 列表以源 session 路径作为稳定身份；单击只更新选择，不切换主工作区。
- 双击未加载的 session 复用本地导入、容量预检、复制、大小/BLAKE3 校验和健康检查流程，完成后进入回放。
- 双击已经加载的 session 不重复复制，直接切换到回放；导入后的本地副本路径不会覆盖左侧源 session 的选中高亮。
- 在 1440x920、960x680 和 390x844 视口完成交互、五路图像、无溢出和无控制台错误检查。

### 14.12 `0.11.0` 黑白灰视觉系统

- 将品牌标记、主要按钮、导航选中态、session 选中态、进度、时间轴、裁剪控件、状态徽标和导出反馈统一为黑白灰层级。
- telemetry 的 X/Y/Z/W 曲线使用四档灰度，坐标网格和当前帧标记同步采用中性色；相机画面保留真实源颜色。
- warning/error 继续显示稳定中文标签、Lucide 图标、边框和不同明度背景，不以色相作为唯一状态信息。
- 回放、检查、导出三页已在 1440x920、960x680 和 390x844 视口完成截图检查；五路图像均解码，无横向溢出、console error、page error 或失败请求。

### 14.13 `0.12.0` 自动加载与固定百分位图像抽检

- 选择 SD 卡或记录目录后自动扫描并处理第一条 session，直接进入本地目标选择、导入、大小/BLAKE3 回读、健康检查和回放；顶栏与空状态不再提供“导入并检查”按钮。
- 交互检查对每个非空流按排序后的唯一帧序列固定抽取 `1% / 25% / 50% / 73% / 99%`，小数据自动去重；文件名、重复/缺失帧、图像/状态 frame ID 集合、全部状态行和时间轴仍全量检查。
- 正式 stress 和真实发布 smoke 继续调用全量 JPEG 解码，确保交互提速不削弱发布证据。
- JSON 健康报告升级到 `formatVersion=2`，显式记录 `imageValidationMode`、`imageSamplePercentages` 和每个流实际 `checkedFrames`；旧报告不会进入可信导出缓存。
- 检查页新增“总帧/抽检帧”区分，browser demo 与真实抽检报告使用 26 个已检查文件和每流 5 个检查帧。
- fixture 覆盖固定百分位映射、少帧去重、抽检未命中损坏帧以及全量模式检出同一损坏帧；常规 Rust 测试和前端 production build 已通过。

### 14.14 `0.13.0` 检查结果排序与本地后台报告

- warning/error 检查完成后自动在应用 local-data 的 `reports` 目录生成本地审计报告；报告过程不发起网络请求，也不写入源 SD 卡或导入 episode。
- 自动报告按 episode 路径、数据指纹和报告版本稳定去重，以 partial 写入、回读验证和原子 no-replace 发布；ok 结果不生成后台报告。
- 健康报告升级到 `formatVersion=3` 并增加 `autoReportPath`；旧格式不能进入可信导出缓存。
- 检查表包含图像流和 `states.jsonl` 的真实结果，并按错误、警告、通过排列；issue 列表同步按错误、警告排序并显示严重级别。
- 样例的 `TIMESTAMP_GAP` 现在使 `states.jsonl` 正确显示“警告”，不再误显示“通过”；检查页手动操作从“导出 JSON”改为“导出报告”。
- 后台报告去重/ok 跳过 fixture、常规 Rust suite、前端 production build，以及 1440x920、960x680、390x844 三视口排序/溢出检查已通过。

### 14.15 `0.14.0` 本地账号与 episode 级数据标注

- 首次启动进入本地账号创建页；密码以 Argon2id PHC 哈希和系统随机盐写入应用 local-data，登录会话不跨进程重启保留。
- 未登录时 Rust 扫描、导入、加载、检查、读帧和导出 commands 均拒绝执行；顶栏显示当前账号并提供退出操作。
- 初始任务目录包含 `close_oven`，默认描述自动带出且可编辑；轨迹码按 `oven-001` 递增，由原子占号文件保证不同 episode 不重复。
- 标注按规范化路径和数据指纹归档，每次保存追加稳定修订，记录当前处理人且不写源 SD 卡或导入副本。
- 有标注时 MCAP/HDF5/LeRobot 以轨迹码命名并保存任务/处理人元数据；无标注时保持历史输出兼容。
- 注册/登录、唯一编号、标注修订、三格式真实样例回读、前端 production build 和 Windows x64 MSVC all-target 条件编译通过；注册、保存、退出重登、五路图像和 1440x920/960x680/390x844 零溢出交互检查通过。

### 14.16 `0.15.0` unsigned Release CD 与 GitHub Wiki

- tag 驱动的 CD 已定义 Windows x64 NSIS、macOS arm64 DMG 和 macOS x64 DMG 三个原生构建；Actions 使用不可变 commit，Node/pnpm/Rust 工具链固定。
- Windows 固定 FFmpeg static b6.1.1/Gyan 6.1.1 essentials 的 binary/license/build notice hash 与 exact offline WebView2 hash，确认 DOHC app/NSIS/uninstaller 为 unsigned，再执行 silent install、8 秒启动和 silent uninstall。
- macOS arm64/x64 从固定 hash 和 commit 的 FFmpeg 8.1.2 官方源码构建最小 LGPL sidecar，拒绝 `--enable-nonfree` 和非系统动态库；headless 只读 DMG 验证 `/Applications` 链接、资源 hash 和复制后 8 秒直接启动。发布后发现该 direct-startup 检查绕过了 Gatekeeper，两个 Mac DMG 的 app resource seal 无效并可能显示“已损坏”；这些资产由 `0.15.2` 取代，Windows 资产不受影响。
- final job 只接受三份 `passed` verification report，重新计算安装器 hash，生成 manifest/checksums/provenance 后才公开 draft；已经发布的 tag 不可覆盖。
- Release 标题、说明、三个资产文件名、verification report 和 manifest 均明确披露 `UNSIGNED`；当前不宣称 Authenticode、Developer ID、Gatekeeper 或 notarization 已完成。
- 用户文档已转为 `docs/wiki` 可审查源，覆盖安装、加载、检查、回放/裁剪、账号/标注、三格式导出、隐私、故障排查与发布配置，并由独立 workflow 同步。
- GitHub Wiki 已初始化并完成首次同步；本节只表示 unsigned 流水线和文档实现完成，不能关闭 GAP-001/GAP-002/GAP-009，也不能宣称已有签名正式安装包。

### 14.17 `0.15.1` macOS Gatekeeper 包结构修复候选

- macOS FFmpeg 构建结束后显式 ad-hoc 签名；app 组装完成后按 FFmpeg、主程序、完整 bundle 的顺序重新封印，并把封印前后 FFmpeg SHA-256 和签名模式写入 provenance manifest。
- 两种 Mac 架构都必须通过 `codesign --verify --deep --strict`，且 app/main/FFmpeg 必须是 ad-hoc、没有 Developer ID authority/team；DMG 本身没有 code signature 或 notarization ticket。
- DMG 中的 app 被复制并添加 synthetic quarantine 后，发布脚本执行 `syspolicy_check distribution`。只有 `Adhoc Signed App` 和 `Notary Ticket Missing` 允许作为预期策略拒绝；任何资源封印、嵌套签名或 damaged 错误都会中止发布。
- 用户文档将 `0.15.0` Mac 包明确标记为已取代，并提供系统设置中的一次性“仍要打开”流程；不要求关闭 Gatekeeper 或移除 quarantine。
- 本修复只保证包结构完整并消除虚假的 damaged 错误，不等于 Developer ID 签名或 Apple notarization，不能关闭 GAP-002/GAP-009。
- `v0.15.1` 的 arm64 app、主程序、FFmpeg、DMG 副本和 quarantine 副本均通过 strict codesign，但 GitHub macOS 15 runner 的策略工具返回 `Internal Xprotect Error`，没有输出预期的 `Adhoc Signed App`。门禁按设计阻止 publish，因此该 tag 没有公开 Release，也没有移动或复用。

### 14.18 `0.15.2` macOS 15 policy-service 对照门禁

- 保留 `0.15.1` 的全部 strict code/resource seal、DMG、quarantine 和启动门禁。
- 当产品 app 的 `syspolicy_check distribution` 返回 `Internal Xprotect Error` 时，runner 现场用系统 clang 构建一个最小程序，创建独立 app bundle，完成相同 ad-hoc seal 和 quarantine 后再次执行策略检查。
- 只有最小 control app 同样返回内部 XProtect 错误和 missing notary ticket 时，报告才允许记录 `policyServiceAvailable:false`、`internalXprotectError:true` 和 `controlAssessmentMatched:true`。control 正常而产品异常时发布失败。
- final manifest 保留每个 Mac 资产的 Gatekeeper assessment 和 policy-service availability；用户安装文档以 `0.15.2+` 为修复版本基线。

## 15. 里程碑

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 技术原型 | 真实样例复制、检查、回放、三种导出 | 已完成 |
| M1 多平台 Alpha | Windows x64 离线安装包、macOS arm64/x64 DMG、reviewed FFmpeg 和基本硬件测试 | 进行中；unsigned CD 与 macOS 完整性门禁已完成，目标机待验收 |
| M2 Field Beta | exFAT 卡、长时数据、异常数据、操作员反馈 | 待完成 |
| M3 v1.0 | 关闭所有 P0/GAP，签名发布和操作手册 | 待完成 |

## 16. 开放问题

1. 采集设备使用 exFAT 时的最长稳定写入时长和断电恢复表现如何？
2. Windows 签名采用哪家代码签名服务，Apple Developer ID/notarization 由哪个账号负责？
3. 正式数据是否会增加 action、task 或其他状态字段？字段版本如何识别？
4. 真实最长 episode 的容量、文件数和期望导入时间是多少？
5. warning 导出是否需要附带检查报告，或写入目标格式 metadata？
6. 是否需要支持同一批次多个 episode 的队列导入？
7. 产品负责人、签名证书负责人和 release approver 分别是谁？
8. `close_oven` 之外的正式任务目录、默认描述和编码前缀由谁维护，是否需要管理员审核流程？
9. 后续是否需要接入组织账号服务器、角色权限和跨机器同步？当前本地账号只用于归因。

## 17. Definition of Done

一个 `v1.0` 发布只有在以下条件全部满足时才算完成：

- 所有 P0 需求通过测试且没有未批准的例外。
- 第 14.2 节发布阻断项全部关闭。
- 标准私有样例 import/export smoke test 通过。
- 至少一组损坏数据 fixture 覆盖每类 error/warning。
- 100 GB 级数据压力测试达到性能目标，无不可控内存增长。
- 签名的离线 NSIS 在干净 Win10/Win11 x64 上通过安装和卸载。
- 签名并 notarized 的 arm64/x64 DMG 在对应目标 Mac 上通过安装、启动和完整离线工作流。
- 真实 exFAT SD 卡完整流程通过，源卡内容 hash 前后不变。
- FFmpeg/WebView2/依赖许可证和版本清单已归档。
- `README.md`、`prd.md`、`AGENTS.md` 与最终行为一致。
