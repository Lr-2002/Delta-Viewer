# Delta Viewer Changelog

Application releases use immutable annotated Git tags created automatically
after `main` CI succeeds for a coordinated version change.

## 1.3.6 - 2026-10-27

- 修复同步异常横幅压住历史版本弹窗：历史版本使用原生模态层，键盘焦点限制在弹窗内，关闭后返回原入口，后台状态无法穿透遮挡或接收点击。
- 两套同步异常合并成单一紧凑状态栏，保留真实待传操作事件数量、未落盘风险及补传入口；最早待传时间、最近用户中心确认、原因及原始错误按需展开，正常或短暂排队不显示。服务端拒绝记录继续独立提示，不把未知错误归因断网。
- 重新登录后分别重试审核操作与标注审计队列，失败继续保留；已知鉴权错误在统一入口处理，其他业务错误不被隐藏。普通更新轻提示移至右下角，避免遮住顶部状态和恢复按钮；同步版本号及中文摘要。

## 1.3.5 - 2026-10-26

- 包含 admin 管理／测试模式、真实客户端版本与单个／多选／全部更新提醒，账号页独立查询不等待审核统计。
- 修复浏览器演示的独立账号接口返回空列表：恢复删除、暂停及删除后刷新保留历史的完整回归；演示设备版本保持未知，不伪造上报。1.3.4 因该回归失败未发布，本版递增版本并重新通过完整三平台发布门禁。

## 1.3.4 - 2026-10-26

- 管理模式默认进入审核账号，账号元数据与设备运行版本独立查询，不再等待数百万条审核事件聚合。即使审核总览超时，仍可读取真实账号、筛选、刷新版本，以及单个、多选和一键推送提醒；任务和文字勘误页也不触发无关统计轮询。
- 账号页显示独立版本刷新时间，获取失败保留上次记录并明确状态未知；删除、启用或暂停账号后重新读取实际账号状态。后端按当前账号名单合并版本报告，已删除账号不能因旧报告重新出现，管理员保护使用真实服务器权限。
- 包含 1.3.3 的 admin 管理／测试模式整合和持久更新提醒，版本号及内置摘要同步递增。

## 1.3.3 - 2026-10-26

- admin 内测账号沿用原账号与密码，通过服务器授权整合管理功能；登录默认进入测试模式，顶部“管理模式 / 测试模式”切换保留已加载数据及本机草稿，管理页操作不计入审核轨迹。按用户确认停用原管理员登录，保留历史身份与记录。
- 管理模式的审核账号列表显示同账号各台设备的实际运行版本、系统、在线状态和最近上报时间，每 15 秒刷新；90 秒未上报、会话退出或失效按离线处理，旧版未上报与刷新失败保持未知，不虚报实时版本。
- 支持一键全部、勾选多账号和行内单个推送更新提醒。提醒在用户中心 SQLite 持久排队，离线重连后补送，重复待处理提醒合并，最长保留 7 天；审核端显示持续消息弹窗，可查看官方更新入口或稍后处理，不自动下载、安装或打断审核。
- 管理权限由服务端确认，普通审核员不能自授权限、查询其他账号版本或推送；版本上报独立于审核审计，不上传源目录或描述，不计人工有效耗时。原审核队列与 NAS 写回规则不变。

## 1.3.2 - 2026-10-26

- 包含 1.3.1 的动作草稿审核通过后发布逻辑。补全多机标来源兼容：不同来源可独立保存未审核草稿，切换来源不再被旧“待写回结论”保护误拦；已提交且待写回的审核结论仍阻止跨来源重复提交，各草稿原共享基线和并发防覆盖保持独立。

## 1.3.1 - 2026-10-26

- 动作片段修改（描述、边界、增删、切割、恢复及越界处理）自动持久保存为按用户中心和账号隔离的本机草稿。点击审核通过后，才原子更新对应的 description.json / desorption.json、技术记录和 session.json QC；再次编辑已通过结果也不提前改写共享文件。
- 不通过仍保存审核结论、原因、审核人和日期，但沿用共享结果或原机标的片段，不发布未批准的动作修改；本机草稿历史继续保留。骨架描述没有审核功能，继续独立保存。
- 未审核的动作草稿不进入 NAS 待写回列表，也不能通过确认写回绕过审核。通过/不通过遇到 NAS 故障时仍先持久保存本机结论和原操作事件，恢复后确认补写，保留并发防覆盖与审计保护。

## 1.3.0 - 2026-10-23

- 包含 1.2.9 的片段边界反向复原：连续调整同一边界时，松手保存后继续往回拖仍逐段恢复原范围与描述；预览、方向键及帧输入一致，恢复保持待审核。
- 修正云端 Ubuntu 构建机使用 Azure 软件源下载依赖异常缓慢的问题，仅临时 CI/CD runner 使用 Ubuntu 官方主镜像，保留软件包签名、全部测试及三平台发布门禁。1.2.9 两次环境准备均在应用测试前取消，未生成 tag 或安装包；本版按版本进位规则恢复发布，不改用户电脑或业务服务器软件源。

## 1.2.9 - 2026-10-23

- 修复片段边界松手保存后，反方向拖动无法复原已覆盖片段的问题：连续调整同一边界保留调整前基准，往回拖按位置恢复原片段范围与描述；起始/结束边界、方向键和帧输入统一处理，动作与骨架均适用。
- 预览与松手保存使用同一复原逻辑；取消不保存，原本删除的片段不自动恢复，恢复后的修改保持待审核。其他编辑、切换边界或重新加载后以当前内容开始新调整，避免覆盖新修改；复原基准不跨重启。

## 1.2.8 - 2026-10-23

- 包含 1.2.7 的全视频片段边界拖动、按屏幕刷新预览、本机结果可靠暂存后计入用户中心审核统计，以及批量/整文件夹与单条共用原因标签和账号排序。
- 修复批量原因标签新增后，并发交互 smoke 仍直接查找“其他原因”文本框的旧流程：预置原因直接点击标签，自定义原因先选其他原因，继续验证当前批次限制、目录切换清空选择、加载失败数据仍可不通过。1.2.7 因此测试失败，未生成 tag 或安装包；本版按完整门禁重新发布，不跳过测试。

## 1.2.7 - 2026-10-23

- 片段起止边界可跨越多个相邻片段，在整段视频范围内调整；被完全覆盖的片段保留可恢复历史，部分覆盖只修剪交叠范围。拖动按屏幕刷新预览，松手后统一保存、定位和记录操作；反向拖回恢复预览，取消不改结果。
- NAS 不可写时，将审核结果和待上传结论在同一 SQLite 持久事务保存，用户中心接收后纳入审核统计。使用原提交标识和时间去重，NAS 恢复写回只转换存储状态；后续编辑撤销当前完成状态，骨架描述不计审核。历史本机待写结果登录后按原时间补传。
- 工作台区分“本机完成待写 NAS”和“NAS 已写待核验”；通过与不通过均计原始时长，有效审核耗时仍按真实操作轨迹扣除超过 120 秒的无操作部分，心跳及自动写回不计人工操作。实际 NAS QC、共享任务进度和自动发布门禁保持独立，未知时长不补零或推测。
- 批量及整文件夹不通过共用单条不通过的全部原因标签、拖动排序、Alt＋方向键、恢复默认和按账号保存的顺序；“其他原因”固定右下角并支持填写说明，继续仅处理未审核数据和二次确认。

## 1.2.6 - 2026-10-22

- 任务中心仅在具体批次行显示审核领取人；移除根目录及上级分组的领取人、人数和已领取批次数汇总，保留各级审核进度。

## 1.2.5 - 2026-10-22

- 修复目录迁移映射缺失时历史领取人无法匹配的问题：支持读取已核实的备用映射；无法确认身份时明确报错并保留上次结果，避免把已有任务显示为未领取。分组行增加子批次领取人汇总，具体领取与释放仍以独立批次为准。
- 修复服务器全量统计期间实时进度和手动刷新排队的问题：刷新不再把展开分组当作整组核对，大批次分段处理；完整校准时继续处理已知数据 QC 变化和独立核对回执；校准提交前重读期间改动，失败保留已成功发布的增量和待重试事件。
- 空共享映射不再清空本机已有迁移缓存，保持离线暂存与续审路径兼容。原机标、媒体、人工结果、历史 QC 和领取归属不改写。

## 1.2.4 - 2026-10-21

- 修复机标范围超出 Camera 0 时只能查看、无法继续审核的问题。新增“查看越界片段并处理”，列出原始片段及范围；审核员核对视频并确认后，仅保留有效范围交集，保存为待审核草稿，不缩放时间轴或伪造缺失画面。
- 跨越末帧的片段截去越界尾部，完全越界片段保留原文字和边界作为技术历史，不进入人工结果的有效片段；恢复删除不会把它们重新加入播放范围。保存前将原机标及已有人工结果原字节持久备份到本机，失败不覆盖源结果。
- 处理后持续提示来源/时间对齐仍需人工核对，回放核对确认前不能通过；继续编辑重新要求核对。重启恢复已处理草稿与越界历史，后端拒绝新增或恢复越界有效片段；视频清单过期时要求重新加载。
- 原机标、媒体及其他 episode 保持只读。人工 JSON 审核信息继续只含通过/不通过/待审核、审核人、日期，技术记录另存；不自动改写历史 QC。

## 1.2.3 - 2026-10-21

- 修复任务中心仍记忆旧 D1 daily 等分组根目录时只显示残留空目录的问题：分组入口统一展示 Delta-D1 数据集，保留仍存在的旧目录，展示当前各分组及真实批次路径；连续迁移沿用原批次键查询历史领取人，不重新分配历史任务。
- 侧栏明确区分“本机通过／不通过／草稿 · 待写回 NAS”和“我已审”，不把本机暂存误称共享审核完成；按当前账号、服务和所加载目录查询全部待写摘要，超过 200 条也不遗漏，不读取媒体或依赖 NAS。
- 用户确认写回数据目录后立即重新读取本人审核标记，部分失败继续保留待写标记；切换账号、目录时清理过期状态，骨架描述不计入审核标记。
- 包含 1.2.2 的独立骨架片段、预置及自定义标签、skeleton.description.json 保存和目录连续改名兼容。

## 1.2.2 - 2026-10-21

- “动作片段”旁新增“骨架片段”切换入口，初次为空，不导入机标动作。支持新增、删除、恢复、裁剪、边界微调、片段回放和现有键盘快捷键；只作为描述入口，无通过/不通过及 Enter 审核行为，不改变当前数据 QC 和审核进度。
- 骨架标签库按账号独立保存，预置往前走、抬肘、踢腿、蹲下、顶门、关上洗碗机；支持自定义描述、数字快捷键、拖动排序和删除。
- 骨架描述独立写入与 description.json 平级的 skeleton.description.json，恢复/并发信息另存专属技术文件；只读打开并恢复已有骨架描述，原机标、动作结果与 session.json 保持不变。写入失败沿用本机暂存和手动确认写回，动作与骨架队列独立，原事件 ID、时间及账号隔离保留。
- 补齐现场后续改名 D1-Daily、D1-Validation、D1-Yiqi、D1-Motion caption 的分组识别，分组不可领取，日期或 Skeleton 子批次独立。明确迁移映射支持连续改名，保留旧批次身份，不按相同文件名猜测位置；不自动拆分旧误领整组记录。

## 1.2.1 - 2026-10-21

- 包含 1.2.0 的三支线目录兼容、独立批次领取、人工结果审核信息精简及技术记录分离。1.2.0 的云端 CI 在并发操作 smoke 发现旧模拟后端尚未实现新增目录解析接口，未生成版本 tag 或公开安装包。
- 为并发操作及对话框恢复测试补齐目录解析接口，保留原有领取后直接加载、取消与操作归属断言，不跳过或放宽回归。
- 修复 Windows 标准 UNC/盘符路径与 canonicalize 扩展路径格式不同，可能导致迁移前本机待写结果无法匹配的问题；仅在本机查询确定的等价路径，不访问 NAS、不重写原队列键，不跨账号匹配。

## 1.2.0 - 2026-10-21

- 适配 `D1 daily`、`D1 validation`、`D1 yiqi` 分组后的日期批次。分组不可领取，各子批次使用独立标识；已确认迁移保留原批次领取身份。旧版误领的整组记录原样保留，不推测拆分。
- 任务中心递归展示和查询实际批次，按真实批次加载、定位单条和筛选未审核；直接扫描增加有界递归。显式迁移映射恢复旧目录、上次记录、草稿、本机待写结果和仍匹配原片的旧预览，不按相同编号搜索猜测。
- 修复选中旧人工 `desorption.json` 后仍固定更新 `description.json` 的问题；通过、不通过、增加/删除片段均保存到实际人工结果和根级 `session.json.qc`，机标及采集文件保持只读。
- 人工结果 `_human_review` 只保留 `status`、`reviewer`、`reviewedAt`。修订、改动摘要、来源及恢复状态另存 `.description.review-state.json` 或 `.desorption.review-state.json`，与人工文件内容哈希绑定。兼容读取旧完整格式，明确保存才转换；实际片段数组仍保存全部增删改。
- 勘误与撤销继续支持精简人工结果；技术记录先落盘，失败不确认保存。本机待写队列只读本机迁移缓存，NAS 不可用时仍可暂存；原事件 ID、时间、账号隔离和防覆盖保护保持有效。

## 1.1.9 - 2026-10-21

- NAS 满盘或共享目录写入失败时，单条审核、批量及整文件夹不通过先可靠保存到本机 SQLite，明确标记“待写回数据目录”。本机保存成功后可继续审核；本机也无法保存时保留应急草稿并阻止完成，不虚报提交。
- 主界面持续显示当前账号的待写结果数量，后台每 30 秒只读检查存储。容量与连接恢复后弹窗提醒，由审核员确认后依次写回；支持稍后处理、重新检查，重启后保留，服务及账号隔离。共享任务进度仍以 NAS 根级 QC 为准。
- 写回前锁内核对原机标、人工结果及 QC 基线，其他人已修改时保留本机结果并报告冲突；源端成功但本机确认中断时幂等恢复，保持原事件 ID 与审核发生时间，事件落盘后才移除待写结果。被后续本机编辑替换的结果保留在本机历史中。
- 保存前以独立只读进程限时检查目录及至少 32 MiB 临时空间，5 秒无响应不启动写入；区分满盘、权限、超时和未知 I/O。实际写入超过 8 秒明确尚未确认，不重复提交。Windows 使用支持 UNC 和配额的系统容量接口。
- 已复现 NAS 数据卷可用 0 字节及 ENOSPC，用户中心健康检查正常。此更新不增加 NAS 容量、不删除数据、不重启后台服务；本机结论写回、用户中心接收操作事件、工作台统计更新分别提示。

## 1.1.8 - 2026-10-20

- 修复批量不通过把过期本机草稿、已移走人工文件或旧机标哈希误判为并发修改、刷新后仍失败的问题。本次准备时读取最新共享内容，保存锁内核对该快照的哈希、修订及当前 QC；真正的新修改仍拒绝覆盖，已有共享人工结论继续保留，孤立本机历史结论不再冒充已审核。
- 修复当前目录未审核却因本机旧草稿或历史人工结果显示“已通过”的问题；右下角结论独立读取当前根级 `session.json.qc`，与任务进度的判定依据一致，不根据机标来源核验或历史修订推断当前结论。
- 历史版本摘要改为明确的“历史修订（非当前结论）”，完整摘要保留在悬浮提示；共享人工结果缺失时，本机保留内容不再显示为已保存。
- 重新读取先清除旧状态；QC 读取失败或内容异常显示“审核状态未知”及可重试原因，不回退为通过。加载仅只读查询，不修改源审核结论、草稿内容或机标。

## 1.1.7 - 2026-10-19

- 修复任务中心多行统计提示被压缩后溢出、遮挡下方目录的问题；顶部按实际内容保留高度，目录独立滚动，窄屏查询与按钮自动换行。
- 在任务中心上方增加领取人、批次名称和采集日期起止查询，可组合即时筛选并一键清空；日期取批次文件夹名称，支持姓名、账号和“未领取”，不额外扫描源数据、不改变进度或领取归属。
- 修复 Windows SMB 可能持续读取旧 `status.json`、导致服务器已经核对完成却仍显示等待的问题。服务器按请求生成唯一回执并附带对应索引，客户端必须读到该回执才确认完成，保留后续新索引更新与超时重试保护。
- 增加多行异常提示下滚动、三种视口、组合查询、旧状态不误确认、回执发布失败重试及关联索引保留回归。客户端与独立统计服务需同时升级，不修改源审核结论。

## 1.1.6 - 2026-10-19

- 修复任务中心点击刷新后没有明确反馈的问题，增加刷新中、服务器统计暂无变化、后台核对等待、完成及失败提示，单独显示最近读取时间。
- 展开批次后刷新会请求服务器按源 `session.json.qc` 重新核对该批次；未展开时优先核对本人领取的批次。核对在服务器执行，只读 QC，不扫描视频、不触发全量目录扫描；以服务端完成确认为准，未确认时不宣称完成。
- 修复目录移走并在同一路径替换后监听仍绑定旧目录的问题，批次核对同时补装监听。增量统计发布失败会保留旧内存状态，重试仍能发布真实变化。
- 索引读取超过 20 秒会给出可重试原因并保留可用结果；重复读取复用尚未结束的原生请求，避免断网时积累工作线程。保留领取、未审核筛选及夜间完整统计规则。

## 1.1.5 - 2026-10-16

- 目录与机标编号不同的核对提醒增加“忽略本条提示”；选择按当前账号、目录及机标内容保存在本机，重新打开继续生效，内容变化时重新提醒，并可随时查看已忽略的提示。
- 更新摘要、新版可用和更新已准备好改为右上角滑入、淡出的轻量通知，不占审核页面布局。通知约 10 秒自动收起，鼠标停留、键盘聚焦或应用隐藏时暂停计时，保留关闭与查看更新记录入口，支持减少动态效果的系统设置。
- 保留 1.1.4 的缺失 value 等异常机标属性兼容；新增忽略范围、账号隔离、通知停留、自动收起及桌面/窄屏回归。

## 1.1.4 - 2026-10-16

- 修复百炼属性数组中个别项目缺少 `value` 时整份机标加载失败的问题；缺失值保留为空，不猜测其他键的含义，合法动作片段和中英文描述继续读取。
- 属性缺少名称、格式异常或重复不再遮住整条记录；重复值冲突不自动选取，原始属性、未知字段和源 JSON 保留。动作片段区显示可展开的属性核对提示，异常描述可继续人工补充。
- 人工修改只回写目标描述，保留异常的非目标属性；新增缺失值、重复冲突、格式异常、通过后重开及桌面/窄屏回归。

## 1.1.3 - 2026-10-16

- 按审核需求放宽目录编号与机标身份的绑定：优先精确匹配及唯一 asset_id，单一结果允许直接按同目录文件读取；旧路径、编号、缺失或变化的元数据指纹不再阻断机标加载。
- 明确区分“来源核验通过”与“兼容读取、来源尚未核实”，显示实际核验限制；不把同目录或相同帧数当作来源已核实，原机标及编号保留。
- 自动来源在首选机标不可读时继续尝试同目录其他百炼/人工 JSON；声明帧数不同但所有片段在实际视频范围内时使用实际帧数，原边界不缩放或截断。
- 兼容旧人工结果与应急草稿的重复索引、旧状态；恢复前在本机保存原记录。旧帧范围确实无效时保留备份并重新载入机标，不自动缩放或截断人工片段，不在加载时改写 QC。
- 旧人工结果或草稿 JSON 无法解析时先保留原字节，再显示可读机标，避免旧文件错误遮住整条数据；人工保存后延续原有冲突及修订保护。
- 审核保存校验改为说明具体片段、重复索引、帧范围或状态原因，避免笼统的“片段范围、状态或索引无效”；增加移动目录、缺失指纹、兼容后保存重开及旧草稿恢复回归。

## 1.1.2 - 2026-10-16

- 修复采集目录编号变更后，百炼机标仍保存旧 episode_id 导致整份机标无法加载的问题。精确匹配优先；失配时仅在 asset_id 唯一指向主结果、生产端 MP4 元数据指纹一致且主相机帧数一致时兼容读取。
- 在动作片段区持续显示目录编号与原机标编号差异及核验依据；原机标字节、原编号和未知字段保持不变，人工保存、重开及换机读取延续原有流程。
- 无法核实的错误文件、缺失指纹、重复主结果或帧数不符继续拒绝自动套用；错误显示两侧编号，并提供换来源或人工标注指引。
- 增加编号偏移、错误来源、歧义结果、人工保存后新主机重载、固定指纹向量及窄屏提示回归，并纳入 Windows 原生发布检查。

## 1.1.1 - 2026-10-15

- 修复 GitHub 更新请求未读取 Windows/macOS 系统代理设置的问题；固定证书的局域网用户中心保持直连。
- 清单、版本查询与更新包遇到超时、连接中断或临时服务错误时最多重试 3 次；每次丢弃未完成响应，取消下载可中断等待。
- 原生安装器直接复用已完整读取并验证的清单，取消重复联网读取；仍严格验证正式版本、平台、官方 HTTPS 地址、大小、SHA-256 与 Minisign 签名。
- 更新失败明确显示所在环节、超时/HTTP/证书等原因及尝试次数；错误不阻断审核，不自动安装或丢弃已验证缓存。
- 增加离线网络故障回归和 Windows 原生更新测试，保留实际正式包下载验签诊断工具。

## 1.1.0 - 2026-10-15

- 修复服务器目录变更事件可能被普通 QC 刷新提前清除、导致新增批次等待夜间统计才出现的问题；目录校准期间继续保留事件。
- 任务中心审核进度为 100% 的批次隐藏“仅未审核”筛选；未完成或尚未确认完整统计的批次保留入口。
- 筛选期间收到批次全部完成的服务器进度后，自动恢复完整目录，保持展开状态；之后新增待审核数据时重新显示筛选按钮。
- 应用版本升为 1.1.0；后续末位只使用 0–9，1.1.9 后发布 1.2.0，并同步中文版本摘要和版本管理规范。

## 1.0.63 - 2026-10-15

- 更新入口改为 GitHub 官方仓库 Lr-2002/Delta-Viewer 最新正式 Release，API 限流时自动改查官方最新版本跳转；排除草稿、预发布与降级，停止客户端使用旧 HTTP 镜像和双镜像测速。
- 启动登录后后台检查，不占用数据任务；发现新版在“版本与更新”显示标记并仅提醒一次，查看说明后由用户主动下载。
- 下载完成先验证大小、SHA-256 和 Minisign 签名并保存本机缓存；显示“更新已准备好”，支持“保存并重启更新”或“稍后”，不自动安装。
- 安装前等待当前修改及审核操作落盘；扫描、检查、导出或批量任务未结束时阻止安装。失败保留当前版本和审核会话，可重试。
- 新版首次打开显示简短中文更新摘要和完整更新记录入口，同版本关闭后不重复弹出。

## 1.0.62 - 2026-10-15

- 修复机标中间片段结束帧为 null 或缺失时整份机标无法打开的问题：仅在片段起点严格递增且存在合法下一片段时，暂按下一片段起点推定结束边界；保留全部片段及原机标，显示定位与人工核对提示，确认后才允许通过。
- 人工保存时将缺失边界写入 description.json 及其关联片段；已保存人工结果仍严格校验，无法推定、倒序及越界数据不静默修复。
- 不通过原因新增“动作失范”，支持 QC 保存、重新加载及审核记录。
- 原因标签新增“调整顺序”、拖动排序、Alt + 方向键移动和恢复默认；顺序按账号在本机记忆，“其他原因”固定右下角，排序操作不会误选原因。

## 1.0.61 - 2026-10-13

- 修复旧操作队列迁移、异步目录标识期间新增事件可能未落盘的问题，失败时保留原事件编号和发生时间供补传。
- 审核结论保存后等待操作事件落盘再进入下一条；更新、退出登录前等待保存，失败时保留审核会话，重试不重复提交审核结论。
- 同步提示仅在本机保存失败、上传失败、持续积压或异常记录时显示；正常同步和短暂排队不占用页面，恢复后自动隐藏。
- 提示展示真实待传操作事件数、最早待传时间、最近用户中心接收确认和具体原因，支持重试上传及当前账号重新登录补传；服务端拒绝的事件单独保留提示。
- 此修复不补造历史缺失操作记录；用户中心已接收不代表工作台已完成统计。

## 1.0.60 - 2026-10-09

- 修复任务中心领取后传递批次目录的兼容性：保留旧集成的节点路径参数，同时让审核工作台按批次扫描并定位所选 session。

- 修复旧版只记录已完成条目时的恢复边界：登录会按当前批次审核状态继续定位到下一条未审核数据。
- 恢复路径兼容 Windows UNC、盘符大小写和尾部斜杠差异；任务中心进入批次时优先使用该批次而不被旧目录配置覆盖。
- 恢复条目后自动滚动并聚焦目录位置，便于直接继续审核。

## 1.0.58 - 2026-10-09

- 审核员登录后按账号恢复上次正在审核的批次和条目；审核完成后自动切换到下一条时同步更新恢复位置。
- 恢复时读取本人审核状态，已通过或不通过的旧条目不再抢占恢复位置；没有进行中记录时自动选择当前批次第一条未审核数据。
- 新增浏览器回归测试覆盖批次、条目和账号隔离的恢复行为。

## 1.0.57 - 2026-09-24

- 标签库新增固定序号、文字拖动排序与数字快捷键填充；顺序按账号保存，新标签追加末尾。
- 支持连续输入两位数编号，普通输入和其他弹窗不误触；标签库打开时可在描述框按数字替换。
- 关闭 Windows 主窗口的原生文件拖放拦截，使标签拖动在桌面安装版中生效。1.0.56 安装包未发布，功能统一由本版交付。

## 1.0.56 - 2026-09-24

- 标签库增加固定序号，拖动标签文字可调整顺序并按账号保存；新增标签追加到末尾，保留已有快捷键编号。
- 选中动作片段后按数字编号替换当前描述，支持连续输入两位数编号；普通输入框保留数字输入，标签库打开时描述框支持数字选取，其他弹窗和组合快捷键不触发替换。
- 标签替换沿用审核草稿保存和待审核状态，记录使用与排序操作；标签库满额时提示处理，不再挤掉已有标签。

## 1.0.55 - 2026-09-23

- Viewer 顶部工作台入口改为免工作台账号登录的“审核总览”，隐藏实时行为、审核记录、账号、任务和复核入口。
- 保留真实统计、日期和审核人筛选、效率时间轴、刷新与 CSV 导出；只读页面不调用账号或管理操作接口，不转发账号 Cookie。

## 1.0.54 - 2026-09-23

- 修复采集工作台打开时 `create_webview_window not allowed by ACL` 报错，补齐主窗口创建、显示和聚焦工作台窗口的权限，支持首次打开和重复唤起。

## 1.0.53 - 2026-09-23

- 修正对话框恢复回归测试对顶部来源按钮的定位，避免与采集工作台入口冲突。

## 1.0.52 - 2026-09-23

- 修正新增采集工作台入口后浏览器并发 smoke test 的来源按钮定位，保持发布回归覆盖稳定。

## 1.0.51 - 2026-09-23

- Viewer 顶栏新增真实采集工作台入口，打开 `10.1.41.17:44587` 的完整人工 QC 页面及其统计、行为、账号、任务和保存接口，并复用工作台原生认证与权限。
- 修复机标校对剪切按钮和 `X` 快捷键在片段边界失效的问题；边界位置自动选择最近可分割帧，输入框内仍不会误触发。

## 1.0.50 - 2026-09-22

- 不通过原因新增“状态异常”，前后端统一校验，保存后可重新加载并保留原因。

## 1.0.49 - 2026-09-22

- 审核时实时检查错别字、重复字和术语，提供建议替换、忽略、撤销，并在通过前要求确认未处理提示。
- 管理员新增文字勘误工作区，支持历史扫描、按批次/审核人/日期筛选、批量修正、术语库、白名单、审计记录、撤销和需更新清单导出。
- 文字勘误使用文件与审核状态哈希保护并发修改；含义变更恢复待复审，普通错别字保留审核结论；术语库保存在应用数据目录，不写回 NAS 源目录。

## 1.0.48 - 2026-09-21

- 修复没有可读取媒体、机标或恢复清单损坏的数据无法批量判为不通过的问题；在共享锁内复核未审核 QC，仅原子保存不通过原因、审核人和修订，不创建虚假片段或改写媒体。
- 加载失败页面提供单条不通过入口，保留原因和确认流程；根级 QC 保存后计入任务完成进度，已有结论和非法 QC 不覆盖。

## 1.0.47 - 2026-09-21

- 将批量不通过与整文件夹不通过移到当前已加载目录上方；批量操作只作用于当前目录列表，整文件夹操作只作用于当前加载根目录。
- 两种操作均只处理未审核 QC，已有通过、不通过和异常结果保留；任务中心继续专注批次领取、进入、释放和进度查询。

## 1.0.46 - 2026-09-21

- 任务中心新增审核员释放本人批次入口，确认后恢复可领取，保留审核结果和进度；管理员仍可释放任意批次或转交。
- 用户中心在事务内校验释放归属并记录历史，拒绝释放他人或已转交任务；释放失败提示不再被后台状态刷新清除。

## 1.0.45 - 2026-09-21

- 回放网格固定为五路原有相机加 `extension_left`、`extension_right`，隐藏不属于摄像头的额外流（例如 `t265_pose`），并恢复完整对齐布局。

## 1.0.44 - 2026-09-21

- 新增相机槽位固定对应 `extension_left`、`extension_right`，各自读取同名目录的视频，缺少任一路时保留对应占位，不交换左右画面。
- 所有相机名称旁保留分辨率，修复窄窗口隐藏分辨率；清单缺少尺寸时从已解码 JPEG 或视频元数据补齐，较长目录名支持换行。

## 1.0.43 - 2026-09-20

- 回放区在现有五路流与骨架之间预置两个等尺寸画面槽位；新数据按实际相机目录名自动发现并使用同一帧读取和播放逻辑，未接入时保留明确占位。
- 支持 JPEG 相机目录和 MP4 manifest 中的任意安全流名称，预览生成器同步处理新增流；桌面和窄屏布局均保持无溢出。

## 1.0.42 - 2026-09-20

- 包含任务中心批次“仅未审核”筛选，支持一键查询、显示结果数量、打开记录与恢复完整列表；1.0.41 安装包未发布。
- 查询覆盖当前批次的多层子目录，以最多 4 个并发请求读取服务器索引；按相对路径区分同名 session，不扫描媒体或其他批次。
- 查询失败、统计不完整和加载中明确显示状态，避免误报没有未审核数据；刷新保留筛选，切换批次忽略旧请求结果。

## 1.0.41 - 2026-09-20

- 任务中心每个批次新增“仅未审核”快捷筛选，自动展开并读取当前批次明细，只显示 QC 未审核 session；支持一键恢复完整列表。
- 筛选范围限定在当前批次，不触发其他批次扫描，已通过、不通过和异常数据不会被误计为未审核。

## 1.0.40 - 2026-09-20

- 任务中心领取成功后自动打开对应批次目录并加载数据，加载成功后关闭任务中心。
- 本人已领取批次提供“进入审核”，可再次进入；目录断开、无可加载数据等失败保留领取归属与重试入口，避免误报进入成功。
- 连续点击仅提交一次领取；其他账号已领取的批次仍不可领取，管理员释放和转交规则保持不变。

## 1.0.39 - 2026-09-20

- 任务中心直接读取 NAS 预计算索引，打开和刷新不再重复全量扫描 QC，目录明细按展开加载。
- 服务器每天北京时间 23:00 自动完整统计；白天监听 QC 原子保存并增量更新，服务重启后自动校准。
- 顶部显示服务器最近统计完成时间、增量更新时间、后台统计进度及服务异常；失败保留上次成功结果。
- 管理员可立即启动服务器统计，普通刷新只获取已有结果；批次领取归属与原 QC 审核规则保持一致。

## 1.0.38 - 2026-09-20

- 包含 1.0.37 的本地监管队列、缓存迁移和原地登录补传修复；1.0.37 未发布安装包。
- 验证原生队列返回状态，空值或非法确认保留待存记录并提示重试；补齐并发浏览器测试的新增 IPC 契约。

## 1.0.37 - 2026-09-20

- 审核监管待补传记录改用应用本地 SQLite 持久化队列，不再占用浏览器缓存配额；旧缓存按账号和服务安全迁移，确认落盘后才移除旧记录。
- 保留未确认记录与离线积压；被服务端拒收的异常记录单独保留，不再堵住其他审核操作补传，手动重试可再次提交。
- 同时展示待传数量和实际错误，支持当前页面重新登录与立即重试；兼容旧服务把登录过期误报为审核员权限错误。
- 退出登录前等待监管记录落盘，仍仅在内存时阻止退出；保留人工审核结果、标签库和应急草稿。

## 1.0.36 - 2026-09-20

- 任务中心先显示批次目录与领取人，QC 统计逐批返回，不再等待所有批次扫描完成后才显示列表。
- 使用有界 8 工作线程在批次和 session 间分配扫描；按文件大小与修改时间复用短期 QC 缓存，手动刷新强制回读，不读取媒体内容。
- 重新打开任务中心立即展示本账号最近目录快照；自动扫描间隔从 1 分钟调整为 5 分钟，保留领取状态每 15 秒更新。
- 显示已统计数量、最近读取路径及耗时，支持停止扫描；统计未完成显示未知并禁用领取，后台更新保留已展开目录。

## 1.0.35 - 2026-09-18

- 缺少 NAS 预览目录时静默回退原片，不再误报“预览不可用”；真实清单校验失败时显示“预览校验失败”。
- 将开发预览设置按钮恢复到多路回放标题栏，审核员默认仍使用自动预览路径，开发人员可直接覆盖原片和预览目录。

## 1.0.34 - 2026-09-18

- 个人任务详情替换为任务中心，按真实文件夹树展示批次领取人、审核进度和 session QC；通过与不通过均计入已审核，异常不计完成。
- 用户中心原子保存批次领取，拒绝重复抢占；管理员可释放、转交，归属及操作历史重启后保留，需同步升级用户中心。
- 默认发现已挂载的 Delta-D1 数据目录，并自动映射独立预览目录；普通审核界面不再显示预览配置，开发模式保留覆盖与恢复自动入口。
- 修复目录缩放未生效，支持 75%–135% 显示比例及百分比反馈。

## 1.0.33 - 2026-09-16

- 新增 NAS/SMB 预览生成器：服务器在独立目录生成 1080p、720p、480p HLS 预览，原片保持只读。
- 播放器按网络吞吐自动切换预览清晰度，支持手动选择并在预览失效时回退 4K 原片。
- 新增预览源目录和输出目录设置，校验清单、帧数、帧率、尺寸及原片指纹，避免使用过期预览。

## 1.0.32 - 2026-09-16

- 软件统一更名为 Delta Viewer：应用窗口、登录页、安装包、GitHub Release、README 和 Wiki 同步更新。
- 登录页入口改为“注册审核员账号”，注册页标题改为“审核员注册”。
- 保留现有应用身份和数据存储键，继续读取账号配置、审核草稿和进度；Windows 升级复用旧安装目录并清理旧名称快捷方式和卸载入口，Linux 包替换旧包，更新镜像兼容改名前后的版本。

## 1.0.31 - 2026-09-16

- 不通过原因新增“轨迹不动”“无效数据”“任务不符”“动作过快”，支持写入 QC、历史审核和重载。
- 单击起始/结束手柄只选中、不跳帧；高亮当前手柄，左右箭头微调所选边界。选中播放头后左右箭头逐帧定位。
- 校对快捷键 X 在当前帧分割片段，沿用裁剪按钮的边界限制；输入框、弹窗、组合键与按键长按不误触发。

## 1.0.30 - 2026-09-16

- 修复 1.0.29 无机标 JSON 时加号仍不可用：自动模式建立只读人工审核模板，加载、切割、保存、审核与重载使用同一套持久化流程。
- 空列表点击加号创建覆盖 Camera 0 全部视频帧的片段，不受当前播放位置影响，不使用状态数据条数代替视频帧数；无需生成伪机标文件。
- 新增无机标整段创建、切割、保存重载、跨本机草稿恢复与审核通过回归，保留非法机标报错及源媒体只读约束。

## 1.0.29 - 2026-09-15

- 无机标结果但已有人工审核状态时允许直接新增人工片段，默认按整段视频帧范围创建切割标注。

## 1.0.28 - 2026-09-14

- 修正已删除账号历史筛选回归：默认隐藏，勾选“包含已删除账号”后可继续查询历史审核记录。

## 1.0.27 - 2026-09-14

- 实时审核进度、实时行为和默认账号筛选隐藏已删除账号；历史审核记录增加“包含已删除账号”选项，开启后仍可查询完整留痕。

## 1.0.26 - 2026-09-14

- 审核账号表增加删除按钮和确认窗口，支持取消、失败提示与重试；仅管理员可以删除普通审核账号，不能删除管理员。
- 删除后移除登录凭据、注销所有服务端会话，并从账号管理列表移除。历史审核事件和统计保留，历史筛选标记“已删除”，原账号名不可复用；需同步升级用户中心。
- 记录删除时间及操作管理员，重复删除幂等；增加权限、历史保留、重启、同名注册限制及桌面/小屏确认流程回归。

## 1.0.25 - 2026-09-14

- 发布 1.0.24 的状态图增高、坐标轴完整显示、标题留白、动作片段独立滚动和键盘选中项跟随改进。
- 用户中心支持超过 24 小时的历史监管记录幂等补传并保留原操作时间，修复积压记录持续报 `AUDIT_TIME_INVALID`；仍校验非法与超前时间，需同步升级用户中心。
- 修复 Windows 并发 QC 测试临时目录仅按时间戳命名导致的重名失败，增加原子序号并保留所有原生业务检查。1.0.24 安装包未公开，完整修复随本版发布。

## 1.0.24 - 2026-09-14

- 状态图最低高度提高至 220px，画布按实际容器尺寸绘制，为图例和坐标轴预留空间，修复小屏轴标签被裁掉的问题。
- 动作片段列表增加独立滚动条并按窗口高度限制长度，上下键切段自动显示选中项，保留编辑与审核按钮空间；多路回放、状态数据标题增加边缘留白。
- 修复旧监管接口拒绝超过 24 小时的待传记录、导致重试队列阻塞的问题。用户中心允许历史事件幂等补传并保留原操作时间，继续拒绝非法时间和超前超过 5 分钟的时间；需同步升级用户中心。

## 1.0.23 - 2026-09-11

- 机标来源按当前 session 动态列出根目录和 `.session_meta` 中的 `bailian*.json`、`description.json` 与 `desorption.json`，以路径区分同名文件；保留帧范围、区间和当前 session 身份检查。
- 监管扫描跳过已识别 session 的相机媒体子目录；旧 JPEG 时长仅读取状态时间戳和 Camera 0 文件名，不解码图像或索引全部相机，状态采样数与视频帧数分别处理。
- 修复 Windows 已通过数据导出在最终发布目录时因清单文件尚未关闭而出现“拒绝访问”；清单同步并关闭后再原子发布，保留源数据只读、回读校验与取消清理规则。
- Windows 发布流程增加原生 QC 扫描和导出回归测试。1.0.22 安装包发布因该实机问题已取消，完整功能随本版发布。

## 1.0.22 - 2026-09-11

- 监管账号可选择或输入数据根目录，先递归扫描全部 session 的根级 QC，再查看通过、不通过、待审核及异常数据明细；修改路径后旧扫描失效。
- 总览显示原始数据总时长、通过数据原始时长及人工裁剪后的有效总时长；人工保留片段合并重叠、排除删除段，未知时长单独提示，多个相机不重复累加。
- 扫描后可另选目标目录，集中导出全部已通过 session 的完整数据和人工裁剪记录。导出前后复核 QC、裁剪及源文件变化，逐文件校验大小和 BLAKE3 回读，支持取消，失败清理 partial，不覆盖已有输出。

## 1.0.21 - 2026-09-11

- 管理员工作区改为审核总览、实时行为、逐条审核记录和账号管理，移除原标注分配、抽检、导入及标注报表入口。
- 记录视频定位起止帧、拖动耗时、播放和控件操作、标签库增删应用、片段修改、保存及审核结论；可按账号、日期、行为和条目会话筛选、分页与导出 CSV，并查看从载入数据到提交成功的耗时。
- 新增独立审核事件接口与 SQLite 历史存储；客户端按账号和服务隔离暂存、断网补传，服务端幂等去重与权限校验。管理员每 3 秒刷新，需同步升级用户中心（Node.js 22.13+）。旧版未采集的历史交互不会补造。

## 1.0.20 - 2026-09-11

- 修复审核通过状态在进入下一条后被扫描刷新清空的问题；账号审核状态在扫描结果更新时保留，并继续从本机账号记录补齐。

## 1.0.19 - 2026-09-11

- 删除标准私有样例作为 `check:full` 和发布检查的硬性前置；完整检查改为直接运行通用门禁和 Tauri debug 构建。
- 保留可选的真实样例测试，但不再因样例目录不存在而阻断提交、合并或 Release。
- 历史版本回归测试读取当前应用版本，避免补丁升级时旧版本断言阻断 CI；完整检查继续要求 Tauri debug 构建成功。

## 1.0.18 - 2026-09-10

- 发布本地 1.0.9 至 1.0.17 的校对改进：四区工作台、目录收起与缩放、片段新增和分割、全局与片段播放，以及账号独立的常用描述库。
- 人工修改保存到 description.json，根 session.json 记录审核结论、原因、署名及唯一修订；保留原始机标和采集字段。
- 持久保存各账号审核关联和上次目录，恢复应急草稿，重试时保留人工内容并备份被替换的结果；兼容已挂载 CIFS 的网络目录保存。
- 修复自动模式遗漏 .session_meta 内 Flash 机标的问题，并拒绝链接或异常机标路径。
- 修复窄窗口五路画面与顶部按钮重叠，增加画面边界和工具栏布局回归。
- 通过既有流水线发布完整 Windows x64、macOS arm64、Ubuntu x64 UNSIGNED 安装器和签名更新包；可信发布者签名、实卡及大容量验收缺口保持开放。

## 1.0.17 - 2026-09-10

- 按稳定账号持久关联每条审核数据，退出、重启和改名后恢复“我已审”目录标记，多人审核保留各自关联。
- 隔离账号的上次数据目录与应急草稿，切换账号清理旧标记，已审核条目继续显示。
- 不通过新增“镜头遮挡”，同步写入根 session.json 的 qc、审核员与账号记录。

## 1.0.16 - 2026-09-10

- 人工审核内容优先：旧修订自动接续保存，机标更新保留人工描述、删除结果与实际帧数，冲突结果在本机留备份。
- 修复保存失败后审核页和目录切换被永久锁住，保留应急草稿并支持重新读取、重试与重启恢复。
- 修复重新登录时任务接口异常或启动操作竞争导致上次数据目录未显示。

## 1.0.15 - 2026-09-10

- 不通过时选择骨架抖动、镜头污渍、动作错误、画面过曝或其他原因；其他原因必须填写内容，后端校验后与审核员姓名、审核时间一起写入根目录 session.json 的 qc。
- session.json 的 revision 与审核页一致，每次保存生成唯一编号并附相对上次保存的中文摘要；appVersion 记录软件版本。description.json 的公开审核片段不再输出 decision、deleted，内部草稿继续支持删除恢复和并发冲突检查。
- 时间轴按当前片段顺序分配颜色，增加片段边界线，修复导入、删除、分割后相邻片段同色的问题。
- 同步更新软件版本、安装包和历史版本中文摘要。

## 1.0.14 - 2026-09-10

- 在 1.0.13 优化布局基础上，根目录 session.json 的 qc 同时保存 reviewerName（登录审核员显示姓名）和 reviewedAt（后端生成的 UTC ISO 8601 审核操作时间）。
- 再次编辑回到待审核时清除旧审核姓名和时间，避免沿用过期结论；三个审核字段不改变采集内容指纹。
- 保留删除片段后实际帧号对齐、description.json 仅输出保留片段，以及网络目录保存兼容修复。

## 1.0.13 - 2026-09-09

- 补丁：优化四区工作台视觉密度，缩小状态数据图，右侧片段列表独立滚动并固定审核操作区，改善桌面和窄窗口适配。

## 1.0.12 - 2026-09-09

- 人工审核结论写入每条数据根目录 session.json 的小写 qc 字段，保留原采集字段；不再写入 .session_meta/session.json。只有 qc 的变化不使采集指纹失效。

- 修复 Ubuntu GVFS 网络目录无法重复保存复核结果的问题：核对同一 NAS 共享的现有 CIFS 挂载后执行加锁和原子写入，保留原路径草稿与冲突检查。
- description.json 仅输出保留的片段，审核记录也不再包含被删片段；删除标记保留在本机草稿，跨主机重开时从原机标重建。
- 删除中间片段后，后一段起始帧自动对齐前一段结束边界，结束帧不变；前端定位与后端实际输出帧号一致，恢复删除时同步恢复相邻边界。

## 1.0.10 - 2026-09-09

- 补丁：新增片段与当前帧分割，保留上一帧、下一帧按钮；空格暂停/继续，左右键微调最近选中的片段边界，上下键切换片段，Enter 通过。
- 补丁：点击片段仅播放该段，全局播放按钮切换到完整视频；修复按钮焦点导致快捷键失效的问题。
- 补丁：左上多路回放、左下紧凑状态图、右侧时间轴和动作编辑；收紧右栏与小窗口适配，增加中文历史摘要。

## 1.0.9 - 2026-09-09

- 补丁：调整四区回放布局，并支持目录收起与缩放。
- 补丁：机标优先从 `.session_meta` 读取，人工复核输出 `description.json` 并记录 QC。

## 1.0.8 - 2026-09-09

- Restore selected-segment playback in unified proofreading: stop at the selected
  end, restart from its beginning, and follow boundary edits and segment changes.
- Preserve full-timeline paused seeking while restricting continuous playback
  to the active segment, using the existing five-camera and skeleton clock.

## 1.0.7 - 2026-09-09

- Merge playback and proofreading into the default proofreading workspace,
  preserving the five-camera grid, skeleton, telemetry and existing playback controls.
- Replace manual annotation and segment creation with the review timeline and
  action segments, connected to the existing playback clock and autosave writer.
- Load readable recordings directly without a quality-warning confirmation screen.

## 1.0.6 - 2026-09-09

- 校对工作区默认打开，回放与校对导航顺序调整；仅展示 cam0 与三维骨架。
- 支持 3.8 Max/Flash 中文机标，片段边界可在统一时间轴两端拖动并实时生成 review 文件。
- 删除、描述、边界和整条通过/不通过均写入唯一版本号的复核 JSON；保存失败保留草稿并阻止误跳下一条。



## 1.0.4 - 2026-09-09

- Show synchronized, interactive episode skeletons alongside proofreading video.
- Remove model pipeline status and generated warning paragraphs from the
  proofreading workspace while preserving source JSON and operational errors.

## 1.0.3 - 2026-09-09

- Read Qwen 3.8 Flash schema v4 results with bilingual T/value attribute arrays,
  while retaining schema v3 object attributes and original frame conventions.
- Select Flash or original machine annotations in proofreading. Prefer Flash
  automatically when present and keep source-specific drafts and reviewed files.
- Show Chinese action descriptions and pipeline issues. Preserve bilingual
  attributes, task metadata and unknown fields when saving human corrections.

## 1.0.2 - 2026-09-08

- Recognize new recordings whose MP4 manifest is stored in .session_meta,
  including their actual state cadence and per-camera startup offsets. Preserve
  readable recordings when quality checks flag individual streams or frames;
  a failed primary frame pauses playback without clearing the workspace.
- Keep health findings visible and preserve backend export validation gates.
- Promote proofreading into the stable edition while retaining operator task,
  trim and segment annotation, including explicit tracking-warning continuation.
- Align segment playback and boundary previews with source video frames,
  independent of state counts; sample inside each frame to avoid preceding-frame
  seeks. Coalesce rapid seeks and keep segment lists stable during playback.
- Display true annotation gaps, adjust shared boundaries without creating gaps,
  and support description edits, frame fine-tuning, deletion and restoration.
- Autosave per-segment review decisions locally. Create a separate
  bailian_annotation_reviewed.json only after all retained segments pass, then
  update it atomically while preserving untouched machine fields and reporting
  pending/rejected decisions after further edits. Preserve the original JSON.
- Protect saves with source/output hashes, revisions, cross-process locks and
  interrupted-write recovery. Keep proofreading out of manual completion counts.
- Ship the complete UNSIGNED Windows, macOS arm64 and Ubuntu installer set on
  the stable update channel. Existing GAP-003/GAP-007 qualification limits remain.

## 1.0.1 - 2026-09-08

- Begin the user-requested stable release numbering at 1.0.1, retaining the
  reviewed annotation and NAS playback improvements from 0.17.67.
- Restore saved trim ranges on re-entry and mark episodes annotated only
  after both task annotations and nonempty segments have been saved.
- Keep experimental machine-annotation proofreading in the separate
  development edition; the stable edition retains its existing workspace.
- Installers remain explicitly UNSIGNED. Existing physical-device and
  large-volume qualification gaps GAP-003/GAP-007 remain open; the version
  numbering change does not assert that those checks have passed.

## 1.0.2-dev.2 - 2026-09-08

- Restore operator annotation for readable videos whose position tracking is
  static or missing: show the warning and allow explicit continuation instead
  of automatically skipping the episode and hiding all annotation controls.
- Preserve task saving, trims, segment saving and saved-range restoration.
  Keep the proofreading workspace unchanged and retain unreadable-frame gates.
- Restore editable human bounds when returning from proofreading through a
  double-click on the already loaded episode in the source list.
- Development installers remain UNSIGNED and use their separate app identity.

## 1.0.2-dev.1 - 2026-09-08

- Add a development-only Proofread workspace alongside Replay, Checks,
  Export and Batch. Keep machine annotations out of the human annotation page.
- Read per-episode bailian_annotation.json without modifying source files;
  compare model segments with saved human annotations and preview media ranges.
- Align exclusive source-video intervals with the primary playback timeline,
  and report missing, malformed, legacy or mismatched machine metadata.
- Match the requested proofreading layout with a main video, independent
  start/end frame previews, a colored action strip, segment attributes and JSON.
- Publish an Apple Silicon development DMG first at the user's request,
  with ad-hoc sealing, mounted-install startup verification and checksums.
- Distribute the development edition as DOHC Viewer Dev with the separate
  com.dohc.viewer.dev application identity and local data directory.
- Disable stable-update checks and installation in the development edition.
  Stable 1.0.1 retains the previously released annotation optimizations.
- Development builds remain unsigned and do not imply target-machine or
  large-volume qualification.

## 0.17.67 - 2026-09-07

- Restore saved trim boundaries before mounting annotation editors so stale drafts
  cannot replace the retained range when an episode is reopened.
- Keep read-only previews available while validation runs, reuse the validated
  fingerprint for annotation loading, and restore both draft boundaries
  together for task-only annotations.
- Show the catalog's annotated marker only after the task annotation and
  nonempty segments have both been saved. Changing tasks requires saving the
  new task's segments instead of inheriting completion from the previous task.
- Keep a newly selected task when the task catalog refreshes and verify
  re-entry, completion markers, and task changes at desktop and narrow widths.
- Make the buffering regression wait for the final submitted frame to paint
  before asserting that both the shared timeline and media clocks stay frozen.
- Physical target-machine and large-volume qualification gaps
  GAP-003/GAP-007 remain open.

## 0.17.66 - 2026-09-07

- Use the primary video's presentation clock for MP4 playback and skeleton
  synchronization, avoiding repeated seeks and stalls caused by slower views.
- Wait for native video discovery before starting compatibility decoding and
  move filesystem discovery and media probing off Tauri's command thread.
- Read media byte ranges in bounded 1 MiB blocks, coordinate camera buffering,
  and avoid rebuilding the episode catalog on each playback frame.
- Recover native playback after buffering, preserve exact paused seeks, and
  handle segment transitions, recording completion, and replay explicitly.
- Add native-browser playback regressions and read-only NAS diagnostics.
  Sustained source throughput must still support the video bitrate; physical
  target-machine and large-volume qualification gaps GAP-003/GAP-007 remain open.

## 0.17.65 - 2026-08-31

- Fix synchronized MP4 playback by using the media stream's probed frame rate
  for native playback and compatibility frame decoding.
- Route MP4 streams through the FFmpeg fallback instead of treating their
  stream directories as legacy JPEG sources.
- Keep source episodes available for read-only preview when no server task is
  assigned, while retaining assignment controls for annotation work.

## 0.17.64 - 2026-08-26

- Classify Linux GVFS mounts as remote sources so SMB shares opened through the
  desktop file manager receive the same network-source behavior as native
  CIFS/NFS mounts.
- Make JPEG playback on NAS sources start and recover from middle seeks after a
  30-frame Camera 0 runway instead of the local 360-frame runway, while keeping
  bounded background read-ahead during playback.
- Add independent strided read-ahead for the four secondary JPEG views at their
  existing roughly 10 FPS preview cadence, preventing small camera tiles from
  remaining stuck behind slow per-file network reads without copying source data.
- Route ordinary per-frame JPEG directories through a tokenized, loopback-only
  read-only media source so WebView decodes the files directly instead of moving
  every frame through Rust-to-JavaScript Base64 IPC; segment BIN and MP4
  compatibility decoding keep their existing validated fallback paths.

## 0.17.63 - 2026-08-25

- Complete the operations cockpit with per-assignment progress and ETA, exact
  minute deadlines, batch account lifecycle controls, bulk transfer previews,
  and capacity-aware assignment previews.
- Persist annotation and segment drafts locally, restore the last unfinished
  assigned episode, restrict every source type to the signed-in operator's
  assignment range, confirm task/segment/frame totals before saving, advance to
  the next item after completion, and retry idempotent audit events after an
  outage.
- Expand the exception center with inactivity, delayed start, slow processing,
  repeated-open, source, user-center, save and validation signals while keeping
  “possible stagnation” advisory; reject non-whitelisted audit payload fields.
- Record independent quality reviews against annotator, revision, segment and
  frame ranges, preserve rework chains, and create rework-priority assignments
  from review results rather than operator self-reporting.
- Export daily, weekly and task reports as atomic, verified JSON, CSV or
  printable HTML files and reveal their output folder after completion.

## 0.17.62 - 2026-08-25

- Add a login-page action for re-importing a refreshed LAN user-center
  configuration after the service host address changes, while preserving the
  existing TLS health and same-service-ID migration gates.
- Keep the configuration refresh action with the secondary login links below
  the form, including wrapping behavior for narrow diagnostic viewports.

## 0.17.61 - 2026-08-24

- Route every manifest-backed MP4 stream through its own tokenized,
  loopback-only HTTP Range source so Camera 1, Camera 2 and both T265 views use
  continuous native decoding instead of the throttled frame-preview fallback.
- Retry initial secondary-stream playback after the first seek or readiness
  transition, fixing Camera 1 and Camera 2 remaining paused until the operator
  manually paused and resumed the timeline.
- Keep Camera 0's established player, priming gate and fallback behavior
  unchanged; streams without native MP4 data continue to use the bounded,
  read-only per-frame compatibility path.

## 0.17.60 - 2026-08-24

- Refine the existing supervision cockpit without adding duplicate workflows:
  introduce a restrained operations palette, stronger navigation and data
  hierarchy, and clearer connected, success, warning and error states.
- Improve dense management surfaces across overview, assignment, alerts,
  quality and reports with consistent tables, charts, controls and responsive
  layouts for the supported desktop and narrow diagnostic viewports.
- Fix Windows source responsiveness probes by passing the selected path through
  a dedicated process environment value instead of appending it to PowerShell
  command text.
- Restore the Windows Rust release gate by embedding the Common Controls v6
  dependency in crate targets and making platform-specific test imports and
  collision fixtures portable.

## 0.17.59 - 2026-08-24

- Keep manually selected removable recordings visible for managed operators,
  while preserving assignment filtering for fixed/NAS roots, and support
  same-service user-center endpoint migration plus certificate-covered private
  LAN aliases for login without Internet access.
- Correct lower-FPS MP4 stream bounds on the shared timeline and make middle
  seeks reset and rebuild their own Camera 0 runway without waiting forever for
  nonexistent tail frames or secondary streams.
- Give Camera 0 a loopback-only, tokenized, read-only HTTP Range path for true
  continuous MP4 decoding without copying or modifying the mounted recording;
  retain bounded FFmpeg batch fallback with longer primary read-ahead,
  source-FPS cadence, secondary preview throttling, and catch-up-burst removal.
- Reduce playback main-thread work by deduplicating frame requests and native
  settlement state, memoizing frame tiles, and separating the telemetry trace
  from its per-frame playhead.

## 0.17.58 - 2026-08-21

- Load dated `hybrid-h264-jpeg-segment-v1` recording folders directly by
  combining their top-level camera MP4 manifest with nested T265 segment BIN
  images and poses on one batch-ID timeline.
- Carry the hybrid timeline's first batch ID into native MP4 playback and
  frame-extraction fallback, including 15 FPS streams on the 30 Hz pose clock,
  while preserving the existing legacy MP4 and standalone segment loaders.
- Validate the complete mounted `/media/descfly/DOHC1TB` batch: all 15 sealed
  hybrid recordings scan, load and sample without format errors; the legacy MP4
  remains discoverable, and three interrupted `jpeg-stream-v1` recordings that
  contain only partial/zero-length outputs are reported as invalid data without
  crashing.

## 0.17.57 - 2026-08-21

- Recognize folders containing any positive number of `segment-*.bin` files,
  sort their numeric suffixes numerically, and load all records as one
  continuous T265 episode while ignoring unrelated files.
- Parse the observed `DHSG`/`DHSC` little-endian record container, reuse the
  existing pose/JPEG models, and read JPEG frames on demand by indexed offset
  with payload and whole-record CRC32 verification.
- Report invalid names, sequence gaps, duplicate segment/frame numbers,
  truncation, malformed pose JSON, CRC failures and JPEG decode failures
  without crashing. Empty non-applicable camera streams no longer enter the
  segment playback wait set.
- Verify the loader against the mounted six-segment 1.385 GB production sample:
  10,229 poses and 10,229 frames per T265 eye, including first/last frame reads
  and fixed-percentile health validation.

## 0.17.56 - 2026-08-21

- Probe source directories in a bounded child process before scanning, loading,
  validation or supervision task discovery. An unresponsive hard NFS/SMB mount
  now fails after five seconds without trapping the desktop process in a
  filesystem syscall.
- Release the frontend operation state after source-probe failures so operator
  logout, source reconfiguration, local imports and retries remain available.
- Classify and display unresponsive network sources separately in local
  operation history without changing or uploading source data.

## 0.17.55 - 2026-08-21

- Add two batch assignment modes: allocate every episode from multiple selected
  task folders in one operation, or select multiple tasks and set an independent
  total quantity for each task before even or speed-weighted distribution.
- Validate batch totals against folder capacity and assignments held by
  unselected operators, and submit each selected operator's complete updated
  queue once per batch operation.
- Replace assignment deadline time points with date-only deadlines. Store the
  selected local date through the end of that day and label same-day deadlines
  as `今天` in administrator and operator views.

## 0.17.54 - 2026-08-20

- Add a privacy-bounded task operations cockpit with daily/cumulative/remaining
  totals, per-task and per-operator throughput, hourly and seven-day trends,
  completion estimates, connection freshness, and non-accusatory stagnation
  indicators. Segment and frame totals remain local to imported annotation JSON.
- Extend assignments with ordered, non-overlapping ranges, priority, deadline and
  pause state; add drag ordering, even or speed-weighted batch previews, and an
  atomic cross-account transfer operation protected by serialized state updates.
- Add an exception center with acknowledgement, notes, reassignment entry points
  and closure, plus administrator-only quality reviews and pass/rework history.
- Add privacy-safe JSON, CSV and printable HTML reports; improve the operator
  task drawer with current/next/remaining groups, continue/next actions, paused
  task filtering, playback shortcuts, and an explicit local-not-uploaded state.
- Cover concurrent range allocation, atomic transfer, alert lifecycle, quality
  persistence, allocation math and the full cockpit browser flow with regression
  tests.

## 0.17.53 - 2026-08-20

- Added rate-limited operator self-registration to the managed login screen;
  self-registration cannot request or create an administrator role, and
  concurrent account/state updates are serialized to prevent lost writes.
- Warn before assigning a task already held by another operator, and default
  scanned task quantities to all episodes currently available in the folder.
- Let a signed-in operator update their current display name while preserving
  the stable username used for assignments, audit ownership and supervision.

## 0.17.52 - 2026-08-19

- Add an operator task drawer with local source-folder setup, assigned task
  details and date-filtered personal annotation activity without uploading paths.
- Reuse existing task definitions when assignment names share their generated
  code prefix, preventing assigned tasks such as `oven` from failing at login.
- Show scanned folder totals in supervision assignment cards and add per-folder
  and per-task controls that safely fill the complete available quantity.
- Keep annotation descriptions on one aligned native selector, with an optional
  custom text field that saves on Enter or focus loss.

## 0.17.51 - 2026-08-19

- Advertise structured task-assignment support from the LAN user center and
  reject legacy services before assignment reads or writes.
- Verify that assignment save responses preserve every task name, quantity and
  total so an old server can no longer report a misleading successful save.

## 0.17.50 - 2026-08-19

- Fixed supervision assignments imported from task JSON being silently blocked
  unless the administrator also scanned a NAS task directory.
- Show assignment save errors and confirmations beside the save control, update
  the overview from the persisted server response, and keep NAS quantity bounds.

## 0.17.49 - 2026-08-18

- Anchor the three-dimensional skeleton heading to the initially displayed pose
  so later turns remain visible instead of changing the viewer's reference frame.
- Detect SMPL facing direction from the feet and COCO facing direction from the
  nose, including mirrored source coordinates and a corrected axis fallback.

## 0.17.48 - 2026-08-18

- Allocate non-overlapping per-task episode ordinal ranges centrally without
  transmitting NAS paths or episode identifiers to the user center.
- Store the mounted NAS task root only on each workstation; after its one-time
  setup, operator login automatically scans and opens only assigned episodes.
- Automatically select the matching assigned task when an operator moves between
  assigned video entries, while retaining imported descriptions as annotations.

## 0.17.47 - 2026-08-18

- Added an administrator-only, local JSON import for annotation supervision.
  The dashboard groups the latest annotation revision per episode by person and
  shows each person's tasks, trajectories, segments, and inclusive frame totals.
- Kept full annotation details out of the user-center audit API: imported JSON
  is parsed locally, bounded to 8 MiB and 20,000 records, and returns no source
  roots, fingerprints, descriptions, or segment text to the interface.

## 0.17.46 - 2026-08-18

- Made JPEG playback lossless and sequential: all five streams finish the
  current frame before the transport advances exactly one frame, allowing
  playback to slow down under I/O pressure instead of skipping images.
- Kept native MP4 playback continuous while retaining synchronized pause,
  seek, speed and timeline state.
- Replaced numeric-only supervision assignments with a detailed operator and
  task workbench that directly assigns scanned or imported named tasks, shows
  completion progress and overlapping assignees, and persists the exact list.
- Kept the existing task-completion catalog unchanged and made the detailed
  assignment workbench open only after selecting an operator, with an explicit
  close action returning to the normal supervision overview.
- Removed display of legacy numeric-only assignment totals and added a bounded
  quantity field to every selected task, persisting per-task allocation counts.
- Made task names dynamic from the selected JSON `tasks` array (`label`) or the
  scanned directory, and treat each imported `description` as its task annotation;
  selecting a directory remains optional and only adds completion counts.
- Keep the current imported task list session-local and replace it on every file
  import, so persisted annotations do not make tasks appear before a file is chosen.
- Added assigned-task frame totals to the account overview: `states.jsonl` rows
  provide total frames, while frames in episodes with `description.json` count
  as completed, filtered to each operator's assigned task names.
- Unified the account overview layout with fixed column proportions, centered
  metric values, and the date/frame-count explanation grouped under its title.
- Operators now load only their centrally assigned tasks on the normal work
  screen; missing local definitions are synchronized from the assigned task name
  and imported `description` so the tasks can be selected and saved immediately.

## 0.17.45 - 2026-08-17

- Added read-only discovery and synchronized preview-frame decoding for recorder
  sessions using `h264-split-mp4-v1`, including nested `pose` state records and
  the five different per-stream frame rates found on the `DOHC1TB` exFAT sample.
- Excluded hidden recorder benchmark/QC directories from source-root discovery
  and explicitly blocked the still-JPEG-only export adapters for MP4 sources.
- Stopped treating the expected 60 Hz state-axis versus per-stream MP4 frame-rate
  ratios as JPEG-style `COUNT_MISMATCH` warnings.
- Made MP4 preview try each available FFmpeg decoder and fall back from the
  bundled JPEG-focused binary when it cannot open H.264 MP4 input.
- Replaced per-frame FFmpeg process spawning during MP4 playback with five
  persistent native video elements synchronized to the shared state timeline;
  only manifest-listed canonical segment files enter the runtime media scope.
- Advanced health reports to format v7 after MP4 validation semantics changed,
  preventing stale v6 reports from failing atomic readback, and added a bounded
  10 FPS FFmpeg preview fallback for Linux WebKit installations without H.264.
- Added Ubuntu deb dependency and release gates for `gstreamer1.0-libav`, so apt
  installs WebKitGTK's H.264 decoder together with DOHC Viewer.
- Added `gstreamer1.0-vaapi` to Ubuntu installs while retaining libav fallback;
  decoder choice remains with WebKitGTK because globally forcing VA-API can break its renderer.
- Fixed native MP4 playback being immediately paused by an inverted condition,
  stopped background JPEG extraction while native video is active, and limited
  native seeking to paused timeline changes.
- Decoupled continuous MP4 decoding from React's state timeline by refreshing
  the surrounding review UI at 10 Hz while each native video retains its source FPS.
- Exposed each MP4 tile's actual native/buffering/fallback state and stopped a
  transient WebKit `play()` rejection from silently enabling frame extraction.
- Restored the original per-frame clock for JPEG recordings and made native MP4
  playback apply the selected timeline position both at play start and after metadata loads.

## 0.17.44 - 2026-08-17

- Added an administrator-only supervision dashboard for task assignments and completion metrics, plus an in-app history view for installed and prior release versions.

## 0.17.43 - 2026-08-17

- Updated browser regression flows to select the renamed “登录工作区” entry and assert that the retired offline entry stays unavailable, restoring CI coverage after unified login became mandatory.

## 0.17.42 - 2026-08-12

- Require every data user to sign in through the pinned-certificate LAN user center, upload an idempotent annotation audit event after each save, and expose administrator-only per-user task-count, operation-count, and annotation-duration totals for later KPI quality scoring.

## 0.17.41 - 2026-08-11

- Added local task-template JSON import with selectable, editable task descriptions
  and reusable segment-title choices; browser preview now selects the actual JSON
  file and imports every configured task.
- Kept segment timing entirely manual: templates no longer split an episode into
  inferred ranges, and operators apply titles after placing their own splits.
- Added `TRAJECTORY_POSITION_UNAVAILABLE` for state streams whose position is
  absent or entirely null, upgraded health reports to v6, and automatically
  skipped those records before annotation.

## 0.17.40 - 2026-08-11

- Updated browser regression flows to explicitly accept the annotation warning
  decision and to distinguish browser-demo saves from source `description.json`
  persistence.
- Restored focus to the session that opened the annotation warning after the
  operator continues or the confirmation load fails.

## 0.17.39 - 2026-08-11

- Mounted the read-only episode preview immediately after loading its states and
  stream index, allowing frame inspection while the health check continues.
- Kept validation as the gate for annotation and export, with failed or
  cancelled checks clearing the provisional preview.

## 0.17.38 - 2026-08-11

- Corrected the playback regression assertion for an unavailable current frame:
  it now verifies the immediate `FRAME_UNAVAILABLE` block instead of waiting
  for a frame counter that is intentionally unmounted with the session.

## 0.17.37 - 2026-08-11

- Updated playback regression coverage to verify that a runtime unavailable
  frame stops the session and records `FRAME_UNAVAILABLE`.

## 0.17.36 - 2026-08-11

- Updated browser playback regression coverage to accept the new warning gate
  before asserting synchronized image loading and playback behavior.

## 0.17.35 - 2026-08-11

- Persisted clip ranges and every segment's frame range, title and note in the
  source episode `description.json` alongside the overall task description.
- Upgraded source annotation metadata to format-v2 without changing capture
  fingerprints or the atomic write boundary.
- Blocked playback when the per-stream image precheck finds unavailable frames,
  added a reversible source-list skip action, and report runtime frame failures.
- Added a right-side annotation decision for every warning except
  `STATE_FRAME_GAP`; declining skips to the next record, while
  `TRAJECTORY_STATIC` skips annotation automatically.
- Added `TRAJECTORY_STATIC` state validation for trajectories with no position
  movement, and show the exact source metadata path after annotation saves.

## 0.17.34 - 2026-08-11

- Moved the fixed LAN update-mirror and user-center endpoints to `10.1.11.200`.
- Kept the public update mirror, ports, origin and signature verification gates unchanged.

## 0.17.33 - 2026-08-11

- Saved the editable task description to a format-v1 `description.json` in the
  episode root using verified, cross-platform atomic replacement.
- Kept `description.json` outside capture statistics and fingerprints so saving
  metadata does not invalidate health checks or annotation identity, while
  preserving it in explicit verified imports.
- Restricted source writes to the managed description file and report explicit
  failures when the source episode is not writable.

## 0.17.32 - 2026-08-10

- Changed source selection to a shallow session catalog that inspects each
  immediate directory once without walking image trees or collecting file
  metadata for every session.
- Added a fast annotation preview path that reads states and five stream file
  names first, then builds one reusable deep index during the health check.
- Added explicit pending, preview, and indexed list states while preserving the
  read-only source, source-change detection, and validation-gated export rules.

## 0.17.31 - 2026-08-10

- Added a bounded in-memory source index for mounted directories. Directory
  summaries, frame indexes, and their metadata fingerprint are reused only
  within the current process; validation and export still enforce a current
  source fingerprint.
- Started the read-only episode preview as soon as states and optional skeleton
  data load, while the health check continues in the background. The export
  action stays disabled until that check completes.
- Added browser coverage proving that five camera frames render during a
  pending validation task, without invoking the importer or copying source data.

## 0.17.30 - 2026-08-10

- Aligned SMPL and COCO source coordinates to a stable Y-up playback view so
  Z-up skeleton captures open standing instead of lying on their side.
- Added unit and browser regression coverage for upright framing, synchronized
  skeleton motion, orbit interaction, nonblank canvas pixels, and narrow layout.

## 0.17.29 - 2026-08-10

- Added guarded deletion for unused custom tasks while preserving built-in and
  referenced task definitions.
- Added full pre-copy validation to explicit imports, bounded black-screen
  detection, and report v5 median-FPS and frame-interval stability statistics.
- Embedded clipped segment annotations in MCAP, HDF5, and LeRobot outputs,
  returned the verified companion Metadata path, and enlarged the cam0 view.

## 0.17.28 - 2026-08-10

- Restored episode-list focus only after React commits the loading state that
  re-enables the target button, removing an intermittent activation race.
- Invalidated pending focus restoration when the workspace resets so an old
  session cannot receive focus after a mode or identity transition.

## 0.17.27 - 2026-08-10

- Persisted continuous segment ranges, editable names, notes, and clip bounds in
  append-only app-local annotation revisions without writing to source episodes.
- Added atomically published, read-back-verified Metadata JSON companions for
  annotated MCAP, HDF5, and LeRobot exports while preserving one video timeline.
- Kept normal session activation on the direct read-only source path and added
  browser coverage for segment save/restore, playback, and narrow-view overflow.

## 0.17.26 - 2026-08-07

- Replaced unconditional interval-based frame stepping with a render-aware
  playback clock that advances only after all five current camera frames have
  loaded or reported an error, keeping video and skeleton motion synchronized.
- Added regression coverage for ready-frame advancement, delayed-image holding,
  and clip-end clamping.

## 0.17.25 - 2026-08-06

- Allowed operating-system-mounted network volumes, including Windows mapped
  drives and SMB/NFS mounts, as read-only data sources for scanning, loading,
  fingerprinting, and explicit-import source validation.
- Kept source data read-only with no automatic copies or application-managed
  SSH, HTTP, cloud-storage, or NAS protocol connections.
- Kept import and export destinations on local filesystems so their capacity
  preflight and atomic no-replace publication guarantees remain unchanged.

## 0.17.24 - 2026-08-06

- Added a persisted workspace-mode choice for unified LAN account management or
  account-free offline work.
- Offline mode enters the local workspace without user-center requests, account
  controls, processor display, or automatic update checks; local annotations
  retain an internal offline-local provenance marker instead of a user account.
- Switching modes clears the active source, loaded episode, task state, and
  operation notices before entering the new workflow.
- Updated the playback browser regression to select unified management before
  registering its demo account.
- Updated the browser operation-ownership and dialog-recovery mocks to report
  their selected unified-management workspace mode before loading the workspace.
- Updated session-activation browser coverage to select unified management before
  opening its registration form.

## 0.17.20 - 2026-08-06

- Added optional local SMPL/skeleton NPZ loading with bounded Rust parsing,
  frame-ID synchronization, and non-blocking visible parse errors.
- Added an interactive Three.js skeleton viewer beside the five synchronized
  camera images on desktop, with a stacked layout on narrow windows.

## 0.17.19 - 2026-08-06

- Restored the continuous single-track time-trim controls after the compact
  segment workflow accidentally removed the export clip editor and its
  playback boundary behavior.
- Kept session-only segment drafting and its compact playback controls while
  making it explicit that segment notes do not replace the closed interval
  used by playback and export.

## 0.17.18 - 2026-08-04

- Integrated current-session segment drafting directly below synchronized
  playback, with timeline seeking, sequential “create to current frame” ranges,
  immediate note editing, deletion, and no source-card writes.
- Compacted episode annotation into the playback page with task, trajectory,
  description, processor, save status, and save action in a scan-friendly layout.
- Reused the main playback transport in the segment timeline and removed the
  separate segment tab, duplicate preview, trim control block, and playback rail.
- Added responsive browser regression coverage for segment creation, notes,
  camera rendering, console errors, and horizontal overflow.

## 0.17.17 - 2026-07-31

- Added a 30 FPS state-timeline health gate. It measures the median raw-nanosecond
  period per frame-ID-normalized adjacent state interval, accepts a ±5% tolerance, records the result in
  health report v4, and reports `FRAME_RATE_MISMATCH` for stable off-rate data.

## 0.17.16 - 2026-07-31

- Fixed the update mirror when GitHub's `releases/latest/download/latest.json`
  shortcut returns 404. The mirror now resolves only the fixed official latest
  Release API, derives the immutable semver tag, and retains the existing
  three-platform, size, SHA-256, and Minisign verification gates.

## 0.17.15 - 2026-07-31

- Added a LAN-only HTTPS user center on the current host at `10.1.11.36:17880`.
  The host administrator initializes the first admin and creates operator
  accounts; desktop clients import a pinned certificate configuration and do
  not store passwords.
- Added annotation and export provenance for capture time, annotation edits,
  edit duration, operator identity, export time, and exporter identity across
  MCAP, HDF5, and LeRobot metadata with readback verification.
- Added a one-command macOS LaunchAgent installer and deployment documentation
  for the user center, and removed the old client-side account creation path
  from the real desktop runtime.

## 0.17.14 - 2026-07-31

- Measured the fixed public and LAN update mirrors concurrently with a bounded
  32 KiB range request, then downloaded through the faster path while retaining
  the existing size and Minisign verification gates.

## 0.17.13 - 2026-07-31

- Aligned the time-trim selection rail with both range sliders on desktop and
  narrow layouts, including a regression check for the shared pixel bounds.

## 0.17.12 - 2026-07-30

- Moved automatic updates to the fixed public mirror and added a fixed LAN
  fallback with host-bound manifest rewriting, so internal clients do not
  depend on NAT loopback while all updater bytes remain size- and
  Minisign-verified.

## 0.17.11 - 2026-07-30

- Fixed Linux release startup by explicitly permitting the fixed local HTTP
  mirror in Tauri while retaining the fixed origin, bounded payload, and
  Minisign verification gates before installation.

## 0.17.10 - 2026-07-30

- Added an authenticated startup check that automatically downloads, verifies,
  installs, and restarts into a newer release through the fixed local mirror at
  `10.1.11.36:17879` on Windows x64, macOS arm64, and Ubuntu x86_64; clients no
  longer need GitHub access and mirror failures do not block local data work.
- Added a strict 64 MiB download bound, fixed-mirror URL validation, and a
  dedicated Ed25519/Minisign signature check before any update is installed.
- Extended Release CD to produce signed platform updater payloads and
  `latest.json`, plus a read-only mirror service that verifies and atomically
  caches the complete release while retaining the previous version on sync
  failure. Existing `0.17.8` installations require one manual `0.17.10` install
  from the mirror page before later versions can update automatically.
- Fixed the browser test Tauri contracts so their mocks include the
  automatic-update commands invoked after local login.
- Fixed the browser regression locator so the new update control cannot be
  mistaken for the data-health-check command.

## 0.17.8 - 2026-07-28

- Fixed Windows release packaging so Tauri's moving WebView2 cache key is
  populated with the exact reviewed offline installer instead of silently
  downloading a different upstream payload.
- Kept the embedded WebView2 SHA-256 and Microsoft Authenticode gates, and made
  hash mismatch failures report both expected and actual values.
- Superseded the unpublished `v0.17.7` release attempt, whose Windows payload
  gate correctly prevented a partial GitHub Release.

## 0.17.7 - 2026-07-28

- Added per-item failure logs for batch export, with an in-app error view and a
  direct action to reveal each log in the local file manager.
- Added an explicit “打开文件所在位置” action for every successful batch
  export, and documented the one-commit/one-tag release workflow.

## 0.17.6 - 2026-07-27

- Retired macOS Intel/x64 from future releases; CD now publishes Windows x64,
  macOS arm64, and the Ubuntu 22.04+ x86_64 deb as one verified set.
- Added authenticated batch export for locally annotated full episodes, with
  backend-trusted annotation selection, source fingerprint revalidation,
  per-item health gates and results, cancellation, and MCAP/HDF5/LeRobot support.

## 0.17.5 - 2026-07-27

- Made a unique, dated, non-empty `CHANGELOG.md` entry mandatory for every
  release and publish that curated entry directly in the GitHub Release notes.
- Ignore macOS AppleDouble `._*` and `.DS_Store` metadata consistently during
  source statistics, fingerprinting, frame validation, and explicit imports,
  while retaining errors for actual malformed JPEG frame names.
- Reduced repeat CI from 5 minutes 54 seconds to 2 minutes 59 seconds with
  isolated Rust dependency caches, and removed the duplicate full gate from CD
  while preserving every platform packaging and runtime verification.

## 0.17.4 - 2026-07-27

- Read and validate sessions directly from the mounted read-only source in the
  normal UI, without automatically creating app-local episode copies.
- Added locally creatable annotation tasks with editable descriptions and
  Rust-only atomic `{task-prefix}-{NNN}` trajectory assignment.
- Changed telemetry dimensions to stable red, green, blue, and purple series,
  while retaining labels and distinct line patterns for non-color distinction.

## 0.17.3 - 2026-07-27

- Refreshed the reviewed Microsoft WebView2 x64 offline-installer URL and
  SHA-256 after the upstream fixed link moved to a new signed payload.
- Superseded the unpublished `v0.17.2` tag, whose macOS and Ubuntu packages
  passed but whose Windows embedded-payload hash gate correctly blocked the
  complete GitHub Release.

## 0.17.2 - 2026-07-27

- Simplified Release CD to use the repository `GITHUB_TOKEN`, automatically
  create the immutable annotated version tag after successful `main` CI, and
  publish the complete four-installer draft without a dedicated release commit,
  GitHub App credentials, or release Environment.
- Routed rejected native export confirmations and destination pickers through the
  visible error and operation-history recovery path, while preserving successful
  export and report-export behavior.
- Made the mocked-Tauri dialog recovery suite a required browser CI gate so a
  missing browser cannot silently skip the regression coverage.
- Corrected stream-scoped issue locating so valid stream frames are selected
  without clamping to unrelated state bounds.
- Removed the Flatpak manifest, build script, verification script, and active
  packaging references. The Ubuntu 22.04+ x86_64 deb is the only supported
  Linux release asset, Ubuntu 20.04 has no v0.17.2 binary, and release assembly
  rejects unexpected Flatpak assets.

## 0.17.1 - 2026-07-22

- Kept native deb construction, `apt` installation, and startup verification on
  Ubuntu 22.04, while moving only the downstream GNOME 50 Flatpak packaging to
  Ubuntu 24.04's compatible `flatpak-builder`.
- Passed the verified Ubuntu 22.04 deb between isolated jobs and retained
  independent deb/Flatpak reports, attestations, and the five-installer atomic
  publication gate.
- Superseded the unpublished `0.17.0` tag, whose deb checks passed but whose
  combined Ubuntu 22.04 job was blocked when its older Flatpak builder could not
  invoke `appstream-compose` from the GNOME 50 SDK.

## 0.17.0 - 2026-07-22

- Added an unsigned native x86_64 deb as the preferred installer for Ubuntu
  22.04 and later, while retaining the GNOME 50 Flatpak for Ubuntu 20.04+
  compatibility.
- Fixed Linux release builds on Ubuntu 22.04 and added a real `apt` install,
  package/dependency inspection, bundled-resource validation, unresolved-library
  check, and 10-second Xvfb startup smoke for the generated deb.
- Expanded the atomic GitHub Release gate to require five verified installers,
  with independent deb and Flatpak reports, checksums, manifests, and build
  provenance before publication.

## 0.16.1 - 2026-07-22

- Hid the per-frame loading overlay while synchronized playback is running, so
  repeated `解码中` messages no longer obscure video. Paused loading feedback
  and explicit unavailable-frame errors remain visible.

## 0.16.0 - 2026-07-22

- Added Ubuntu 20.04+ x86_64 support through an unsigned Flatpak bundle using
  the pinned GNOME 50 runtime; the Ubuntu 24.04 `.deb` is retained only as the
  Flatpak build input.
- Added Linux `/proc/self/mountinfo` volume detection, removable-device
  classification, remote-volume rejection, and `vfat`/`msdos` FAT32 safeguards.
- Added reproducible Linux FFmpeg staging, Flatpak build/verification scripts,
  AppStream metadata, runtime permission checks, Xvfb startup smoke, and a
  four-installer release completeness gate.

## 0.15.3 - 2026-07-22

- Removed the second local-destination dialog. Selecting an SD card now creates
  a managed app-local-data workspace and automatically imports every discovered
  session, while preserving the source-path identity and per-session status in
  the left list.
- Added append-only local operation error history with the original platform
  message, stable error classification, source path, timestamp, and operator.
  Permission failures such as `Operation not permitted` remain available after
  the transient banner is closed or the app is restarted.

## 0.15.2 - 2026-07-21

- Kept strict macOS nested-code and sealed-resource verification while making
  the quarantined policy check portable to GitHub's macOS 15 runners.
- When `syspolicy_check` reports an internal XProtect error, the release gate
  now builds a separate minimal ad-hoc control app and accepts the runner state
  only if the same error occurs for that known-good control. Product-only
  XProtect or any signature/resource damage still blocks publication.
- Recorded policy-service availability and the control result in each macOS
  verification report and final release manifest. The `0.15.1` tag was blocked
  before publication, so users should install `0.15.2` or later.

## 0.15.1 - 2026-07-21

- Fixed the invalid macOS app resource seal in the `0.15.0` DMGs that could make
  Gatekeeper report that DOHC Viewer was damaged. The `0.15.0` macOS assets are
  superseded; its Windows installer is unaffected.
- Added an explicit ad-hoc seal for the macOS app, main executable, and bundled
  FFmpeg, including a post-signing FFmpeg hash in the bundled provenance
  manifest. This validates package integrity without claiming a trusted Apple
  Developer ID or notarization.
- Added strict nested-code and sealed-resource verification plus a quarantined
  Gatekeeper regression gate. macOS packages may now fail policy only for the
  expected ad-hoc identity and missing notarization, never for structural damage.

## 0.15.0 - 2026-07-21

- Added GitHub CD for explicitly unsigned Windows x64 NSIS and macOS arm64/x64
  DMG installers, with native install/startup smoke checks, complete-set
  publication, checksums, manifests, and build provenance.
- Added a reviewed `docs/wiki` user manual and automatic GitHub Wiki sync for
  installation, SD-card loading, validation, playback, annotation, export,
  privacy, troubleshooting, and release operations.
- Added pinned Windows FFmpeg/WebView2 inputs and reproducible minimal macOS
  FFmpeg source builds; all public assets and reports carry an `UNSIGNED`
  warning until Authenticode, Developer ID, and notarization are added.
- Fixed macOS packaging at macOS 12 or later, added headless DMG construction,
  and pinned the release Rust toolchain to 1.97.1.

## 0.14.0 - 2026-07-21

- Added offline local account creation, login, and logout so every annotation
  revision records the operator who processed the episode.
- Stored passwords only as Argon2id PHC hashes with random salts, kept sessions
  process-local, and gated data commands in Rust when no account is signed in.
- Added episode-level task annotation with an editable auto-filled description,
  starting with `close_oven`, plus globally reserved codes such as `oven-001`.
- Preserved append-only annotation revisions outside the SD card, bound to the
  canonical episode path and fingerprint.
- Made annotated MCAP, HDF5, and LeRobot exports use the trajectory code as the
  base name and carry task and processor metadata, while preserving legacy names
  for unannotated recordings.

## 0.13.0 - 2026-07-21

- Added offline background reports for warning and error validation results in
  the application-local data directory; passing checks do not generate one.
- Made automatic report names stable per episode path, data fingerprint, and
  report version, with atomic publication, readback verification, and deduplication.
- Upgraded health reports to format v3 with `autoReportPath`, and kept stale
  formats outside the trusted export cache.
- Ordered check rows and issues by error, warning, then pass, and fixed state
  results so `TIMESTAMP_GAP` makes `states.jsonl` visibly report a warning.
- Renamed the check-page action from "Export JSON" to "Export report" and added
  visible local background-report status across desktop and narrow layouts.

## 0.12.0 - 2026-07-21

- Made SD-card selection automatically scan and load the first session through
  local destination selection, verified import, health checking, and playback;
  removed both manual "Import and check" controls.
- Replaced interactive all-frame JPEG decoding with deterministic per-stream
  samples at 1%, 25%, 50%, 73%, and 99%, while retaining complete structural,
  state, frame-ID, and timestamp checks.
- Kept formal stress and real release smoke validation on full JPEG decoding,
  with fixtures proving that full mode still detects damage outside the sampled
  positions.
- Upgraded health reports to format v2 with image validation mode, sampling
  percentages, and actual checked-frame counts; stale reports are rejected by
  the trusted export cache.
- Updated the checks view to distinguish total and sampled frames, including
  compact narrow-viewport table tracks and a matching browser demo.

## 0.11.0 - 2026-07-21

- Reworked the complete application chrome into a black, white, and neutral-gray
  system across navigation, session selection, controls, progress, status, and
  export feedback.
- Converted telemetry axes, grids, and markers to distinct grayscale values while
  preserving the original color of camera recordings.
- Kept warning and error states identifiable through labels, icons, borders, and
  luminance instead of relying on hue alone.
- Verified playback, checks, and export at 1440x920, 960x680, and 390x844 with
  five decoded images, no horizontal overflow, and no browser runtime errors.

## 0.10.0 - 2026-07-21

- Made the left episode list a session selector: a single click only changes
  selection, while a double click enters normal playback.
- Double-clicking an unloaded session runs the existing local import, capacity
  preflight, size/BLAKE3 verification, and health-check workflow before playback.
- Double-clicking an already loaded session returns to playback without copying
  again, and source-session selection remains highlighted after local import.
- Kept generated recordings and exports under `data/` ignored except for the
  tracked inventory document, preventing local test output from entering a release.

## 0.9.0 - 2026-07-21

- Added inclusive single-trajectory frame trimming with start/end sliders,
  numeric inputs, current-frame markers, range playback, and shared range-aware
  export controls.
- Applied the selected range in Rust across state rows and all five image
  streams, with backend boundary validation and range-aware warning/error gates.
- Recorded clip bounds in MCAP, HDF5, and LeRobot v2.1 metadata and clipped
  output names; real frames 10-19 pass all three adapter readbacks.
- Upgraded MCAP to seven topics and three schemas using official Foxglove
  `CompressedImage` and `PoseInFrame` protobuf messages while retaining JSON
  state and bounded production summary readback.
- Opened the full 196-frame sample in Foxglove Desktop 2.57.0: all five image
  panels decoded, state JSON was readable, and all seven topics were recognized
  at 196 messages each.
- Re-ran the complete 80,531,730-byte APFS development workflow in 72.726
  seconds with stable source BLAKE3; formal Windows, physical SD-card, and
  100 GB/100,000-file gates remain open.

## 0.8.0 - 2026-07-21

- Added a repeatable macOS-hosted Windows x64 MSVC all-target compile check with
  rustup toolchain consistency, LLVM resource compilation, and atomic JSON
  evidence that explicitly excludes linking, packaging, and Windows runtime.
- Added an opt-in BLAKE3 intrinsic feature for that cross-host check so the
  normal Windows release build retains BLAKE3's default optimized backend.
- Added a macOS ExFAT smoke command that creates a sparse image, stages the
  private fixture, remounts the source read-only, runs the full production
  stress workflow, and only removes marker-verified temporary data after detach.
- The read-only virtual ExFAT fixture passed all 981 files and 80,531,730 bytes
  in 75.662 seconds of stress execution with 5 ms cancellation and 27,213,824
  bytes peak RSS; all three adapters read back and source hashes remained stable.
- Kept signed Windows packaging, clean Win10/Win11 offline runtime, a physical
  ExFAT SD card, and the 100 GB/100,000-file run as explicit release gates.

## 0.7.0 - 2026-07-21

- Added a cross-platform `stress-check` CLI that drives source scan, cancellable
  import, verified local copy, full validation, all three adapter readbacks, and
  a final source-side BLAKE3 pass through the production Rust implementations.
- Made formal mode require a release build, clean exact annotated version tag, explicit
  reviewed FFmpeg, an exFAT source on a separate volume, at least 100 GB and
  100,000 files, and a conservative local-work capacity budget.
- Added an import cancellation probe that waits for a marked partial, requires
  cancellation within one second, rejects published output, and uses guarded
  partial cleanup.
- Added atomic schema-v1 stress reports with host, Git, volume, FFmpeg hash,
  threshold, validation, output, phase duration/throughput, cancellation, and
  peak-RSS evidence on macOS/Linux/Windows.
- Re-read every source file against the format-v2 import manifest after the
  workflow, with a regression test for same-size source tampering.
- The 80.5 MB APFS development fixture passed in 72.551 seconds with 1 ms
  cancellation and 27,394,048-byte peak RSS. It is deliberately recorded as
  `formal:false`; physical exFAT/100 GB and Windows gates remain open.

## 0.6.0 - 2026-07-21

- Replaced whole-stream HDF5 JPEG staging and the 512 MiB rejection ceiling
  with cancellable fixed-size 1 MiB chunk streaming.
- Pinned and vendored `hdf5-pure` 0.21.2 with a documented minimal API patch
  exposing its existing lazy chunk writer; no native HDF5 DLL was introduced.
- Added HDF5 progress during payload writes, source-size drift detection,
  failure/cancellation partial cleanup, and stronger frame-index and byte-shape
  readback checks.
- Added tests for cross-file chunks, padded final chunks, cancellation, and a
  100 GiB logical dataset without payload allocation; the 80.5 MB private
  sample still passes all three adapter readbacks in 69.65 seconds.
- Kept the physical 100 GB/100,000-file performance run as an open release gate;
  logical staging coverage is not recorded as field-test completion.

## 0.5.0 - 2026-07-21

- Added cross-platform quick, full, and debug-bundle verification profiles with
  atomic machine-readable JSON evidence reports.
- Made the default check include frontend build, Rust formatting, Clippy with
  warnings denied, and the regular Rust test suite; the full profile also runs
  both private-sample tests and a Tauri application build.
- Hardened Windows FFmpeg staging with expected SHA-256, PE x64, `mpeg4`
  encoder, nonfree-build, source, build-ID, portability-review, and license
  gates.
- Added equivalent macOS FFmpeg staging with architecture and dynamic-library
  portability inspection, plus explicit local-only non-portable debug mode.
- Added platform resource manifests so app/DMG and NSIS packages carry the
  exact staged FFmpeg binary, combined notices, and provenance metadata; normal
  bundle checks reject hash drift and non-portable dependencies.
- Added repeatable headless macOS DMG generation and read-only mount validation
  for CI environments where Finder AppleScript is unavailable.

## 0.4.0 - 2026-07-20

- Made source traversal cancellable and read-only, ignored file/directory
  symlinks, bounded sparse-frame reporting, and added macOS volume details.
- Upgraded import manifests to format v2 with original-to-Windows-safe path
  mappings, collision detection, source-change detection, and target readback
  checks that catch same-size corruption.
- Added atomic no-overwrite publication on Windows, macOS, and Linux and
  tightened Tauri dialog permissions to the two required operations.
- Added validation for negative timestamps, invalid/duplicate frame names, and
  equal-count frame-ID mismatches, with exact missing-frame totals.
- Strengthened MCAP, HDF5, and LeRobot readback checks and made FFmpeg encoding
  cancellation responsive without blocking on child-process pipes.
- Prevented stale frames and stale telemetry from representing the selected
  frame, and bounded chart rendering work for long recordings.
- Added a 512 MiB HDF5 JPEG safety ceiling until the large-data adapter can use
  a genuinely streaming writer.

## 0.3.0 - 2026-07-20

- Added trusted in-process validation records bound to source directory
  fingerprints; stale or missing validation blocks export.
- Reduced the real three-adapter debug smoke test from 276.01 seconds to 70.00
  seconds by reusing an unchanged Rust validation result.
- Added versioned JSON health report export with partial write, readback, and
  no-overwrite publication.
- Added issue-to-frame navigation and tolerant loading of valid states around
  malformed JSON lines while validation retains the blocking error.
- Added timestamp-derived playback FPS with 15/24/30/60 FPS overrides.
- Added reveal-in-file-manager for completed exports using a local-path-only
  Tauri capability.

## 0.2.0 - 2026-07-20

- Added import capacity and filesystem preflight with Windows volume detection.
- Blocked local import/export destinations inside the source recording, network
  drives, FAT/FAT32 volumes, and destinations without sufficient free space.
- Added marked partial import discovery and guarded cleanup; unmarked directories
  cannot be removed through the cleanup command.
- Re-ran full validation in the Rust export entry point so IPC cannot bypass
  error blocking, and required explicit acknowledgement for warning exports.
- Enforced one active long-running task across scan, load, validation, import,
  preflight, and export commands.

## 0.1.0 - 2026-07-20

- Established the Tauri 2, Rust, React, and TypeScript desktop application.
- Added SD/local directory scanning, verified BLAKE3 import, full JPEG and state
  validation, synchronized playback, and telemetry charts.
- Added MCAP, HDF5, and LeRobot v2.1 adapters with real-sample readback tests.
- Added Windows 10 NSIS configuration, offline WebView2 setup, and FFmpeg staging.

## 1.0.11 - 2026-09-09

- 补丁：修复乱序机标片段的人工修改和删除映射，确保删除片段从 `description.json` 的输出数组中消失。
- 补丁：继续保留 `.session_meta/session.json` 的中文 `QC` 审核结论，并递增补丁版本。
