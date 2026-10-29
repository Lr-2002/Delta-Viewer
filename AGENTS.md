# Delta Viewer 开发指南

### 2026-10-29 独立模型库、片段身份与重新编辑（1.4.5）

用户通过协作明确授权读取外部737条MHR实验骨架：新增本机独立模型库与catalog，不增加网络协议，不写源NAS/旧NPZ。原processed默认保持，显式选新模型仍用smpl_joints；完整relative+session原字节SHA256绑定，NPZ大小/hash、SMPL24/frame_ids/专属索引严格校验，用原episode的cam0时钟，不把库目录当数据根。提示1080p实验、物理单位及标定未验收。目录只标清单条目，筛选/全选共用显示集合；失败旧骨架可用，不能按同名或QC改写静默放松。

时间条颜色绑定稳定sourceIndex，不随覆盖后可见排序变色；保留覆盖裁剪与同边界反向恢复，显式删除和后续新编辑保护保持。NAS满盘后本机待写结论原只读隐藏拖柄，新增可见禁用边界与原因、确认重新编辑入口。SQLite事务按账号/来源/原event核对后将原结论入不可变历史、转新待复审草稿和saved回执；源JSON不改，草稿不经补传发布，重新通过才发布片段。冲突/跨账号不覆盖，不代审真实数据，不重启业务服务；正常版本1.4.5、四处版本和中文摘要同步、完整三平台发布与.119验证。


### 2026-10-29 恢复稳定骨架读取与统计故障诊断（1.4.4）

用户反馈 1.4.3 之前正常的骨架也出现抖动，明确要求恢复稳定性。确认原因是 1.4.3 将 raw_smpl_joints 提升为首选，真实样例原始手腕二阶帧差 P95 约为滤波结果 30.4 倍。恢复 1.4.2 原有八个处理数组的优先级，raw_smpl_joints 只在无有效处理数组时回退；保留所选字段专属 ID、相机采集时间映射、原生呈现回调和固定地面。不能宣称恢复滤波后已消除算法时延，不新增滤波、不固定提前帧数、不改源 NPZ/机标/审核结论。

只读诊断 10.1.40.2：/volume8 数据卷可用/空闲均 0，统计服务 exit 1 且每 15 秒自动重试，status 心跳停止，完整统计停留 2026-10-27 23:18:51。红色提醒真实，保留旧结果和警报；当前进度不是实时统计，刷新未确认不能称成功。需要释放空间或扩容，原审核本机队列不因此删除；不清理真实数据、不迁移统计目录、不手工重启任何业务服务。功能修复按正常版本 1.4.4、中文摘要和三平台完整流水线发布，并在目标 Windows 打开。


### 2026-10-28 离线展示、骨架同帧与待写结论恢复（1.4.3）

用户新授权覆盖旧“停用离线身份”限制：登录页直接进入离线模式，无网络/账号/用户中心配置依赖；配置缺失或损坏亦可进入。固定 offline.local 仅为本机 provenance，无管理权限，不作为公司账号展示。应用本机数据使用独立 offline-local 子目录及 offline-local-v1 队列服务，切换管理模式清空登录会话，离线交互不连接用户中心、设备上报、云 QC 或自动更新，不将本机结果补传给以后登录的公司账号。保留本地扫描、回放、检查、动作/骨架编辑、通过/不通过与导出；普通本地批次可更名，共享审核批次仍须登录核对领取归属。动作草稿仍只保存在本机，显式通过才发布；离线结论署名“离线本机”，不计公司效率。

真实 Fridge_051 的 smpl_joints 与流水线因果 EKF 输出逐值一致，快速动作滞后并非常数偏移。优先读取有效 raw_smpl_joints，缺失/无效时保留其他关节数组兼容，界面注明原始/滤波估计。专属 frame_ids 严格单调；已知流水线 cam0 编码索引用播放器同一真实采集时钟或明确标称时钟映射，保留原 ID 与小数时间，不平移固定帧数、不拉伸显式索引、不修改 NPZ。独立片段播放器也直接跟随原生呈现回调；副相机小漂移有限调速，较大且有缓冲才 seek；共同缓冲暂停语义保持。不能承诺任何硬件/视频都无卡顿或五秒进入。

截图中批量待写结论与按机标来源读取错位：跨来源恢复 onlyPending 的本机不通过，保留当前来源片段不使用其空占位；重复批量跳过已有共享或本机结论，保持原事件 ID/时间/原因。冲突单独使用 SOURCE_REVIEW_CONFLICT，不能误称磁盘落盘失败；待写结论显示只读及处理入口，现存应急草稿不自动覆盖。侧栏优先显示已持久结论，不能由其他来源未审核草稿盖过。测试只写隔离数据，不代审真实条目、不重启业务服务、不删除待写队列。按正式版本及三平台完整发布门禁交付。


### 2026-10-28 更新回归适配与正式交付（1.4.2）

1.4.1 CI 在更新前审核落盘测试发现替身缺少新增 reviewIdentityPath 导出，页面模块无法加载，未生成 tag 或公开 Release。同时补齐批量审核并发 smoke 中同一原生接口；只补齐明确测试接口，不吞未知 IPC，不削弱更新/退出落盘保护；更名及固定地面功能保持。递增正式 1.4.2 并同步四处版本、中文摘要、Changelog，重新完整测试后按既有三平台流水线发布，不覆盖失败历史或已发布资产。

### 2026-10-28 批次实际更名与骨架地面参照（1.4.1）

用户明确授权新增源目录写入例外：加载目录上方提供实际更名单批文件夹入口及确认，不是显示别名；仅同父目录原子 no-replace，不更名磁盘/共享卷根、Delta-D1/分组、单条记录或云端下载工作区，采集日期前缀保留。普通审核员不能更名他人已领取批次，原生核对归属。已有共享 layout.json 保留扩展字段并登记路径映射；普通外接盘使用父目录 .delta-viewer-layout.json。先持久化 prepared 意图及批次身份标记并缓存本机别名，后执行原子更名；中断后仅匹配标记的目标可恢复。JSON 内容、审核原 ID/时间和历史路径不改写；待写回/本机草稿通过别名读取。源视频先卸载，更名后重载。任务索引先验证原始 hash/节点，再映射名称和路径，领取 key 回溯原路径；计数和服务器统计时间不伪造，仍是服务器快照而非实时扫描。

骨架原先每帧减骨盆位置抵消真实平移，且地面按载入帧最低点放置。改为整段首帧固定坐标参照、有界采样脚点估计地面，增加地板、固定网格及地面投影参照。相机只跟随水平位移，真实垂直运动保留，不逐帧贴地、不改源 NPZ。界面明确“估计地面参照”，源数据没有世界轨迹/地面标定时不能声称恢复真实轨迹或实测地面。所有更名测试使用隔离目录，不重启任何业务服务，不更名真实批次。按正式 1.4.1 交付，无候选后缀。


### 2026-10-28 正式发布与版本规则（1.4.0）

发布前 CI 先后发现缓冲冻结后的迟到合成帧回调，以及恢复期间重复 seek 与倍速检查重叠，未生成 v1.4.0 tag 或公开 Release。按用户指定正式发布名 1.4.0，在未发布身份内修复暂停/seek 时忽略回调，移除 hold 切换时的重复 seek，倍速验证先等待真实恢复，再用确定性迟到回调回归后重新运行完整 CI；此次仅修复尚未发布的 1.4.0，不覆盖任何 tag/资产。发布后继续逐版本递增。

用户明确要求将当前 1.3.9-rc.cloudqc.9 的功能正式发布为 1.4.0，覆盖此前“独立候选、不推 main、不发正式 Release”的交付限制。以正式 com.dohc.viewer 标识和既有用户数据目录打包，保留独立开发配置与历史候选记录，不迁移或删除待写队列。后续使用无 prerelease 后缀的正常版本：1.4.0 → 1.4.1 → … → 1.4.9 → 1.5.0，每次改动同步版本号、中文摘要和 Changelog。发布仍走既有 CI 与三平台 release.yml 自动 tag/签名/安装验证，不手工发单平台包、不重启业务服务。本版包含云端 QC、新增常用原因、视频失败诊断和原生回放/首屏优化；本地任务与审核保持已恢复的 1.3.8 语义。候选现场证据不冒充 1.4.0 三平台安装验收；一次未复现长等待、Mac 实机、超长大文件及真人云端审核闭环的缺口继续保留。

### 2026-10-28 原生解码与首屏优先（1.3.9-rc.cloudqc.9）

延续独立 Windows 候选，不覆盖正式安装/发布。macOS VideoToolbox、Windows Media Foundation/D3D11/DXVA、Linux WebKit/GStreamer 硬解均由原生 video 和驱动协商，不能将能力查询或“原生播放”冒充已启用硬解；不强加 GPU 黑名单绕过或关闭沙箱。目标 Windows 曾实测 D3D11VideoDecoder。新 .session_meta 状态达到 512 KiB 先返回首尾有界只读预览，视频首帧读取获得最多 2.5 秒优先窗口，再执行完整检查；失败/超时不能阻断检查，仍须完整检查后开放编辑/审核。媒体首 1 MiB 每次 64 KiB 后回到 1 MiB 顺序读取，断开后不继续读。时间索引按规范路径、大小、mtime、起点、帧数和 FPS 缓存，最多 28 路/200 万帧；变化不缓存，校验不削弱。快速预览不逐段统计容量，正式检查补齐；回环媒体不重复注册 asset scope，无回环仍沿用 asset 限制。只读媒体、原审核/导出门禁及业务服务保持。5 秒是首屏目标而非任意设备/格式/大小的保证。目标 Windows 新 F 盘两条最终计时五路首屏约 1.85/1.88 秒、可编辑约 3.09/2.92 秒；存在一次 39.46 秒未复现等待，不宣称全场景稳定达标。七路隔离缓冲/拖动/结束回归通过；硬解与实测范围详见 docs/native-decode-startup-20261028.md。


### 2026-10-28 SD 长录制加载与真实时间同步（1.3.9-rc.cloudqc.8）

用户授权优化 Windows F 盘本地录制。新 .session_meta MP4 长状态先读取有界首尾，明确 statesPartial，仅视频预览，不以抽样状态代替完整曲线/校验或审核就绪。完整状态解析在原 TaskControl 中进行，扫描、校验及完整载入复用单个受大小/mtime/规范路径约束的内存快照，变化/取消不入缓存；保留所有原状态错误和可信指纹检查。恒定 MP4 时钟只读有界 atom/stts，非恒定回到原探测。新录制 times schema/clock/unit/流名/数量/严格单调校验，CLOCK_BOOTTIME 对齐状态起点，原生及逐帧回退共用采集帧映射；异常明确显示标称时钟回退，旧格式不变。七路视频保持原生解码并在任一路缺少跑道时共同暂停，恢复先对齐；暂停 metadata 预载减少竞争。源媒体只读，不新增自动媒体复制或转码，不重启业务服务，不修改审核逻辑。延续独立候选，无 main/tag/正式 Release；Windows 验收需区分软件改进和 SD 物理供数限制。


### 2026-10-28 自定义常用不通过原因（1.3.9-rc.cloudqc.7）

新增固定原因“数据内容缺失”，沿用既有原生原因门禁；共享RejectionReasons提供“添加常用原因”、排序、移除、按账号本机保存，单条/批量/整文件夹/云编辑器共用。自定义最多20个、每个40字，拒绝空白、重名和控制字符；提交沿用其他原因：文字协议，不放宽服务端白名单。v2单文档保存选项和顺序，读取迁移旧v1排序，保留兼容键；存储失败不伪报成功，恢复默认只重置顺序而保留自定义，其他原因始终固定右下角。添加/排序/移除不提交审核或修改历史结论。继续独立候选，不生产发布，不重启业务服务。

### 2026-10-28 视频读取失败精确提示（1.3.9-rc.cloudqc.6）

播放失败才调用有界只读诊断：VIDEO_FILE_MISSING 为已确认文件缺失；VIDEO_FILE_DAMAGED 为容器截断、空文件或缺少 moov；VIDEO_MANIFEST_INVALID 为清单/实际文件不一致；VIDEO_READ_FAILED / FRAME_READ_FAILED 保留权限、网络或未知原因，不将解码器不支持误称文件损坏。诊断最多读取64个容器头，跳过媒体负载，不修改媒体、帧数、校验门禁或审核结果。错误卡片及主相机暂停提示包含具体相机、文件和原因，操作历史保留稳定码。后台预读失败不触发额外诊断，异步旧回包不可污染新帧。继续独立候选，不生产发布。

### 2026-10-28 恢复 1.3.8 本地功能（1.3.9-rc.cloudqc.5）

按用户要求恢复云端接入期间对原功能的改动：本地 TaskCenter 只按原 role 判管理员，不能把 operator/canManage 在测试模式视为管理员而隐藏领取；管理模式恢复原明确管理视图。原 MachineAnnotationPanel.tsx、styles.css 和既有统一审核测试恢复 1.3.8 原字节；云端新增权限、来源和空机标界面移入独立 CloudMachineAnnotationPanel 和 cloud-qc.css，仅云目录使用。恢复原 source_review_queue::publish 入口，本地不安装云门禁。云端身份仍用真实账号，不因管理视图改角色。保留所有业务数据、持久队列及云端能力，不回退内部版本号、不覆盖正式安装。

只读诊断 NAS 数据卷可用空间0，统计服务退出重启，status心跳停更；客户端警报真实，代码回退不能修复满盘，不删除源数据或隐藏失败。此次不重启业务服务。新 .5 候选须测试、本地提交并在Windows独立打开。


### 2026-10-27 云端预览领取与原结论补传（1.3.9-rc.cloudqc.4）

云端下载预览不代表领取；编辑器默认只读，实时查询精确 job/recording 归属，只有本人已领取才开放修改与通过/不通过。原生单条、暂存、批量及待写回入口均在写入前核对服务端归属；本地/NAS原有流程不依赖云端。未领取已有真实本机结论时提供用户显式领取并补传，原 pending payload、submission ID、CAS版本与审核时间保持不变，拒绝和未确认不删记录、不重做审核。正常补传与人工重试共用同目录单飞，在途 busy 不覆盖原业务错误。会话标定启用 serde_json float_roundtrip，避免最低位变化导致身份校验误拒绝。独立 .4 候选，不发布正式 Release、不覆盖正式安装，不修改后端服务或绕过其领取校验。


### 2026-10-27 云端任务界面与空机标来源（1.3.9-rc.cloudqc.3）

按用户要求，标题与主界面品牌仅显示 Delta Viewer 和简洁数字版本 1.3.9；唯一内部版本保留在摘要/版本详情，候选仍隔离、不生产发布。任务中心统一头部和本地/云端入口，原本地审核、模式及草稿语义不变；云端批次显示目录名、创建时间、稳定短编号，订单/完整 revision 折叠，仅由抽中数据推导的名称注明范围。刷新失败与操作失败分别保留，列表独立滚动并适配窄屏，不改变云身份和领取权限。

同名 Washing_003 存在三份不同机标：原 NAS 6 动作、旧云副本 0 动作、新云副本 7 动作；不得互相覆盖或按同名替换。动作入口显示实际来源、加载目录和原文件摘要，空机标明确说明，仍支持手工新增。原数据只读验证，禁止代领/编辑/审核真实任务；Windows .3 独立 app-rc3，不覆盖 .2 或正式版。


### 2026-10-27 云端下载与登录恢复协调（1.3.9-rc.cloudqc.2）

延续独立 Windows 候选，不发布正式版。云任务在领取/下载前同步获得 App OperationScope，使用同一原生取消 ID；已有恢复/加载未完成时禁用领取和预览并明确提示等待。显式下载递增目录导航代次并清除延迟恢复，防止异步返回的旧目录在下载期间抢占 TaskControl。下载完成释放保护后才进入已有只读加载流程；取消、失败、账号切换/卸载都释放所属保护，不抢占既有任务、不自动重试领取。真实新批次验证只读7动作，禁止领取审核/修改冻结结果。


### 2026-10-27 Windows 真实云 QC 联调候选（1.3.9-rc.cloudqc.1）

用户明确要求在最新 1.3.8 基础独立 worktree/分支接入真实云 QC，覆盖旧“不允许云端下载”的对应范围：仅显式导入账号绑定、公司限定、固定 HTTPS/CA/下载域名配置，经原生 Rust 下载 SHA256 清单到专用本机工作区，既有回放读该目录。Windows 通过仅绑定 127.0.0.1 的 SSH 反向隧道访问测试网关；不关闭 TLS、不在仓库/日志输出 token。云 QC 独立身份来自服务端，不用本机管理模式或 canManage 提升网关权限，不升级共享账号。保留 1.3.8 所有功能。

本版是隔离联调候选，用户明确不生产发布：不推 main、不打 tag、不上传正式 Release、不覆盖正式安装目录。候选版本、窗口标题和中文摘要必须明确；独立 app identifier/数据目录，不复制旧登录 session 和队列。先以真实账号登录；凭据只复制配置文件与专用审核 token。

任务中心云 QC 每 5 秒读取；显式领取由服务端版本/账号核验；下载预览不领取、不提交结论。动作编辑继续只保存本机 SQLite 草稿，审核通过才发布本机云副本的 session/description。后端确认接收与最终交付分开。已审核后改动使用独立 revoke 撤回放行，不发布未审核草稿；持久 pending 原请求/ID/版本，网络失败保留，重启原生扫描补传，部分异常不能被无关成功清除。初次下载已有文件仅作基线，不自动伪造结论。真实批次冻结待人工审核；自动验证只读/下载/加载，不点击通过或不通过。

仅可停用本机旧 1.2.7 云 QC 候选，不重启 44587/18082/8765/8766 或上传服务；后端由协作线程维护，不并发修改。Windows 原生构建和真实 UI 需验收；没有真人审核不能宣称云 QC 闭环已验收。


### 2026-10-27 当前软件版本与版本日志（1.3.8）

账号列表只显示已确认在线的当前软件版本，多个在线版本仍明确提示；设备上报与时间收进原生模态“版本日志”。离线、失败和未上报保持当前版本未知，不从审核事件推测版本、不将未上报判为未工作。安装实例 ID 跨升级复用并只读迁移旧键，返回前台及恢复网络主动重报；版本心跳不影响审核计时或补传。


### 2026-10-27 同步布局发布回归适配（1.3.7）

包含 1.3.6 的紧凑同步状态栏、双队列补传及原生历史版本弹窗；旧磁盘失败回归改为先核对醒目风险摘要，再展开原因。1.3.6 因旧测试等待隐藏详情而未发布，本版递增版本重新执行完整门禁，不跳过审核保护检查。


### 2026-10-27 同步提示布局与模态层（1.3.6）

修复 1.3.5 同步警告 sticky z-index 35 高于历史版本 overlay 20 而穿透遮挡。历史版本改为原生 dialog.showModal，原生焦点约束、Escape/遮罩关闭及原入口焦点恢复。两套待传提示合为单一状态栏，置于当前模式头部下方正常布局；无绝对定位和跨弹窗置顶。异常摘要、真实待传操作事件数量、补传按钮保持可见，时间/原因/原始错误按需展开；异常记录和未落盘风险仍明确展示，正常及短暂排队继续隐藏。标注审计队列另有待传时独立说明、不混算到审核操作事件数量；同账号登录后分别尝试两个队列，任一失败保留。只收拢明确的工作区鉴权失效错误，其他错误不被同步成功清除。普通更新轻提示移至右下角，不盖顶部补传入口；数据队列、统计语义、服务端及 NAS 写入逻辑不变，不重启服务。


### 2026-10-26 账号演示兼容与发布恢复（1.3.5）

1.3.4 原生账号查询和核心门禁通过，但完整浏览器回归发现非 Tauri 演示的独立版本接口返回空账号，导致原账号删除入口不可见，CI 阻止发布且未生成 tag。修复仅补齐演示侧独立账号元数据，复用演示账号状态及隔离审核 fixture 的身份，删除后刷新不复活；不调用审核聚合、不伪造设备上报。保留失败提交，以 1.3.5 完整发布提交恢复，不手工补 tag 或跳过门禁。原生服务端协议无变化，不再次重启业务服务。


### 2026-10-26 账号版本独立查询（1.3.4）

真实部署约 753 万审核事件的全量汇总超过原 12 秒请求预算，不能让账号展示依赖该统计。管理模式默认账号页（有 canManage 的整合账号）；账号与版本通过独立有界元数据接口读取并由 Rust 按当前真实账号名单合并，不调用审核聚合，不因旧版本报告复活已删除账号。账号页独立刷新时间、筛选、错误与推送；任务/勘误页不轮询无关统计。审核总览继续原统计语义，本次不改变其计算结果或伪造完成。1.3.4 延续 1.3.3 服务端协议和账号迁移，无需再次重启任何业务服务。


### 2026-10-26 admin 双模式与版本提醒（1.3.3）

用户明确授权将现有管理功能整合到 admin 内测账号，保留 admin 原密码、稳定用户名和 operator 审核身份。managementAccess 只能在服务主机维护的账号状态中授予，登录回传 canManage；Rust 和服务端管理门禁同时核验，不能靠前端模式或账号名称授权。admin 默认测试模式；切换管理/测试保留已载入数据及本机草稿，隐藏编辑器暂停快捷键、播放和审核会话，管理页交互不计审核操作。已确认停用原 yangshuoniubi 登录，保留其历史身份、归属、原密码哈希和所有记录；迁移只在既有用户中心停止时备份并原子修改两账号字段，不合并或重写历史。

明确新增用户中心协议例外：已登录客户端每 15 秒以稳定随机本机实例 ID、编译版本、平台上报，管理者可读取各账号设备版本、服务器上报时间和在线状态，并按账号单个/多选/全部推送固定更新提醒。不得上传主机名、源数据或路径；不写审核事件、不计有效耗时。90 秒新鲜度和有效登录会话共同判断在线；服务重启先显示离线历史，旧版未上报显示未知，获取失败保留版本并明确在线未知。提醒 SQLite FULL/WAL 持久保存最多 7 天；按账号确认、幂等去重、离线重连补送，不能越权确认他人提醒。客户端提醒不抢焦点、不自动消失、不强制更新，查看更新只打开既有官方 GitHub 下载验签与主动安装入口。旧版不支持该协议，须先手动升级，不能声称全版本已可推送。允许在隔离测试通过后更新既有用户中心单元；保留证书/service ID/账号/审核与领取库及主机扩展，不重启工作台或上传服务。


### 2026-10-26 多来源草稿兼容（1.3.2）

在 1.3.1 的提交后发布流程上补全切换来源：同一数据的各机标来源可各自保存未审核本机草稿，不把 pending 草稿误当为必须先写回的结论；只有已提交但待写回的结论才阻止跨来源重复提交。各来源仍保留自己的首次共享基线；另一来源发布导致共享结果变化时继续拒绝旧草稿覆盖，不放松审核通过门禁。

### 2026-10-26 动作片段审核通过后发布（1.3.1）

用户新要求覆盖旧“动作修改实时写入 NAS/撤销共享 QC”的规则：动作描述、边界、增删、切割、恢复、越界处理均只保存当前用户中心/账号的本机 SQLite FULL/WAL 草稿，不改当前 description.json / desorption.json、技术侧车或 session.json；包括再次修改已通过结果。显式审核通过才发布当前动作快照。未审核草稿不能由通用待写回发布，也不进入容量恢复弹窗；侧栏显示“本机草稿 · 待审核”。审核不通过仅提交结论/原因/审核人/日期，片段沿用最新共享内容或原机标，不发布未批准的动作修改；替换前草稿历史仍在本机保留。共享结果变化继续拒绝覆盖，本机记录不删除。

通过/不通过先将本机结果和原提交 ID/时间的审计回执置于同一事务，再尝试写回；NAS 故障时等待确认补写，未确认结果不删除。骨架入口无审核功能，继续独立自动保存。用户中心效率仍可计本机持久结论，不等于 NAS QC 或工作台已统计；通过、不通过时长、120 秒无操作扣除与心跳规则不变。本版无需更新或重启用户中心、工作台及上传服务。


本文件适用于整个仓库。所有开发者和自动化编码 agent 在修改代码前都必须阅读 `prd.md`；产品范围、字段语义和验收标准以 `prd.md` 为准。


### 2026-10-23 全视频边界、本机审核回执与批量原因标签（1.2.7）

按用户新要求，覆盖旧“只有写回 NAS 才统计审核效率”的限制：本机结果与待上传结论须在同一 SQLite FULL/WAL 事务提交；用户中心接收后可纳入人工审核完成与效率统计，但不等于 NAS QC 已写入、共享任务进度已完成或工作台已统计。沿用原提交 ID、发生时间、账号和会话；自动 NAS 写回发送独立 source_written 回执，不再发送第二次通过/不通过，不计人工操作或有效耗时。通过、不通过原始时长均计入；未知时长/轨迹保持未知，有效时间继续扣除超过 120 秒的无操作部分，心跳不能代替操作。

用户中心白名单审计 details.value 允许有界 delta.review-receipt.v1 元数据：storage、submissionId、dataset（固定数据集名）、identityKey（小写数据集相对目录的 SHA-256）、channel、originalDurationMs、batch；这是用户授权统一统计所需的新协议例外，不发送明文源路径、描述、图像或片段。哈希只用于跨盘符匹配和去重，不证明数据质量。相同目录取最新结论，后续 saved 撤销当前完成；骨架不计审核。工作台仅通过已登记迁移映射匹配哈希，不按同名编号猜测，不将本机结论用于自动遮罩、转换、上传或发布；这些流程继续使用实际 NAS QC。旧本机队列按原事件补传，不宣称历史缺失 10 条已恢复。

边界允许跨多片段扩展至全视频，部分覆盖仅裁去交叠，完全覆盖保留精确删除历史；拖动预览按 requestAnimationFrame 更新，仅释放时提交，反向拖回恢复预览，取消不保存。批量/整文件夹不通过与单条共用 RejectionReasons，包含全部原因、拖动排序、Alt＋方向键、恢复默认与按账号本机记忆，“其他原因”固定右下角；仍只处理未审核条目并二次确认。

用户明确允许隔离测试通过后更新并用既有 systemd 单元重启工作台 44587 和用户中心；部署前记录传输/发布状态，部署后核对恢复，不重启 8765/8766 或单独上传服务。



### 2026-10-23 1.2.8 发布恢复

1.2.7 main CI 在并发交互 smoke 中仍直接查找批量原因文本框，未选择“其他原因”，失败后未生成 tag 或安装包。保留失败提交，不移动历史或手动补 tag；本次使用完整 1.2.8 发布提交恢复发布状态，预置标签点击与其他原因输入均继续实测。包含 1.2.7 的全部产品行为，不跳过门禁。

### 2026-10-23 片段边界反向复原（1.2.9）

覆盖 1.2.7 仅在单次拖动预览中可逆的限制。同一编辑器连续调整同一片段同一边界时，保留首次调整前的片段基准，松手自动保存后反向拖动仍按位置逐段恢复原范围和描述；起始、结束边界、方向键和数字帧输入共用逻辑。预览不保存，取消不影响已保存状态，只有释放才提交；恢复范围不恢复已失效审核结论，保持待审核。原本已删除的片段不自动复活。

调整另一片段/另一侧边界，或修改描述、增删/切割/手动恢复、重新读取/切换数据与账号/动作骨架通道后，以当前内容开始新的边界调整，避免旧快照覆盖新编辑。反向恢复基准仅保留在当前编辑器内存，不跨重启；已有版本历史和删除恢复继续可用，不重写历史结果。本次仅客户端修改，无需更新或重启统计与上传服务。

### 2026-10-23 1.3.0 构建环境恢复

1.2.9 在云端安装 Ubuntu 系统依赖时遇到 Azure archive 下载仅约数十 KiB/s，119 MB 依赖无法在原 30 分钟门禁内可靠完成；同一步在上一版约 39 秒。两次尝试均在应用测试前取消，未生成 tag 或安装包。保留原提交，按 1.2.9 -> 1.3.0 规则发布恢复，不复用版本、不移动 tag、不跳过门禁。仅在临时 Ubuntu CI/CD runner 中把 azure.archive.ubuntu.com/ubuntu 精确替换为官方 https://archive.ubuntu.com/ubuntu，保留 suite、组件、安全源和签名校验；不改变用户电脑、NAS 或业务服务软件源。完整三平台门禁通过后交付 1.3.0，包含全部 1.2.9 反向复原行为。

## 1. 不可破坏的产品约束

1. 源 JPEG、`states.jsonl`、骨架和其他采集文件是只读数据。唯一源端写入例外是用户明确保存标注时，在当前 episode 根目录原子创建或更新应用管理的 `description.json`；不得创建、修改、重命名或删除其他源文件。
2. 数据运行时只通过操作系统已挂载或映射为目录的文件系统路径访问源数据：支持本地目录及 Windows 映射盘、SMB/NFS 挂载等网络文件系统目录。应用不增加 SSH、云存储或 NAS 连接协议。除根级 `description.json` 外不写回源目录，也不自动复制。用户中心是唯一的业务身份和标注绩效审计例外：客户端只通过管理员导入的固定证书访问当前主机局域网 HTTPS 服务；审计 payload 只允许事件 ID、操作类型、task ID、trajectory code、revision、开始/结束/操作时间，账号由登录 token 推导；不得发送源路径、episode ID、描述、片段文本、图像、状态、检查结果、报告或 hash。自动更新按 2026-10-15 用户新要求只读取 GitHub 官方正式 Release，见下述补充。
3. 正常工作流是“选择 SD 卡 -> 自动扫描全部 session -> 直接加载首条 session -> 健康检查 -> 回放/标注/导出”。正常 UI 不得自动复制源数据；保存标注需要当前 episode 可写，其他流程保持只读；使用期间源卷必须保持挂载。
4. 导入器仅用于压力验收和未来显式离线导入；一旦执行完整导入，仍必须验证目标端的文件大小和 BLAKE3，不能只信任复制时的源端 hash。
5. `capture_time_ns` 在 Rust/磁盘中为 int64，在 TypeScript 中必须保持十进制字符串；涉及差值时使用 `BigInt`。
6. 五个标准流名称固定为 `cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`。
7. Warning 数据可以在明确提示后导出；error 数据不能通过 UI 或 IPC 绕过阻断。
8. LeRobot 数据不得虚构源数据中不存在的 action。规范化时间轴时必须保留原始纳秒时间。
9. 正式输出必须先写 partial 路径，成功后再原子 rename；不得覆盖已有输出。
10. 私有原始数据、构建产物、FFmpeg 二进制和签名凭据不得提交到 Git。
11. 时间裁剪只允许单条轨迹的一个连续闭区间；不得修改采集文件，保存标注时只可刷新 `description.json`，三个 adapter 必须使用同一范围。
12. 所有数据用户必须使用统一管理登录模式；离线身份绕过已停用。账号由当前部署主机上的局域网用户中心统一管理：登录页可自助注册且只能创建普通标注员，管理员只能在服务主机初始化或由现有管理员创建；已登录标注员只能修改自己当前的显示名称，稳定账号名和角色不可自助修改。客户端通过导入配置固定 HTTPS 证书和 service ID，登录成功后只在 Rust 进程内保存当前会话和短期 token。标注保存后必须上传第 2 条定义的幂等白名单审计事件，用于按用户统计任务量、操作次数和耗时；质量评分只能由后续独立检测写入，客户端不得自报。所有数据 command 必须经 `AuthState::require_user()` 门禁，用户中心和更新 command 必须要求已登录用户。
13. GitHub Release 必须同时包含 Windows x64、macOS arm64 和 Ubuntu 22.04+ x86_64 原生 deb 三个可安装产物；不再构建或发布 macOS x64。当前阶段允许发布明确标记为 `UNSIGNED` 的完整集合；该标记表示没有可信发布者身份。Windows 产物不得暗示 Authenticode；macOS app/main/FFmpeg 必须有结构有效的 ad-hoc seal，但不得暗示 Developer ID 或 notarization；Ubuntu deb 必须在 22.04 runner 用 `apt` 安装和启动验证。任一平台、依赖或安装/启动检查失败时不得公开部分 Release。
14. 自 `v0.17.6` 之后，仓库实际默认分支 `main`（口头所称 `master`）不得保留没有对应版本 tag 的独立提交。每个进入 `main` 的 commit 都必须是完整的发布提交：同一 commit 包含全部代码/文档变更、四处一致且唯一的新 semver，以及带日期的 Changelog；CI 成功后必须由发布 workflow 创建精确指向该 commit 的 annotated `vX.Y.Z` tag。禁止先推功能、修复、文档、CI 或配置 commit，再另推 version/release commit；除自动 tag 尚在运行的短暂 pending 状态外，`main` 必须保持一 commit 对应一 tag。
15. 按用户 2026-10-15 新指令，本版从 `1.0.63` 升为 `1.1.0`。此后 patch 末位仅使用 0–9：`X.Y.0` 至 `X.Y.8` 连续加一，`X.Y.9 -> X.(Y+1).0`，例如 `1.1.9 -> 1.2.0`，不再生成 `1.1.10`。minor 的这种自动进位已获授权，major 变化仍需用户明确指定；不按功能规模跳号。
16. 自动更新以 2026-10-15 补充为准：固定官方 GitHub 仓库和 HTTPS 资产域名，精确版本/平台/1–64 MiB/SHA-256/Minisign 硬校验；下载与安装使用 TaskControl，检查不占用数据任务。更新私钥只在受控备份和 Actions secrets。

### 2026-10-15 GitHub 更新与交互补充（1.0.63）

1.0.63 更新体验与来源（2026-10-15）：按用户明确新要求覆盖旧镜像更新规则。客户端只从 https://github.com/Lr-2002/Delta-Viewer 最新正式 Release 更新；先读固定 GitHub latest Release API，不可用时读取同仓库官方 /releases/latest 的精确标签跳转，拒绝 draft、prerelease、非标准 tag 和降级，再锁定精确 tag 的有界 latest.json 与当前平台资产。已登录后后台检查不占用 TaskControl、不阻断数据载入；发现新版仅标记入口和一次轻提示。用户查看说明并主动下载，完成后先验大小、SHA-256 和 Minisign 签名并缓存，提供“保存并重启更新”和“稍后”。安装仍使用 TaskControl，不打断扫描/检查/导出/批量任务，先等待当前复核保存和审核事件落盘，失败恢复会话并留在当前版本。重启后联网检查匹配版本时重新验证缓存并恢复准备好状态；缓存不可用时要求重下，不使用已篡改字节。每版本首次打开显示内置更新摘要，关闭后本机不重复。GitHub 不可达、超时或限流仅影响更新，在入口中提供可重试原因，不自动弹错误或阻断审核。旧镜像服务仅供历史客户端，不再是新版发布验收依赖。说明见 docs/github-updates.md。

### 2026-10-16 用户明确放宽机标读取约束（1.1.3）

按用户最新要求“只要有机标 JSON 记录都能正常读取加载”，覆盖 1.1.2 下文“无法核实指纹继续拒绝”的旧限制。目录/旧路径/指纹变化不能单独阻止读取：精确匹配优先，其次唯一 asset_id 主结果，再次文件中唯一结果；同目录兼容读取不等于来源已核实，必须区分提示，不虚称相同帧数/单一结果证明身份。多结果无法唯一选择、JSON 损坏和非法原始边界仍须具体说明，禁止随意取首条或虚构动作。旧人工/本机草稿的技术索引或状态可以兼容恢复，恢复前原字节在本机持久备份；无法使用的旧范围不得静默缩放或覆盖原件，可重新载入原机标并提示恢复备份。加载不修改源机标、人工结果或 QC。仅正常人工保存时提交当前内容。

### 2026-10-16 机标目录编号兼容补充（1.1.2）

机标优先精确匹配目录名。失配只允许使用固定生产端 MP4 元数据指纹协议核实当前 cam0 列表、大小和修改时间，并同时核对主相机帧数及 asset_id 唯一主结果；不按编号偏移、相同帧数或“只有一个结果”猜测。只核验当前目录，禁止扫描其他批次或解码全视频。无法支持的来源、符号链接、歧义及无法核实的指纹继续拒绝，显示两侧编号与人工标注指引。兼容加载显示编号差异提示（1.1.5 按用户新要求允许忽略当前账号、目录及机标内容的提醒，可恢复查看；内容变化重新提醒），保留原 source_json/hash/episode_id，人工输出继续按原机标身份回写。见 docs/machine-episode-identity.md。

### 2026-10-15 更新稳定性补充（1.1.1）

公网 GitHub 更新开启 reqwest `system-proxy`，局域网固定证书用户中心必须 `.no_proxy()`，不可将身份/审核流量随公网代理转发。GET/HEAD 仅对短暂传输及指定服务错误有界重试，不对证书、来源、大小、哈希或签名失败降级。只读一份有界清单，验证后交给原生安装器，禁止恢复重复联网读取。错误须显示环节与可识别原因，未知不伪称断网，不泄露代理凭据或 CDN 查询参数。原生 Windows 网络回归是发布检查的一部分；联网清单/下载验签诊断只读、显式执行且不安装。见 docs/github-updates.md 与 docs/github-update-stability-20261015.md。

### 2026-09-08 校对与正式发布补充

用户明确要求在正式版 `1.0.2` 发布校对编辑与播放优化，取代之前仅开发版提供机标的限制。原人工标注功能继续保留，静止/缺失位置轨迹仍允许确认警告后标注。最新指令还要求可打开的数据完整加载：兼容 `.session_meta/manifest.json` 的新 MP4 记录；个别相机/帧或尺寸、帧号等质量问题不再卸载整条记录，主帧读取失败只暂停播放并保留数据供继续定位。只有未识别到任何视频/图像流时阻止空工作区加载。检查报告保留所有问题，导出 error 门禁不变。这覆盖旧的任一图像 issue 即阻断加载规则。

新增源端写入例外：校对草稿先写应用本机目录；所有保留片段明确合格后，才在当前 episode 根目录首次创建 `bailian_annotation_reviewed.json`。后续编辑实时原子更新该文件，未修改机标字段保留，原 `bailian_annotation.json` 始终只读。复核结果带独立人工状态，后续修改会撤销对应片段合格状态。允许同目录的固定复核锁及专用 partial；这些应用管理文件不参与采集指纹或统计。禁止覆盖外部同名文件、源机标变更或并发修订冲突。此明确用户需求覆盖上文仅允许 `description.json` 的旧限制。复核内容不上传用户中心、不写人工标注记录，也不计入人工标注完成量。

`1.0.2` 恢复正式应用身份 `com.dohc.viewer` 和正式更新通道，必须按既有三平台完整集合门禁发布，不能使用此前 Mac 开发版优先发布的例外。

### 2026-10-21 机标越界显式处理（1.2.4）

机标声明范围超过当前 Camera 0 时继续保留原始结果供查看，新增人工确认入口列出受影响片段；确认前不自动保存。确认仅取当前视频帧范围交集，跨尾片段截尾，完全越界片段以精确原始索引/范围及文字保留在技术历史，不进入有效人工 annotations。禁止按比例缩放或宣称帧数相等证明内容对齐。保存前原机标和已有人工结果原字节必须在本机持久备份，失败不能覆盖。处理保存为 pending，已有审核结论变待审核；回放核对确认前不能通过，编辑后撤销核对勾选。后端只允许精确原机标的 deleted 越界历史，所有有效片段必须在当前 Camera 0 范围内。重新打开及新主机保留技术历史，恢复删除不可恢复越界段。媒体、原机标、其他 episode 均只读，非显式保存不改变人工结果或 QC。

### 2026-10-21 任务中心入口与待写审核标记（1.2.3）

任务中心记忆或选择 Delta-D1 下已知分组目录时，从 Delta-D1 展示全部当前分组和批次，仍存在的旧目录保留，不重定向源数据或改写迁移映射；批次名称下显示相对路径。历史领取人沿用已确认连续映射的原批次键，不猜测拆分旧整组领取。

侧栏本机待写动作结果明确显示“本机通过／不通过／草稿 · 待写回 NAS”，不能显示为已写入审核。摘要按当前服务、账号和加载路径在本机有界查询，不受提示明细前 200 条限制，骨架不参与审核标记。确认写回成功后重新读取本人审核关联；失败条目保持本机标记，不增加共享进度。切换账号和目录清理过期查询，异步旧回包不能污染新视图。用户中心接收事件与工作台统计完成仍分别说明。

### 2026-10-21 1.2.1 发布恢复说明

1.2.0 main CI 因新增 IPC 的浏览器模拟接口遗漏而失败，未创建 tag。保留失败提交，不修改历史或手动补 tag；按当前用户持续授权修复并发布新版本，本次以完整 1.2.1 发布提交恢复 main 的可发布状态。此为本次失败的恢复记录，不取消后续发布前完整检查及一提交对应版本规则。

### 2026-10-21 目录迁移与人工结果精简补充（1.2.0）

按用户确认的新要求覆盖旧版完整 `_human_review` 输出：人工 `description.json` / `desorption.json` 的审核信息只保留 `status`（pending/approved/rejected）、`reviewer`、`reviewedAt`（UTC ISO 8601；待审核署名及日期为空）。片段数据仍按原格式保存，删除真实移除、新增真实插入，不以技术元数据代替。完整修订、摘要、来源索引、恢复及并发状态允许另写当前 episode 根级应用专属 `.description.review-state.json` / `.desorption.review-state.json` 及其唯一 partial；这是用户明确授权的源端写入例外。技术状态必须与当前人工文件字节哈希及输出名绑定，不能将旧技术片段套到新人工内容。技术文件不参与采集统计/指纹。加载只读兼容旧完整格式；仅显式保存才精简，不批量改写已有结果。

勘误技术标记另存技术文件，本机撤销历史继续保留。技术文件先原子落盘，再原子写人工结果、根级 QC 和本机确认；中断仍保留 pending 草稿/原事件身份，不虚报完成。共享 session 的 QC 仍为任务进度依据，现有账号关联协议保持兼容。

三支线分组不可领取，日期批次各自领取。固定共享索引目录 `Delta-Viewer-TaskIndex/Delta-D1/layout.json` 只存已确认 completed 迁移，最长前缀匹配，拒绝越界/歧义/链接；旧路径仍存在时不得替换。只读加载索引后再适配批次身份，不放松原索引哈希和回执校验。允许在该索引目录部署映射，不修改源媒体、机标或历史 QC，不重启后台服务。映射缓存仅写本机 `dataset-layout.json`，离线待写队列不得访问 NAS 查找别名；不得推测拆分旧整组误领记录。

### 2026-10-21 骨架片段描述补充（1.2.2）

按用户明确要求新增与动作片段并列的骨架片段入口。骨架描述不导入机标，初次为空，支持与动作相同的增删/恢复、切割、边界微调、回放、数字标签快捷键和自定义标签；预置往前走、抬肘、踢腿、蹲下、顶门、关上洗碗机，标签库按账号及通道隔离。无审核功能，Enter 不提交审核，保存不改 session.json、动作人工结果或任务进度。

允许在当前 episode 根级原子写应用管理的 skeleton.description.json、.skeleton.description.review-state.json 及唯一 partial，这是用户明确新增的源端写入例外。公开骨架文件沿用 episode_results/annotations、零基左闭右开帧范围，只含实际保留片段，不写 _human_review；并发/恢复技术状态与文件哈希绑定。恢复只读源文件，允许记住本机比较基线；普通保存校验版本及共享字节，冲突保留本机结果。NAS 失败沿用持久队列及明确确认写回，动作与骨架独立且不覆盖；骨架只有 saved 操作事件，不伪造 approved/rejected，不影响原时长统计及 120 秒无操作扣除。

目录后续改名 D1-Daily、D1-Validation、D1-Yiqi、D1-Motion caption 保留分组语义；已确认连续迁移逐步解析，拒绝循环，最长前缀优先。只更新独立索引目录的已确认映射，不修改原审核结论或重启服务。发布仍按三平台完整门禁。

### 2026-10-22 领取人仅显示在具体批次（1.2.6）

任务中心仅在具体批次行显示审核领取人（姓名与账号）及领取状态。数据根目录和上级分组不显示领取人、人数、已领取批次数汇总或对应提示。目录与审核进度继续展示；领取、释放、历史映射及服务器统计逻辑不变。

### 2026-10-22 任务中心领取归属与实时统计（1.2.5）

已确认 NAS `layout.json` 缺失导致迁移后批次查询新键而非历史键，原领取记录仍在用户中心。恢复经逐个最终目录核实的 164 条既有 completed 映射，仅写独立索引；增加同目录 `layout.last-good.json` 缺失回退，主映射存在但损坏不得回退掩盖。两者均缺失时已知分组统计报明确错误，保留旧视图，不能将未知身份显示为未领取；空映射不覆盖本机已有离线映射。分组不领取，行内仅汇总子批次人数及已领取数量，具体归属仍在批次行。

手动刷新只选择展开的实际批次或本人领取的批次，不能将分组目录展开等同于核对全部数据；旧客户端提交整组核对时明确返回具体批次指引。每个核对请求分块读取最多 64 条 QC，未全部完成前保留原请求且不发成功回执，重启可重新核对。服务器完整扫描协作处理 inotify 的已知 session QC 与批次核对回执，继续发布上次完整树的增量；全量候选树发布前重读扫描中变化的 QC，避免覆盖刚收到的审核。扫描失败保留期间已成功发布的增量，发布失败保留重试事件；新增/移走目录仍由完整校准处理。源 QC、人工结果、媒体和用户中心归属不改写。仅允许重启独立 delta-viewer-task-index，不重启用户中心或采集工作台。实时可见延迟仍受源 I/O、批次大小及客户端 15 秒轮询影响，不承诺零延迟。

## 2. 仓库结构

### 2026-09-11 已通过数据集中导出补充（1.0.22）

1.0.22 数据扫描总览：管理员在审核总览选择或输入本机/已挂载共享目录，显式扫描其下 session 根级 `session.json.qc`；不使用审计事件次数代替唯一数据量，不使用 `.session_meta/session.json` 作为结论。展示通过、不通过、待审核、异常明细与数量，并分别汇总全部原始时长、通过数据原始时长、通过数据人工保留有效时长。Camera 0 清单帧数/FPS 优先；旧记录由采集时间戳估算并标注依据，不累加多个相机。有效时长以已保存 `description.json` 的人工片段为准，排除已删除片段、合并重叠；缺失、结论矛盾或非法范围显示未知/异常，不伪装为零秒。

必须先成功扫描才能另选目录导出全部通过数据，路径编辑使扫描失效。导出为完整 session 文件及裁剪记录，不重新编码视频；保持相对目录以避免同名冲突。源目录只读，目标不得与源互相包含，逐文件分块复制、大小及 BLAKE3 回读验证，发布前复核 QC/裁剪与源文件变化；异常或取消清理临时输出，成功原子发布不覆盖已有目录。此用户显式导出授权覆盖历史“不自动复制”限制，仅适用于管理员确认的已通过数据集中导出；不新增媒体或完整源路径上传。

### 2026-09-11 审核监管补充（1.0.21）

按用户明确要求，Viewer 管理员工作区统一改为审核监管，删除原标注任务分配、标注抽检、标注导入与标注报表入口，保留账号管理。新增独立审核审计 API，允许上传条目名称、规范路径的 SHA-256 标识（不上传原路径）、会话/事件 ID、帧与视频位置、操作耗时、标签名称与 ID、片段修改前后文本、审核原因及修订。账号由服务端登录 token 推导；客户端账号与 service ID 必须和当前会话一致。此授权覆盖上文对这些审核字段的禁止上传规则；原媒体、密码、token、完整源路径仍不进入审计。

客户端按服务和账号隔离保存待补传事件；服务端使用 Node.js 22.13+ 内置 SQLite 持久保存、幂等去重和分页，禁止退回只保留最近 500 条。审核会话从数据成功载入开始，到保存通过/不通过成功为止计算经过时间，包含停留与后台时间，不宣称是有效劳动时长。旧标注 API 仅为兼容已有客户端保留，不作为审核统计来源。用户中心升级必须保留原账号、证书、service ID 和本地业务扩展。

```text
DOHC_Viewer/
  prd.md                         产品需求和验收基线
  CHANGELOG.md                   按 tag 记录的版本历史
  README.md                      用户/构建入口
  AGENTS.md                      本开发指南
  update-service.config.json    固定 IP 更新镜像与官方上游配置
  .github/workflows/
    release.yml                 三个安装包 CD 与完整集合发布门禁
    wiki.yml                    docs/wiki 到 GitHub Wiki 的同步流程
  docs/wiki/                    GitHub Wiki 的可审查唯一源文件
  src/                           React/TypeScript UI
    App.tsx                      顶层工作流和视图状态
    components/                  回放、检查、进度和导出组件
      AuthScreen.tsx             工作模式选择、用户中心配置导入、审核员注册和登录
      AnnotationPanel.tsx        episode 任务、描述、轨迹码和处理人
      SkeletonViewer.tsx         可选 SMPL/骨架 Three.js 三维回放
    lib/backend.ts               所有 Tauri IPC/browser demo 适配
    types.ts                     前端共享数据类型
  src-tauri/
    src/lib.rs                   Tauri commands 和长任务调度
    src/model.rs                 Rust/IPC 数据模型
    src/identity.rs              工作模式、进程内用户会话和身份校验
    src/workspace_mode.rs        追加式本地工作模式选择
    src/user_center.rs           固定证书用户中心配置、健康检查和登录
    src/updater.rs               固定镜像检查、有界下载、验签和平台安装
    src/annotations.rs           任务目录、轨迹占号和追加式标注修订
    src/episode_metadata.rs      根级 description.json 原子写入契约
    src/source.rs                episode 发现、扫描、状态/帧读取
    src/skeleton.rs              可选 SMPL/骨架 NPZ 有界只读解析
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
    tauri.linux.conf.json        Linux deb 输入包和 FFmpeg 资源配置
    tauri.windows.conf.json      Win10+/NSIS/离线依赖配置
    windows/installer-hooks.nsh  Win10 最低版本检查
    examples/stress-check.rs     压力验收 CLI；正式模式默认开启
  scripts/release-check.mjs      跨平台 quick/full/bundle 发布检查
  scripts/verify-release.mjs     annotated tag、版本与打包契约门禁
  packaging/linux/               Ubuntu deb 的 AppStream metadata
  scripts/assemble-release.mjs   三安装器/更新资产/报告汇总与发布清单
  scripts/updater-signature.mjs  发布侧流式 Ed25519/Minisign 更新包验签
  scripts/update-mirror-server.mjs  GitHub 上游验签、原子缓存与只读分发服务
  scripts/install-update-mirror-macos.sh 本机 launchd 常驻服务安装
  user-center.config.json         当前主机局域网用户中心配置
  scripts/user-center-server.mjs  管理员账号中心 HTTPS 服务
  scripts/install-user-center-macos.sh 用户中心 launchd 一键安装
  scripts/build-ffmpeg-linux.sh  Linux x64 最小 LGPL FFmpeg 源码构建
  scripts/build-ffmpeg-macos.sh 固定源码构建最小 LGPL FFmpeg
  scripts/seal-macos-app-adhoc.sh macOS app 嵌套代码与资源 ad-hoc 封印
  scripts/verify-release-macos.sh DMG 封印、Gatekeeper、挂载与启动检查
  scripts/verify-release-deb.sh Ubuntu deb 元数据、apt 安装、资源与启动检查
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
- `src-tauri/src/updater.rs` 是客户端唯一允许运行时更新 HTTP 的模块；`src-tauri/src/user_center.rs` 只允许连接导入配置中固定证书、固定私有 IP 的 HTTPS 用户中心。两者都只允许统一管理模式的已登录用户调用；前端不得提供任意 endpoint、URL、版本或签名。
- `scripts/update-mirror-server.mjs` 为历史客户端提供兼容镜像，1.0.63 客户端直接使用固定官方 GitHub 仓库。它只能从固定仓库 HTTPS Release 同步，必须拒绝部分 target、错误文件名、超限、hash 或签名不符，使用服务自有 partial/版本目录原子激活，并在新同步失败时保留上一版。对客户端只开放 GET/HEAD，不增加上传 API、客户端身份或访问遥测。
- 导出 IPC 只能使用 `ValidationCache` 中与当前源目录指纹匹配的 Rust 报告；不得接受前端回传的报告或 status 作为授权。
- 文件遍历、哈希、解码和导出必须在 Rust 中执行。
- 源目录遍历统一使用可取消的 no-follow 路径；不要重新引入会隐式跟随 symlink 的文件判断。
- macOS AppleDouble `._*` 和 `.DS_Store` 是平台元数据，不属于采集数据；扫描、统计、指纹、校验和显式导入必须统一忽略且不得删除源文件。其他无法映射为非负十进制帧号的 JPEG 仍是 `INVALID_FRAME_FILENAME` error。
- 根级 `description.json` 是应用管理的 episode metadata，不参与采集统计、健康检查或数据指纹；其 partial 必须被扫描、指纹和导入忽略，正式文件随显式导入复制并验证。
- Export UI 不知道格式内部结构；格式差异只能进入 adapter。
- 未登录时只允许读取/选择登录模式、用户中心状态、配置导入、普通审核员注册、登录和退出 commands；自助注册不得接受角色字段或创建管理员，管理员创建仍只能在用户中心管理员页面完成。已登录标注员的个人资料接口只接受显示名称，不得修改账号名、角色、密码或其他账号。扫描、导入、加载、检查、读帧、标注和导出必须经 `AuthState::require_user()` 门禁；前端隐藏工作区不能替代后端门禁。
- 内置任务和用户创建任务的校验、持久化与自动编号逻辑以 `src-tauri/src/annotations.rs` 为唯一真源。新任务只接收名称，由 Rust 生成稳定 task ID/轨迹前缀；前端不得提交或指定轨迹编号。
- 批量导出清单只能由 `src-tauri/src/annotations.rs` 回读本机最新标注；批量 IPC 只接受 episode ID、目标目录和格式，必须在 Rust 中重新解析标注、核对规范化源路径与指纹、生成可信检查缓存后再调用 adapter。不得接受前端提交的源路径、标注对象或检查状态作为授权。
- Browser demo 仅用于视觉开发，必须和真实样例统计、warning 和类型保持一致。其工作模式、账号、用户任务和标注只保存在当前页面进程内，刷新后重置；离线演示不得渲染账号/处理人或发起用户中心请求。交互抽检基线是报告 format v5、26 个已检查文件、每流 5 帧、`[1,25,50,73,99]`、30 FPS 帧率与稳定度统计和非空 `autoReportPath`。它不能被当作账号安全、后端门禁或数据验收。

## 4. 环境与常用命令

要求：Node.js、pnpm 10、`rust-toolchain.toml` 固定的 Rust、平台对应的 Tauri 构建依赖。LeRobot smoke test 还需要 FFmpeg。

```bash
pnpm install
pnpm dev
pnpm tauri:dev
pnpm build
pnpm check
pnpm check:wiki
pnpm check:linux
pnpm check:windows-cross
pnpm check:exfat-macos
pnpm test:update-mirror
pnpm check:full
pnpm check:bundle
pnpm update-mirror:install
```

`pnpm check` 是快速门禁，包含前端 production build、operation ownership 与
issue-locate 回归 fixtures、Rust format、Clippy `-D warnings` 和常规 Rust
tests。`check:full` 额外运行 Tauri debug no-bundle build，不要求私有样例；
`check:bundle` 再生成当前平台 unsigned debug
bundle；macOS 无头环境使用 `scripts/make-dmg.sh` 生成内容等价的 DMG，Linux
生成并检查 `.deb` 内的主程序和资源。`check:linux` 在任意开发平台静态验证
deb 依赖/安装门禁、AppStream metadata 和 Tauri 资源配置；该命令不在 CI/CD 中运行。三者均通过 `scripts/release-check.mjs` 写入 ignored 的
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

标准私有样例已删除，之后开发、提交、审核和发布均不要求提供或寻找该样例。
常规自动化检查使用自包含测试数据。下述路径和基线仅为历史记录，相关 ignored 测试
只在另行取得匹配数据时自愿运行，不作为任何常规发布门禁。

历史样例路径：

```text
data/raw/2026-07-13_07-34-12
```

历史数据包含 981 个文件和 80,531,730 字节，并被 `.gitignore` 排除。若另行提供数据，不要移动、重写或“修复”源目录。测试输出必须写入测试专属临时目录，并只清理本次测试创建的明确路径。

可选历史样例 smoke test（不属于 `check:full`）：

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

- 写入前确认目标位于应用管理的导入工作区、用户明确选择的导出 destination，或精确为当前规范化 episode 根目录的 `description.json`。
- 中间结果使用唯一 `.partial-{nonce}`，完成后 rename。
- 使用 `create_new` 防止意外覆盖。
- 最终发布必须调用 `storage::publish_noreplace`，保持 Windows/macOS/Linux 原子 no-replace；不能退回 `exists + rename` 的竞态组合。
- 导入的每个路径组件必须经过 `importer::sanitize_name`；保持 Windows 保留名、大小写折叠和清理后碰撞测试。
- Manifest 当前为 format v2：`sourcePath` 是原始相对路径，`path` 是 Windows 安全目标路径；数据集 BLAKE3 仍基于原始 `sourcePath`。
- 取消或失败时不得出现正式输出名。
- 如果新增自动清理，只能删除本应用可证明创建的 partial 路径，不能使用宽泛 glob 或递归删除用户目录。
- 正常 UI 不创建 `appLocalData/imports` 副本。导入器或压力验收显式使用管理工作区时，路径固定为 `appLocalData/imports/{safe-source-name}-{path-hash}`；源采集文件始终只读。应用管理的根级 `description.json` 是唯一例外，必须使用同目录唯一 partial、回读验证和跨平台原子替换，且写入失败必须返回 `SOURCE_DESCRIPTION_WRITE_FAILED`。不得借此写入其他源文件。
- warning/error 后台报告只能写入 Tauri `appLocalData` 下的应用专属 `reports` 目录；不得写入源卡或 episode。保持 partial、回读和原子 no-replace，同一 episode 路径/指纹/报告版本稳定去重；不得把“后台汇报”实现为网络上传。
- 用户可见的扫描、导入、加载、检查和导出失败写入 `appLocalData/reports/operation-errors` 的不可覆盖 JSON；原始平台消息必须保留，权限类消息使用稳定码 `PERMISSION_DENIED`，Unix 文件权限为 `0600`。
- 用户中心主机将账号和密码哈希写入服务专属私有目录；客户端将工作模式追加记录写入 `appLocalData/workspace-mode`，统一管理配置写入 `appLocalData/user-center.json`，用户任务写入 `appLocalData/tasks`，轨迹占号写入 `appLocalData/trajectory-codes`，标注修订写入 `appLocalData/annotations/{episodeId}`。全部使用 `create_new`、回读和原子 no-replace；Unix 新文件权限为 `0600`。不得写入源 SD 卡或 episode。

### 6.3 数据模型

- Rust 对外结构使用 `#[serde(rename_all = "camelCase")]`。
- 原始 `capture_time_ns` 可用 `i64` 解析，`StateRecord` 对前端必须是 `String`。
- 数组宽度是契约的一部分，不要把固定数组改成无约束 `Vec`。
- 新 issue code 必须稳定、全大写下划线，并同步更新 `prd.md`、前端显示和 fixture 测试。
- 可定位的 issue 必须设置 `frameId`；新增 JSON 报告字段或破坏语义时提高 `formatVersion`。
- 破坏 manifest/HDF5 schema 时提高对应格式版本，不能只提高应用版本。
- 密码只能作为注册/登录请求的瞬时输入，不得进入 `UserIdentity`、日志、报告、标注或导出。标注必须绑定规范化 episode 路径和数据指纹，并保留不可覆盖的修订号、时间和统一管理账号或固定离线本机 provenance 标记；该离线标记不是账号，前端不得展示为处理人。

### 6.4 Validation

- 健康检查应报告事实，不自动修复源数据。
- Warning 表示数据可读取但存在质量风险；error 表示缺失、损坏或语义不可用。
- 新检查必须说明 severity、scope、code、消息和导出影响。
- 交互健康检查固定解码每流排序后唯一帧序列的 `1% / 25% / 50% / 73% / 99%`，少于五个命中时去重；结构、文件名、缺帧、frame ID 集合、状态和时间轴仍全量检查。
- 正式 stress 和发布 smoke 必须调用全量 JPEG 解码，不能用交互抽检报告替代。任何报告都必须显式记录 `imageValidationMode`、`imageSamplePercentages` 和实际 `checkedFrames`；仅读 header 不能算 JPEG 解码检查。
- 抽检无法保证发现未命中帧的编码损坏。界面、报告、文档和测试不得把 sampled 结果描述成全量 JPEG 通过。
- warning/error 必须在检查 command 返回前完成本地后台报告，ok 不生成；报告字段 `autoReportPath` 与实际普通文件一致，失败必须显式返回，不能显示“已生成”。
- 导出后端必须最终具备 error hard gate，不能只依赖按钮 disabled。
- 当前稳定 issue code 还包括 `INVALID_TIMESTAMP`、`INVALID_FRAME_FILENAME`、`DUPLICATE_FRAME_ID`、`FRAME_ID_MISMATCH` 和 `FRAME_RATE_MISMATCH`；改变其 severity 属于契约变更。

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
10. 已标注 episode 必须以统一轨迹码作为三种格式的基础输出名，并在格式 metadata 中保存任务与统一管理账号或离线本机 provenance；未标注 episode 保持历史命名兼容。
11. 批量导出首版只处理完整 episode，所有条目共用一个目标目录和格式并顺序执行；单条失败继续后续条目，取消中止当前未完成项并停止剩余队列，且不得删除已经成功原子发布的输出。

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
- 可选骨架数据只能由 Rust 从当前只读 episode 源解析，前端通过 `EpisodeData` 接收坐标和 frame ID；Three.js 视图不得直接读文件。桌面端骨架面板位于五路图像右侧，窄窗口位于图像之后；NPZ 缺失或解析失败只显示非阻断状态。
- 选择 SD 卡后自动扫描全部 session，并直接从源路径加载、检查第一条记录；不得自动创建本地数据副本，也不显示导入目标。扫描、检查和回放保持只读，只有保存标注可以更新 `description.json`。左侧 episode 列表以源路径作为稳定身份：单击只选择，双击或聚焦后按 Enter/空格才读取并进入回放；异步载入成功或失败后焦点必须回到触发的 session。读取失败和权限错误必须写入本地操作历史。
- 登录页是唯一的工作区入口，显示当前账号和退出；退出必须清空当前 episode、检查和标注状态，Rust 仍负责会话门禁。
- 回放首页顶部固定提供 episode 级数据标注。用户可以只输入名称创建本地任务；选择任务时自动填充默认描述并预览该任务的下一个轨迹码，描述可编辑。保存时必须由 Rust 原子分配或复用该 episode 的轨迹号，前端轨迹码始终只读，并显示修订号和最近处理人；保存成功后上传白名单审计事件。
- 批量页从本机最新标注列出轨迹码、任务、描述、统一管理处理人或离线本机来源、修订和源状态；源断开的条目可见但不可选。用户只选择条目、统一格式和一个目标目录，不在前端编辑源路径或检查结果。
- 检查结果固定使用“错误/警告/通过”文本，错误优先、警告其次、通过最后；`states.jsonl` 必须从 scope 为 `states` 的 issue 推导结果。手动报告按钮使用“导出报告”，不暴露存储格式作为主标签。
- 应用布局、控件和状态 UI 使用黑、白和中性灰；原始相机画面保留源颜色。Telemetry 的 X/Y/Z/W 数据系列使用稳定、可区分的彩色曲线，同时保留维度文字和不同线型；状态不得只靠色相表达，必须同时使用文字、图标、边框和明度层级。
- 图标使用当前 Lucide 库，陌生图标按钮提供 `title`/`aria-label`。
- 桌面工具保持紧凑、可扫描，不增加 landing page、营销 hero 或装饰性卡片。
- 卡片圆角不超过 8 px，不嵌套卡片，letter-spacing 保持 0。
- 中文是主要 UI 语言；技术 ID、format name 和 issue code 保留英文。

视觉修改至少检查：

- 1440x920 标准窗口。
- 960x680 最小桌面窗口。
- 390x844 窄视口，用于发现溢出问题，不代表移动端发布目标。
- 回放、检查、导出、批量四个 tab。
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
| Batch export | Rust 标注枚举/源断开继续/取消测试 + browser 批量交互 + 相关三视口截图；adapter 未改时仍运行真实三格式样例回读 |
| Tauri config | `pnpm tauri build --debug --no-bundle`；平台配置在目标平台验证 |
| Windows 条件源码 | `pnpm check:windows-cross`；仍需 Windows 本机构建和运行 |
| macOS ExFAT 路径 | `pnpm check:exfat-macos`；仍需真实 SD 卡和大容量 formal run |
| 更新镜像 | `pnpm test:update-mirror`；本机安装后检查 localhost/固定 IP `healthz`、安装页和 `latest.json` |
| Windows release | Win10/Win11 x64 断网安装、源卡直读、检查、回放、三导出、卸载 |
| Ubuntu release | Ubuntu 22.04 CI 构建/安装/启动 deb；仍需 Ubuntu 22.04 deb 实机及物理 SD 卡验收 |

提交前默认运行：

```bash
pnpm check
```

真实样例会读取私有数据，因此保持 `#[ignore]`。`--all-targets` 常规 Rust suite
当前为 104 项（98 通过、6 个私有样例/环境测试 ignored），其中包含用户会话、任务创建/删除、轨迹占号、标注修订、监管报表原子发布、黑屏与帧率稳定度检查、批量导出、HDF5 UTF-8 属性回读、导出 provenance 元数据和压力 CLI 参数测试；
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

`.github/workflows/release.yml` 在 `main` 的 CI 成功后运行。四处应用版本和带日期的
Changelog 条目是唯一发布信号；当对应的 `vX.Y.Z` 不存在时，controller 使用当前
仓库的 `GITHUB_TOKEN` 自动创建 annotated tag。自 `v0.17.6` 之后，不再允许保持已发布
版本号的普通 commit 进入 `main`；代码、修复、文档、CI 和配置变更必须先在非 `main`
分支或本地整理，并与新版本号及 Changelog 合并为一个 release-ready commit。不存在
“功能 commit + release commit”的两步发布轨迹，也不要求手工 tag、GitHub App 凭据或
release Environment。完整 `pnpm check` 和 release workflow 回归只在 CI 对同一
commit 运行一次；controller 再验证 main HEAD、clean checkout、annotated tag、
Changelog 和四处应用版本后，三个平台直接并行构建，不得在 CD 中重复完整 CI。
Windows x64、macOS arm64 和 Ubuntu x64 在原生 runner 上构建；所有 job 使用锁定
commit SHA 的 Actions，并固定 Node 22、pnpm 10.12.1 和 Rust 1.97.1。

CI 和三个平台使用固定 commit 的 `Swatinem/rust-cache` v2.9.1 缓存 Cargo 依赖编译
结果。cache key 必须按 CI/平台/目标架构隔离，并包含 action 自动计算的 Rust 工具链、
Cargo manifests/lockfile 和编译环境指纹；PR 不得写入 main 的 CI cache。保持默认
`cache-all-crates:false`/`cache-workspace-crates:false` 和 `CARGO_INCREMENTAL=0`，不得
缓存 workspace crate、最终 app、DMG、NSIS、deb、签名/封印结果或 verification report。
缓存命中只能加速重新编译，每次 Release 仍必须重新组装并执行全部平台验证。

当前 release channel 是显式 unsigned，即没有可信发布者身份。Windows FFmpeg、许可证、构建说明和
WebView2 exact URL/SHA-256 固定在 workflow；Tauri 的 evergreen WebView2 跳转只允许
用于解析当前缓存键，实际写入缓存和 NSIS 的内容必须是上述固定 hash 的已审核文件，
构建后仍需回读内嵌 hash。macOS arm64 从固定 archive hash 和
Git commit 的 FFmpeg 8.1.2 官方源码构建只含 JPEG -> MPEG-4 所需能力的最小 LGPL
sidecar。Linux x64 使用相同固定源码构建最小 LGPL sidecar，在 Ubuntu 22.04 生成
原生 `.deb` 并完成 `apt` 安装/启动检查。不得替换为
`--enable-nonfree` 或带未审查动态库的构建。macOS 的
unsigned 披露不允许省略 ad-hoc 完整性封印。

平台验证最低包括：

1. Windows 确认 DOHC 应用、NSIS 和 uninstaller 为 unsigned，同时验证 Microsoft 已签名
   的 offline WebView2、FFmpeg/许可证/manifest、silent install、启动 8 秒和 silent uninstall。
2. macOS 确认没有 Developer ID 和 notarization claim；app、主程序和 FFmpeg 必须是
   ad-hoc 且通过 `codesign --verify --deep --strict`。验证 FFmpeg 源码/封印前后 binary
   hash、架构与系统库依赖、只读 DMG、`/Applications` 链接；复制 app 并添加合成
   quarantine 后运行 `syspolicy_check distribution`。正常结果为 `Adhoc Signed App` 和
   `Notary Ticket Missing`。若 GitHub runner 返回 `Internal Xprotect Error`，必须现场构建
   一个最小 ad-hoc control app，并且 control 得到相同错误后才能记录
   `policyServiceAvailable:false`；control 正常但产品异常、invalid signature、missing
   resources 或 damaged 一律失败。之后再执行 8 秒直接启动。
3. Ubuntu deb 必须声明 WebKitGTK 4.1、GTK 3、AppIndicator 和 librsvg 运行时依赖，
   在干净 Ubuntu 22.04 runner 用 `apt` 安装，检查 ELF 动态库、desktop/AppStream、
   FFmpeg 资源，并在 Xvfb 中保持启动 10 秒。
4. final job 重新读取三份 verification JSON 和安装器 hash，生成
   `latest.json`、`release-manifest.json`、`SHA256SUMS.txt` 和 provenance；三个 installer
   及其 updater/signature 集合完整后才解除 draft。final job 必须使用配置中的公钥重新
   验证每个更新签名，并拒绝错误 target、超限大小或篡改内容。公开过的 tag 不允许 clobber。

Windows updater 使用不内嵌离线 WebView2 的 NSIS executable，macOS updater 是完成 ad-hoc seal
后的 arm64 app tarball，Ubuntu updater 复用已经过 `apt` 安装/启动验证的正式 deb；三者
都必须保持 1-64 MiB。workflow 的三个原生平台 job 分别使用
`TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 生成签名，secret 不得
进入普通 env、日志、artifact 或报告。这个更新签名不提供可信发布者身份；installer
仍必须显示 `UNSIGNED`。自动 tag 继续只用 `GITHUB_TOKEN`，不引入 GitHub App 凭据。

客户端更新来源与发布检查按 2026-10-15 补充执行。旧镜像服务保持可选历史兼容，不要求部署、重启或等待镜像同步才发布新版。

所有安装器文件名、Release 标题/说明和 manifest 必须显示 `UNSIGNED`。加入可信签名时必须
作为单独版本恢复 Authenticode、Developer ID、timestamp、Gatekeeper 和 notarization
门禁，不得在同一 tag 上替换资产。GitHub hosted runner 不是目标机验收；CD 通过仍不得
关闭 Win10/Win11 断网、目标 Mac、Ubuntu 22.04 deb 实机、真实 SD 卡或 100 GB/100,000 文件缺口。用户文档以 `docs/wiki/` 为唯一源，
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
- 用户中心服务使用 Node 内置 `scrypt`（N=16384、r=8、p=1）和操作系统 CSPRNG 盐保存密码哈希；客户端不保存密码。服务端不引入账号网络同步以外的数据路径，Windows/macOS/Linux 客户端均只保存固定证书配置和进程内会话。
- `tauri-plugin-opener 2.5.4` 为 MIT/Apache-2.0 双许可的官方跨平台实现。`v0.3.0` 全部变更使 macOS ARM debug 二进制增加 1,239,152 bytes（约 2.2%）；Windows release 体积必须在目标构建机另行记录。
- `tauri-plugin-updater 2.10.1`（MIT/Apache-2.0）负责跨平台安装；本版 vendored 最小补丁为其清单读取添加 1 MiB 上限，来源和 archive checksum 见 `vendor/tauri-plugin-updater/DELTA_PATCH.md`，没有新增原生依赖；`reqwest 0.13.4`（MIT/Apache-2.0）用于 64 MiB 上限的 HTTP(S) 流式读取，`minisign-verify 0.2.5`（MIT）使用应用内嵌公钥验证更新包。不得退回 updater 插件无大小中止能力的默认 `Vec` 下载路径，也不得关闭签名校验。客户端只使用官方 GitHub HTTPS，签名仍是安装完整性的硬门禁。`semver 1`（MIT/Apache-2.0，原已在 Cargo.lock 中作为传递依赖）显式用于解析和比较正式版本，不引入新的原生库，三平台均支持。
- `foxglove 0.26.0`（MIT）、`prost 0.14.4`（Apache-2.0）和 `bytes 1.12.1`（MIT）用于生成官方 Foxglove protobuf schema/消息；Foxglove 默认 features 保持关闭。`v0.9.0` macOS ARM debug 主程序相对 `v0.8.0` 增加 383,472 bytes（约 0.5%），Windows x64 MSVC all-target 条件编译已通过，目标机 release 体积仍需另行记录。

## 12. Git 与工作区纪律

- 保留用户已有修改，不重置或覆盖无关文件。
- 不使用 `git reset --hard`、宽泛递归删除或不受控清理命令。
- 原始数据只保存在 ignored 目录；需要共享测试数据时创建最小、脱敏、明确许可的 fixture。
- 不提交 `dist/`、`node_modules/`、`src-tauri/target/`、generated schemas 或临时截图。
- 除非任务明确要求，不在本地自动创建 commit、tag 或 release；版本变更推送后由
  GitHub Actions 按发布契约自动创建 tag 和 Release。
- 修改行为时同步更新相关文档；不要把“已实现”状态提前写入 PRD。

`main` 允许直接推送，但只允许推送 release-ready commit，并禁止删除和 force-push。
任何进入 `main` 的改动都必须分配新版本；版本号不是孤立字段，而是 commit、Changelog、
annotated tag 和 Release 的同一身份。自动 tag 尚未创建时，该 HEAD 仅处于 pending 状态，
此时不得再向 `main` 推送或合并下一条 commit。CI 仍是自动发布的前置条件。创建版本时必须：

当前版本规则以 2026-10-15 用户新指令为准：本版为 `1.1.0`；后续 patch 连续加一且只使用 0–9，满 9 时向 minor 进位并将 patch 归零（`1.1.8 -> 1.1.9 -> 1.2.0`）。该进位是用户授权的常规版本递增，取代旧的 patch 无上限规则；major 变化仍需用户明确指定。每次交付仍须同步版本号和中文摘要。

用户补充（2026-10-13）：每次交付改动（包括提供到桌面的预览版）都必须同步更新版本号和中文更新摘要；不能用旧版本号交付不同内容。预览版须明确标识发布候选，应用内版本历史、桌面交付说明和后续 Release 摘要保持一致。内部尚未交付的构建迭代不单独占用版本号。

1. 保持 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 的 semver 一致。
2. 每次 Release 必须在 `CHANGELOG.md` 新增唯一、带合法日期且至少包含一条具体变更的当前版本条目；当前版本必须是第一条带日期的版本记录，`Unreleased` 或 `TBD` 不能替代。GitHub Release 正文必须直接展示该条目，不能只放 commit compare 链接。同步更新 PRD 实现状态。
3. 至少运行 `pnpm check:full`；标准私有样例不是硬性前置。平台包变更还要运行相应 bundle 检查，并确认私有数据、staged FFmpeg、报告和构建产物未暂存。
4. 在非 `main` 分支或本地工作区整理全部改动；将代码、修复、文档、CI、配置、版本号和 Changelog 合并为一个 release-ready commit 后，才可一次性推送或合并到 `main`。不得创建独立的功能 commit 或独立的 release commit。
5. CI 成功后由 `release.yml` 自动创建 annotated `vX.Y.Z` tag；不要手工创建、移动或覆盖版本 tag。
6. 确认 annotated tag 精确指向该 `main` commit 后，才可开始下一个版本；一个 tag 不得覆盖多个 commit，一个 commit 也不得复用旧版本 tag。
7. 测试失败、报告 failed、版本不一致或工作区混入无关文件时不得发布。自动 tag pending 或失败时必须冻结 `main` 并先处理该版本，不得追加无版本提交绕过。

自动 tag 创建后，GitHub Release 只能由 `release.yml` 生成。不要手工上传或只发布单一平台；
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
