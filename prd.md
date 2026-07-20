# DOHC Viewer 产品需求文档

| 属性 | 内容 |
| --- | --- |
| 产品名称 | DOHC Viewer |
| 文档版本 | 0.4 |
| 应用版本基线 | 0.4.0 |
| 文档状态 | 安全 Alpha，等待 Windows 实机发布验收 |
| 首发平台 | Windows 10/11 x64 |
| 文档日期 | 2026-07-20 |
| 产品负责人 | 待指定 |
| 技术负责人 | 待指定 |

## 1. 文档目的

本文定义 DOHC Viewer 的产品边界、数据契约、用户流程、功能需求、非功能需求和发布验收标准。产品、设计、开发和测试均以本文为共同基线。

本文同时记录当前 `0.4.0` Alpha 已经验证的能力和正式发布前仍需完成的工作。标记为“已实现”不代表已经通过 Windows 发布验收；Windows 安装包、真实 SD 卡和长时数据测试仍是独立的发布门槛。

## 2. 背景与问题

DOHC 采集设备将一次记录写入 SD 卡。现有卡使用 ext4，macOS 和标准 Windows 环境不能直接读取。团队需要一个离线桌面工具，把数据从物理 SD 卡可靠地复制到本地，对数据质量进行检查，完成多路同步回放，并导出到机器人数据工具链需要的格式。

当前人工流程存在以下问题：

- ext4 卡不能由目标办公电脑直接读取。
- 大量 JPEG 和状态记录无法快速判断是否为空、缺帧或损坏。
- 手工复制无法证明目标文件与源文件一致。
- 五路相机与状态数据缺少统一时间轴进行检查。
- MCAP、HDF5 和 LeRobot 数据需要重复编写临时转换脚本。
- 原始记录目录名可能包含 Windows/exFAT 不允许的字符，例如冒号。

## 3. 已确认的产品决策

| 编号 | 决策 |
| --- | --- |
| D-001 | 产品运行时只支持本机可见的 SD 卡或本地目录，不支持 SSH、HTTP、NAS 或其他网络数据源。 |
| D-002 | 工作流必须先复制到本地，再进行完整检查、回放和导出；源 SD 卡始终按只读数据源处理。 |
| D-003 | 首发平台为 Windows 10/11 x64，技术栈为 Tauri 2、Rust、React 和 TypeScript。 |
| D-004 | 推荐未来采集卡使用 exFAT，以便 Windows/macOS 直接读取；当前 ext4 卡必须先备份再格式化。 |
| D-005 | 导入完整性采用“文件大小 + BLAKE3”逐文件回读校验，并生成数据集级 BLAKE3。 |
| D-006 | 导出格式通过独立 adapter 实现，首批为 MCAP、HDF5 和 LeRobot v2.1。 |
| D-007 | 数据存在 warning 时允许导出；存在 error 时必须阻止正常导出。 |
| D-008 | 应用不依赖运行时网络，Windows 安装包必须包含离线 WebView2 安装能力和 FFmpeg。 |
| D-009 | 源数据没有 `action` 字段，LeRobot 导出不得虚构 action。 |
| D-010 | 文件和目录名必须兼容 Windows；旧数据中的非法字符由导入器确定性替换。 |

## 4. 产品目标

### 4.1 核心目标

1. 让非开发用户在一套桌面界面内完成 SD 卡数据导入、检查、回放和导出。
2. 让每次本地导入都能提供可复核的完整性证据。
3. 在导出前暴露空流、缺帧、JPEG 解码、状态解析和时间戳问题。
4. 让五路图像和状态曲线在同一帧位置同步查看。
5. 通过 adapter 降低新增数据格式的成本，并保持各格式语义清晰。
6. 在无网络环境中完成核心工作流。

### 4.2 成功指标

- 受支持记录的导入完整性错误检出率为 100%。
- 已知损坏 JPEG、空流、无效状态 JSON 和非单调时间戳均能被自动检出。
- 标准测试记录能够成功导出三种格式并被各自读取器重新打开。
- 用户从选择源到看到第一条进度反馈不超过 1 秒。
- Windows 10/11 目标机断网时可以完成安装后的完整工作流。
- 现场用户无需命令行脚本即可完成主要任务。

### 4.3 非目标

- 不直接读取 Windows 无法挂载的 ext4 分区。
- 不提供 SSH、云同步、远程上传或多人协作。
- 不在 SD 卡上修复、重命名、删除或覆盖原始文件。
- 不提供数据标注、剪辑、拼接或训练任务管理。
- 不自动推断机器人 action、task 语义或标注信息。
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

1. 操作员插入 exFAT SD 卡，选择卡根目录，应用发现一个或多个记录。
2. 操作员选择记录及本地目标目录，应用复制数据并验证目标端文件。
3. 应用自动运行健康检查，并给出通过、警告或失败状态。
4. 用户在五路画面和状态曲线之间同步定位异常帧。
5. 用户选择目标格式和目录，生成数据集并获得输出路径和统计信息。

## 6. 端到端流程与状态

```text
物理 SD 卡
   |
   v
选择目录 -> 扫描 episode -> 选择记录 -> 复制到本地 -> 大小/BLAKE3 回读校验
                                                        |
                                                        v
                                               数据健康检查
                                                  /        \
                                             warning       error
                                                |            |
                                                v            v
                                        回放并允许导出    回放诊断、禁止导出
                                                |
                                                v
                                      MCAP / HDF5 / LeRobot
```

前台同一时间只允许一个长任务。长任务包括扫描、导入、检查和导出，共享统一进度条和取消入口。

| 状态 | 含义 | 允许操作 |
| --- | --- | --- |
| 未选择 | 没有数据源 | 选择 SD 卡目录 |
| 已扫描 | 已发现 episode，尚未复制 | 选择记录、开始导入 |
| 导入中 | 正在复制或回读校验 | 查看进度、取消 |
| 检查中 | 正在解析状态和解码图像 | 查看进度、取消 |
| 通过 | 没有 warning/error | 回放、导出 |
| 警告 | 存在可疑但仍可读取的数据 | 回放、确认警告后导出 |
| 失败 | 存在阻断问题 | 回放可用部分、查看问题；不允许正常导出 |
| 导出中 | adapter 正在生成目标数据 | 查看进度、取消 |
| 已导出 | 输出已完成并通过最低回读验证 | 打开输出位置、继续导出其他格式 |

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
| FR-SRC-005 | P0 | 源目录在整个应用流程中只读。 | 自动化测试和代码审查确认没有对源路径执行写入、重命名或删除。 | 已实现并测试；实卡 hash 仍为发布门槛 |
| FR-SRC-006 | P1 | 明确显示卷类型、可移动介质状态和可用容量。 | UI 可以区分 SD 卡与普通本地目录。 | Windows/macOS 已实现；待实机验收 |

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
| FR-VAL-007 | P0 | 解码每个 JPEG。 | 无法解码产生 error，并记录 stream/frame。 | 已实现 |
| FR-VAL-008 | P0 | 检查同一流内分辨率一致。 | 与该流首帧尺寸不一致产生 error。 | 已实现 |
| FR-VAL-009 | P0 | 对比图像帧数和状态条数。 | 数量不一致产生 warning。 | 已实现 |
| FR-VAL-010 | P0 | 提供汇总与逐问题视图。 | 展示状态、已检查文件数、耗时、各流帧数、解码失败数和 issue code。 | 已实现 |
| FR-VAL-011 | P0 | error 在 UI 和 Rust 导出入口形成双重阻断。 | 不能通过直接调用 IPC 绕过检查。 | 已实现并测试 |
| FR-VAL-012 | P1 | 导出机器可读检查报告。 | 可生成包含版本、issue 和统计的 JSON 文件。 | 已实现并测试 |

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

机器可读报告使用 `formatVersion=1`，包含 `episodeRoot`、`parsedStateCount`、总状态、文件/流统计和完整 issue 列表。可定位的 issue 附带可选 `frameId`。报告先写入隐藏 partial 文件并回读验证，再原子发布，同名时不覆盖。

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

#### 8.5.1 MCAP 契约

- 输出为单个 `.mcap` 文件。
- `/dohc/state`：`json` 编码，使用 `dohc.State` JSON Schema。
- `/dohc/camera/{stream}`：原始 JPEG 字节，encoding 为 `jpeg`。
- 消息 `log_time` 和 `publish_time` 使用原始 `capture_time_ns`。
- 五个图像 channel 的 metadata 包含 `mime_type`、`width` 和 `height`。
- 数据集 metadata 包含源名称和状态条数。

#### 8.5.2 HDF5 契约

- 输出为单个 `.h5` 文件，根属性包括 `format=dohc-hdf5`、`format_version=1` 和 `source_name`。
- `/states` 包含 `frame_id`、`capture_time_ns`、`position`、`velocity`、`quaternion`、`euler`、`omega` 和 `confidence`。
- `/images/{stream}` 包含 `jpeg_data`、`offsets`、`sizes` 和 `frame_id`。
- 图像 group 属性包含 `mime_type=image/jpeg`、`width` 和 `height`。
- 使用纯 Rust HDF5 实现，Windows 运行时不得依赖额外 HDF5 DLL。
- 当前 writer 会在内存中暂存 JPEG；JPEG 总量超过 512 MiB 时以 `HDF5_STREAMING_REQUIRED` 阻止导出，不得冒险耗尽内存。解除上限前必须实现真正的流式写入并完成第 9.1 节压力测试。

#### 8.5.3 LeRobot v2.1 契约

- 输出是 `{episode}_lerobot_v2/` 目录。
- 数据文件为 `data/chunk-000/episode_000000.parquet`，使用 Snappy。
- 每个流生成 `videos/chunk-000/observation.images.{stream}/episode_000000.mp4`。
- Meta 包含 `info.json`、`tasks.jsonl`、`episodes.jsonl`、`stats.json` 和 `episodes_stats.jsonl`。
- `codebase_version` 固定为 `v2.1`。
- 标准 `timestamp` 使用 `frame_index / fps`，与恒定帧率 MP4 对齐。
- 原始纳秒时间保存在 `observation.capture_time_ns`，类型为 int64。
- 原始状态映射为 observation；不得生成虚构的 action。
- FPS 从正时间差的中位数估算，并在 5% 内吸附到常见帧率；标准样例应得到 30 FPS。
- FFmpeg 查找顺序为 `DOHC_FFMPEG`、应用资源目录、系统 PATH。Windows 发布版必须命中应用资源目录。

### 8.6 任务进度与错误处理

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
| NFR-PERF-004 | 取消操作在当前 1 MiB 复制块、8 个检查帧或 adapter 的下一个安全点内生效，目标体验不超过 1 秒。 |
| NFR-PERF-005 | 标准五路样例在 1x 下目标为 30 FPS，连续 60 秒丢帧率低于 1%，拖动时间轴后 300 ms 内更新首批画面。 |
| NFR-PERF-006 | Windows 发布前必须用至少 100 GB/100,000 文件记录做扫描、导入、检查和每种导出的压力测试。 |
| NFR-PERF-007 | 内存不得随 JPEG 总数据量无界增长；大数据 HDF5 导出若超过内存门槛必须改为流式写入。 |

### 9.2 可靠性与数据安全

- 源路径只读，任何写入只能发生在用户选择的本地目标或导出目录。
- 所有完整输出使用 partial + 同文件系统原子 rename 发布。
- 发布操作在 Windows/macOS/Linux 均使用原子 no-replace 语义，不覆盖用户已有文件。
- 原始时间戳和数值数据不得静默修复；规范化字段必须保留原始字段。
- 完整性失败必须阻断最终导入目录发布。
- 应用退出或断电后，正式目录应是完整版本；partial 可清理但不可当作成功结果。

### 9.3 兼容性

- 首发支持 Windows 10/11 x64。
- 安装器必须在 Windows 10 以下系统中停止安装。
- Windows 安装包使用 NSIS current-user 模式，不要求管理员权限作为默认路径。
- Windows 安装包包含离线 WebView2 安装器。
- 未来 macOS 支持依赖 exFAT 等系统可读文件系统，不提供 ext4 驱动。
- 源 SD 卡推荐 exFAT；本地目标推荐 NTFS。FAT32 因 4 GB 单文件限制不作为受支持导出目标。

### 9.4 离线、安全与隐私

- 核心功能不得发起网络请求。
- 不收集遥测，不上传路径、图像、状态或 hash。
- 文件选择仅由原生目录对话框触发。
- Tauri capability 只开放核心窗口和目录对话框需要的权限。
- Windows 发布依赖必须锁定版本并完成许可证审查。

### 9.5 可维护性

- Rust 和 TypeScript 共享的字段必须有显式类型和 camelCase 序列化约定。
- 每种导出格式必须独立 adapter，不在 UI 中实现格式细节。
- 新 adapter 必须包含真实数据 smoke test 和回读验证。
- 错误、issue code 和 manifest 版本必须保持向后兼容；破坏性变更需要增加版本。
- `Cargo.lock` 和 `pnpm-lock.yaml` 必须提交。

## 10. UI 信息架构

### 10.1 全局区域

- 顶栏：产品名、当前源路径、健康状态、选择 SD 卡、导入并检查。
- 任务条：当前阶段、路径、进度、吞吐/耗时、取消按钮。
- 左侧栏：episode 列表、选中状态、文件数、容量和五路存在状态。
- 主工作区：回放、检查、导出三个 tab。

### 10.2 回放页

- `cam0` 为主要大画面，其余四路排列在右侧或窄屏网格中。
- 画面必须使用稳定尺寸，加载、错误和帧变化不能引发布局跳动。
- 时间轴控制位于画面下方，状态曲线位于同页后半部分。

### 10.3 检查页

- 顶部显示总状态、已检查文件、耗时和有效状态数。
- 每个流显示帧数、解码失败和结果。
- Issue 列表显示 scope、中文消息和稳定 code。

### 10.4 导出页

- 显示源记录概况、三种格式单选、当前 adapter 和导出命令。
- error 状态时禁用导出并说明原因。
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
- 完成代码签名和可信时间戳；证书不进入仓库。
- 在干净的 Win10 和 Win11 虚拟机断网安装并执行 smoke test。

### 12.2 版本管理

- `package.json`、`Cargo.toml` 和 `tauri.conf.json` 版本必须一致。
- Manifest `format_version`、HDF5 `format_version` 和产品 semver 独立管理。
- LeRobot `codebase_version` 明确固定为 v2.1，升级需要新 adapter 行为和兼容性测试。

## 13. 验收测试

| 编号 | 场景 | 预期结果 |
| --- | --- | --- |
| AT-001 | 选择包含标准 episode 的 SD 卡根目录 | 正确发现记录并显示五路、196 状态和容量 |
| AT-002 | 导入标准样例 | 981 个文件、80,531,730 字节校验通过，生成 format-v2 manifest 和稳定数据集 BLAKE3 |
| AT-003 | 修改目标副本中任意一个字节 | BLAKE3 回读失败，不发布正式目录 |
| AT-004 | 删除一个流目录 | `EMPTY_STREAM` error，禁止导出 |
| AT-005 | 删除中间 JPEG | `MISSING_FRAMES` warning，问题可见 |
| AT-006 | 使用截断或随机字节 JPEG | `DECODE_FAILED` error，并定位流和帧 |
| AT-007 | 写入无效 JSON/NaN/非单调时间戳 | 对应 error 被报告 |
| AT-008 | 加载标准样例 | 五路 frame 0 同步显示，曲线可切换，时间轴可播放/步进 |
| AT-009 | 标准样例的末尾时间间隔异常 | 得到 `TIMESTAMP_GAP` warning，不被静默修复 |
| AT-010 | 导出 MCAP | 6 个 channel 和 1 个 schema 可被 MCAP reader 读取 |
| AT-011 | 导出 HDF5 | `states/frame_id` 和 `images/cam0/frame_id` shape 为 196 |
| AT-012 | 导出 LeRobot v2.1 | `fps=30`，Parquet 196 行，包含原始纳秒字段，五个 MP4 非空 |
| AT-013 | 目标输出重名 | 生成后缀名称，不覆盖原文件 |
| AT-014 | 复制、检查或导出时取消 | 没有正式输出；partial 不会出现在正常记录列表 |
| AT-015 | 断网的干净 Win10/Win11 机器 | 安装、启动、导入、检查、回放和三种导出均可完成 |
| AT-016 | 1440x920、960x680 桌面视口 | 无重叠、横向溢出或不可见操作 |
| AT-017 | 导入含非法/大小写冲突路径的记录 | 安全路径写入 manifest；任何目标路径碰撞在复制前阻止 |

## 14. 当前实现状态

### 14.1 已完成并验证

- Tauri 2 + React + Rust 工程和 `main` Git 分支。
- SD/目录扫描、episode 发现和进度事件。
- 本地复制、逐文件 BLAKE3、目标回读和 format-v2 manifest 路径映射。
- 五路 JPEG 全量解码、状态和时间轴检查。
- 五路同步回放、状态曲线和检查页。
- MCAP、HDF5、LeRobot v2.1 adapters 与导出 UI。
- 标准样例的完整 import smoke test。
- 标准样例三格式生成与回读 smoke test。
- macOS ARM 上的 Tauri debug 二进制构建。
- Windows 安装最低版本 hook、离线 WebView2 配置和 FFmpeg staging 脚本。
- Windows 卷类型/文件系统识别、空间预检和 FAT/FAT32 阻断。
- Rust 导出入口只接受与当前源指纹匹配的可信健康检查记录；error 硬阻断，warning 必须显式确认。
- 应用标记的未完成导入可在下次启动识别并安全清理。
- 后端只允许一个扫描、导入、检查或导出长任务同时运行。
- 可版本化的 JSON 检查报告、issue 帧定位和容错状态加载。
- 基于中位时间戳的自动 FPS 与 15/24/30/60 FPS 用户覆盖。
- 导出后在系统文件管理器中选中结果。
- Rust 可信检查缓存与源目录指纹；三格式 debug smoke test 从 276.01 秒恢复到 70.00 秒。
- 可取消且不跟随 symlink 的源遍历、稀疏帧有界报告和精确缺帧总数。
- Windows/macOS/Linux 原子 no-replace 发布，以及 macOS 卷/文件系统信息。
- MCAP/HDF5/LeRobot 适配器内部回读校验；HDF5 超过 512 MiB JPEG 时安全阻止。
- 长曲线有界降采样，以及缺失帧/状态时不复用旧画面或旧遥测。

### 14.2 发布前阻断项

| 编号 | 阻断项 | 完成标准 |
| --- | --- | --- |
| GAP-001 | Windows x64 安装包尚未构建/签名 | 生成签名 NSIS，并通过 Win10/Win11 断网测试 |
| GAP-002 | FFmpeg Windows 构建和许可证尚未定版 | 锁定二进制 hash、来源、许可证和编码器策略 |
| GAP-003 | 尚未在真实 exFAT SD 卡完成现场测试 | 完成第 11 节完整测试矩阵 |
| GAP-007 | 长时/大容量数据性能未知，HDF5 仍需内存暂存 JPEG | 完成真正的 HDF5 流式写入，并用至少 100 GB/100,000 文件完成压力测试和基线记录 |

### 14.3 `0.2.0` 已关闭缺口

| 编号 | 完成证据 |
| --- | --- |
| GAP-004 | 导入 IPC 和 UI 预检可用空间、目标文件系统及源/目标路径隔离；Windows FAT/FAT32 被阻断。 |
| GAP-005 | Rust command 只接受与当前源目录指纹绑定的进程内完整检查记录；记录缺失或过期时阻止导出，error fixture 证明 IPC 无法绕过。 |
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

## 15. 里程碑

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 技术原型 | 真实样例复制、检查、回放、三种导出 | 已完成 |
| M1 Windows Alpha | Windows x64 离线安装包、FFmpeg、基本硬件测试 | 待完成 |
| M2 Field Beta | exFAT 卡、长时数据、异常数据、操作员反馈 | 待完成 |
| M3 v1.0 | 关闭所有 P0/GAP，签名发布和操作手册 | 待完成 |

## 16. 开放问题

1. 采集设备使用 exFAT 时的最长稳定写入时长和断电恢复表现如何？
2. Windows 发布使用哪个 FFmpeg 分发版本、许可证组合和视频编码器？
3. 正式数据是否会增加 action、task 或其他状态字段？字段版本如何识别？
4. 真实最长 episode 的容量、文件数和期望导入时间是多少？
5. warning 导出是否需要附带检查报告，或写入目标格式 metadata？
6. 是否需要支持同一批次多个 episode 的队列导入？
7. 产品负责人、签名证书负责人和 release approver 分别是谁？

## 17. Definition of Done

一个 `v1.0` 发布只有在以下条件全部满足时才算完成：

- 所有 P0 需求通过测试且没有未批准的例外。
- 第 14.2 节发布阻断项全部关闭。
- 标准私有样例 import/export smoke test 通过。
- 至少一组损坏数据 fixture 覆盖每类 error/warning。
- 100 GB 级数据压力测试达到性能目标，无不可控内存增长。
- 签名的离线 NSIS 在干净 Win10/Win11 x64 上通过安装和卸载。
- 真实 exFAT SD 卡完整流程通过，源卡内容 hash 前后不变。
- FFmpeg/WebView2/依赖许可证和版本清单已归档。
- `README.md`、`prd.md`、`AGENTS.md` 与最终行为一致。
