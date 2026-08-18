# DOHC Viewer 产品需求文档

| 属性 | 内容 |
| --- | --- |
| 产品名称 | DOHC Viewer |
| 文档版本 | 0.28 |
| 应用版本基线 | 0.17.49 |
| 文档状态 | 安全 Alpha，三安装器 unsigned CD、固定 IP 更新镜像与平台完整性门禁已定义，等待可信签名与目标机验收 |
| 发布平台 | Windows 10/11 x64；macOS 12+ arm64；Ubuntu 22.04+ x86_64 deb |
| 文档日期 | 2026-08-18 |
| 产品负责人 | 待指定 |
| 技术负责人 | 待指定 |

## 1. 文档目的

本文定义 DOHC Viewer 的产品边界、数据契约、用户流程、功能需求、非功能需求和发布验收标准。产品、设计、开发和测试均以本文为共同基线。

本文同时记录当前 `0.17.30` Alpha 已经验证的能力和正式发布前仍需完成的工作。标记为“已实现”不代表已经通过目标机发布验收；当前 GitHub Release 明确为没有可信发布者身份的 unsigned 通道，可信签名安装包、真实 SD 卡和长时数据测试仍是独立的生产门槛。

## 2. 背景与问题

DOHC 采集设备将一次记录写入 SD 卡。现有卡使用 ext4，macOS 和标准 Windows 环境不能直接读取。团队需要一个离线桌面工具，在不修改物理 SD 卡、也不自动占用等量本机空间的前提下，对数据质量进行检查，完成多路同步回放，并导出到机器人数据工具链需要的格式。

当前人工流程存在以下问题：

- ext4 卡不能由目标办公电脑直接读取。
- 大量 JPEG 和状态记录无法快速判断是否为空、缺帧或损坏。
- 自动复制大容量记录会重复占用本机磁盘，重复选择同一张卡时尤其明显。
- 五路相机与状态数据缺少统一时间轴进行检查。
- MCAP、HDF5 和 LeRobot 数据需要重复编写临时转换脚本。
- 原始记录目录名可能包含 Windows/exFAT 不允许的字符，例如冒号。
- 本地处理缺少操作员身份、任务语义和统一轨迹编号，无法可靠判断一条数据由谁处理、对应什么任务。

## 3. 已确认的产品决策

| 编号 | 决策 |
| --- | --- |
| D-001 | 产品数据运行时只通过操作系统已挂载或映射为目录的文件系统路径访问 SD 卡、本地目录或网络文件系统目录（如 Windows 映射盘、SMB/NFS 挂载）。应用不实现 SSH、HTTP、云存储或 NAS 连接协议，也不自动复制源数据。五路 JPEG、`states.jsonl`、骨架和其他采集文件保持只读；唯一源端写入是用户明确保存标注时，在当前 episode 根目录原子创建或更新应用管理的 `description.json`。固定局域网用户中心只承载账号登录和管理员账号管理，不承载采集数据。客户端自动更新只能访问 D-031 指定的固定 IP 镜像。 |
| D-002 | 正常工作流直接从已挂载源目录只读加载，进行全量结构/状态检查和固定百分位 JPEG 抽检，然后回放和导出；不自动复制源数据。正式压力/发布验收仍全量解码 JPEG。 |
| D-003 | 正式安装包覆盖 Windows 10/11 x64、macOS 12+ arm64 与 Ubuntu 22.04+ x86_64 原生 deb；首个现场验收重点仍为 Windows。技术栈为 Tauri 2、Rust、React 和 TypeScript。 |
| D-004 | 推荐未来采集卡使用 exFAT，以便 Windows/macOS 直接读取；当前 ext4 卡必须先备份再格式化。 |
| D-005 | 导入完整性采用“文件大小 + BLAKE3”逐文件回读校验，并生成数据集级 BLAKE3。 |
| D-006 | 导出格式通过独立 adapter 实现，首批为 MCAP、HDF5 和 LeRobot v2.1。 |
| D-007 | 数据存在 warning 时允许导出；存在 error 时必须阻止正常导出。 |
| D-008 | 扫描、检查、回放和导出数据本身不依赖运行时网络；所有用户必须连接固定证书局域网用户中心登录，标注保存还必须提交 D-032 白名单审计事件。Windows 安装包必须包含离线 WebView2 安装能力和 FFmpeg；已登录会话中的本地浏览功能不因用户中心短暂不可用而中断，更新失败不得破坏当前版本。 |
| D-009 | 源数据没有 `action` 字段，LeRobot 导出不得虚构 action。 |
| D-010 | 文件和目录名必须兼容 Windows；旧数据中的非法字符由导入器确定性替换。 |
| D-011 | 100 GB 正式验收必须使用 exFAT 实卡、不同本地工作卷、release exact tag 和显式 reviewed FFmpeg；开发 fixture 结果不得替代。 |
| D-012 | macOS 上的 Windows MSVC 条件编译和虚拟 ExFAT smoke 只作为预资格证据；不能替代 Windows 链接/打包/运行、真实 SD 卡或 formal 大容量验收。 |
| D-013 | v0.9 支持对单条轨迹做连续、闭区间的帧范围裁剪；裁剪只影响本次回放和导出，不修改采集文件；保存关联标注时只允许刷新根级 `description.json`。 |
| D-014 | 应用布局、控件和状态使用黑、白和中性灰；原始相机画面保留源颜色，telemetry 数据系列使用稳定彩色曲线并辅以维度文字和不同线型。状态仍通过文字、图标、边框和明度共同表达，不仅依赖色相。 |
| D-015 | 历史：v0.12 开始自动处理第一条 session，v0.16 曾扩展为全部 session 自动导入；当前行为由 D-026 取代。 |
| D-016 | v0.13 起 warning/error 检查结果必须在后台自动生成本地审计报告；ok 不自动生成。报告只写入应用本地数据目录，不上传网络、不写源卡或 episode；同一 episode 路径和数据指纹在同一报告版本下去重。 |
| D-017 | 所有数据用户进入工作区前必须登录当前主机局域网用户中心账号；账号只能由管理员创建，离线身份模式停用。服务保存 scrypt 密码哈希、账号字段和 D-032 的标注绩效审计事件；客户端通过管理员导入的固定 HTTPS 证书配置登录，登录 token 只在 Rust 进程内保存。 |
| D-018 | 标注记录绑定规范化 episode 路径与数据指纹，使用本地任务、可编辑任务描述和 `{prefix}-{NNN}` 轨迹编码。首个内置任务为 `close_oven`，前缀为 `oven`；新任务只输入名称，由系统生成稳定 ID/前缀。保存标注时，完整修订继续追加写入应用 local-data，并在 episode 根目录原子创建或更新 format-v2 `description.json` 保存整体描述、裁剪范围和连续片段数组；该应用管理 metadata 不参与采集数据指纹。 |
| D-019 | 每个进入 `main` 的 commit 都必须是完整 release-ready 内容，使用唯一新 semver、带日期 Changelog，并在 CI 成功后由 GitHub Actions 使用仓库 `GITHUB_TOKEN` 创建精确指向该 commit 的 annotated `vX.Y.Z` tag；禁止先推普通变更再另推 release commit。当前版本必须是 `CHANGELOG.md` 第一条带日期的版本记录、只能出现一次并至少包含一条具体变更，GitHub Release 正文必须直接展示该条目，并从该 clean exact tag 同时构建 Windows x64、macOS arm64 和 Ubuntu 22.04+ x64 deb 三个安装包。Codex 默认只递增 patch `+0.0.1`，minor/major 只能按开发负责人明确指令更新；当前阶段允许公开显式 `UNSIGNED` 的完整集合，但标题、说明、文件名、报告和 manifest 必须一致披露。未来签名产物必须使用新版本/tag，不覆盖 unsigned 资产。 |
| D-020 | 用户文档使用 GitHub Wiki；`docs/wiki` 是可审查的唯一源，由 workflow 同步，避免网页内容与代码版本分叉。 |
| D-021 | unsigned macOS app 仍必须对 FFmpeg、主程序和完整 bundle 生成结构有效的 ad-hoc seal；发布门禁必须在 synthetic quarantine 下区分“无可信身份/未公证”的预期策略拒绝、由已知良性 control app 复现的 runner XProtect 服务错误，以及 invalid signature/damaged 的产品包结构错误。 |
| D-022 | v0.16 起所有用户可见的扫描、导入、加载、检查和导出操作错误都要以不可覆盖的本地 JSON 记录保存；记录包含时间、操作、稳定错误码、原始消息、源路径和统一管理账号或固定离线本机 provenance 标记，界面提供最近 200 条历史回读。离线 UI 不显示该标记为账号。权限类消息统一归类为 `PERMISSION_DENIED`，不得只在顶部短暂显示。 |
| D-023 | 历史：v0.16 曾在选卡后自动导入全部 session 到 app-local-data；该行为因磁盘占用由 D-026 取代。 |
| D-024 | 产品不支持 Flatpak；仓库不保留 Flatpak manifest、构建脚本或验证脚本，CI/CD 与 GitHub Release 也不得生成 Flatpak。Ubuntu 可原生只读挂载 ext4 SD 卡。 |
| D-025 | Ubuntu 22.04+ x86_64 通过原生 `.deb` 正式分发，由 Ubuntu 22.04 runner 构建并通过 `apt` 真实安装、依赖/资源回读和 Xvfb 启动检查。该 deb 是当前唯一进入 GitHub Release 的 Ubuntu 安装包。 |
| D-026 | 正常 UI 不再调用导入器或创建 `appLocalData/imports` 数据副本；选择源后扫描全部 session，首条直接检查/回放，其他 session 按需读取。除保存标注时更新当前 episode 的 `description.json` 外不写源目录；源卷在使用期间必须保持挂载，保存标注时必须可写。 |
| D-027 | 轨迹编号只能由 Rust 在保存标注时原子分配；前端只能选择/创建任务、编辑描述和显示编码预览，不能提交自定义轨迹编号。 |
| D-028 | macOS AppleDouble `._*` 和 `.DS_Store` 是平台元数据，不属于采集数据；扫描统计、数据指纹、校验和显式导入统一忽略这些文件，但不得删除或修改。应用管理的根级 `description.json` 及其 partial 同样不参与采集统计和指纹；正式 `description.json` 会随显式导入复制并校验，partial 不进入导入。其他非数字 JPEG 文件名仍按 `INVALID_FRAME_FILENAME` error 处理。 |
| D-029 | 后续 Release 不再构建或发布 macOS Intel/x64 DMG；macOS 正式分发仅保留 Apple Silicon/arm64。已经公开的旧 tag 和其中的 x64 资产保持不可变历史，不删除、不覆盖，也不代表继续维护。 |
| D-030 | 本机已保存的 episode 标注可作为批量导出清单，但标注不复制或缓存源数据。批量导出只处理仍可从原规范化路径读取且指纹与标注时一致的完整 episode；所有条目共用一个目标目录和一种格式，按顺序重新检查并导出。单条失败不阻断后续条目；取消会中止当前未完成条目并停止后续队列，同时保留已经原子发布的输出。 |
| D-031 | 已登录用户通过固定公网镜像 `http://39.155.172.162:17879` 和固定局域网镜像 `http://10.1.11.200:17879` 检查更新，以避免 NAT loopback。发现更高 semver 时，在当前长任务完成后，客户端并行请求两端同一精确版本资产的 32 KiB `Range` 样本，在 1 秒受限窗口内按实际完成时间选择最快路径；不支持 Range、超时或格式不正确的源不参与选择，若两端都无法测速则保留已验清单路径。完整下载、精确大小检查、嵌入应用的 Ed25519/Minisign 验签、安装和重启不变。客户端不得直连 GitHub，只接受上述两个精确 scheme/host/port 和 `releases/vX.Y.Z/` 目录；更新包必须为 1-64 MiB 且流式读取不得越界。镜像只会在受信任的请求 Host 匹配局域网地址时返回局域网资产 URL，其他请求使用公网 URL；Tauri 的 `dangerousInsecureTransportProtocol` 只能为这两个固定 HTTP endpoint 启用，且不能替代 Rust 的 origin、大小或签名 hard gate。镜像机每 5 分钟从 `Lr-2002/Delta-Viewer` 官方 HTTPS Release 同步，完整验证三个 target、文件名、大小、SHA-256 和签名后原子激活；同步失败继续提供上一完整版本，并以只读 GET/HEAD 同时提供三个正式安装包和 SHA-256 页面。不得随请求发送账号、源路径、标注、报告、hash 或遥测。Windows 使用 NSIS updater，macOS 使用 ad-hoc sealed app archive，Ubuntu 使用 x86_64 deb；Linux 安装可触发系统提权确认。检查、下载、验签或安装失败必须可见、可重试并保持当前版本可用。HTTP 的可用性可被网络攻击者干扰，但任何未通过内嵌公钥验签的字节都不得安装。`0.17.12` 是公网地址自动更新引导版，旧版本需从镜像页手动安装一次。 |
| D-032 | 标注保存后必须向固定证书用户中心上传幂等白名单事件：账号由登录 token 推导，payload 只含事件 ID、操作类型、task ID、trajectory code、revision、标注开始/结束/操作时间。禁止上传源路径、episode ID、描述、片段文本、图像、状态、检查结果、报告或 hash。服务以不可覆盖事件统计每用户完成轨迹数、操作次数和标注耗时；质量评分字段首版为空，只能由后续独立质量检测产生，不能由客户端自报。 |
| D-032 | episode 根目录中的可选 SMPL/骨架 NPZ（优先 `smpl_skeleton.npz`，也接受文件名包含 `smpl` 或 `skeleton` 的 `.npz`）由 Rust 直接从只读源读取；支持常见的 `(frames,joints,XYZ)`/`(frames,XYZ,joints)` 浮点坐标数组和可选 frame ID 数组，受有界大小限制。展示层从有限多帧估计髋部到头部/肩部的固定竖直方向并对齐 Three.js `Y-up`，使不同源坐标系默认直立，同时保留后续帧相对该固定坐标系的真实倾斜。解析失败只在回放右侧显示可行动错误，不阻断图像和状态回放；骨架流程不复制、不修改源 NPZ，也不进入三种导出。 |
| D-033 | 登录会话是数据 IPC 的安全边界。未选择登录模式时返回 `WORKSPACE_MODE_REQUIRED`，无会话时返回 `AUTH_REQUIRED`；旧版持久化的离线选择升级后转换为登录模式，任何显式离线选择均返回 `OFFLINE_MODE_DISABLED`。退出必须清空当前工作区状态。 |
| D-034 | 顶部当前版本旁提供只读历史版本入口，按 Changelog 展示带日期的发布记录；历史列表不提供任意降级或安装能力。 |
| D-035 | 监管端按任务数量分配不重叠的 episode 序号区间；用户中心不得接收 NAS 路径或 episode ID。每台工作电脑仅在本机保存一次已挂载 NAS 根目录，普通账号后续登录后自动扫描并只展示其序号区间内的视频条目。 |
| D-035 | 管理员登录后进入应用内监管工作台，可查看账号任务分配、当天及累计完成数量和平均完成时间，并维护任务说明；管理员还可手动选择本地标注 JSON，按每个 episode 的最新修订查看每位标注人的任务、轨迹数、片段数、闭区间覆盖帧数和轨迹明细。该 JSON 只在客户端本地解析，不扩展 D-032 用户中心审计 payload；普通账号不得访问监管 API。 |
| D-036 | 读取流程同时识别 `h264-split-mp4-v1` 记录：根级 `manifest.json` 声明五路固定流的分段 MP4、帧率、帧数和分辨率，`states.jsonl` 使用 60 Hz `batch_id` 主时间轴并允许位姿位于可空的 `pose` 对象中。界面按主时间轴和各流清单帧率只读同步解码预览，不修改或复制 MP4；连续播放必须复用每路持续的视频解码上下文，不得逐帧启动 FFmpeg，运行时本地媒体权限只允许清单列出的、规范化后仍位于当前 episode 内的普通 MP4 文件。隐藏的 recorder benchmark/QC 目录不作为 episode。首版 MP4 兼容范围仅为扫描、状态读取和回放；仍依赖逐帧 JPEG 语义的 MCAP/HDF5/LeRobot adapter 必须后端明确阻断，直至各格式完成 MP4 原生适配与回读验收。 |
| D-037 | 监管工作台保留原任务完成概览，从已扫描任务目录和已导入任务详情生成统一任务池；具体分配工作区仅在管理员点击某个操作员的分配入口后出现，并可显式关闭返回概览。管理员按操作员勾选具体任务，并为每类任务填写不超过目录总量的正整数数量；服务持久化任务名到数量的精确映射，总分配量为各项之和。界面展示任务完成量、详情和重复分配提示，支持搜索、当前结果全选与清空；旧账号的数字分配值不在新界面展示，首次保存具体任务后转为结构化分配。 |

### 3.1 分段标注首版边界

`v0.17.18` 首次增加“分段标注”编辑能力，并直接融合到回放首页的
多路回放区域下方，不占用独立顶级 Tab，复用五路画面的当前帧和播放状态。首版
只提供绑定当前已加载 episode 的当前会话草稿。草稿默认以完整轨迹创建片段 1，用户可在当前帧分割所在片段，形成覆盖完整轨迹且互不重叠的连续闭区间，并可编辑
片段名称和注解、点击时间线跳转。切换 episode 或刷新后清空，不写源卡；保存后由
Rust 通过登录门禁将片段和修订审计追加写入 appLocalData，并由三个 adapter 以伴随
Metadata JSON 继承。分段草稿不得取代回放和导出所使用的单一连续闭区间时间裁剪；
该裁剪始终提供范围滑块、数值输入、当前帧设点和重置操作。

## 4. 产品目标

### 4.1 核心目标

1. 让非开发用户在一套桌面界面内直接检查、回放和导出已挂载 SD 卡中的数据。
2. 扫描、检查、回放和导出保持只读，且不自动创建等量本地副本；标注保存只写很小的根级 `description.json`。
3. 在导出前暴露空流、缺帧、JPEG 解码、状态解析和时间戳问题。
4. 让五路图像和状态曲线在同一帧位置同步查看。
5. 让用户像视频编辑器一样快速选择一段轨迹并预览，然后导出同一段数据。
6. 通过 adapter 降低新增数据格式的成本，并保持各格式语义清晰。
7. 在无网络环境中完成核心工作流。
8. 用统一管理账号或离线本机 provenance、任务标注和唯一轨迹编码记录数据处理归属，并让三种导出继承同一语义。
9. 让用户从本机标注目录一次选择多条完整轨迹，按统一格式批量导出并逐条查看结果。
10. 在客户端无法访问 GitHub 时，通过固定 IP 签名镜像让引导版自动升级到完整通过发布门禁的新版本。

### 4.2 成功指标

- 正常 UI 选择源后不会调用导入 IPC，也不会新增 `appLocalData/imports` 数据副本。
- 固定抽检位置上的已知损坏 JPEG，以及任意位置的空流、无效状态 JSON 和非单调时间戳均能被交互检查检出；正式全量检查能检出任意位置的已知损坏 JPEG。
- 每个 warning/error 检查结果都有可回读的本地后台报告；ok 不产生无意义报告，健康检查和报告过程本身不发起网络请求。
- 每个用户可见的操作失败都有可回读的本地历史记录；关闭提示或重启应用后，最近 200 条仍可在界面查看。
- 标准测试记录能够成功导出三种格式并被各自读取器重新打开。
- 用户从选择源到看到第一条进度反馈不超过 1 秒。
- Windows 10/11 目标机断网时可以完成安装后的完整工作流。
- macOS 12+ Apple Silicon 目标机可通过签名并 notarized 的 DMG 安装并完成同一离线工作流。
- Ubuntu 22.04+ x86_64 目标机可通过原生 deb 安装，并从已挂载的 ext4/exFAT SD 卡完成同一离线工作流。
- 现场用户无需命令行脚本即可完成主要任务。
- 相同应用数据目录中不会把一个轨迹编码分配给两个不同 episode；每次标注修订记录统一管理账号或固定离线本机 provenance 标记。
- 批量导出只从后端可信的最新标注生成候选项；源断开、路径身份变化或指纹变化的条目不会被导出，其他有效条目仍可继续。
- 引导版只访问固定 IP 镜像，发现更高版本后先以受限 Range 样本并行选择最快可用路径，再安装通过嵌入公钥验签且大小受限的当前平台更新包；镜像断开、断网或更新失败不影响本地数据工作流。

### 4.3 非目标

- 不直接读取 Windows 无法挂载的 ext4 分区。
- 不提供 SSH、云同步、远程上传或多人协作；局域网用户中心只负责统一登录和管理员账号生命周期。
- 不在 SD 卡上修复、重命名、删除或覆盖采集文件；唯一例外是保存标注时原子更新根级 `description.json`。
- 不提供多段拼接、多轨编辑、逐帧标注或训练任务管理；当前标注范围只包含 episode 级任务、描述、轨迹码和处理人。
- 不自动推断机器人 action 或 task 语义；任务由用户选择或本地创建，描述允许人工编辑。
- 不提供云账号、组织级角色权限、跨机器标注同步或忘记密码服务；当前主机局域网用户中心仅提供账号登录和管理员创建账号。
- 不缓存源 JPEG 或状态文件；源卷移除后不能继续回放、检查或导出。
- 首版批量导出不保存或复用单条回放页的临时裁剪范围，只导出每个已标注 episode 的完整轨迹。

## 5. 用户与使用场景

### 5.1 主要用户

| 用户 | 目标 | 关注点 |
| --- | --- | --- |
| 采集操作员 | 从 SD 卡安全取出数据并判断采集是否有效 | 简单、进度明确、不能误删源数据 |
| 数据工程师 | 复核数据并转换为分析格式 | 完整性、时间轴、格式可验证 |
| 机器人算法工程师 | 获得可用于工具链或训练的数据 | MCAP/HDF5/LeRobot 兼容性和字段语义 |
| 发布工程师 | 构建和签发 Windows 安装包 | 离线依赖、许可证、可重复构建 |

### 5.2 典型场景

1. 用户先选择工作模式：统一管理模式由管理员在当前主机初始化用户中心并创建操作员账号，操作员导入证书配置后登录；离线模式不要求账号，直接进入本机工作区。
2. 操作员插入 exFAT SD 卡并选择卡根目录，应用扫描记录并自动选择第一条 session。
3. 应用直接从源路径只读加载首条 session，运行结构/状态检查和固定百分位 JPEG 抽检；不创建本机数据副本。
4. 其余 session 保持可用状态，用户从左侧双击或按 Enter/空格时按需从源路径读取和检查。
5. 用户选择现有任务或只输入名称创建任务，查看自动编码预览并按需要编辑任务描述；保存时由系统原子分配编号并记录统一管理账号或离线本机 provenance。
6. 用户在五路画面和状态曲线之间同步定位异常帧，并设置起止帧。
7. 用户选择目标格式和目录，生成继承轨迹码、任务和 provenance 的数据集并获得输出路径和统计信息。
8. 用户也可以打开“批量”页，从本机最新标注中选择多条源仍在线的完整轨迹，以同一种格式导出到同一目标目录。

## 6. 端到端流程与状态

```text
物理 SD 卡
   |
   v
选择工作模式 -> [统一管理配置/登录 | 离线直接进入] -> 选择目录 -> 自动扫描全部 episode -> 只读加载首条/按需加载其他记录
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

前台同一时间只允许一个长任务。正常 UI 长任务包括扫描、读取、检查和导出，共享统一进度条和取消入口；导入任务仅由压力验收路径使用。

| 状态 | 含义 | 允许操作 |
| --- | --- | --- |
| 未选择 | 没有数据源 | 选择 SD 卡目录 |
| 未选择模式 | 没有工作模式选择 | 选择统一管理或离线模式；数据 IPC 不可用 |
| 统一管理未登录 | 没有用户中心登录会话 | 导入管理员配置并登录；数据 IPC 不可用 |
| 已扫描 | 已发现 episode，尚未写入源目录 | 首条自动读取；其他记录按需进入 |
| 读取中 | 正在读取源记录 | 查看进度、取消；保持源卷连接 |
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
  description.json              可选，DOHC Viewer 保存的任务描述 metadata
```

规则：

- 五个流名称固定为 `cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`。
- JPEG 文件名的 stem 是十进制 `frame_id`。
- Episode 可以是用户选择的目录本身，也可以是所选目录的直接子目录。
- `description.json` 使用 format-v2 保存 `description`、可选的 `clipStartFrame`/`clipEndFrame` 和连续 `segments` 数组（每项包含 `startFrame`、`endFrame`、`title`、`note`）；它不参与采集数据指纹、健康统计或导出门禁，但显式导入会复制并验证该文件。
- `v1.0` 不递归发现多层嵌套 episode。
- 扫描时不得跟随符号链接。
- 记录器应使用 `YYYY-MM-DD_HH-MM-SS` 目录名，不能使用 Windows 保留字符。

MP4 记录可使用以下只读预览结构：

```text
episode/
  manifest.json                 storage_format 为 h264-split-mp4-v1
  cam0/cam0-00000.mp4
  cam1/cam1-00000.mp4
  cam2/cam2-00000.mp4
  t265_left/t265_left-00000.mp4
  t265_right/t265_right-00000.mp4
  states.jsonl                  60 Hz batch_id 主时间轴，pose 可空
```

后续分段按清单中的 `segments[].path` 顺序读取；每一路以清单 `fps` 将主时间轴
映射到本路帧序号。源 MP4 和清单保持只读，当前不进入三种 JPEG 导出 adapter。

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
- 帧 180-195 存在 170-369 ms 的状态时间间隔，基准中位数为 33.9 ms，因此预期得到 `TIMESTAMP_GAP` warning。中位帧率约为 29.50 FPS，仍在 30 FPS 的 ±5% 容忍范围内；约 91.8% 的有效间隔落在中位周期 ±10% 内，仍达到 90% 基本稳定门槛，因此不产生帧率不匹配或不稳定 warning。

## 8. 功能需求

优先级定义：P0 为首发阻断，P1 为首发后高优先级，P2 为候选需求。

### 8.1 数据源与扫描

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-SRC-001 | P0 | 用户可以选择物理 SD 卡挂载目录、本地测试目录或操作系统已映射的网络文件系统目录。 | 仅接受操作系统可见的目录路径（包括 Windows 映射盘、SMB/NFS 挂载），不出现 URL/SSH 输入；网络目录只读，不自动复制。 | 已实现 |
| FR-SRC-002 | P0 | 扫描目录本身及其直接子目录中的 episode。 | 至少含 `states.jsonl` 或一个已知流目录时可被发现。 | 已实现 |
| FR-SRC-003 | P0 | 展示 episode 名称、文件数、总大小、状态数和五路流概况。 | 侧栏可以比较多个 episode。 | 已实现 |
| FR-SRC-004 | P0 | 扫描过程可见且可取消。 | 显示阶段、路径、计数/字节和耗时；取消后不开始读取或检查。 | 已实现 |
| FR-SRC-005 | P0 | 采集文件在整个应用流程中只读，源端写入仅限标注描述。 | 扫描、检查、回放和导出不修改源；保存标注只在当前 episode 根目录以 partial、回读和原子替换写 `description.json`，其他源路径写入、重命名或删除均不存在。 | 已实现并测试；实卡仍待验收 |
| FR-SRC-006 | P1 | 明确显示卷类型、可移动介质状态和可用容量。 | UI 可以区分 SD 卡、普通本地目录和网络磁盘。 | Windows/macOS 已实现，虚拟 ExFAT 识别通过；待实机验收 |
| FR-SRC-007 | P0 | 左侧 episode 列表只负责 session 选择和进入回放。 | 单击只更新选中项，不切换主工作区；双击或聚焦后按 Enter/空格从源路径读取并检查后进入回放；选中身份始终绑定源 session。 | 已实现并通过三视口交互检查 |
| FR-SRC-008 | P0 | 选择 SD 卡目录后自动发现全部 session。 | 扫描成功后首条记录直接只读检查并回放；其他记录显示可用状态并按需读取；正常 UI 不调用 `import_episode` 或创建数据副本。 | 已实现并通过 browser 回归 |
| FR-SRC-009 | P0 | 忽略不属于采集数据的 macOS 文件系统元数据。 | `._*` 和 `.DS_Store` 不进入文件数、总大小、数据指纹、帧索引、校验或显式导入；源文件保持不变，其他非法 JPEG 名仍报错。 | 已实现并测试 |

### 8.2 显式导入与完整性（非正常 UI）

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-IMP-001 | P1 | 导入器只用于 formal/development stress 和未来显式离线导入。 | 正常 React UI 没有自动导入调用；stress 仍可在独立工作卷执行完整导入。 | 已实现 |
| FR-IMP-002 | P0 | 文件按稳定相对路径顺序复制。 | 相同输入产生相同 manifest 和数据集哈希。 | 已实现 |
| FR-IMP-003 | P0 | 复制时计算每个源文件的 BLAKE3。 | Manifest 包含相对路径、大小和 64 个十六进制字符的 BLAKE3 文本。 | 已实现 |
| FR-IMP-004 | P0 | 复制后重新打开目标文件，校验大小和 BLAKE3。 | 任一不一致立即失败，不发布最终目录。 | 已实现并测试 |
| FR-IMP-005 | P0 | 成功后写入 `.dohc-manifest.json`。 | Manifest 含格式版本、源名称、总文件数、总字节、数据集 BLAKE3 和文件列表。 | 已实现 |
| FR-IMP-006 | P0 | 最终目录通过同文件系统原子重命名发布。 | 处理中仅存在 `.partial-*`；成功后才出现正式目录。 | 已实现 |
| FR-IMP-007 | P0 | 不覆盖已有目录。 | 名称冲突时使用 `_2`、`_3` 等确定性后缀。 | 已实现 |
| FR-IMP-008 | P0 | 非法 Windows 文件名被安全转换。 | 冒号、斜杠、控制字符和保留设备名均被处理。 | 已实现 |
| FR-IMP-009 | P0 | 导入前检查目标剩余空间和文件系统能力。 | 空间不足或不支持大文件时，在复制前阻止任务。 | 已实现 |
| FR-IMP-010 | P1 | 取消/失败的 partial 目录可被识别和清理。 | 下次启动可提示清理，不会把 partial 当作 episode。 | 已实现 |
| FR-IMP-011 | P1 | 显式导入在复制前执行完整数据健康检查。 | 全量解码五路 JPEG、检测近乎全黑图像并统计状态帧率/稳定度；warning/error 报告只写 app-local `reports`，检查报告随导入结果返回，源目录不写入。 | 已实现并测试 |

Manifest `formatVersion=2`。采集数据文件集合明确排除 macOS AppleDouble `._*` 和 `.DS_Store`；其余每个文件的 `sourcePath` 保存 UTF-8 原始相对路径，`path` 保存逐组件清理后的 Windows 安全目标相对路径。若清理或大小写折叠后发生碰撞，必须在复制前阻止导入。数据集 BLAKE3 的输入序列定义为：对按原始 `sourcePath` 排序的每个文件依次写入 UTF-8 原始相对路径、单个 `0x00`、小端 `u64` 文件大小、该文件 BLAKE3 的 ASCII 十六进制文本。

上述导入契约继续作为压力验收能力保留，但正常用户工作流直接从源路径只读检查、回放和导出。历史 `appLocalData/imports` 副本不会自动删除。

### 8.3 数据健康检查

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-VAL-001 | P0 | 解析 `states.jsonl` 每个非空行。 | 无效 JSON、缺字段或类型不符产生 error。 | 已实现 |
| FR-VAL-002 | P0 | 检查状态中的 NaN/Infinity。 | 任一非有限值产生 error。 | 已实现 |
| FR-VAL-003 | P0 | 检查状态帧号和时间戳顺序。 | 帧号跳变为 warning；非单调时间戳为 error。 | 已实现 |
| FR-VAL-004 | P0 | 检测明显时间戳间隔异常，并验证状态帧率和稳定度。 | 正 delta 的中位数存在时，超过中位数 3 倍产生 warning；以相邻状态记录的递增 frame ID 步长归一化原始纳秒周期并取中位数计算帧率，偏离 30 FPS 超过 ±5% 时产生 warning；落在中位周期 ±10% 内的间隔不足 90% 时产生 warning。 | 已实现并测试 |
| FR-VAL-005 | P0 | 检查五路图像是否为空。 | 流目录缺失或零帧产生 error。 | 已实现 |
| FR-VAL-006 | P0 | 检查图像 frame ID 连续性。 | 首尾范围内缺失位置产生 warning，并报告数量；加载后在右侧确认是否进入标注，选择不标注时跳到下一条。 | 已实现 |
| FR-VAL-007 | P0 | 交互检查按排序后帧序列的 `1% / 25% / 50% / 73% / 99%` 固定位置解码 JPEG；正式压力/发布检查解码全部 JPEG。 | 小于五帧时百分位去重；抽检或全量模式中无法解码的帧产生 error，并记录 stream/frame。 | 已实现并测试 |
| FR-VAL-008 | P0 | 检查被解码 JPEG 与该流首帧 header 尺寸是否一致。 | 交互模式覆盖五个固定抽检位置，正式模式覆盖全量；不一致产生 error。 | 已实现并测试 |
| FR-VAL-009 | P0 | 对比图像帧数和状态条数。 | 数量不一致产生 warning。 | 已实现 |
| FR-VAL-010 | P0 | 提供汇总与逐问题视图。 | 每项明确显示错误/警告/通过，按错误、警告、通过排序；展示已检查文件数、耗时、各流总帧、实际抽检/检查帧数、解码失败数和 issue code。 | 已实现 |
| FR-VAL-011 | P0 | error 在 UI 和 Rust 导出入口形成双重阻断。 | 不能通过直接调用 IPC 绕过检查。 | 已实现并测试 |
| FR-VAL-012 | P1 | 导出机器可读检查报告。 | 检查页使用“导出报告”操作，可生成包含版本、图像检查模式/百分位、issue 和统计的 JSON 文件。 | 已实现并测试 |
| FR-VAL-013 | P0 | warning/error 在检查完成后自动生成本地后台报告。 | 写入应用 local-data 的 `reports` 目录，原子发布并回读；相同 episode 路径、指纹和报告版本只保留一份，ok 不生成，任一失败不得伪装成已汇报。 | 已实现并测试 |
| FR-VAL-014 | P1 | 标注抽检或全量解码中近乎全黑的图像。 | 对每张已解码图像做最多约 32×32 点的有界亮度采样；平均亮度不高于 8 且至少 99.5% 采样点不高于 8 时，该流生成一个带首个命中 `frameId` 和命中数的 `BLACK_SCREEN` warning。 | 已实现并测试 |
| FR-VAL-015 | P1 | 检查状态 position 轨迹是否静止或没有有效位置变化。 | 至少两条有限 position 的记录全部与首条相同（每个坐标差不超过 `1e-6`）时，生成带首个 `frameId` 的 `TRAJECTORY_STATIC` warning 并直接跳过该条，不进入标注；position 为 `null`、`[null,null,null]` 或没有完整有限三维位置时生成 `TRAJECTORY_POSITION_UNAVAILABLE` warning 并直接跳过该条。 | 已实现并测试 |

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
| `FRAME_RATE_MISMATCH` | warning | 状态中位帧率偏离期望 30 FPS 超过 ±5% |
| `FRAME_RATE_UNSTABLE` | warning | 落在中位帧周期 ±10% 内的有效间隔不足 90% |
| `TRAJECTORY_STATIC` | warning | 至少两条有效 position 记录中没有位置变化 |
| `EMPTY_STREAM` | error | 图像流为空或缺失 |
| `INVALID_FRAME_FILENAME` | error | 排除 `._*` 平台元数据后，JPEG 文件名仍不能映射为非负十进制帧号 |
| `DUPLICATE_FRAME_ID` | error | 多个 JPEG 文件名映射到同一帧号 |
| `MISSING_FRAMES` | warning | 图像 frame ID 范围内缺帧 |
| `FRAME_ID_MISMATCH` | error | 数量相同时图像和状态 frame ID 集合不一致 |
| `DECODE_FAILED` | error | JPEG 无法解码 |
| `BLACK_SCREEN` | warning | 已解码图像中发现近乎全黑帧 |
| `DIMENSION_MISMATCH` | error | 同一流帧尺寸不一致 |
| `COUNT_MISMATCH` | warning | 图像帧数与状态数不一致 |
| `TRAJECTORY_POSITION_UNAVAILABLE` | warning | 状态记录没有完整有限的 position 三维值，数据不进入标注 |

机器可读报告使用 `formatVersion=6`，包含 `episodeRoot`、`parsedStateCount`、`imageValidationMode`（`sampled` 或 `full`）、`imageSamplePercentages`、`stateFrameRate`（目标 FPS、实测中位 FPS、容忍百分比、有效间隔数、稳定度百分比和稳定状态）、`autoReportPath`、文件/流统计和完整 issue 列表。每个流的 `checkedFrames` 是实际解码数；抽检报告固定记录 `[1,25,50,73,99]`，全量报告记录空数组。可定位的 issue 附带可选 `frameId`。报告先写入隐藏 partial 文件并回读验证，再原子发布，同名时不覆盖。抽检报告不代表未抽中 JPEG 已通过解码或黑屏检查。`TRAJECTORY_POSITION_UNAVAILABLE` 是 `states` scope 的 warning：当全部状态记录的 `position` 为 `null`、`[null,null,null]` 或无完整有限三维位置时生成，前端自动跳过该条，不能进入标注。

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
| FR-VIS-008 | P1 | 支持按 issue 跳转到相关帧。 | 状态 scope 的 issue 保持状态时间轴定位；流 scope 的 issue 先按该流的首尾帧范围校验，只有存在同 frame_id 的状态时才切换到该精确帧。没有同步状态时必须明确提示，不能静默跳到相邻状态帧。 | 已实现 |
| FR-VIS-009 | P0 | 提供单条轨迹的起止帧裁剪控件。 | 起点/终点滑块、数字输入、按当前帧标记和重置均可用；起点不晚于终点。 | 已实现 |
| FR-VIS-010 | P0 | 回放和时间轴遵循选中裁剪范围。 | 播放从起点开始并在终点停止，画面、曲线和片段状态数保持一致。 | 已实现 |
| FR-VIS-011 | P1 | 连续播放不显示逐帧加载文案，并在目标帧解码前保留上一张已成功解码的图像。 | 播放过程中不出现“解码中”覆盖层；暂停、拖动或步进等待帧时保留加载提示和上一张已解码图像。新图仅在解码完成后替换；请求帧不可用时清除旧图并显示明确错误。 | 已实现 |
| FR-VIS-012 | P1 | 在存在 SMPL/骨架数据时，用 Three.js 在五路图像右侧显示与当前 frame ID 同步的三维骨架。 | 桌面窗口中骨架面板位于图像右侧并有可交互视角，SMPL/COCO 的 Y-up 或 Z-up 源坐标默认以直立方向打开；窄窗口按顺序显示在图像下方；缺少或解析失败时保留图像回放并显示明确状态。 | 已实现并通过 browser 检查 |
| FR-VIS-013 | P1 | cam0 作为主要相机画面在桌面五路网格中放大。 | cam0 跨两行且使用 2.2 倍网格轨道，从画面中心保持原始比例向可用空间扩展；960x680 和窄视口无横向溢出。 | 已实现并通过 browser 检查 |

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
| FR-EXP-010 | P1 | 已标注 episode 的三个 adapter 使用统一轨迹码和标注元数据。 | 输出基础名称使用轨迹码；MCAP、HDF5、LeRobot 的正式输出内嵌任务、处理人和裁剪后的片段数组，并各自附带原子发布、回读验证的 `metadata.json`；结果返回实际 `metadataPath` 供 Windows/macOS/Linux 界面确认；未标注数据兼容原名称。 | 已实现并测试 |
| FR-EXP-011 | P1 | 已选择工作模式的用户可以查看本机最新标注并选择源仍可用的条目。 | 清单只由 Rust 从 `appLocalData/annotations` 回读，统一管理显示处理人，离线显示本机来源而不显示为账号；两种模式都显示轨迹码、任务、描述、修订和源状态；前端不能提交任意源路径冒充标注。 | 已实现并测试 |
| FR-EXP-012 | P1 | 用户可以把多条已标注完整 episode 顺序导出为同一种格式。 | 每条在导出前重新核对规范化路径和数据指纹、执行交互健康检查并写入可信缓存；warning 经一次批量确认后允许，error 或单条故障记录失败并继续；每条失败结果写入本机不可覆盖日志并返回路径，成功结果可直接定位输出；取消停止剩余条目，已完成输出保留。 | 已实现并测试 |

#### 8.5.1 MCAP 契约

- 输出为单个 `.mcap` 文件。
- `/dohc/state`：`json` 编码，使用 `dohc.State` JSON Schema，保留完整原始状态字段。
- `/dohc/pose`：`protobuf` 编码，schema 为官方 `foxglove.PoseInFrame`，由 position/quaternion 映射机器人位姿。
- `/dohc/camera/{stream}`：`protobuf` 编码，schema 为官方 `foxglove.CompressedImage`，`format=jpeg`，`data` 为原始 JPEG。
- 消息 `log_time` 和 `publish_time` 使用原始 `capture_time_ns`。
- Foxglove protobuf 的 `Timestamp` 与图像/位姿消息使用同一 capture time；`frame_id` 分别为 `dohc_base` 和流名。
- 五个图像 channel 的 metadata 包含 `mime_type`、`width` 和 `height`。
- 数据集 metadata 包含源名称、状态条数和 `clip_start_frame`/`clip_end_frame`；存在标注时增加轨迹码、任务 ID/描述、统一管理处理人账号/显示名或离线本机 provenance，以及 `segment_annotations_json` 片段数组。
- `dohc.dataset` metadata 必须包含 `dohc_provenance_version`、选中范围的 `capture_started_at_ns`/`capture_ended_at_ns`、`exported_at_ms`/`exported_by_*`；存在标注时增加 `annotation_created_at_ms`、`annotation_updated_at_ms`、`annotation_edit_started_at_ms`、`annotation_edit_duration_ms` 和修改人字段。
- 文件必须能被 Foxglove Desktop 打开；Image panel 可选择五路图像，3D panel 可选择 `/dohc/pose`，Raw/Plot panel 可读取 `/dohc/state`。

#### 8.5.2 HDF5 契约

- 输出为单个 `.h5` 文件，根属性包括 `format=dohc-hdf5`、`format_version=1` 和 `source_name`。
- 根属性同时保存 `clip_start_frame` 和 `clip_end_frame`。
- 根属性和 `/provenance` 必须记录采集起止纳秒时间、标注创建/修改时间、修改耗时、修改人、导出时间和导出人；`dohc_provenance_version=1`。
- 存在标注时，根属性保存 `trajectory_code`、`task_id` 和处理来源；统一管理模式保存 `processed_by_username`，离线模式保存固定本机 provenance；`/annotation` 以 UTF-8 字节 dataset 保存任务描述、可选处理人显示名和 `segments_json_utf8` 片段数组。
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
- `info.json.dohc_provenance` 记录采集起止时间、导出时间和实际导出人；`dohc_annotation` 记录标注创建/修改时间、修改起始时间和修改耗时。
- 存在标注时，`tasks.jsonl`/`episodes.jsonl` 使用可编辑任务描述，`info.json.dohc_annotation` 保存轨迹码、任务、修订号、统一管理处理人或离线本机 provenance，以及裁剪后的 `segments` 片段数组。
- `codebase_version` 固定为 `v2.1`。
- `info.json` 保存 `clip_start_frame`、`clip_end_frame`；裁剪输出目录名包含
  `_frames_START-END`，完整导出保持原有目录名。
- 标准 `timestamp` 使用 `frame_index / fps`，与恒定帧率 MP4 对齐。
- 原始纳秒时间保存在 `observation.capture_time_ns`，类型为 int64。
- 原始状态映射为 observation；不得生成虚构的 action。
- FPS 从正时间差的中位数估算，并在 5% 内吸附到常见帧率；标准样例应得到 30 FPS。
- FFmpeg 查找顺序为 `DOHC_FFMPEG`、应用资源目录、系统 PATH。Windows 发布版必须命中应用资源目录。

### 8.6 工作模式、局域网用户中心账号与数据标注

| 编号 | 优先级 | 需求 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FR-AUTH-001 | P0 | 首次启动选择统一管理或离线模式。 | 选择记录写入本地 `workspace-mode` 追加记录并在重启后恢复；统一管理模式可导入管理员配置、登录和退出，离线模式直接进入本地工作区。 | 已实现并测试 |
| FR-AUTH-002 | P0 | 数据工作区和数据 IPC 按工作模式执行后端门禁。 | 未选择模式直接调用数据 IPC 返回 `WORKSPACE_MODE_REQUIRED`；统一管理未登录返回 `AUTH_REQUIRED`；离线模式允许本地扫描、加载、检查、标注和导出，但用户中心/更新 command 返回 `MANAGED_MODE_REQUIRED`。 | 已实现并测试 |
| FR-AUTH-003 | P0 | 用户中心管理员创建操作员账号。 | 服务首次初始化只能在主机本机创建首个管理员；普通账号无自助注册入口，管理员页面创建的账号才能登录客户端。 | 已实现并测试 |
| FR-AUTH-004 | P0 | 用户可以切换工作模式。 | 切换前清空当前 episode、检查、任务、标注和更新状态；离线界面不显示账号、登录、退出、处理人或自动更新；切回统一管理后重新要求登录。 | 已实现并测试 |
| FR-ANN-001 | P0 | 回放首页支持选择已有任务或只输入名称创建本地任务；任务描述可编辑。 | 新任务立即进入任务选择并以任务名作为默认描述；`close_oven` 仍自动带出内置默认描述。 | 已实现并通过 browser 交互测试 |
| FR-ANN-002 | P0 | 轨迹码使用任务前缀和至少三位序号，且只能由 Rust 在保存时分配。 | 前端只读显示预览、不提交轨迹码；`close_oven` 依次使用 `oven-001`、`oven-002`，自定义任务使用系统生成前缀；后端以原子占号防止跨 episode 重复。 | 已实现并测试 |
| FR-ANN-003 | P0 | 标注记录数据身份、处理来源、整体描述、片段和修订历史。 | 绑定规范化 episode 路径与指纹；每次保存先在 episode 根目录原子写入并回读 format-v2 `description.json`（整体描述、裁剪范围和完整连续片段），再追加不可覆盖的本机修订文件。统一管理模式记录账号，离线模式记录固定本机 provenance 标记且 UI 不显示为处理人；`description.json` 不改变采集指纹。 | 已实现并测试 |
| FR-ANN-004 | P1 | 用户可以删除不再需要的自定义任务。 | 删除经 Rust 身份门禁执行，只移除 app-local 普通任务文件；内置任务返回 `TASK_BUILT_IN`，任何历史本机标注修订仍引用的任务返回 `TASK_IN_USE`，源数据和历史标注不被修改。 | 已实现并测试 |
| FR-ANN-005 | P1 | 用户可导入本地任务模板 JSON。 | 模板仅写入 `appLocalData/tasks`；每个任务提供一个或多个可选 description 和可选默认片段标题。选择任务或 description 后仍可直接编辑；片段标题由操作员在手动分割时间轴后选择或修改，模板不自动分配区间。导入不读取或修改源数据，任务 ID/编码前缀冲突时拒绝整个配置。 | 已实现并测试 |

用户中心服务将账号和 scrypt 密码哈希写入当前主机服务专属私有目录；客户端将工作模式选择追加写入 `appLocalData/workspace-mode`，统一管理配置写入 Tauri `appLocalData/user-center.json`。用户创建的任务位于 `appLocalData/tasks`，轨迹占号位于 `appLocalData/trajectory-codes`，标注修订位于 `appLocalData/annotations/{episodeId}`。离线模式不创建账号或用户中心会话；本机标记仅用于区分 provenance，不是可登录账号。用户中心只提供身份和管理员账号管理，不提供文件加密、操作系统用户隔离或跨组织权限体系。

内置任务目录如下；用户创建的任务只要求名称，系统据此生成稳定 ID、编码前缀和默认描述：

| Task ID | 显示名 | 编码前缀 | 默认描述 |
| --- | --- | --- | --- |
| `close_oven` | 关闭烤箱 | `oven` | 关闭烤箱门，并确认烤箱门完全闭合。 |

任务模板配置使用 `formatVersion: 1`，包含 `tasks` 数组。每项需要 `label`，并至少提供一个 `description` 或 `descriptions` 条目；`segments` 可选且按顺序提供默认片段标题。示例见 `docs/task-template.example.json`。导入只允许普通 JSON 文件，最大 256 KiB、最多 500 个任务、每任务最多 100 个默认片段；任何任务 ID 或编码前缀冲突都会拒绝该次导入。

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
| NFR-PERF-003 | 压力验收中的显式导入复制阶段吞吐应达到同一设备/目标直接系统复制基线的 70% 以上；正常 UI 不执行该复制。 |
| NFR-PERF-004 | 取消操作在当前 1 MiB 复制块、当前检查帧或 adapter 的下一个安全点内生效，目标体验不超过 1 秒。 |
| NFR-PERF-005 | 标准五路样例在 1x 下目标为 30 FPS，连续 60 秒丢帧率低于 1%，拖动时间轴后 300 ms 内更新首批画面。 |
| NFR-PERF-006 | Windows 发布前必须用至少 100 GB/100,000 文件记录做扫描、导入、检查和每种导出的压力测试。 |
| NFR-PERF-007 | 内存不得随 JPEG 总数据量无界增长；大数据 HDF5 导出若超过内存门槛必须改为流式写入。 |
| NFR-PERF-008 | 选择裁剪范围只建立状态/帧索引，不复制或重编码源 JPEG；回放期间不得因当前帧变化重复扫描全量状态。 |

### 9.2 可靠性与数据安全

- 五路图像、状态、骨架及其他采集文件只读；正常 UI 不创建数据副本。保存标注只允许更新根级 `description.json`，压力验收中的显式导入只写独立工作卷，导出只写用户选择的导出目录。
- 所有完整输出使用 partial + 同文件系统原子 rename 发布。
- 发布操作在 Windows/macOS/Linux 均使用原子 no-replace 语义，不覆盖用户已有文件。
- 原始时间戳和数值数据不得静默修复；规范化字段必须保留原始字段。
- 显式导入的完整性失败必须阻断最终导入目录发布。
- 应用退出或断电后，正式目录应是完整版本；partial 可清理但不可当作成功结果。

### 9.3 兼容性

- 正式安装包支持 Windows 10/11 x64、macOS 12+ arm64 和 Ubuntu 22.04+ x86_64 deb。
- 安装器必须在 Windows 10 以下系统中停止安装。
- Windows 安装包使用 NSIS current-user 模式，不要求管理员权限作为默认路径。
- Windows 安装包包含离线 WebView2 安装器。
- macOS 支持依赖 exFAT 等系统可读文件系统，不提供 ext4 驱动；Ubuntu 使用内核原生 ext4 支持，不额外安装 ext4 驱动。
- 源 SD 卡推荐 exFAT；Windows app-local-data 工作区应位于 NTFS。FAT32 因 4 GB 单文件限制不作为受支持导出目标。

### 9.4 离线、安全与隐私

- 检查、回放、报告和导出等核心数据功能不得发起网络请求；统一管理模式只在进入工作区前连接用户中心，用户中心断开时不影响已经登录的当前进程会话；离线模式不连接用户中心。
- 统一管理模式的唯一运行时联网能力是登录后的自动更新：客户端只访问 `http://39.155.172.162:17879/latest.json`、`http://10.1.11.200:17879/latest.json` 及其同 origin 精确版本资产；离线模式不得检查或安装更新。发现更新后并行下载两个 32 KiB Range 样本，按实测速度选择完整下载路径。不直连 GitHub，不附加账号、源路径、标注、报告、hash 或遥测。失败不得阻断核心功能。
- 更新包必须先匹配清单中的精确字节数和 1-64 MiB 上限，再使用内嵌 Ed25519/Minisign 公钥验签；任一不匹配不得进入安装。固定镜像的 HTTP 传输不替代签名，攻击者即使能修改公网或局域网流量也只能造成更新不可用，不能提供可安装的篡改字节。公钥可提交，更新私钥只能保存在发布者受控位置和 GitHub Actions secrets。
- 镜像机是唯一访问 GitHub 更新元数据/资产的运行时组件；它不记录客户端地址或业务数据，只开放 GET/HEAD，并对单一合法字节范围返回有界 206 响应。新版本必须下载到服务自有 partial，验证完整三平台集合后原子切换，失败保留上一已验证版本。
- 不收集遥测，不上传路径、图像、状态或 hash。
- 用户中心使用 scrypt 和操作系统 CSPRNG 盐；客户端密码只通过固定证书 HTTPS 发送，服务不接收源路径、图像、状态、标注、报告或 hash。
- 工作模式选择、账号、标注与操作错误历史使用当前用户可写的应用 local-data；Unix 新文件权限为 `0600`，Windows 继承当前用户目录 ACL。离线本机 provenance 标记不得被当作用户账号展示。
- 源目录和导出目录选择仅由原生目录对话框触发；正常 UI 不提供导入目标选择框。
- Tauri capability 只开放核心窗口和目录对话框需要的权限。
- Windows/macOS/Linux 发布依赖必须锁定版本并完成许可证审查；构建阶段访问依赖和签名服务不改变安装后核心功能的离线边界。

### 9.5 可维护性

- Rust 和 TypeScript 共享的字段必须有显式类型和 camelCase 序列化约定。
- 每种导出格式必须独立 adapter，不在 UI 中实现格式细节。
- 新 adapter 必须包含真实数据 smoke test 和回读验证。
- 错误、issue code 和 manifest 版本必须保持向后兼容；破坏性变更需要增加版本。
- `Cargo.lock` 和 `pnpm-lock.yaml` 必须提交。

## 10. UI 信息架构

### 10.1 全局区域

- 视觉系统：界面背景、控件、选中态和状态使用黑、白与中性灰；相机画面保持原始颜色，不应用灰度滤镜。telemetry 的 X/Y/Z/W 数据系列使用稳定的红、绿、蓝、紫，并同时使用文字和不同线型区分。
- 顶栏：产品名/当前版本、工作模式、更新状态（仅统一管理模式）、当前源路径、健康状态、选择 SD 卡、操作错误历史，以及统一管理模式的当前账号和退出按钮；离线模式不显示账号、处理人或更新入口。选择后自动扫描全部 session，首条直接从源路径只读检查并进入回放，不提供导入按钮。更新检查失败显示非阻断提示和重试入口。
- 任务条：当前阶段、路径、进度、吞吐/耗时、取消按钮。
- 左侧栏：episode 列表、选中状态、文件数、容量和五路存在状态；单击选择，双击或聚焦后按 Enter/空格进入回放。
- 主工作区：回放、检查、导出、批量四个 tab；没有当前已加载 episode 时仍可进入批量页。

### 10.2 回放页

- `cam0` 为主要大画面，其余四路排列在右侧或窄屏网格中。
- 若 episode 含可识别的 SMPL/骨架 NPZ，三维骨架面板固定放在五路图像右侧；窄窗口改为图像之后纵向排列，并按当前 `frame_id` 同步。面板只读且支持旋转、平移和缩放，不改变源数据。
- 页面顶部是 episode 级数据标注：可以选择、创建或导入模板任务；轨迹码为系统只读预览，description 模板可选且仍可直接编辑，并显示处理人和保存状态。模板只提供可选片段标题，不自动分配时间区间；操作员手动分割后可选择、改名、合并和保存。保存成功必须明确提示 `description.json` 已更新；源不可写时显示失败，不能只保存本机后伪装完整成功。
- 画面必须使用稳定尺寸，加载、错误和帧变化不能引发布局跳动。
- 连续播放期间不显示逐帧“解码中”覆盖层；暂停、拖动或步进时仍可显示加载反馈，帧错误不得隐藏。
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

### 10.5 批量导出页

- 从本机标注目录显示每个 episode 的最新修订；源断开的条目保持可见但不可选择。
- 提供全选可用项、统一 MCAP/HDF5/LeRobot 格式和单个目标目录，不允许前端修改标注绑定的源路径。
- 每条完整 episode 在后端顺序重新检查和导出；成功结果提供“打开文件所在位置”，失败结果显示错误内容并提供独立失败日志及其本机位置。
- 批量取消后显示未处理数量，并明确保留取消前已经完成且通过回读的输出。

## 11. 文件系统与 exFAT 约束

exFAT 可以解决未来 SD 卡在 Windows/macOS 间直接挂载的问题，但不等于把当前 ext4 数据原地转换为 exFAT：

1. 当前 ext4 数据必须先复制并验证。
2. 格式化为 exFAT 会清空卡。
3. 采集设备必须验证 exFAT 驱动、单文件大小、长时写入和异常断电行为。
4. exFAT 不带日志，不能把文件系统可挂载等同于数据一定完整。
5. 记录器必须停止使用冒号等 Windows 非法字符。

exFAT 上线测试至少包括：连续写入目标最长记录时长、接近满盘、突然断电、重新插拔、Win10/Win11/macOS 挂载、单文件超过 4 GB，以及 DOHC Viewer 只读扫描/检查/回放/导出和源端前后 hash 对比。独立 formal stress 仍额外执行显式导入与目标回读。

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

- 最低系统版本固定为 macOS 12.0，只生成 arm64 DMG，不把单架构产物命名为 universal；不再生成 x64 DMG。
- 可分发 app/DMG 必须使用只依赖 macOS 系统库的 reviewed FFmpeg；当前从固定 archive hash 和 commit 的 FFmpeg 8.1.2 官方源码构建最小 LGPL sidecar，Homebrew 动态链接版本只能标记为 local-debug。
- DMG 必须只读挂载验证 app、`/Applications` 链接、版本、架构和 FFmpeg 资源 hash，再将 app 复制到本地目录执行启动 smoke。
- 当前 GitHub Release 允许没有可信发布者身份的 unsigned DMG，但 app、主程序和 FFmpeg 必须使用本地 ad-hoc seal，并通过 `codesign --verify --deep --strict`；文件名、Release 和报告必须明确标记，且不得宣称 Developer ID 或 notarization 已通过。
- 复制后的 app 必须添加 synthetic quarantine；`syspolicy_check distribution` 正常应因 ad-hoc identity 和 missing notary ticket 拒绝。若 runner 返回内部 XProtect 错误，只有现场构建的最小 ad-hoc control app 得到相同结果时才能记录为 policy service unavailable；产品独有的 XProtect 错误、invalid signature、missing resources、damaged 或其他结构问题一律阻止发布。用户首次启动仍需通过系统设置执行一次性“仍要打开”。
- 生产签名阶段仍需让 app/FFmpeg 完成 Developer ID Application 签名和 secure timestamp，并完成 Apple notarization/stapling；证书和 Apple 凭据不进入仓库，签名产物使用新版本/tag 发布。
- GitHub hosted runner 通过后仍需在目标 Apple Silicon Mac 验收。

### 12.3 Ubuntu deb 包要求

- 原生 deb 正式支持 x86_64 Ubuntu 22.04 及以上，文件名固定为 `DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb`。
- deb job 固定在 Ubuntu 22.04 runner 构建。deb 必须声明 `libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`、`librsvg2-2`、提供 H.264 软件解码的 `gstreamer1.0-libav` 和可用时提供硬件解码的 `gstreamer1.0-vaapi`，并用 `apt` 安装后检查 `amd64` 元数据、动态库、媒体解码插件、应用资源和启动；不得把只解包或只构建当作安装通过。
- Ubuntu 的扫描、检查、回放和导出不联网且不写源 SD 卡；保存标注需要 episode 可写并只更新根级 `description.json`。自动更新仍只使用 D-031 的固定 IP 镜像。

### 12.4 正式 CD 与 GitHub Release

- `.github/workflows/release.yml` 在 `main` CI 成功后核对 HEAD、clean checkout、完整 Changelog 条目和四处应用版本，并使用该次运行的 `GITHUB_TOKEN` 自动创建缺失的 annotated `vX.Y.Z` tag；当前 unsigned 通道不依赖 GitHub App 凭据或 release Environment。Changelog 缺失、重复、未置顶、日期无效、为空或仅含占位文本时，必须在 tag 创建前失败。完整 `pnpm check` 与 release workflow 回归只在 CI 对同一 commit 执行一次，CD 不重复该门禁。
- Windows x64、macOS arm64、Ubuntu x86_64 使用原生 hosted runner 构建；Node、pnpm、Rust 和全部 GitHub Actions 固定版本或 commit。
- CI 与三个平台可恢复按平台/目标架构和 Rust/Cargo 环境隔离的依赖编译缓存；只有受信任的 main/release 运行可写共享 cache。workspace crate、增量编译产物和最终 installer 不得进入 cache，每次 Release 必须重新组装并执行完整安装、启动、资源、封印和 hash 验证。
- Windows 固定 reviewed FFmpeg binary/license/build notice 与 WebView2 exact Microsoft URL/SHA-256；Tauri evergreen 跳转只解析缓存键，缓存和 NSIS 必须使用固定 hash 的已审核 WebView2 字节；macOS 从固定官方 FFmpeg source archive hash/Git revision 构建 arm64 sidecar。
- Windows 检查 DOHC 产物为 unsigned、Microsoft WebView2 签名、NSIS 内嵌 hash、silent install/startup/uninstall；macOS 检查 ad-hoc sealed nested code/resources、没有 Developer ID/notarization claim、DMG 挂载、资源 hash、synthetic-quarantine Gatekeeper 分类和复制后直接启动。
- Release 标题、说明、三个 installer 名称、verification report 和 manifest 必须显示 `UNSIGNED`；后续引入签名时恢复 Authenticode、timestamp、Developer ID、Gatekeeper、notarization 和可信 Linux 包发布门禁。
- 三个平台同时生成自动更新资产：Windows x64 NSIS updater executable、macOS arm64 ad-hoc sealed app tarball、Ubuntu x86_64 deb。每个更新资产必须使用独立 Ed25519/Minisign 私钥签名；final job 用 `tauri.conf.json` 内嵌公钥重新验签，并生成包含三个精确 target、URL、signature、size 和 SHA-256 的 `latest.json`。更新签名只证明更新字节来自本项目发布流程，不得把外层 installer 描述为 Authenticode、Developer ID 或可信 Linux 包签名。
- final job 重新核对三份 verification report、安装器 SHA-256、更新包大小与签名，生成 `latest.json`、`release-manifest.json`、`SHA256SUMS.txt` 和 GitHub provenance。三安装器及其更新资产集合完整后才解除 draft，已经公开的 tag 不允许覆盖。
- 本机镜像服务由 `launchd` 常驻在 `0.0.0.0:17879`，上游固定为 GitHub `latest.json`；每 5 分钟同步一次。公网请求的客户端清单重写为 `http://39.155.172.162:17879/releases/vX.Y.Z/...`，受信任的局域网 Host 请求重写为 `http://10.1.11.200:17879/releases/vX.Y.Z/...`，签名保持原值；版本资产同时支持受控单段 Range，以供客户端用 32 KiB 样本并行测速而不重复传输完整安装包。根页面提供同版本三个正式安装包和 SHA-256，供旧版完成一次引导安装。
- 当前 CD 仍不需要 GitHub App ID/private key 或 release Environment；自动 tag 使用仓库 `GITHUB_TOKEN`。自动更新另需 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 两个 GitHub Actions secret，它们只用于更新包完整性签名，不能提交到仓库或写入 artifact/log。
- GitHub hosted runner smoke 不是 Win10/Win11 断网、目标 Mac、真实 SD 卡或 100 GB 实盘验收的替代品。

### 12.5 版本管理

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 版本必须一致。
- 每次 Release 必须有唯一、带合法日期且非空的当前版本 Changelog；Release 正文从该条目生成并直接展示具体变更，不能用自动 commit 列表或 compare 链接代替。
- 每个进入 `main` 的 commit 都必须同时包含完整版本内容，不能创建独立 release commit；CI 成功后由 workflow 自动创建精确指向该 commit 的 annotated tag，不手工创建或推送版本 tag。
- Codex 默认将 patch 位连续增加 1（`X.Y.Z -> X.Y.(Z+1)`）；minor、major 或跳号必须由开发负责人明确指定。
- Manifest `format_version`、HDF5 `format_version` 和产品 semver 独立管理。
- LeRobot `codebase_version` 明确固定为 v2.1，升级需要新 adapter 行为和兼容性测试。

### 12.6 可重复验证与依赖证据

- 快速检查必须统一执行前端 production build、Rust format、Clippy warnings-as-errors 和常规 Rust tests。
- 完整检查必须额外运行真实样例导入/hash、健康检查、三个 adapter 生成与内部回读，以及 Tauri debug application build。
- 每次检查必须生成 schemaVersion=1 的本机 JSON 报告，记录应用版本、Git 状态、工具版本、各命令 exit code 和耗时；报告和本地构建产物不进入 Git。
- FFmpeg staging 必须在复制前验证期望 SHA-256、目标架构、`mpeg4` encoder、非 `--enable-nonfree` 构建、HTTPS 来源、build ID 和许可证输入。
- bundle 必须包含 FFmpeg 二进制、合并许可证和 provenance manifest，并在构建前回读 hash；标记为非可移植的依赖只能进入显式 local-debug 包。
- unsigned debug bundle 只证明本机构建和资源布局；unsigned GitHub Release 还必须通过三安装器 CI 安装或挂载、直接启动、依赖和完整集合门禁，但两者都不能替代生产签名和目标机器验收。
- 大容量验收必须由 `stress-check` 统一执行扫描、取消探针、verified import、完整检查、三格式生成/回读和源端 BLAKE3 复核，并原子生成 schemaVersion=1 JSON 报告。
- formal 报告必须记录 release profile、clean exact tag、源/工作卷、100 GB/100,000 文件阈值、FFmpeg BLAKE3、阶段耗时/吞吐/峰值 RSS、取消延迟、输出大小以及源前后 hash；`formal:false` 只能作为开发证据。
- 非 Windows 宿主的 MSVC 预检必须使用同一 rustup toolchain 的 Cargo/Rustc、显式 `x86_64-pc-windows-msvc` target 和 `llvm-rc`，编译 `--all-targets` 并生成报告；报告必须明确 `linksExecutable:false`、`buildsInstaller:false`、`runsOnWindows:false`。
- macOS 虚拟 ExFAT smoke 必须在写入 fixture 后只读重挂载源卷，验证 ExFAT/只读/独立工作卷、完整 stress 结果和安全清理；报告必须明确 `physicalSdCard:false`、`formalStress:false`，不能关闭 GAP-003/GAP-007。

## 13. 验收测试

| 编号 | 场景 | 预期结果 |
| --- | --- | --- |
| AT-001 | 选择包含多个标准 episode 的 SD 卡根目录 | 正确发现全部记录并显示五路、状态和容量；首条直接只读检查/回放，其他记录按需读取；正常 UI 不调用导入 IPC、不创建 `appLocalData/imports` 数据副本，也不弹本地目标选择框 |
| AT-001a | 扫描或读取源目录时系统返回 `Operation not permitted`/`operation not allowed` | 顶部显示权限提示，原始消息以 `PERMISSION_DENIED` 记录到本地错误历史；重新授权后可重试读取 |
| AT-002 | 导入标准样例 | 981 个文件、80,531,730 字节校验通过，生成 format-v2 manifest 和稳定数据集 BLAKE3 |
| AT-003 | 修改目标副本中任意一个字节 | BLAKE3 回读失败，不发布正式目录 |
| AT-004 | 删除一个流目录 | `EMPTY_STREAM` error，禁止导出 |
| AT-005 | 删除中间 JPEG | `MISSING_FRAMES` warning，右侧要求确认是否进入标注；选择不标注时跳到下一条数据 |
| AT-006 | 在任一固定百分位抽检位置使用截断或随机字节 JPEG | 交互检查产生 `DECODE_FAILED` error，并定位流和帧；回放预检阻止加载 |
| AT-038 | 一个或多个相机流的抽检 JPEG 始终无法解码，或回放中任一帧读取失败 | 预检或运行时显示 `FRAME_UNAVAILABLE` 提示、停止加载，左侧提供可恢复的“跳过数据”操作；跳过不修改源文件或本机标注 |
| AT-039 | states position 连续多帧保持不动 | 检查报告生成带首个 frame ID 的 `TRAJECTORY_STATIC` warning，直接跳过该条数据而不进入标注 |
| AT-007 | 写入无效 JSON/NaN/非单调时间戳 | 对应 error 被报告 |
| AT-008 | 加载标准样例 | 五路 frame 0 同步显示，状态曲线可切换；X/Y/Z/W 使用稳定彩色并辅以不同线型，时间轴可播放/步进 |
| AT-009 | 标准样例的末尾时间间隔异常 | 得到 `TIMESTAMP_GAP` warning，不被静默修复 |
| AT-010 | 导出 MCAP | 7 个 channel、3 个 schema 可被 MCAP reader 读取；官方 Foxglove protobuf 消息逐条解码，输出可在 Foxglove Image/3D/Raw/Plot panel 选择 |
| AT-011 | 导出 HDF5 | 状态/帧索引 shape 为 196，`jpeg_data` 字节 shape、offset/size 末端和首末 frame ID 回读一致 |
| AT-012 | 导出 LeRobot v2.1 | `fps=30`，Parquet 196 行，包含原始纳秒字段，五个 MP4 非空 |
| AT-013 | 目标输出重名 | 生成后缀名称，不覆盖原文件 |
| AT-014 | 扫描、读取/检查或导出时取消 | 不继续后续阶段且没有正式导出；压力验收中的显式导入取消仍不得发布正式目录 |
| AT-015 | 断网的干净 Win10/Win11 机器 | 安装、启动、源卡只读扫描/检查、回放和三种导出均可完成，过程中不自动复制源 session |
| AT-016 | 1440x920、960x680 桌面视口 | 无重叠、横向溢出或不可见操作 |
| AT-017 | 导入含非法/大小写冲突路径的记录 | 安全路径写入 manifest；任何目标路径碰撞在复制前阻止 |
| AT-018 | clean exact tag 上运行 exFAT 100 GB/100,000 文件 formal stress | 源/工作卷不同，取消不超过 1 秒，无 error，三格式回读通过，源端 BLAKE3 前后相同并生成 passed JSON 报告 |
| AT-019 | macOS 执行 Windows x64 MSVC all-target compile check | 条件源码通过，报告明确未链接、未打包、未在 Windows 运行 |
| AT-020 | macOS 从只读虚拟 ExFAT 卷执行开发样例完整链路 | 卷/只读/独立工作盘、取消、导入、检查、三导出回读、源 hash 和 marker 清理全部通过；报告不冒充实卡证据 |
| AT-021 | 将标准样例裁剪为帧 10-19 后导出三种格式 | MCAP/HDF5/LeRobot 均只含 10 条状态和对应五路图像；输出名称/metadata 记录范围，源目录 hash 不变 |
| AT-022 | 选中范围外存在逐帧 warning/error | 范围外 issue 不阻断本次导出；范围内或全局 issue 仍按 error hard gate/warning acknowledgement 处理 |
| AT-023 | 损坏 JPEG 只位于五个固定抽检位置之外，再运行正式全量检查 | 交互报告明确标记 `sampled` 且不声称覆盖该帧；正式 `full` 报告产生 `DECODE_FAILED` |
| AT-024 | 分别检查 warning、error、ok 数据并重复检查 warning 数据 | warning/error 在应用 local-data 自动生成 format-v3 报告，重复检查复用同一路径且源指纹不变；ok 不生成；检查页按错误/警告/通过排序并显示后台报告状态 |
| AT-025 | 管理员在当前主机初始化用户中心并创建操作员、错误密码登录、正确登录、退出后直接调用数据 IPC | 首个管理员只能从主机本机初始化；普通账号只能由管理员创建；客户端配置固定证书和 service ID，错误密码拒绝，正确登录成功，退出后数据 IPC 返回 `AUTH_REQUIRED` |
| AT-026 | 创建“整理餐具”任务并为两个 episode 保存，第一条再由另一中心账号编辑描述 | 新任务默认描述可编辑；编码只读并由 Rust 依次分配 `整理餐具-001`/`整理餐具-002`，前端不能指定编号；修订历史保留两个处理人和修改耗时；三种导出以轨迹码命名并回读 UTF-8 标注元数据 |
| AT-027 | 将统一版本号和带日期 Changelog 的版本提交推送到 `main`，CI 成功 | workflow 自动创建不可改写的 annotated tag，并同时生成文件名带 `UNSIGNED` 的 Windows x64 NSIS、macOS arm64 DMG 和 Ubuntu 22.04+ x86_64 deb；三者均披露无可信发布者身份并通过依赖、安装或挂载、启动和 hash 检查；macOS 还通过 strict ad-hoc seal 与 synthetic-quarantine Gatekeeper 分类，Ubuntu deb 通过 Xvfb 启动检查，完整 draft 才自动公开 |
| AT-028 | 修改 `docs/wiki` 并合入 main | 页面与内部链接检查通过后同步 GitHub Wiki；网页文档与仓库源一致 |
| AT-029 | 对 macOS Release app 添加 quarantine 并执行分发策略检查 | app/main/FFmpeg 的 nested code 与 sealed resources 严格校验通过；策略报告 ad-hoc identity/missing notary ticket，或内部 XProtect 错误被独立最小 control app 同样复现并显式记录；不出现产品独有 XProtect、invalid signature、missing resources 或 damaged |
| AT-030 | 检查 Linux 打包配置和 Release 产物集合 | 仓库没有 Flatpak manifest、构建或验证脚本；Linux 打包契约只接受 Ubuntu 22.04+ x86_64 deb，Release 汇总发现 Flatpak 产物时拒绝发布 |
| AT-031 | 在干净 Ubuntu 22.04 CI 用 `apt` 安装原生 deb | package/version/amd64/依赖正确，无 deb 签名声明；应用 binary、desktop、metainfo、icon、FFmpeg/许可证/manifest 完整且动态库无缺失，并在 Xvfb + D-Bus 中保持运行 10 秒 |
| AT-032 | 本机有源断开、健康状态 error、warning 和通过的已标注数据，再执行批量 MCAP 导出 | 清单标记断开的源；后端请求仍逐条校验，断开/error 项返回失败且各自生成可定位的本机失败日志，warning 经一次确认后与通过项完成导出和回读并可定位输出；取消中止当前未完成项、不启动后续条目，且已完成输出保留 |
| AT-033 | 固定 IP 镜像分别面对“完整新版本、部分 target、断网、清单超限、资产被篡改”，已登录引导版再检查镜像 | 镜像只原子激活完整且 hash/签名正确的三平台集合，失败继续提供上一版；客户端不访问 GitHub，只接受同 origin 精确版本路径。发现更高版本后，并行取得两个 32 KiB Range 样本，仅接受 `206`、精确 `Content-Range` 和精确样本大小，按最快成功结果下载；都不能测速时保留清单路径。完整下载仍验大小和签名后才安装重启；请求不包含本地业务数据；镜像不可达显示可重试提示且核心功能可用；大小不符、超过 64 MiB 或签名错误均拒绝安装并保留当前版本。Release 汇总缺少任一平台更新资产或签名时不得公开 |
| AT-034 | 从同一标注分别导出 MCAP、HDF5、LeRobot | 三种输出都记录选中范围采集起止时间、标注创建/修改时间、修改耗时、修改人、实际导出时间和导出人；回读失败不得发布正式输出 |
| AT-035 | episode 根目录放置合成 `smpl_skeleton.npz` 并加载回放 | Rust 读取坐标和 frame ID；Z-up fixture 在 Three.js 中以 Y-up 直立显示，三维骨架在 1440x920 中位于图像右侧、在 390x844 中位于图像下方；骨骼轮廓高度大于宽度、画布像素非空、当前帧切换同步、视角控件可交互；非法 NPZ 显示错误但不阻断图像回放 |
| AT-036 | 分别选择统一管理和离线模式并切换 | 未选择模式只显示模式选择；统一管理显示配置/登录和更新入口；离线无用户名、登录、退出、账号/处理人和用户中心请求，但可扫描、回放、检查、标注、导出；切换模式清空当前工作区并重新执行对应门禁 |
| AT-037 | 在可写 episode 中编辑任务描述和片段并连续保存两次，再检查源指纹 | 根目录只有一个 format-v2 `description.json`，其中保存整体描述、裁剪范围和完整片段数组，第二次内容原子替换第一次内容；本机标注追加两个修订，采集数据指纹与健康检查缓存保持有效；只读或非普通文件目标返回 `SOURCE_DESCRIPTION_WRITE_FAILED` |

## 14. 当前实现状态

### 14.1 已完成并验证

- Tauri 2 + React + Rust 工程和 `main` Git 分支。
- SD/目录扫描、episode 发现和进度事件。
- 正常 UI 从源路径直接只读扫描、检查、回放和导出，不自动创建本地数据副本；保存标注只原子更新根级 `description.json`。
- 压力验收保留显式复制、逐文件 BLAKE3、目标回读和 format-v2 manifest 路径映射。
- 交互加载对五路 JPEG 执行固定百分位抽检并全量检查结构、状态和时间轴；正式压力/发布流程保留 JPEG 全量解码。
- 五路同步回放、彩色且带线型区分的状态曲线、单轨迹时间裁剪和检查页。
- 支持闭区间帧裁剪的 MCAP、HDF5、LeRobot v2.1 adapters 与导出 UI。
- 支持从本机最新标注选择多条完整 episode，以统一格式顺序重新检查和批量导出，并显示逐条结果。
- 登录后从固定 IP 镜像自动检查更新；双源受限 Range 测速选择最快下载路径，完整下载、Ed25519/Minisign 验签、平台安装与重启共用单长任务门禁，离线失败不阻断本地工作流。
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
- 可选 SMPL/骨架 NPZ 的只读解析、frame ID 同步和 Three.js 三维回放；桌面端显示在图像右侧，窄窗口显示在图像下方，解析失败保持非阻断可见状态。
- 跨平台 quick/full/bundle 检查和原子 JSON 证据报告。
- Windows/macOS/Linux FFmpeg hash、架构、encoder、来源、许可证与可移植性 staging 门禁。
- macOS app/DMG、Windows NSIS、Linux deb 的 FFmpeg 二进制、许可证及 provenance manifest 资源配置。
- 跨平台 `stress-check` 验收 runner、正式环境硬门禁、import 取消/partial 清理探针和原子 JSON 性能证据。
- macOS 到 Windows x64 MSVC 的 Rust all-target 条件编译预检和边界明确的原子 JSON 证据。
- macOS 只读虚拟 ExFAT 卷上的完整生产数据链路 smoke 和 marker 保护清理。
- 局域网用户中心管理员账号初始化/创建、固定证书客户端配置、中心登录/退出、后端会话门禁，以及可创建任务、可编辑描述、Rust 自动编号和带处理人的 episode 级标注。
- 统一管理/离线工作模式选择、追加持久化、后端门禁和模式切换工作区清理；离线本机 provenance 不作为账号显示。
- MCAP/HDF5/LeRobot 导出继承轨迹码、任务、采集时间、修改时间、修改耗时、修改人和实际导出人元数据。
- 三安装器正式 Release CD、完整集合发布门禁、安装器 verification report、SHA-256 manifest 和 GitHub build provenance 工作流。
- `docs/wiki` 用户/发布手册、内部链接检查和 GitHub Wiki 自动同步工作流。

### 14.2 发布前阻断项

| 编号 | 阻断项 | 完成标准 |
| --- | --- | --- |
| GAP-001 | Windows x64 生产签名与目标机验收尚未完成 | 生成 Authenticode/timestamp 签名 NSIS，并通过 Win10/Win11 断网测试 |
| GAP-002 | Windows FFmpeg 来源/hash/许可证已锁定，但尚待首次 Windows runner 和目标机证据 | 首次 Release job 与 Win10/Win11 实机均通过编码、安装和许可证检查 |
| GAP-003 | 尚未在真实 exFAT SD 卡完成现场测试 | 完成第 11 节完整测试矩阵 |
| GAP-007 | 验收 runner 已就绪，但长时/大容量实盘性能未知，尚无物理 100 GB 证据 | 用至少 100 GB/100,000 文件完成扫描、导入、检查、每种导出、取消延迟和内存/吞吐基线记录 |
| GAP-009 | unsigned CD 已实现；仓库尚未配置 Windows/Apple/Linux 包可信发布凭据和 signed release approver，也未产出完整可信签名 Release | 配置受保护的签名环境，恢复 Authenticode/Developer ID/notarization/可信 Linux 包发布门禁，以新版本生成完整 signed Release，并在 Win10/Win11、目标 Mac 和 Ubuntu 完成验收 |
| GAP-010 | Ubuntu deb 已有 CI 安装和 Xvfb smoke，但尚无 Ubuntu 22.04 deb 实机、真实 ext4 SD 卡和长时直读证据 | 在 Ubuntu 22.04+ x86_64 实机验收 deb，并挂载真实 SD 卡完成只读扫描、检查、回放、三格式导出和权限错误历史验收，确认正常 UI 不复制 session |

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
- 每次门禁都会在 ignored 目录原子发布机器可读报告；当时可用 `--require-clean` 检查独立 release commit，该流程现已由版本驱动的 GitHub Actions 自动 tag 取代。
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

### 14.11 历史：`0.10.0` session 选择与回放入口

- 左侧 episode 列表以源 session 路径作为稳定身份；单击只更新选择，不切换主工作区。
- 双击未加载的 session 复用本地导入、容量预检、复制、大小/BLAKE3 校验和健康检查流程，完成后进入回放。
- 双击已经加载的 session 不重复复制，直接切换到回放；导入后的本地副本路径不会覆盖左侧源 session 的选中高亮。
- 在 1440x920、960x680 和 390x844 视口完成交互、五路图像、无溢出和无控制台错误检查。

### 14.12 历史：`0.11.0` 黑白灰视觉系统

- 将品牌标记、主要按钮、导航选中态、session 选中态、进度、时间轴、裁剪控件、状态徽标和导出反馈统一为黑白灰层级。
- telemetry 的 X/Y/Z/W 曲线使用四档灰度，坐标网格和当前帧标记同步采用中性色；相机画面保留真实源颜色。
- warning/error 继续显示稳定中文标签、Lucide 图标、边框和不同明度背景，不以色相作为唯一状态信息。
- 回放、检查、导出三页已在 1440x920、960x680 和 390x844 视口完成截图检查；五路图像均解码，无横向溢出、console error、page error 或失败请求。
- 当前 telemetry 曲线配色已由第 14.27 节取代；中性界面和状态不只依赖色相的约束继续有效。

### 14.13 历史：`0.12.0` 自动加载与固定百分位图像抽检

- 选择 SD 卡或记录目录后自动扫描并处理第一条 session，直接进入应用管理工作区导入、大小/BLAKE3 回读、健康检查和回放；顶栏与空状态不再提供本地目标选择或“导入并检查”按钮。（后续 `0.16.0` 扩展为全部 session 自动导入。）
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

### 14.15 历史：`0.14.0` 固定任务目录与 episode 级数据标注

- 首次启动进入本地账号创建页；该历史行为已由 `0.17.15` 的局域网用户中心取代。
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

### 14.19 历史：`0.16.0` 自动导入工作区与操作错误历史

- 选择 SD 卡后只出现一次源目录选择框；应用在当前用户可写的 app-local-data/imports 下按源卷路径生成隔离工作区，自动依次导入全部发现的 session。
- 左侧源 session 身份保持不变；每条记录显示等待、导入中、已导入或失败状态。首个成功导入项自动进入大小/BLAKE3 回读、健康检查和回放，其他已导入项可双击进入。
- 导入失败不会丢失已完成项；每个失败 session 立即记录操作历史并继续队列，顶部错误历史保留最近 200 条，原始 `Operation not permitted`/`operation not allowed` 归类为 `PERMISSION_DENIED`。
- app-local-data 工作区不写入源卡，导入目标不再由用户选择；导出目录仍由用户在导出动作时选择。PRD、Wiki、browser demo、Rust 单元测试和前端 production build 同步更新。

### 14.20 历史：`0.16.0` Ubuntu Flatpak 分发（已退役）

- Linux 卷信息现在通过 `/proc/self/mountinfo` 的最长挂载点匹配识别文件系统、远程卷和可移动块设备；Linux `vfat`/`msdos` 与 Windows FAT/FAT32 一样被导出目标预检阻断，exFAT 保持支持。
- `0.16.0` 曾从 Ubuntu deb 中间包生成 GNOME 50 Flatpak，并验证离线权限、资源和启动。
- 该兼容路径已在 `0.17.2` 退出发布范围；随后连同本地 manifest、构建脚本和验证脚本一并移除。Ubuntu 原生支持 ext4，用户只需以只读方式挂载 SD 卡。

### 14.21 `0.16.1` 回放加载提示优化

- 五路同步连续播放期间隐藏每帧切换产生的“解码中”覆盖层，避免文案反复遮挡画面。
- 暂停、拖动或单帧步进时仍保留加载状态，真实的“帧不可用”错误继续显示。

### 14.22 历史：`0.17.0` Ubuntu 原生 deb 分发候选

- Ubuntu 22.04+ x86_64 新增正式原生 deb 安装入口，文件名显式记录最低系统版本；Ubuntu 20.04+ GNOME 50 Flatpak 继续作为兼容包。
- Linux release/smoke job 固定在 Ubuntu 22.04，先从固定源码构建 FFmpeg 和 deb，再用 `apt` 安装实际产物，验证 package/version/architecture/依赖、ELF 动态库、desktop/AppStream/icon、FFmpeg 资源和 10 秒 Xvfb 启动。
- Ubuntu 22.04 CI 的 deb 构建、`apt` 安装、资源回读和 Xvfb 启动检查通过；随后同一 runner 的旧 `flatpak-builder` 无法在 GNOME 50 SDK 中调用 `appstream-compose`，完整集合门禁按设计阻止公开 Release。`v0.17.0` tag 保持不变且没有公开资产，由 `0.17.1` 取代。

### 14.23 历史：`0.17.1` Linux 分离 runner 发布

- deb 构建和真实安装验证继续固定在 Ubuntu 22.04；成功后把 deb 与独立 verification report 作为不可变 job artifact 上传。
- Ubuntu 24.04 Flatpak job 依赖并下载上述 artifact，从同一 deb 构建 GNOME 50 bundle，再执行 runtime、权限、资源和 10 秒 Xvfb 启动检查；不重新编译另一个 deb。
- final job 分别接收 deb/Flatpak 报告和安装器，五个安装器全部匹配后才公开 Release。

### 14.24 `0.17.2` 交互恢复与问题定位修复

- 原生导出确认和目标目录选择失败统一进入可见错误与操作历史恢复路径，成功导出和报告导出行为保持不变。
- mocked-Tauri browser 回归覆盖变为 CI 必跑门禁；缺少支持的浏览器时会失败，而不会跳过。
- stream-scoped issue 定位会选择实际受影响帧；没有可同步 state 时会明确反馈，不再静默落到相邻 state 帧。

### 14.25 `0.17.3` Windows 发布依赖刷新

- Microsoft WebView2 x64 offline installer 的固定链接切换到新 payload 后，workflow 更新为新的 exact filestreamingservice URL 和 SHA-256，仍要求 Microsoft Authenticode 有效并回读 NSIS 内嵌 hash。
- `v0.17.2` 的 macOS arm64/x64 与 Ubuntu deb 验证通过，但 Windows 内嵌 payload 与旧审核 hash 不一致；完整集合门禁按设计阻止公开 Release，tag 保持不变并由 `0.17.3` 取代。

### 14.26 当前 CI/CD 包范围

- 主 CI 不再运行 Ubuntu packaging smoke；独立的 Linux package smoke workflow 已移除。
- `main` 允许直接推送但禁止删除和 force-push；CI 成功和统一版本变更共同触发自动 annotated tag，无独立 release commit、手工 tag、GitHub App 凭据或 release Environment。
- CI 是同一 commit 的唯一完整代码门禁；Release controller 只重复不可变 tag、main HEAD、版本和 Changelog 验证，三个平台随后直接并行构建。CI 与各原生平台使用隔离的 Cargo 依赖缓存，最终安装包和验证结果始终重新生成。
- GitHub Release 只发布 Windows x64、macOS arm64 和 Ubuntu 22.04+ x86_64 deb。
- Flatpak manifest、构建脚本和验证脚本已从仓库移除；Release 汇总对意外出现的 Flatpak 产物保持拒绝。

### 14.27 `0.17.4` 源卡直读、动态任务与彩色状态曲线

- 正常 React 工作流不再调用导入器，也不在 `appLocalData/imports` 自动创建 session 副本；扫描后首条 session 直接从只读源路径检查和回放，其他 session 按需读取。源卷必须在读取、回放和导出期间保持挂载。
- 完整导入器、目标端大小/BLAKE3 回读、manifest 和 partial 清理继续供 formal/development stress 使用；历史导入副本不会被自动删除。
- 用户可在标注面板只输入名称创建本地任务；系统生成稳定 ID/前缀和默认描述，任务描述仍可逐 episode 编辑。
- 轨迹码只由 Rust 在保存标注时原子分配，前端仅显示只读预览且不提交编号；同一 episode 继续编辑相同任务时复用原编码。HDF5 标注属性支持 UTF-8 自定义任务和轨迹码。
- telemetry 的 X/Y/Z/W 使用稳定红、绿、蓝、紫曲线，并辅以不同线型和维度文字；界面其余部分继续使用黑、白和中性灰，状态不只依赖颜色表达。
- browser 回归覆盖“正常 UI 不调用导入 IPC”、自定义中文任务自动编码和彩色 canvas 像素；Rust 单元测试覆盖动态任务、原子编号、修订复用和无效任务拒绝。

### 14.28 `0.17.5` macOS 元数据兼容与 CI/CD 加速

- 源统计、指纹、帧校验和显式导入统一忽略 AppleDouble `._*` 与 `.DS_Store`，不再把 macOS 在外部卷生成的伴生文件误报为非法帧；其他非数字 JPEG 文件名继续产生 `INVALID_FRAME_FILENAME` error。
- 每次 Release 必须具有唯一、带合法日期且非空的当前版本 Changelog，自动 tag 前验证，GitHub Release 正文直接展示该条目。
- 完整代码和 release workflow 门禁只在同一 CI commit 执行一次，controller 验证不可变发布身份后四个平台直接并行；CI 和原生打包任务使用隔离的 Cargo 依赖缓存，但每个 installer、封印和验证报告仍然重新生成。
- GitHub hosted Ubuntu CI 的冷缓存运行耗时 5 分 54 秒，同一 commit 缓存命中后为 2 分 59 秒；正式四平台 CD 的缓存收益仍以 `0.17.5` 及后续实际 Release 记录为准。

### 14.29 `0.17.6` macOS x64 退出发布范围

- 后续 CD 固定只构建 Windows x64、macOS arm64 和 Ubuntu 22.04+ x86_64 deb；macOS Intel/x64 不再进入支持或发布范围。
- macOS workflow 固定使用 Apple Silicon runner 和 `aarch64-apple-darwin` target；Release 汇总器将额外出现的 x64 DMG 视为意外安装器并阻止公开。
- `v0.17.5` 及更早公开 Release 中已有的 x64 DMG 保持不可变历史，不删除或覆盖；用户文档明确不再维护该架构。

### 14.30 `0.17.6` 本机标注批量导出

- 新增登录门禁后的“批量”工作区，从 Rust 回读本机每个 episode 的最新标注和源可用状态。
- 批量命令只接受 episode ID，在后端重新解析可信标注、规范化源路径、核对数据指纹并运行健康检查；不从前端接受源路径或健康报告作为授权。
- 所有条目共用目标目录和 MCAP/HDF5/LeRobot 格式，按顺序导出完整轨迹；单条失败继续，取消中止当前未完成项、停止后续队列并保留已发布结果。
- 标注仅保存任务、轨迹码、处理人、源路径和指纹，不复制源 JPEG 或状态数据；源卷断开或内容变化时该条目必须失败。

### 14.31 `0.17.7` 批量导出失败日志与输出定位

- 每条批量失败在 Rust 后端写入应用本地 `reports/operation-errors` 独立 JSON 日志，并在结果 IPC 中返回日志路径。
- 批量结果页可展开失败日志、定位日志文件；成功结果提供“打开文件所在位置”操作。
- 增加 Tauri mock 与 Rust 回归测试，覆盖一条批量任务中成功/失败条目的逐条结果和定位动作。

### 14.32 `0.17.8` Windows WebView2 确定性暂存

- Windows CD 继续固定 WebView2 exact filestreamingservice URL、SHA-256 和 Microsoft Authenticode；Tauri 的 evergreen 跳转只用于解析当前缓存键，不再决定实际打包字节。
- workflow 将已审核文件复制到 Tauri 当前缓存键，构建后仍从 NSIS 回读并验证内嵌 hash；微软跳转变化不能静默替换发布依赖。
- `v0.17.7` 的 Windows 内嵌 hash 门禁正确阻止了不完整 Release；修复进入新版本，不移动或覆盖旧 tag。

### 14.33 `0.17.12` 固定 IP 镜像自动更新

- 用户登录后先读取 `http://39.155.172.162:17879/latest.json`；没有新版本时保持当前运行，公网地址不可达时才读取固定局域网 fallback `http://10.1.11.36:17879/latest.json`。发现更高 semver 时等待当前长任务结束，再自动下载、安装并重启。检查或下载失败显示可重试提示，但不影响离线检查、回放、标注和导出。
- Rust 只接受两个固定镜像 origin 和精确版本目录的 asset URL，按清单精确大小以 64 MiB 上限流式读取，并使用应用内嵌 Ed25519/Minisign 公钥验签；不向网络发送账号、源路径、标注、报告、hash 或遥测。
- 本机镜像服务从官方 GitHub Release 同步三平台更新资产和正式安装包，先验证 target、大小、SHA-256 与签名，再用 partial/版本目录原子激活；对外只提供 GET/HEAD、安装页和健康状态。它只向受信任的局域网 Host 返回局域网下载 URL，其他请求保持公网 URL，以避免 NAT loopback 与 Host 注入；新同步失败继续提供上一完整版本。
- CD 为 Windows x64、macOS arm64 和 Ubuntu x86_64 分别生成更新资产及签名，由 final job 独立验签并生成 `latest.json`；任一安装器、更新包、签名或 target 缺失都阻止 Release。外层安装器仍明确为无可信发布者身份的 `UNSIGNED`。
- `0.17.12` 是公网地址自动更新引导版；`0.17.8` 及更早版本没有 updater，必须从固定镜像根页面手动安装本版本一次。`0.17.11` 在旧局域网地址可达时会自动迁移；之后版本才能自动升级。

### 14.34 `0.17.13` 时间裁剪轨道对齐

- 时间裁剪的上方选中范围轨与起点、终点两个范围滑块共享相同的 Grid 列尺寸，避免右侧帧输入和“当前帧”按钮导致上方轨道过长。
- 桌面和窄视口统一清除 range 控件的浏览器默认外边距；Chromium 回归检查在 1440x920、960x680 和 390x844 视口验证三条轨道的左右像素边界一致且无横向溢出。

### 14.35 `0.17.14` 自动更新镜像测速

- 镜像服务为单一合法 `Range` 返回固定长度、`Content-Range` 完整的 HTTP 206 响应；普通 GET/HEAD、版本缓存、原子激活和不记录客户端数据的边界保持不变。
- 发现更新后 Rust 并行读取公网与局域网同一资产的 32 KiB 样本，在 1 秒窗口按实测耗时选最快成功路径；只有完整下载的精确大小和 Minisign 验签同时通过才安装。旧镜像不支持 Range 或所有测速失败时继续使用已验清单 URL，不制造更新中断。

### 14.36 `0.17.15` 局域网用户中心与导出审计元数据

- 当前主机通过 `pnpm user-center:install` 一键部署固定 `10.1.11.36:17880` HTTPS 用户中心；首个管理员只能在服务主机本机初始化，操作员账号由管理员创建。
- 客户端导入管理员生成的固定证书配置，校验 service ID 和私有 IP 后登录；密码不落客户端磁盘，服务不接收源数据、路径、标注或报告，已登录进程可在服务短暂断开时继续本地工作。
- 标注修订记录采集时间范围、创建/修改时间、修改开始时间、修改耗时和处理账号；MCAP、HDF5、LeRobot 导出均写入并回读统一 provenance metadata。

### 14.37 `0.17.16` 更新镜像 latest 解析修复

- GitHub `releases/latest/download/latest.json` 返回 404 时，更新镜像只查询固定的官方 latest Release API 读取 semver tag，再从该 tag 的不可变 `latest.json` 路径继续执行三平台集合、文件名、大小、SHA-256 和 Minisign 验证。任何 API 中的 URL、非 semver tag 或非 GitHub 固定资产路径仍会拒绝。

### 14.38 `0.17.17` 30 FPS 状态帧率验证

- 健康检查以相邻状态记录的递增 frame ID 之间的原始纳秒时间除以帧号步长，取每帧周期中位数得到实测 FPS；帧号跳号不会被误判为低帧率。
- 报告升级为 `formatVersion=4`，新增目标 30 FPS、实测 FPS、±5% 容忍和有效间隔数；超过容忍范围生成全局 `FRAME_RATE_MISMATCH` warning，已有 `TIMESTAMP_GAP` 与非单调时间 error 语义不变。

### 14.39 `0.17.18` 回放标注与片段时间线整合

- 回放首页按五路同步画面、紧凑 episode 标注、时间裁剪与片段时间线的顺序组织，任务、轨迹码、描述和处理人保持在同一行可扫描区域。
- 片段草稿按上一片段结束帧的下一帧连续起步，并以当前播放帧作为闭区间终点；时间线继续支持点击片段编辑名称、注解和删除。
- 播放、倍速和 FPS 控件进入片段时间线区域；点击片段时间线定位帧，回放页不再显示独立的时间裁剪控件块或播放进度条。

### 14.40 `0.17.19` 恢复连续时间裁剪

- 回放页恢复单条轨迹的连续闭区间裁剪控件，包括范围滑块、起止帧数值输入、当前帧设为起点或终点和重置完整轨迹。
- 片段草稿继续仅在当前会话存在；它不会改变播放或导出的裁剪范围，也不会替代范围裁剪的无障碍输入和边界控制。

### 14.41 `0.17.20` SMPL/骨架三维回放

- episode 加载阶段在 Rust 中从源目录直接发现并有界解析可选的 SMPL/骨架 NPZ，保留源 frame ID；缺少或解析失败只生成回放侧可见状态，不阻断其他数据。
- 回放页新增 Three.js 交互面板，桌面布局将骨架放在五路图像右侧，窄窗口纵向放在图像之后；当前 frame ID 切换时骨架同步更新。
- 新增 synthetic NPZ browser regression，检查 1440x920/390x844 的布局、canvas 非空、无横向溢出和无 console/page/request 错误。

### 14.42 `0.17.24` 双工作模式

- 首次启动先选择统一管理或离线模式；选择结果以追加式本地记录持久化，重启后恢复，切换时清空当前 episode、检查、任务、标注和更新状态。
- 统一管理模式继续使用当前主机局域网用户中心账号、处理人审计和自动更新；用户中心/更新 command 由 Rust 强制要求已登录的统一管理会话。
- 离线模式不创建或要求账号，不显示登录/退出/处理人/更新控件，也不发起用户中心或更新请求；扫描、检查、回放、标注和三格式导出仍可用，标注以固定离线本机 provenance 标记区分来源。
- 浏览器回归覆盖模式选择、离线无账号元素、无用户中心请求、任务和标注保存，以及切换回模式选择页；Rust 单元测试覆盖模式恢复和离线/统一管理门禁。

### 14.43 `0.17.25` 已挂载网络盘只读源

- Windows 映射盘及操作系统挂载的 SMB/NFS 目录可作为数据源；扫描、按需加载、数据指纹和显式导入源端检查不再因卷类型为 `remote` 而拒绝。
- 应用只使用操作系统提供的文件系统路径，不实现 SSH、HTTP、云存储或 NAS 连接协议；网络源保持只读，不写回也不自动复制数据。
- 网络磁盘类型继续显示给用户。导入和导出目标仍限制为本地文件系统，保留容量预检与 partial 后原子 no-replace 发布保证。

### 14.44 `0.17.26` 回放图像同步

- 连续播放改为在五路当前图片全部完成加载或明确失败后再推进下一帧；图片读取或解码慢于记录 FPS 时自动降低实际速率，避免骨架前进但画面请求持续被新目标取代。
- 播放速度、裁剪终点和现有有界图片预读保持不变，并增加就绪推进、加载等待和终点钳制回归测试。

### 14.45 `0.17.27` 分段标注持久化与导出 Metadata

- 连续片段的名称、注解、闭区间范围和裁剪边界通过 Rust 门禁追加写入 appLocalData 标注修订；恢复 episode 时回读最新修订，源目录保持只读。
- 已标注的 MCAP、HDF5 和 LeRobot 输出增加原子 no-replace 发布且回读验证的 Metadata JSON，记录同一视频时间轴上的片段批注；未标注输出保持原行为。
- 正常 UI 继续从源路径直接读取，不调用导入器创建缓存；补充片段保存/恢复、裁剪范围扩展、名称编辑、播放回归和窄视口无溢出覆盖。

### 14.46 `0.17.28` Session 激活焦点恢复

- episode 读取完成或失败后，焦点恢复改为等待 React 提交按钮重新启用状态，再聚焦触发读取的 session，避免渲染时序竞争导致焦点丢失。
- 工作模式或身份切换重置工作区时同步作废尚未执行的焦点恢复请求，防止旧 session 在后续界面更新中重新获得焦点。
- Session 激活浏览器回归连续运行 20 轮，覆盖跨 session 键盘读取、失败重试和单击选择后双击读取。

### 14.47 `0.17.29` 任务删除、导入质量标记与 Metadata 落盘

- 回放标注可删除尚未被任何本机标注引用的自定义任务；Rust 拒绝删除内置任务或仍被引用的任务，源数据和追加式标注历史不变。
- 显式导入在复制前执行全量图像与状态检查；近乎全黑帧生成 `BLACK_SCREEN` warning，状态报告同时显示中位 FPS、±10% 周期带内的稳定度占比，并在低于 90% 时生成 `FRAME_RATE_UNSTABLE` warning。报告升级为 `formatVersion=5`。
- 已标注导出把裁剪后的片段数组内嵌到 MCAP、HDF5 和 LeRobot，并继续原子写入 companion Metadata；IPC/UI 返回实际 `metadataPath`，便于 Windows 上确认文件已经落盘。
- 桌面回放网格把 cam0 主画面轨道从 1.6 倍扩大到 2.2 倍并提高稳定高度，窄视口继续保持全宽主画面和无横向溢出。

### 14.48 `0.17.30` 骨架默认直立朝向

- Three.js 展示层从最多 64 个均匀抽样帧估计 SMPL 髋部到头部或 COCO 髋部到肩部的平均方向，并生成一套固定旋转对齐到 `Y-up`；源坐标、Rust 解析结果和后续帧的相对倾斜保持不变。
- Browser demo 改用 Z-up 骨架 fixture，桌面和窄视口均检查非空 canvas、直立骨骼轮廓和无横向溢出；桌面回归同时确认帧推进和 OrbitControls 拖动会更新画面。

### 14.49 `0.17.31` 挂载源 online view 优化

- 扫描挂载源时在 Rust 进程内建立有界的 episode 索引，复用目录摘要、流帧索引和扫描时的元数据指纹；缓存不落盘、不包含图像 payload，源路径保持只读。
- 首条 episode 读取到状态和可选骨架后立即进入回放，五路 JPEG 仍按需从当前挂载源读取；健康检查在同一操作链路中继续执行，检查完成前导出按钮保持禁用。
- 健康检查只有在扫描指纹与检查结束时的当前指纹一致时才能生成可信缓存；导出仍重新计算当前源指纹并要求报告精确匹配，源发生变化时提示重新扫描。
- 缓存包含 episode 数量和帧路径上限，网络盘断开、权限失败或源变化不会通过旧索引绕过错误门禁。

### 14.50 `0.17.32` 标注优先的分阶段加载

- 选择源目录时只枚举根目录和每个直接子目录一次，用 `states.jsonl` 或五个标准流目录识别全部 session；不在初始扫描中递归遍历图像树、读取每个文件 metadata、统计容量或解码 JPEG。
- 首条或用户激活的 session 先读取 `states.jsonl` 和五个流的直接文件名索引，立即显示同步画面、状态和数据标注区；列表依次显示“待读取”“快速预览”和检查后的精确文件/容量统计。
- 健康检查按需建立单条 session 的完整 metadata/帧索引并复用到抽检，取消了同一阶段对五个流目录和 JPEG metadata 的重复读取；检查结束仍重新计算当前源指纹，只有前后匹配才写入可信缓存。
- 快速预览不写入源目录、不复制图像、不把未检查状态当作通过；导出继续要求与当前源指纹匹配的 Rust 检查报告，error 仍由后端硬阻断。

### 14.51 `0.17.33` 源 episode 描述 Metadata

- 保存 episode 或片段标注时，在当前 episode 根目录写入 format-v1 `description.json`，内容为用户保存的任务描述；文件通过同目录 partial、回读验证和跨平台原子替换更新。
- `description.json` 及应用 partial 不进入采集文件统计、健康检查或数据指纹，保存描述不会让当前可信检查缓存和标注身份失效；正式文件仍会随显式导入复制并执行大小/BLAKE3 回读。
- 源端写入范围严格限制为根级 `description.json`；五路 JPEG、`states.jsonl`、骨架和其他采集文件保持只读。源卷不可写时标注保存明确失败，不伪装为完整成功。

### 14.52 `0.17.35` 源 episode 片段 Metadata

- 保存 episode 或片段标注时，在当前 episode 根目录写入 format-v2 `description.json`，内容包含用户保存的整体任务描述、裁剪范围和完整连续片段数组；文件通过同目录 partial、回读验证和跨平台原子替换更新。
- `description.json` 及应用 partial 不进入采集文件统计、健康检查或数据指纹；片段保存会同步更新源端 metadata 和本机追加式修订。
- 保存整体标注和保存片段都会在前端显示实际更新的 `description.json` 路径。
- 回放先执行每流固定五点 JPEG 预检；空流、非法/重复 frame ID、frame ID 不匹配、抽检解码失败或尺寸不一致时不加载。运行时读帧失败同样停止加载；用户可跳过并恢复显示当前扫描中的数据，且不修改源文件。
- 除 `STATE_FRAME_GAP` 外的任何 warning 会在右侧先列出并要求确认是否进入标注；选择不标注时跳到下一条。`TRAJECTORY_STATIC` 是例外，检测到位置始终不动后直接跳过该条而不进入标注。

### 14.53 `0.17.36` 标注警告确认回归

- 浏览器回放回归在载入包含 warning 的演示数据后显式确认“仍要标注”，覆盖新的标注前质量门禁，不再因等待图像而超时。

### 14.54 `0.17.37` 运行时帧不可用回归

- 浏览器回放回归在运行时 JPEG 读取失败后验证 `FRAME_UNAVAILABLE` 操作错误和回放停止，而不是继续要求五张已卸载图像保留各自的错误覆盖层。

### 14.55 `0.17.38` 运行时帧停止断言

- 当前帧 JPEG 读取失败时，回放会立即卸载；浏览器回归直接验证 `FRAME_UNAVAILABLE` 阻断提示和已退出的回放区域，不再等待已经不存在的帧计数器。

### 14.56 `0.17.39` 后台检查期间的只读预览

- `load_episode` 返回状态和流索引后立即挂载只读回放，健康检查在后台继续；检查完成前导出保持禁用，warning/error 或取消会清理临时预览并遵守原有门禁。

### 14.57 `0.17.40` 警告确认后的焦点恢复

- 操作员选择“仍要标注”后，确认加载成功或失败都会把键盘焦点恢复到触发该 session，保持与普通异步加载相同的可访问性和连续操作行为。

### 14.58 `0.17.43` 登录入口回归修复

- 浏览器回归统一使用强制登录流程中的“登录工作区”入口，并验证已停用的离线入口不再出现；覆盖回放、session 激活和完整演示流程，避免登录入口变更后 CI 在进入工作区前超时。

### 14.59 `0.17.44` 监管工作台与版本历史

- 管理员登录后进入监管工作台查看并维护任务分配与完成汇总；普通账号继续进入数据工作区。
- 应用顶部显示当前版本，并提供只读历史版本窗口。

### 14.60 `0.17.45` 挂载源 MP4 同步回放

- 只读识别 `h264-split-mp4-v1` 记录并按 60 Hz 状态主时间轴同步五路分段 MP4。
- 连续播放复用原生视频解码上下文；Linux 安装包声明 H.264 解码依赖，JPEG 回放路径保持不变。
- 当前 MP4 支持范围仅为扫描、检查与回放，依赖逐帧 JPEG 的导出格式继续由后端明确阻断。

### 14.61 `0.17.46` JPEG 无跳帧回放

- JPEG 回放按帧顺序推进，五路当前帧全部完成后只前进一帧；I/O 或解码不足时允许整体变慢，不得跳过中间帧。
- MP4 保持原生连续解码，并保留同步暂停、拖动、倍速和时间线状态。
- 监管页新增可搜索的操作员—任务分配工作台，可直接分配扫描或导入的具体任务并保存精确列表。

### 14.62 `0.17.47` 监管标注 JSON 明细

- 监管账户可手动选择单条标注修订 JSON、标注数组或 `{ "annotations": [...] }` 汇总 JSON，在本机读取每位标注人的任务、轨迹、片段和覆盖帧统计。
- 同一 episode 的历史修订只保留最新记录参与统计；片段帧数以包含起止帧的闭区间累计，重叠片段 JSON 明确拒绝。
- 导入限制为不跟随符号链接的普通 JSON 文件，最大 8 MiB、20,000 条标注和每条 2,000 个片段；前端不显示源路径、指纹、描述或片段文本，用户中心审计协议不变。

### 14.63 `0.17.48` 跨电脑自动任务分配

- 用户中心按任务数量分配不重叠的 episode 序号区间，且不接收 NAS 路径或 episode ID。
- 每台工作电脑只需保存一次本机 NAS 根目录；普通账号登录后自动扫描、过滤并打开已分配的视频条目。

### 14.64 `0.17.49` 三维骨架初始朝向

- 三维骨架以当前首次显示帧作为固定朝向参考，后续播放中的真实转身不会改变观察坐标系。
- SMPL 通过脚踝到脚部方向、COCO 通过肩部中点到鼻子的方向判断正面，并兼容镜像坐标数据。

## 15. 里程碑

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 技术原型 | 真实样例只读检查、回放、三种导出，以及独立压力导入器 | 已完成 |
| M1 多平台 Alpha | Windows x64 离线安装包、macOS arm64 DMG、Ubuntu 22.04+ x86_64 deb、reviewed FFmpeg 和基本硬件测试 | 进行中；三安装器 unsigned CD 与完整性门禁已定义，目标机待验收 |
| M2 Field Beta | exFAT 卡、长时数据、异常数据、操作员反馈 | 待完成 |
| M3 v1.0 | 关闭所有 P0/GAP，签名发布和操作手册 | 待完成 |

## 16. 开放问题

1. 采集设备使用 exFAT 时的最长稳定写入时长和断电恢复表现如何？
2. Windows 签名采用哪家代码签名服务，Apple Developer ID/notarization 由哪个账号负责？
3. 正式数据是否会增加 action、task 或其他状态字段？字段版本如何识别？
4. 真实最长 episode 的容量、文件数，以及从不同 SD/读卡器直接回放和导出的性能基线是多少？
5. warning 导出是否需要附带检查报告，或写入目标格式 metadata？
6. 后续是否需要由用户显式选择某些 episode 创建离线副本，还是长期只保留源卡直读？
7. 产品负责人、签名证书负责人和 release approver 分别是谁？
8. 用户创建的任务后续是否需要重命名或停用？当前只允许删除没有历史标注引用的自定义任务。
9. 后续是否需要组织级角色权限和跨主机标注同步？当前局域网用户中心只提供账号生命周期和处理人归因，标注与数据仍保留在各客户端本机。

## 17. Definition of Done

一个 `v1.0` 发布只有在以下条件全部满足时才算完成：

- 所有 P0 需求通过测试且没有未批准的例外。
- 第 14.2 节发布阻断项全部关闭。
- 标准私有样例只读 validation/export smoke 和独立 import 完整性 smoke 均通过。
- 至少一组损坏数据 fixture 覆盖每类 error/warning。
- 100 GB 级数据压力测试达到性能目标，无不可控内存增长。
- 签名的离线 NSIS 在干净 Win10/Win11 x64 上通过安装和卸载。
- 签名并 notarized 的 arm64 DMG 在目标 Apple Silicon Mac 上通过安装、启动和完整离线工作流。
- 真实 exFAT SD 卡完整流程通过，源卡内容 hash 前后不变。
- FFmpeg/WebView2/依赖许可证和版本清单已归档。
- `README.md`、`prd.md`、`AGENTS.md` 与最终行为一致。
