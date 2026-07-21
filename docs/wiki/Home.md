# DOHC Viewer 用户手册

DOHC Viewer 是用于 DOHC 采集数据的离线桌面应用。它从本机可见的 SD 卡或目录读取一次采集 session，先复制到本地并校验，再进行数据检查、同步回放、任务标注和格式导出。

GitHub Release 提供以下安装产物：

- Windows 10/11 x64 离线 NSIS 安装器。
- macOS 12 及以上 Apple Silicon DMG。
- macOS 12 及以上 Intel DMG。

核心流程不需要网络，不会上传账号、路径、图像、状态、标注或 hash。源 SD 卡始终作为只读数据源。

## 从这里开始

1. 按照[安装与升级](Installation)选择与电脑架构匹配的安装包。
2. 阅读[快速开始](Quick-Start)，完成账号登录、SD 卡选择和自动导入。
3. 在[数据检查](Data-Validation)中理解错误、警告、通过和 JPEG 抽检范围。
4. 使用[回放与裁剪](Playback-and-Clipping)复核五路画面并选择轨迹范围。
5. 完成[账号与数据标注](Accounts-and-Annotations)后，按需要执行[数据导出](Data-Export)。

## 支持的数据

输入 episode 固定包含五路 JPEG：`cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`，以及逐行 JSON 状态文件 `states.jsonl`。当前导出格式为 MCAP、HDF5 和 LeRobot v2.1。

DOHC Viewer 不提供 ext4 驱动。Windows 和 macOS 只能直接选择操作系统已经挂载的卷；新卡推荐使用经过采集设备验证的 exFAT。现有 ext4 卡必须先在能够读取 ext4 的机器上完成备份，格式化会清空卡。

## 发布可信度

当前 Release 通道明确为 `UNSIGNED`，不宣称 Authenticode、Developer ID、Gatekeeper 或 Apple notarization 已完成。Release 只有在 Windows 与两种 macOS 架构全部完成依赖校验、安装或挂载、直接启动 smoke 和 SHA-256 汇总后才会公开。每个 Release 同时附带 `SHA256SUMS.txt`、`release-manifest.json` 和 GitHub build provenance。

这些自动检查不能替代真实 SD 卡、干净 Win10/Win11 断网机器和目标 Mac 的现场验收；对应限制会保留在发布说明中。
