# macOS 使用 Paragon extFS 只读访问 ext4 SD 卡

DOHC Viewer 不包含 ext4 驱动，但可以读取 macOS 已经挂载的普通目录。Paragon extFS for Mac 是第三方商业文件系统驱动；安装后可把 ext2、ext3 或 ext4 卷挂载到 Finder，再由 DOHC Viewer 从只读路径直接检查、回放和导出。

本教程只允许把采集卡挂载为只读。Paragon 支持写入 ext4，但 DOHC 工作流不使用该能力。Paragon 的购买、试用、激活、系统扩展和技术支持独立于 DOHC Viewer；核心 Viewer 数据流程仍然不会上传图像、状态、路径或 hash。

> 重要：Paragon 是具备完整写入能力的驱动，不能假设一张新卡第一次连接时会默认只读。没有物理写保护或硬件写保护器时，不要把唯一一份原始采集卡直接连接到已经启用 Paragon 的 Mac。

## 1. 开始前

准备以下条件：

- 使用 `0.15.2` 或更高版本的 DOHC Viewer。
- Mac 当前账号具有管理员权限，并预留至少两次重启时间。
- 用于导出的 APFS 卷有足够空间容纳所选输出；正常界面不会再为完整 session 自动创建 app-local-data 副本。
- 如果 SD 卡或全尺寸 SD 转接卡带有写保护开关，先拨到锁定位置。部分 USB 读卡器可能忽略该开关；不可替代的数据应使用硬件写保护器。
- 安装和重启完成前不要插入唯一一份原始采集卡。若已有其他机器能读取该卡，先完成备份和 hash 核对。

不要为了让 macOS 识别卡片而在“磁盘工具”中选择“初始化”“抹掉”或“分区”。这些操作会破坏现有数据。

## 2. 下载并安装 Paragon extFS

1. 只从 [Paragon extFS for Mac 官方页面](https://www.paragon-software.com/home/extfs-mac/)下载当前安装包。不要使用第三方下载站或来历不明的旧版本。
2. 打开下载的 DMG，运行其中的 Paragon extFS 安装程序。
3. 阅读并接受 Paragon 的许可协议，按安装器提示输入 macOS 管理员密码。
4. 安装完成后，如果系统提示来自 `Paragon Software GmbH` 的系统扩展被阻止，先让安装程序结束，再进入“系统设置 -> 隐私与安全性”，选择允许 Paragon 扩展。
5. 按安装器要求重启 Mac。没有完成授权和重启时，不要开始读取正式采集卡。
6. 打开 Paragon extFS，使用已购买的许可证激活，或开始官方提供的限时试用。生产流程不应长期依赖会过期的试用状态。

界面名称会随 Paragon 和 macOS 版本略有变化，应以当前官方安装器显示的发布者、组件和操作步骤为准。

### Apple Silicon 可能要求的额外步骤

只有 Paragon 安装器明确要求启用第三方内核扩展时，才执行下面的操作：

1. 关闭 Mac。
2. 按住电源键进入启动选项，选择“选项 -> 继续”。
3. 在恢复环境菜单中打开“实用工具 -> 启动安全性实用工具”。
4. 选择当前 macOS 系统盘，进入“安全策略”。
5. 选择“降低安全性”，只勾选“允许用户管理来自被认可开发者的内核扩展”。不要选择“宽松安全性”，不要关闭 SIP 或 Gatekeeper。
6. 重启回到 macOS，在“系统设置 -> 隐私与安全性”中允许 `Paragon Software GmbH`，再按提示重启。

如果安装器要求给 Paragon 文件系统组件“完全磁盘访问权限”，只允许安装器明确列出的 Paragon 组件。不要给未知程序授予该权限。

## 3. 把采集卡配置为只读

以下设置是 DOHC 工作流的强制要求：

1. 确认 SD 卡的物理写保护已经开启，然后连接读卡器。
2. 从“应用程序”或菜单栏打开 `Paragon extFS for Mac`。
3. 在左侧卷列表中按容量、设备类型和卷名确认采集卡。不要选择 Mac 内置系统盘或本地工作盘。
4. 如果界面显示该卷已经挂载，先点击 `Unmount`，等待 Finder 中的卷消失。
5. 取消 `Enable Spotlight indexing`，避免系统对采集卡做不必要的索引扫描。
6. 勾选 `Mount in Read-only mode`。
7. 建议同时勾选 `Do not mount automatically`。这样以后插卡后需要在 Paragon 中手动挂载，能够在读取前再次确认只读状态。
8. 点击 `Mount`，等待卷出现在 Finder 的“位置”或 `/Volumes` 下。
9. 确认 Paragon 的卷列表显示 `read-only`。没有该标记时不要打开 DOHC Viewer。

可以在终端做附加检查，其中 `CARD_NAME` 替换为 Finder 显示的卷名：

```bash
diskutil info "/Volumes/CARD_NAME" | grep -E "Device Node|File System Personality|Read-Only Volume"
```

`Read-Only Volume` 必须为 `Yes`。如果 Paragon 界面和 `diskutil` 结果不一致，立即卸载该卷并停止操作。不要通过创建测试文件来验证只读状态。

## 4. 在 DOHC Viewer 中只读打开

1. 先在 Finder 中打开只读卷，确认能看到 session 目录和预期的 `cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`、`states.jsonl` 数据。
2. 启动 DOHC Viewer，选择统一管理模式后导入管理员提供的用户中心配置并登录账号；也可以选择离线模式直接继续，不需要账号或用户中心。
3. 点击“选择 SD 卡”，通过系统目录选择框选择 `/Volumes/CARD_NAME` 对应的卡根目录。
4. 选择完成后 DOHC Viewer 会扫描全部 session，并直接从只读源路径加载第一条记录；不会要求选择导入目标，也不会自动复制完整 session。不要为了标注把唯一原始卡改成可写。
5. 等待结构/状态检查和固定百分位 JPEG 抽检完成。任务结束前保持读卡器连接稳定。
6. 后续检查、回放和导出仍从源卡读取，因此应用使用期间必须保持卷挂载。严格只读模式下不能保存标注，因为保存操作必须在 episode 根目录更新 `description.json`；检查报告仍只写应用 local-data。需要标注时应使用经过授权的可写工作介质，不要解除唯一原始卡的只读保护。

如果目录选择框没有显示该卷，先确认 Finder 能打开它。然后进入“系统设置 -> 隐私与安全性 -> 文件与文件夹”，如果存在 DOHC Viewer 的“可移动宗卷”开关，将其打开，再通过应用内的原生目录选择框重新选择。

## 5. 安全卸载 SD 卡

1. 等待 DOHC Viewer 的读取、检查或导出任务完全结束。
2. 退出 DOHC Viewer，或确认应用不再读取源路径。
3. 在 Finder 中弹出该卷，或在 Paragon 中点击 `Unmount`。
4. 等待卷从 Finder 和 Paragon 的已挂载状态中消失，再拔出读卡器。

不要对原始采集卡使用 Paragon 中的 `Verify`、`Repair`、`Erase`、格式化或写入功能。发现文件系统异常时，先制作块级副本，再由数据恢复人员在副本上处理。

## 6. 每次插卡检查表

- 物理写保护已开启。
- Paragon 显示正确的外置 SD 卷。
- Spotlight indexing 已关闭。
- `Mount in Read-only mode` 已开启。
- Paragon 显示 `read-only`，附加检查中的 `Read-Only Volume` 为 `Yes`。
- DOHC Viewer 正常界面直接只读访问源卡，不自动创建 app-local-data 数据副本；本次只读流程不执行需要写 `description.json` 的标注保存。
- 拔卡前已完成任务并正常卸载。

## 7. 常见问题

### Paragon 或 Finder 看不到卡

打开“磁盘工具”，选择“显示 -> 显示所有设备”，只检查物理设备是否出现，不执行初始化或修复。随后确认 Paragon 已启用、许可证或试用仍有效、系统扩展已在“隐私与安全性”中允许，并完成安装器要求的重启。

如果 Paragon 仍不能挂载，换读卡器和 USB 端口，并在 Linux 机器上以只读方式检查。不要在唯一原始卡上运行 `fsck`。Paragon 官方列出的部分 ext4 feature 可能导致无法挂载或被强制为只读，例如 `bigalloc`、`meta_bg`、`quota` 和 `project`；需要向 Paragon 支持提供诊断信息时，不要把 DOHC 原始图像或账号密码上传到公开工单。

### 卡被挂载为可写

不要启动 DOHC Viewer。立即在 Paragon 中卸载该卷，开启物理写保护，重新勾选 `Mount in Read-only mode` 后再挂载。如果仍显示可写，停止使用该读卡器或驱动配置。

### Viewer 报告 Permission denied

先确认 Finder 能打开卷，然后通过 Viewer 的原生“选择 SD 卡”对话框重新选择卡根目录。检查 macOS 的“文件与文件夹 -> 可移动宗卷”权限。不要通过修改 ext4 文件权限、执行 `chmod` 或把驱动改成可写来绕过问题。

### 如何卸载 Paragon extFS

打开 Paragon extFS，在 macOS 菜单栏选择 `Paragon extFS for Mac -> Preferences -> Uninstall`，完成后重启。不要直接删除应用图标，因为文件系统驱动和辅助组件仍可能保留。

## 8. 官方资料

- [Paragon extFS for Mac 产品页](https://www.paragon-software.com/home/extfs-mac/)
- [Paragon：System Extension Blocked During Installation](https://kb.paragon-software.com/article/5305)
- [Paragon：ExtFS for Mac FAQ](https://kb.paragon-software.com/article/6289)
- [Paragon：卸载 NTFS/extFS for Mac](https://kb.paragon-software.com/article/4500)
- [Apple：Apple Silicon 启动安全策略](https://support.apple.com/guide/security/sec7d92dc49f/web)
