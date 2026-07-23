# 数据安全与隐私

DOHC Viewer 的核心数据工作流完全离线：

- 不支持 SSH、HTTP、NAS、云存储或远程上传数据源。
- 不收集遥测，不上传路径、图像、状态、账号、标注或 hash。
- 源 SD 卡只读；导入写入只发生在应用自动管理的 app-local-data/imports 工作区，导出写入发生在用户选择的导出目录。
- 导入后逐文件回读目标端大小和 BLAKE3，不只信任源端读取。
- 正式输出使用 partial 加同文件系统原子发布，不覆盖已有结果。

## 为什么先复制到本机

直接从 SD 卡回放在技术上可行，但会让拔卡、挂载中断、可移动介质随机读取性能和后续工具误写风险贯穿检查、标注与导出。DOHC Viewer 因此把“直接读取”限制在一次受控导入：先把全部 session 复制到本机工作区，再从目标端重新读取大小和 BLAKE3。之后的回放、标注和导出都使用稳定的本地副本，源卡保持只读并可安全移除。

GitHub Release 的构建过程需要网络下载编译依赖、reviewed FFmpeg 和 WebView2；当前 unsigned channel 不访问外部签名服务。macOS 构建机只在本地生成不含身份的 ad-hoc seal。应用本身不请求 network 权限。这不改变安装后应用运行时的离线边界。

## 文件系统

Windows 和 macOS 不能直接读取普通 ext4 SD 卡。macOS 使用第三方驱动时必须按[Paragon extFS 只读教程](Paragon-extFS-macOS)关闭 Spotlight indexing 并确认卷为只读；第三方驱动的安装、激活和网络行为不属于 DOHC Viewer。Ubuntu 可用 Linux 内核原生只读挂载 ext4；原生 deb 可访问当前用户有权限的挂载目录。exFAT 可以改善跨平台挂载，但格式化会清空现有数据，而且 exFAT 不带日志。切换前必须完成备份、hash 校验、长时写入、接近满盘、断电和重新插拔测试。

应用工作区所在卷应为 NTFS 或 APFS。FAT32 有 4 GB 单文件限制，不作为受支持的导出目标。

## 本地数据位置

Windows 的账号、标注、导入副本、后台报告和操作错误历史位于当前用户的 Tauri app-local-data；macOS 位于 `~/Library/Application Support/com.dohc.viewer/`；Ubuntu 原生 deb 通常位于 `~/.local/share/com.dohc.viewer/`。卸载应用不会默认删除这些审计数据，删除前应先完成归档。
