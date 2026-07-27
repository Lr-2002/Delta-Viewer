# 数据安全与隐私

DOHC Viewer 的核心数据工作流完全离线：

- 不支持 SSH、HTTP、NAS、云存储或远程上传数据源。
- 不收集遥测，不上传路径、图像、状态、账号、标注或 hash。
- 源 SD 卡只读；正常界面直接读取源路径，不在 app-local-data 自动复制 episode。导出只写用户选择的导出目录。
- 独立 formal/development stress 仍保留完整导入、目标端大小和 BLAKE3 回读，用于验证导入器和大容量数据链路；这不是正常用户流程。
- 正式输出使用 partial 加同文件系统原子发布，不覆盖已有结果。

## 为什么不再自动复制

自动复制大容量 session 会额外占用接近源数据大小的磁盘空间，重复选择记录时尤其浪费。正常流程因此改为直接从已挂载源目录只读检查、回放和导出，不创建等量副本。代价是使用期间必须保持 SD 卡连接，拔卡、卸载或读卡器中断会使当前操作失败；源介质的随机读取速度也会直接影响回放和导出速度。

本机标注批量导出遵循同一原则。标注目录只保存任务、轨迹码、处理人、源路径和指纹；批量操作不会提前复制或缓存 JPEG/状态数据，而是在开始每条导出时重新读取并核对原始源。因此它不会额外占用一份源数据大小的 app-local-data 空间，但源卷必须在线且内容不能变化。

旧版本可能已在 `app-local-data/imports` 留下导入副本。应用不会自动删除这些历史数据，避免误删用户仍需保留的文件；确认不再需要后，用户可以在应用完全退出时按操作系统的数据位置手工归档或清理。

GitHub Release 的构建过程需要网络下载编译依赖、reviewed FFmpeg 和 WebView2；当前 unsigned channel 不访问外部签名服务。macOS 构建机只在本地生成不含身份的 ad-hoc seal。应用本身不请求 network 权限。这不改变安装后应用运行时的离线边界。

## 文件系统

Windows 和 macOS 不能直接读取普通 ext4 SD 卡。macOS 使用第三方驱动时必须按[Paragon extFS 只读教程](Paragon-extFS-macOS)关闭 Spotlight indexing 并确认卷为只读；第三方驱动的安装、激活和网络行为不属于 DOHC Viewer。Ubuntu 可用 Linux 内核原生只读挂载 ext4；原生 deb 可访问当前用户有权限的挂载目录。exFAT 可以改善跨平台挂载，但格式化会清空现有数据，而且 exFAT 不带日志。切换前必须完成备份、hash 校验、长时写入、接近满盘、断电和重新插拔测试。

导出目标卷应使用 NTFS、APFS、exFAT 或其他支持大文件的本机文件系统。FAT32 有 4 GB 单文件限制，不作为受支持的导出目标。

## 本地数据位置

Windows 的账号、自定义任务、轨迹占号、标注、后台报告和操作错误历史位于当前用户的 Tauri app-local-data；macOS 位于 `~/Library/Application Support/com.dohc.viewer/`；Ubuntu 原生 deb 通常位于 `~/.local/share/com.dohc.viewer/`。正常界面不会在这里新增 episode 数据副本。旧版本可能仍留有 `imports` 目录；卸载应用不会默认删除这些本地数据，删除前应先确认内容并完成必要归档。
