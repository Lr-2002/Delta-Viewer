# 安装与升级

只从项目的 [GitHub Releases](https://github.com/Lr-2002/Delta-Viewer/releases) 下载安装包。当前发布通道没有可信发布者签名，Release 标题、说明和三个文件名都必须显示 `UNSIGNED`。macOS app 带有用于验证包完整性的本地 ad-hoc seal，但没有 Apple Developer ID 或 notarization。Release 页面没有完整的三平台产物时，不应使用 Actions 临时 artifact 或本地 debug bundle。

## Windows 10/11 x64

下载 `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`，先按本页校验 SHA-256，再双击运行。Windows 会显示未知发布者，SmartScreen 也可能要求选择“更多信息”后确认运行。安装器使用当前用户模式，不要求管理员权限，并内置 WebView2 离线安装器和 reviewed FFmpeg，因此断网也能完成安装和 LeRobot 视频导出。

安装器会在 Windows 10 以下停止。Windows on ARM 当前不在支持范围内。

## macOS 12 及以上

Apple Silicon 机器下载 `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`；Intel 机器下载 `DOHC-Viewer_<version>_UNSIGNED_macos-x64.dmg`。先校验 SHA-256，打开 DMG 后将 `DOHC Viewer.app` 拖入 `Applications`。

可在“关于本机”查看芯片类型。当前 app 已通过完整的 ad-hoc 资源封印校验，但 DMG 没有 Developer ID 和 Apple notarization，因此首次启动仍会被 Gatekeeper 阻止。核对来源和 hash 后，先在“应用程序”中尝试打开一次；随后进入“系统设置 -> 隐私与安全性”，在 DOHC Viewer 提示旁选择“仍要打开”，完成系统认证后再次确认“打开”。这是每个版本的一次性授权。不要关闭 Gatekeeper，也不要运行移除 quarantine 的命令。

`0.15.0` 的 macOS 包存在无效资源封印，可能被系统提示“已损坏”，已由 `0.15.2` 取代。`0.15.1` tag 在 CI 阶段被阻止，没有公开 Release。macOS 用户不得继续使用 `0.15.0` DMG；请下载 `0.15.2` 或更高版本。Windows `0.15.0` 安装器不受此问题影响。

DOHC Viewer 本身不提供 ext4 驱动。需要读取现有 ext4 采集卡时，先按[macOS 使用 Paragon extFS 只读访问 ext4 SD 卡](Paragon-extFS-macOS)安装第三方驱动并确认卷为只读，再从 Viewer 选择系统已经挂载的卡根目录。不得把源卡挂载为可写。

## 校验下载文件

同一 Release 中的 `SHA256SUMS.txt` 记录三个安装器和 `release-manifest.json` 的 SHA-256。

Windows PowerShell：

```powershell
Get-FileHash .\DOHC-Viewer_0.15.2_UNSIGNED_windows-x64-setup.exe -Algorithm SHA256
```

macOS：

```bash
shasum -a 256 DOHC-Viewer_0.15.2_UNSIGNED_macos-arm64.dmg
```

结果必须与 `SHA256SUMS.txt` 中对应文件完全一致。GitHub CLI 用户还可以用 `gh attestation verify <file> --repo Lr-2002/Delta-Viewer` 验证构建 provenance。

## 升级

退出正在运行的 DOHC Viewer 后安装新版本。当前用户的本地账号、后台检查报告和 episode 标注保存在系统应用数据目录，正常覆盖升级不会删除这些数据。降级默认被安装器阻止，避免新格式数据被旧版本误读。
