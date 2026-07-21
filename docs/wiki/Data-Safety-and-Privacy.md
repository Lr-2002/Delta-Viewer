# 数据安全与隐私

DOHC Viewer 的核心数据工作流完全离线：

- 不支持 SSH、HTTP、NAS、云存储或远程上传数据源。
- 不收集遥测，不上传路径、图像、状态、账号、标注或 hash。
- 源 SD 卡只读；写入只发生在用户选择的本地目标、导出目录或应用 local-data。
- 导入后逐文件回读目标端大小和 BLAKE3，不只信任源端读取。
- 正式输出使用 partial 加同文件系统原子发布，不覆盖已有结果。

GitHub Release 的构建过程需要网络下载编译依赖、reviewed FFmpeg 和 WebView2；当前 unsigned channel 不访问外部签名服务。macOS 构建机只在本地生成不含身份的 ad-hoc seal。这不改变安装后应用运行时的离线边界。

## 文件系统

Windows 和 macOS 不能直接读取普通 ext4 SD 卡。exFAT 可以改善跨平台挂载，但格式化会清空现有数据，而且 exFAT 不带日志。切换前必须完成备份、hash 校验、长时写入、接近满盘、断电和重新插拔测试。

本地目标推荐 NTFS 或 APFS。FAT32 有 4 GB 单文件限制，不作为受支持的导出目标。

## 本地数据位置

Windows 的账号、标注和后台报告位于当前用户的 Tauri app-local-data；macOS 位于 `~/Library/Application Support/com.dohc.viewer/`。卸载应用不会默认删除这些审计数据，删除前应先完成归档。
