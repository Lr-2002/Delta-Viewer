# 1.3.9-rc.cloudqc.2 Windows 云 QC 候选

基线：1.3.8 / 9d32daa。独立工作树 /home/descfly/Delta-Viewer-windows-cloud-qc-20261027，分支 integration/windows-cloud-qc-20261027。正式安装与 GitHub main/Release 不变。

用户真实登录后，测试模式 → 任务中心 → 云端 QC；admin 管理模式 → 任务中心 → 云端 QC 也可使用。导入本机私有 profile，审核身份由网关确认。下载预览不领取；领取并打开才领取。初始真实批次 2026-10-08-Washing/Washing_003，559 帧，18.635 秒，母体 1 抽中 1，未审核。

动作修改仍存本机草稿；通过/不通过经既有审核保存入口生成真实 session/description/技术证据，云同步只发送实际字节。服务端的原机标 revision、领取、base_review_version 和账号校验不可绕过。旧已通过修改使用 revoke API 关闭下载，未审核描述不发布。持久请求不因网络失败删除，收到精确 accepted_review_version 后持久 ACK 才移除；重启根据原生草稿及绑定恢复。云端当前状态不能从历史 approved 文件推导。

连接经 SSH 反向转发 Windows 127.0.0.1:19090 到开发网关 127.0.0.1:19090，固定专用 CA；token/profile 仅存 Windows 用户私有目录。Windows 云请求使用原有锁定 reqwest/rustls/ring，保持证书链、主机名和 HTTPS 校验；默认用户中心/更新仍使用原 TLS。依赖均为 Cargo.lock 已锁定 MIT/Apache-2.0，无新增下载来源；原生大小差异以构建记录为准。

真人审核由用户完成。测试不领取真实批次、不伪造通过或不通过；下载/回放通过不等于人工QC闭环已验收。未生产发布。

## 目标机验证（2026-10-27）

Windows 10.1.41.119 / lenovo 的 x64 原生 Rust 1.97.1 构建成功；候选程序为 `C:\Users\lenovo\AppData\Local\Delta Viewer Cloud QC Dev\app\dohc-viewer.exe`，桌面入口为 `C:\Users\lenovo\Desktop\Delta Viewer 1.3.9 Cloud QC.lnk`。二进制 52,263,936 bytes，SHA-256 `6c38ab6f7d03b6e17e7de04aa33d012508a0c9a45e830a2af207839c9c54fa02`。正式 1.3.8 安装及其窗口保留。候选正常重开在交互 Session 1 可见，临时 CDP 端口已关闭；仅开发 SSH 网关转发保留。

使用真实用户中心登录验证 admin 仍为 operator/canManage，云身份为 reviewer；不复制登录 session、不提升权限。固定 CA 的原生 TLS 请求成功，BOS 下载使用独立公共信任客户端。41 个清单文件共 172,016,082 bytes，Windows 回读逐一大小/SHA-256 一致。七路视频全部成功解码：Camera 0 3840×2160，Camera 1/2 1280×720，T265 左右 848×800，extension 左右 1920×1080；全局播放七路均实际推进超过 1 秒，error=null。骨架显示 24 关节并随时间推进，总视频范围 559 帧。1440×920、960×680 回放及 390 宽任务列表无横向溢出。不能由这段短播放推断整条视频无损。

真实原机标的 annotations 与 segments 都为空，Viewer 如实显示 0 段；不是解析时丢失。新增片段入口可用，但未对真实数据新增/修改/审核；上游模型空输出与质量门禁由后端协作任务处理，不变更当前冻结 revision。原生待传云 QC 列表为空，预览前后任务 assignee=null、claim_version=0、review_version=0。后端线程也独立只读确认仍 qc_pending / 不可交付。

正常重启后需用户重新登录，然后“任务中心 → 云端 QC → 领取并打开”执行真人审核；“下载预览”不领取。联调依赖当前私有网关和 SSH 转发，不作为生产直连部署。未执行真实审核提交或最终交付验收。

本机完整门禁通过（237 Rust 常规测试 + 3 CLI 测试，15 ignored），前端构建、Clippy、Tauri no-bundle 通过；云 UI 1 项、任务中心 7 项、账号版本及管理 UI 4 项通过。回归发现并修复新增组件重复 key；构建发现并修复 PowerShell 5.1 UTF-8 配置读取。另核对撤回后的历史 approved 文件只作基线、不自动再提交，fetch/sync 互斥防止绑定版本被并发覆盖。证据只在未提交的 `artifacts/cloud-qc/`。

源码在独立分支 `integration/windows-cloud-qc-20261027`，基线 `9d32daa80e253edae63380ac2b29eb0ea01cfb9f`。目标机二进制先从本工作树构建和验收，之后按用户要求将同一批已验证代码及说明做本地候选提交；未推送、无 tag/Release。Windows 构建目录的 17 项源码 hash 已与本机指纹清单逐项一致，提交前再次复核；最终 commit ID 记录在交付说明与 artifacts 中，避免文档自引用。源文件指纹与清单见 `artifacts/cloud-qc/source-identity.json`，构建产物、资源、私有配置、node_modules 均不提交。原工作树已有修改保持。


## RC2：登录恢复与云下载协调（2026-10-27）

RC1 在登录后立即下载新的非空机标任务时，迟到的原目录自动恢复与云下载竞争原生 TaskControl，旧目录 `load_and_validate` 报“已有任务正在运行”；等待后重试才成功。问题是云下载没有取得 App 的同步 OperationScope，不是机标解析失败。RC2 在领取或下载前取得同一保护和原生取消 ID，已有操作时明确等待；显式打开使延迟恢复失效，取消、错误及卸载最终释放保护，下载完成再进入原有加载流程。不修改后端权限、领取规则或审核保存语义。

RC2 在 10.1.41.119 原生编译完成，17 项构建源码与本机逐项 SHA-256 相同，源码指纹 `a51a86f668f1e184fc2beb38453e99973ef1f1a14e6c94a58a53ecfdfe7daa21`。候选程序：`C:\Users\lenovo\AppData\Local\Delta Viewer Cloud QC Dev\app-rc2\dohc-viewer.exe`；版本 `1.3.9-rc.cloudqc.2`，52,636,672 bytes，SHA-256 `bdbc27eca96cc637f62e3a964c17372b3743960a3de03f13742a82c0599fe4a8`。PowerShell 构建包装器在 Cargo 已成功退出后等待未结束，因此停止自己的构建任务，核对 PE 版本后复制该构建结果和已验证 FFmpeg 资源；不是跳过编译或验收。正式 1.3.8 和 RC1 二进制均保留。

新的非空任务在界面中显示为 `upload_6fcff2d8a3454f79885ec6d922751952`，路径仍为 `2026-10-08-Washing/Washing_003`，不能只按同名路径区分旧任务。job `c4e4b5b2e5a34f6a8f7a6225db6cf97e`，recording `5115ab4bc1b3951c5a5b47d138957ffa`，机标 revision `1791bf07db2bf8ab0a8700c7e8d825cb76cfb9f935eae7d6fd1ba1ed48691d48`。真实机标 7 annotations / 7 segments，模型原有 4 个问题保持，不伪造修复。41 文件共 172,042,980 bytes 在 Windows 逐项回读大小和 SHA-256 全部相符；PowerShell 长路径采用 .NET 文件流校验。

冷启动、真实 admin 登录后立即打开任务中心，恢复等待提示可见，等待约 1.64 秒至允许预览，单击一次成功加载 7 个动作片段。七路视频均解码且实际推进超过 1 秒，24 关节骨架画布可见；1440×920 和 960×680 无横向溢出。无新增操作错误、无页面错误、云 pending 为空。预览前后 assignee=null、claim_version=0、review_version=0、qc=pending；没有领取、编辑、审核或撤回真实任务。前一次 QA 因无法 monkey-patch 原生 invoke 而错误记录下载次数 0，保留该测试工具失败证据；改用 DOM 单击计数后冷启动完整复测通过，产品代码未因该计数问题更改。

RC2 完整门禁通过：237 Rust 常规测试、3 CLI、15 ignored，Clippy、前端构建与 Tauri no-bundle；云 UI 2 项（含实际 App 延迟恢复与取消）、任务中心 7 项、账号版本和管理 UI 4 项通过。人工 QC 提交和最终放行仍待真人操作；只读验收不能证明完整人工审核闭环。最终正常重开会清除进程内登录态，用户需重新登录。桌面入口仍为 `Delta Viewer 1.3.9 Cloud QC.lnk`，指向 app-rc2。候选依赖私有网关及 SSH 转发，未推送、打 tag 或发布正式 Release。

正常重开最终核对：候选进程 PID 23676、交互 Session 1、窗口 visible=true，PE 版本及 SHA-256 与上述一致；正式版 PID 25844 保留。9227 无监听，临时本机 CDP 转发关闭；Windows 回环 19090 网关转发仍监听。桌面快捷方式核对指向 app-rc2。最终提交后的源码关联记录在未提交的 rc2-source-identity.json 中。

## RC3：同名来源诊断与任务中心界面（2026-10-27）

用户反馈 0 动作后，先只读核对 Windows 候选的恢复记录、两个独立云缓存、绑定和原 NAS 文件。最近恢复记录确实指向旧 job d4b5300e 的副本，但不能仅凭领取状态推断所有截图来源。三份同名 `2026-10-08-Washing/Washing_003` 的机标内容不同：NAS 原文件 11,660 bytes，SHA-256 `0ba0b30901915b0c71d3c88537a084707d2b34e73cb75f7673c4108d0939efb1`，6 annotations / 6 segments；旧云文件 SHA-256 `29c46a55375ab61897ff32ba12661853291863c33c847f109d1a50cf36ffdcf0`，0 / 0；新云文件 SHA-256 `1791bf07db2bf8ab0a8700c7e8d825cb76cfb9f935eae7d6fd1ba1ed48691d48`，7 / 7。缓存按 job/recording 隔离、哈希与冻结版本一致，没有将新机标解析成空或互相覆盖的证据。

原 NAS 同目录还有已存 `description.json`，5 annotations / 5 segments，SHA-256 `8b172edd19634008f61584dc8b315607c533db9db97cdd9c08e21d102cfde70d`。Windows 经“选择数据目录”的原生目录对话框打开原目录后，编辑器显示已存人工 5 段，“查看 JSON”只读显示原机标 6 段，这是原有人工结果优先规则；没有强行恢复 6 段、删除人工结果或创建新草稿。验收矩阵因此是“原 NAS 人工 5（原机标 6）/ 旧云 0 明确提示 / 新云 7”。

本版只增强来源说明和界面：动作区无片段时明确解释空机标、未保留人工片段或人工新增；保留加号和所有原审核保护。原保存状态行的来源详情展示实际加载绝对路径、原机标数量、当前片段数量及草稿/人工结果来源；文件指纹准确标为 BLAKE3，下载文件的 SHA-256 是另一独立校验值。内部原 sourceHash/CAS/草稿身份算法未改，不按同名目录替换机标。

窗口与主界面标题简化为 `Delta Viewer 1.3.9`，唯一内部版本 `1.3.9-rc.cloudqc.3` 及候选身份保留在摘要/版本详情。任务中心统一头部、本地/云端切换，云端新批次按创建时间排在前，卡片显示可读目录、创建时间、稳定短编号、状态及领取人；完整订单号、上传材料版本等收进详情。封存订单无 batch_path 时仅以抽中目录推导名称，明确不代表整单所有目录。独立滚动、窄屏按钮换行、统一控件与按需详情替代长串占屏，不修改旧任务领取/审核、模式和草稿语义。

回归还发现 RC2 浏览器演示自动调用 Tauri 云同步造成顶部 TypeError，基线可复现并挤压审核区。RC3 仅在真实 Tauri 运行时挂载自动云补传；原生真实失败继续显示并保留待传。来源入口复用原状态行，常驻高度不增加独立说明行。恢复测试等待实际选中 session-b 且 resume 已持久保存再关闭页面，避免将旧编辑器 enabled 误作恢复已完成。

本机完整门禁通过；最终产品变更后的 38 项云 UI / 本地任务 / 统一审核浏览器回归全部通过。最后仅纠正 BLAKE3 标签及来源数量文案，相关空机标、草稿切换和两项布局回归再次 4 / 4 通过，前端构建通过。原 NAS 真实只读解析测试通过，6 段、559 帧、identity exact。Windows 原生验证使用真实 admin 登录与 reviewer 网关身份，原 NAS 人工 5 / 原机标 6、旧云 0 与新云 7 分别核对；不代领、不编辑、不审核、不撤回。旧用户已领取任务保留，新任务仍未领取，review_version 均为 0。

RC3 最终 Windows 程序为 `C:\Users\lenovo\AppData\Local\Delta Viewer Cloud QC Dev\app-rc3-verified\dohc-viewer.exe`，52,636,160 bytes，SHA-256 `e4984aa6b5cd9b6b956a576e0f8fffdf5ad49a8f7cc7a7212fb1c0782343b135`。120 项源码及 8 项前端构建文件在 Windows 逐一核对一致，源码指纹 `fa2ac2689d38110cb4cb7f30f7f0c3900dc81ac031d8d3fd4afe1b8830cdbde0`。最终构建包含 BLAKE3 准确标签及原机标/当前人工数量说明。早期中间 QA 窗口曾占用目标 exe，未采用被占用目录的复制结果；最终输出独立放在 app-rc3-verified，原 .2 和正式安装文件未覆盖。期间正式版窗口后来已不在进程列表，只保证安装文件保留，不虚称其仍运行。

最终原生 QA 报告 `artifacts/cloud-qc/windows-rc3-native-qa.json` 为 PASS，实际完整任务中心 1440/960/390 截图、旧云空状态、原 NAS 人工5/原机标JSON6、新云7回放均留在 artifacts。原 NAS 机标、人工结果、技术侧车和 session 的字节哈希复核无变化。正常重开最终 PID 9188 / Session 1 / visible=true，桌面 `Delta Viewer 1.3.9 Cloud QC.lnk` 指向 app-rc3-verified。9227 已无监听，临时 CDP SSH 转发关闭，回环 19090 网关转发保留；重开后需真实登录。仅本地候选提交，不推送、不打 tag、不发布正式 Release。最终 commit 与该二进制的精确关联写入未提交的 rc3-source-identity.json，并复制到目标机构建目录。

## RC4：未领取预览、原结论恢复与浮点兼容（2026-10-27）

用户在 RC3 的新批次 `#c4e4b5b2` 下载预览后亲自点击通过，本机 session/description/技术侧车均已保存，但云任务尚未领取。服务端以 `QC_TASK_NOT_CLAIMED` 拒绝是正确门禁；客户端错误在于未领取预览也开放了编辑和审核。原任务待审和本机通过分别代表不同层，不能把本机结论当成云端已接收。

先在目标机私有 evidence-claim-recovery-20261027 目录备份 binding、pending、session、description 和技术侧车。已确认原提交 `c6a2e62ba2df89a7e3a96de54eead3c1`，base_review_version=0，admin 本人结论 approved，7 个片段，reviewedAt=`2026-10-27T10:12:30.435Z`。按本次明确恢复授权，用现有真实 admin 身份领取对应单条任务，再调用原生同步；未再次点击通过，未改 payload、CAS 版本、原提交编号或时间。备份及真实 JSON 不提交 Git。

领取后又暴露两个后端兼容点，由后端协作线程修复，Viewer 不修改该服务：其一，默认 serde_json 解析/序列化使 calibration 中的 `1911.7162939335162` 变成 `1911.716293933516`，相邻 binary64 精度误差被当作 session 身份变化；客户端启用 float_roundtrip 并加入精确小数回归，服务端仅兼容标定同类型 float 的相邻值，其他身份/实际标定变化继续拒绝。其二，服务端已核验 compact 人工信息却再从公开摘要读取缺失账号，误报 REVIEWER_MISMATCH，改用已验证证据核对。两次拒绝期间原 pending 一直保留。

后端最终确认接收原提交，review_version=1，云端 approved / sample_passed，原审核时间和 description 字节摘要不变。Windows binding 的 last_submission_hash 仍为原 `1a8c51ae5e0185715b3a2010f2e6ac5ce374693182ed0421b318c03d09fdee5b`，base=1，pending 仅在原生确认后删除。此事实只说明该原结论恢复并被云端接收；最终交付/平台统计另由后端流程核对，不宣称历史缺失事件恢复。

RC4 编辑器对云工作区默认只读；原生以精确 job/recording 读取服务端真实归属，领取人是本人时才开放编辑。未领取、被别人领取或权限查询失败均不能保存；单条、暂存、批量和确认待写回入口均加原生校验。预览仍能定位和回放片段，Space 可播放，X/边界/描述/通过/不通过等修改被阻断。本地/NAS 数据无需云配置和云请求，保留原有草稿、共享写入和审核规则。

提供“领取后审核”与已有结论的“领取并补传原结论”，后者二次确认并使用原待传请求，客户端不自动代领；领取后再次读取服务端确认归属。同步状态中文说明未领取、网络、会话身份和审核人不一致，未知原因保留原错误，不统称断网。同目录手动/后台同步共用单飞；原生 busy 不清待传、不覆盖既有业务错误，其他条目成功也不会吞掉失败。云 QC 徽标按 binding 中服务端确认更新，成功事件只刷新徽标，不替换当前片段编辑。

完整门禁 PASS：239 Rust + 3 CLI，15 ignored，前端构建/Clippy/Tauri debug 均通过。最终源码的 41 项云任务/只读预览/显式领取/部分失败/本地审核浏览器回归 PASS；另覆盖 1440/960/390 宽度提示与按钮。Windows 构建及部署验证证据继续记录于 artifacts/cloud-qc，候选仍独立，不发布正式 Release、不覆盖正式安装。

后端线程独立完成真实后续核验：原 submission 唯一，无第二次审核；BOS 48 文件、172,123,044 bytes，平台自动导入 ACK，最终 completed / deliveredCount=1。processed ZIP 17 文件/14,203,404 bytes，full ZIP 48 文件/172,139,842 bytes，逐项 SHA 校验一致；公司 downloadable / QC 各 1 条、18.635 秒、559 帧。客户端不把这一后端验收结果推广为所有历史任务均已恢复。

RC4 Windows 最终程序：`C:\Users\lenovo\AppData\Local\Delta Viewer Cloud QC Dev\app-rc4-verified\dohc-viewer.exe`，53,242,368 bytes，SHA-256 `17a6d026e2e2564410c4cfe211546bdfdc030184b6ff612ec3954a9a79c171bc`，ProductVersion `1.3.9-rc.cloudqc.4`。369 项源码与 8 项 dist 文件在构建前逐一验证，源码指纹 `0075d3001f9f4f79ffa08a47dea861ea98bab2b4a717bd26cc34ee6e4e094155`。

原生 QA PASS：真实 admin 登录，云身份仍 reviewer；真实新任务显示原人工 7 段且云端已通过，待传为 0，七路实际播放均推进 >1 秒、无视频错误和页面异常。通过独立临时本机 fixture 验证不存在服务端任务时 access / 单条保存 / 暂存 / 批量不通过均被原生门禁拒绝，测试副本随后删除，未对真实任务重新领取、编辑或审核。真实任务前后归属与 review_version 完全不变，原 session/description/技术侧车与恢复备份逐字节哈希相同。本地 NAS access 为 cloud=false/canEdit=true。任务列表 1440/960/390 宽度无横向溢出。报告 `windows-rc4-native-qa.json` 与截图仅存 artifacts。

## RC5：恢复本地 1.3.8 行为（2026-10-28）

用户要求新增云端功能不改变原本地功能。差异审查发现 RC1 将 TaskCenter 的管理员判断从 `role === admin` 改成 `canManage || role === admin`，使 admin 内测账号在测试模式（真实 operator/canManage）也进入管理视图，未领取批次仅显示“未领取”且不显示领取按钮。RC5 恢复原 role 判断；管理模式沿用 1.3.8 明确的管理视图，云端另外传真实 currentUser，不用管理视图的 role 推断云权限。

原 `MachineAnnotationPanel.tsx`、`styles.css` 和 `unified-proofreading.test.mjs` 与 1.3.8 基线 `9d32daa` 逐字节一致；新增云权限/来源界面移到独立 `CloudMachineAnnotationPanel.tsx` 和 `cloud-qc.css`，App 只对云目录选择该组件，保存等待同时覆盖各自组件队列。恢复 IS_DEVELOPMENT_EDITION 原判断，恢复原 source_review_queue::publish；没有云工作区时待写回直接使用原入口。本地 TaskCenter 的数据读取、领取、释放、转交、筛选、统计处理与树行原实现不变，只保留新增云端标签/回调接线。云依赖与原生云专属命令、云目录权限和确认装饰保留。

统计刷新失败另有真实环境原因：NAS `/volume8` 可用空间为 0，delta-viewer-task-index 服务 status=1 失败并自动重启，status.json 心跳停在 2026-10-28 08:43:43 北京时间（原始 heartbeatAtMs 1793148223834）。独立只读核验 index.json 仍在，因此页面能展示上次统计，但不能证明实时刷新完成。未清理任何数据、未重启/修改服务、未写源数据；回退客户端无法恢复满盘的服务，保留原真实警报，不能承诺统计已恢复。需后续由用户释放确认可清理数据或扩容后，再核对服务心跳和请求回执。

RC5 验证：原组件/公共样式/原统一测试逐字节基线校验 PASS，本地 TaskCenter 从状态到读取、刷新、领取、树行的全部函数去掉新增 cloudOpen 状态后与 1.3.8 相同。完整构建门禁 PASS（239 Rust + 3 CLI，15 ignored）；37 项云/本地任务/原统一审核浏览器回归 PASS，额外 operator/canManage=true 领取回归 PASS。

Windows 原生编译 .5：53,671,424 bytes，SHA-256 `82580efad74409f5d830d46aece4f4e0e0c1ba3b5e56032642e0fcef79f43166`，独立路径 `C:\Users\lenovo\AppData\Local\Delta Viewer Cloud QC Dev\app-rc5-verified\dohc-viewer.exe`。源码指纹 `8c81acf8decd8adc9b8108d926ce64aa1e4a6b59e7ae62c15bcb83f3d7e0d92a`。

目标机真实 admin 测试模式：展开 D1-Daily 后 102 个“领取”控件，其中 88 个 enabled，另有空目录/已被他人领取等沿用原禁用规则；无管理模式“立即统计”按钮。只读验收未点击领取、通过、不通过或写入业务数据。云端仍为真实 reviewer，原7片段/approved/review_version1不变，七路视频推进，待传0；三种宽度云 UI 无溢出。刷新服务器依旧心跳过期，如实显示上次统计。原生及展开目录截图/报告只存未提交的 artifacts。
