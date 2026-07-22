# 安装与升级

只从项目的 [GitHub Releases](https://github.com/Lr-2002/Delta-Viewer/releases) 下载安装包。当前发布通道没有可信发布者签名，Release 标题、说明和五个安装包文件名都必须显示 `UNSIGNED`。macOS app 带有用于验证包完整性的本地 ad-hoc seal，但没有 Apple Developer ID 或 notarization；Ubuntu deb 和 Flatpak 同样没有可信发行者签名。Release 页面没有完整的 Windows、两种 macOS 架构、Ubuntu deb 和 Ubuntu Flatpak 时，不应使用 Actions 临时 artifact 或本地 debug bundle。

## Windows 10/11 x64

下载 `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`，先按本页校验 SHA-256，再双击运行。Windows 会显示未知发布者，SmartScreen 也可能要求选择“更多信息”后确认运行。安装器使用当前用户模式，不要求管理员权限，并内置 WebView2 离线安装器和 reviewed FFmpeg，因此断网也能完成安装和 LeRobot 视频导出。

安装器会在 Windows 10 以下停止。Windows on ARM 当前不在支持范围内。

## macOS 12 及以上

Apple Silicon 机器下载 `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`；Intel 机器下载 `DOHC-Viewer_<version>_UNSIGNED_macos-x64.dmg`。先校验 SHA-256，打开 DMG 后将 `DOHC Viewer.app` 拖入 `Applications`。

可在“关于本机”查看芯片类型。当前 app 已通过完整的 ad-hoc 资源封印校验，但 DMG 没有 Developer ID 和 Apple notarization，因此首次启动仍会被 Gatekeeper 阻止。核对来源和 hash 后，先在“应用程序”中尝试打开一次；随后进入“系统设置 -> 隐私与安全性”，在 DOHC Viewer 提示旁选择“仍要打开”，完成系统认证后再次确认“打开”。这是每个版本的一次性授权。不要关闭 Gatekeeper，也不要运行移除 quarantine 的命令。

`0.15.0` 的 macOS 包存在无效资源封印，可能被系统提示“已损坏”，已由 `0.15.2` 取代。`0.15.1` tag 在 CI 阶段被阻止，没有公开 Release。macOS 用户不得继续使用 `0.15.0` DMG；请下载 `0.15.2` 或更高版本。Windows `0.15.0` 安装器不受此问题影响。

DOHC Viewer 本身不提供 ext4 驱动。需要读取现有 ext4 采集卡时，先按[macOS 使用 Paragon extFS 只读访问 ext4 SD 卡](Paragon-extFS-macOS)安装第三方驱动并确认卷为只读，再从 Viewer 选择系统已经挂载的卡根目录。不得把源卡挂载为可写。

## Ubuntu 22.04 及以上 x86_64

优先下载 `DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb`。校验 SHA-256 后，在下载目录执行：

```bash
sudo apt update
sudo apt install ./DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb
```

必须保留命令中的 `./`，这样 `apt` 会把参数识别为本地安装包并自动补齐 WebKitGTK、GTK、AppIndicator 和 librsvg 运行时依赖。安装后从应用菜单打开 **DOHC Viewer**，也可以在终端运行 `dohc-viewer`。升级时对新版本 deb 重复同一条 `sudo apt install ./...deb` 命令。

原生 deb 不受 Flatpak 路径沙箱限制，可以选择当前 Linux 用户有权读取的已挂载 SD 卡目录。Ubuntu 内核原生支持 ext4，不需要 Paragon；仍应先以只读方式挂载源卡，DOHC Viewer 会把 session 复制到当前用户的 app-local-data 后再检查，不会直接修改源卡。

## Ubuntu 20.04 及以上 x86_64 Flatpak 兼容包

Ubuntu 20.04 或需要沙箱安装的用户下载 `DOHC-Viewer_<version>_UNSIGNED_ubuntu-x64.flatpak`。首次安装 Flatpak 和 Flathub remote：

```bash
sudo apt update
sudo apt install flatpak
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./DOHC-Viewer_<version>_UNSIGNED_ubuntu-x64.flatpak
flatpak run com.dohc.viewer
```

Flatpak 只预授权 `/media`、`/run/media` 和 `/mnt` 三类常见可移动介质路径，不请求网络权限；若卡挂载在其他位置，请改挂载到上述目录之一。源卡仍应只读挂载，应用仍会把 session 复制到 Flatpak 的用户 local-data 后再检查。

当前只支持 x86_64 Ubuntu，ARM64 不在发布范围内。GNOME 50 runtime 由 Flatpak 从 Flathub 管理，不要求主机自带 WebKitGTK 4.1。

## 校验下载文件

同一 Release 中的 `SHA256SUMS.txt` 记录五个安装器和 `release-manifest.json` 的 SHA-256。

Windows PowerShell：

```powershell
Get-FileHash .\DOHC-Viewer_0.17.0_UNSIGNED_windows-x64-setup.exe -Algorithm SHA256
```

macOS：

```bash
shasum -a 256 DOHC-Viewer_0.17.0_UNSIGNED_macos-arm64.dmg
```

Ubuntu：

```bash
sha256sum 'DOHC-Viewer_0.17.0_UNSIGNED_ubuntu-22.04+-x64.deb'
```

结果必须与 `SHA256SUMS.txt` 中对应文件完全一致。GitHub CLI 用户还可以用 `gh attestation verify <file> --repo Lr-2002/Delta-Viewer` 验证构建 provenance。

## 升级

退出正在运行的 DOHC Viewer 后安装新版本。当前用户的本地账号、后台检查报告和 episode 标注保存在系统应用数据目录，正常覆盖升级不会删除这些数据。降级默认被安装器阻止，避免新格式数据被旧版本误读。
