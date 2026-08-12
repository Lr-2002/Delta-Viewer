# DOHC Viewer 用户手册

DOHC Viewer 是用于 DOHC 采集数据的离线桌面应用。它从本机可见的 SD 卡或目录发现全部采集 session，直接从源路径进行数据检查、同步回放、任务标注和格式导出，不自动创建等量本机副本。保存标注时只在当前 episode 根目录原子更新 `description.json`，其他采集文件保持只读。

固定 IP 更新镜像 [http://39.155.172.162:17879/](http://39.155.172.162:17879/) 提供以下安装产物，用户不需要访问 GitHub：

- Windows 10/11 x64 离线 NSIS 安装器。
- macOS 12 及以上 Apple Silicon DMG。
- Ubuntu 22.04 及以上 x86_64 原生 deb（首选）。

源数据流程只处理操作系统可见的已挂载目录，包括本地目录、SD 卡和网络映射盘；应用不自行连接 SSH、云存储或 NAS 协议。所有用户通过固定证书连接局域网用户中心 `10.1.11.200:17880` 登录；标注保存只上传不含源路径和内容的白名单绩效事件。自动更新只访问固定公网镜像 `39.155.172.162:17879` 与局域网地址 `10.1.11.200:17879`。源采集文件只读；保存标注需要源 episode 可写，以便更新 `description.json`。

## 从这里开始

1. 按照[安装与升级](Installation)选择与电脑架构匹配的安装包。
2. 阅读[快速开始](Quick-Start)，选择统一管理或离线模式；需要统一账号时再阅读[用户中心部署](User-Center-Deployment)。
3. 在[数据检查](Data-Validation)中理解错误、警告、通过和 JPEG 抽检范围。
4. 使用[回放与裁剪](Playback-and-Clipping)复核五路画面并选择轨迹范围。
5. 完成[账号与数据标注](Accounts-and-Annotations)后，按需要执行单条或本机标注[批量数据导出](Data-Export)。

## 支持的数据

输入 episode 固定包含五路 JPEG：`cam0`、`cam1`、`cam2`、`t265_left`、`t265_right`，以及逐行 JSON 状态文件 `states.jsonl`。当前导出格式为 MCAP、HDF5 和 LeRobot v2.1。

DOHC Viewer 不提供 ext4 驱动。Windows 和 macOS 只能直接选择操作系统已经挂载的卷；macOS 用户可按[Paragon extFS 只读教程](Paragon-extFS-macOS)使用独立的第三方商业驱动。Ubuntu 可以用 Linux 内核原生只读挂载 ext4；原生 deb 可访问当前用户有权读取的挂载目录。新卡仍推荐使用经过采集设备验证的 exFAT。现有 ext4 卡必须先在能够读取 ext4 的机器上完成备份，格式化会清空卡。

## 发布可信度

当前 Release 通道明确为 `UNSIGNED`，即没有可信发布者身份：Windows 没有 Authenticode，macOS 没有 Developer ID 或 Apple notarization，Ubuntu deb 没有可信发行者签名。macOS app 仍使用完整的本地 ad-hoc seal，并在合成 quarantine 下执行策略检查。若 GitHub runner 的 XProtect 服务不可用，只有独立构建的最小 control app 得到相同内部错误时才能把它记录为环境状态；产品独有的 XProtect 错误和任何资源封印损坏都会阻止发布。Release 只有在 Windows x64、macOS arm64 和 Ubuntu deb 全部完成依赖校验、安装或挂载、启动 smoke 和 SHA-256 汇总后才会公开。每个 Release 同时附带 `SHA256SUMS.txt`、`release-manifest.json` 和 GitHub build provenance。

这些自动检查不能替代真实 SD 卡、干净 Win10/Win11 断网机器和目标 Mac 的现场验收；对应限制会保留在发布说明中。
