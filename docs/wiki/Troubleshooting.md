# 故障排查

## 选择不到 SD 卡

先确认操作系统文件管理器能够看到卷和 episode 文件。DOHC Viewer 不包含 ext4 驱动；ext4 卡在标准 Windows/macOS 上不能直接选择。macOS 用户可按[Paragon extFS 只读教程](Paragon-extFS-macOS)挂载，必须确认 `Mount in Read-only mode` 和只读卷状态。Ubuntu 原生 deb 可选择当前用户有权读取的只读挂载目录；Flatpak 用户应把卡挂载在 `/media`、`/run/media` 或 `/mnt` 下，其他路径不在 Flatpak 权限内。不要为了读取数据直接格式化仍含数据的卡。

## 选择目录后没有继续

扫描完成后不会再打开本地目标目录选择框。应用会在当前用户的 app-local-data/imports 下自动创建工作区并导入全部 session。若某条记录失败，双击左侧失败项可重试，并在顶栏打开“操作错误历史”。

## 导入失败或空间不足

应用在复制前检查系统工作区所在卷的容量。工作区至少需要容纳完整本地副本；导出还需要额外空间。FAT/FAT32 不适合作为大文件导出卷。

## 出现 operation not allowed / Operation not permitted

应用会把原始消息保存到操作错误历史，并归类为 `PERMISSION_DENIED`。macOS 先确认 Finder 能打开该卷，再在“系统设置 -> 隐私与安全性 -> 文件与文件夹”允许 DOHC Viewer 访问可移动宗卷；Windows 则确认当前用户对卡和 app-local-data 工作区有读取/写入权限；Ubuntu 原生 deb 用户确认当前账号能读取挂载目录，Flatpak 用户还要确认卡位于已授权的 `/media`、`/run/media` 或 `/mnt`。不要通过 `chmod`、关闭系统保护或把源卡改成可写来绕过问题。

如果上次取消留下 partial，应用只会清理带自身 marker、能够证明由 DOHC Viewer 创建的目录；不会删除普通用户目录。

## 数据检查出现警告

警告不等于文件损坏。常见原因包括缺帧、图像/状态数量不同、状态帧号跳变或时间间隔超过基准中位数三倍。先在回放中定位相关帧，再决定是否确认并导出。

## Foxglove 打开 MCAP 显示 Permission denied

macOS 可能使 Foxglove 保存的最近文件权限句柄失效。不要修改 MCAP；在 Foxglove 中使用 **Open local file(s)** 重新选择该文件。

## LeRobot 提示找不到 FFmpeg

GitHub Release 已内置并校验 FFmpeg。出现该错误时先确认安装来自 GitHub Release 且 hash 匹配；不要把本地 debug app 当作发布包。问题报告中附上应用版本、平台、导出错误摘要和 Release 文件 hash，不要附原始图像或账号密码。

## 忘记本地账号密码

当前没有远程找回。账号只存在本机，维护人员应在保留标注审计记录的前提下处理应用 local-data；不要直接编辑账号 JSON 或替换密码哈希。

## macOS 提示应用已损坏或无法验证

`0.15.0` 的 macOS DMG 存在无效 app 资源封印，会触发“已损坏”，不能通过安全设置绕过。请删除该 DMG 和 app，安装 `0.15.2` 或更高版本；`0.15.1` 没有公开 Release，Windows `0.15.0` 不受影响。

`0.15.2` 及更高版本没有 Developer ID 或 Apple notarization，因此首次启动出现“Apple 无法验证”或“无法确认开发者”属于预期策略阻止。先确认下载自本仓库、芯片架构正确并核对 `SHA256SUMS.txt`，再按[安装与升级](Installation)使用“系统设置 -> 隐私与安全性 -> 仍要打开”完成一次性授权。不要关闭 Gatekeeper，也不要运行移除 quarantine 的命令。

若 `0.15.2` 或更高版本仍显示“已损坏”，不要绕过。hash 不符时删除文件并重新下载；hash 相同时在 GitHub Issue 中附上版本、macOS 版本、芯片架构和 DMG hash，不要附原始采集数据或密码。
