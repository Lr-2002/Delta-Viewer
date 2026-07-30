# 安装与升级

只从固定更新镜像 [http://10.1.11.36:17879/](http://10.1.11.36:17879/) 下载安装包，用户不需要访问 GitHub。当前发布通道没有可信发布者签名，页面中的三个安装包文件名都必须显示 `UNSIGNED`。macOS app 带有用于验证包完整性的本地 ad-hoc seal，但没有 Apple Developer ID 或 notarization；Ubuntu deb 同样没有可信发行者签名。镜像没有同时列出 Windows x64、macOS arm64 和 Ubuntu deb 时不要使用临时 artifact 或本地 debug bundle。

## Windows 10/11 x64

下载 `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`，先按本页校验 SHA-256，再双击运行。Windows 会显示未知发布者，SmartScreen 也可能要求选择“更多信息”后确认运行。安装器使用当前用户模式，不要求管理员权限，并内置 WebView2 离线安装器和 reviewed FFmpeg，因此断网也能完成安装和 LeRobot 视频导出。

安装器会在 Windows 10 以下停止。Windows on ARM 当前不在支持范围内。

## macOS 12 及以上 Apple Silicon

Apple Silicon 机器下载 `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`。先校验 SHA-256，打开 DMG 后将 `DOHC Viewer.app` 拖入 `Applications`。后续版本不再提供 Intel/x64 DMG；旧 Release 中已有的 x64 资产仅作为不可变历史保留，不再维护。

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

原生 deb 可以选择当前 Linux 用户有权读取的已挂载 SD 卡目录。Ubuntu 内核原生支持 ext4，不需要 Paragon；仍应先以只读方式挂载源卡。DOHC Viewer 直接从源路径检查、回放和导出，不自动复制 session，也不会修改源卡；使用期间需保持卷挂载。当前只支持 x86_64 Ubuntu，ARM64 不在发布范围内。

项目不支持 Flatpak，也不保留 Flatpak 打包工具。Ubuntu 22.04 及以上 x86_64 deb 是唯一受支持的 Linux 发布安装包；Ubuntu 20.04 没有当前版本的二进制安装包。

## 校验下载文件

镜像页面列出每个正式安装器的 SHA-256，并提供该版本的 `SHA256SUMS.txt`。下载后必须在本机重新计算并逐字符核对。

Windows PowerShell：

```powershell
Get-FileHash .\DOHC-Viewer_0.17.11_UNSIGNED_windows-x64-setup.exe -Algorithm SHA256
```

macOS：

```bash
shasum -a 256 DOHC-Viewer_0.17.11_UNSIGNED_macos-arm64.dmg
```

Ubuntu：

```bash
sha256sum 'DOHC-Viewer_0.17.11_UNSIGNED_ubuntu-22.04+-x64.deb'
```

结果必须与镜像页面和 `SHA256SUMS.txt` 中对应文件完全一致。发布维护人员仍可在能够访问 GitHub 的机器上用 `gh attestation verify <file> --repo Lr-2002/Delta-Viewer` 验证构建 provenance。

## 升级

`0.17.11` 是自动更新引导版。`0.17.8` 及更早版本没有自动更新能力，需要先从固定镜像根页面手动下载并安装 `0.17.11` 一次。之后应用会在本地登录成功后检查镜像；发现更高版本时，先等待正在执行的扫描、检查或导出结束，再自动下载当前平台更新包、验证项目 Ed25519/Minisign 签名、安装并重启。Ubuntu 安装 deb 时可能出现系统提权确认。

镜像不可达、断网、检查失败、下载失败或签名不匹配都会保留当前版本，并在界面显示可重试提示；检查、回放、标注和导出仍可离线使用。客户端只读取 `http://10.1.11.36:17879`，不访问 GitHub，也不发送账号、源路径、标注、报告、hash 或遥测。

自动更新用的签名只验证更新包来自项目发布流程，不等同于 Windows Authenticode、Apple Developer ID 或可信 Linux 包签名；当前安装器仍明确标记为 `UNSIGNED`。镜像使用内网 HTTP，因此网络设备可能阻断检查，但任何被修改的更新包都会在安装前被签名校验拒绝。当前用户的本地账号、后台检查报告和 episode 标注保存在系统应用数据目录，正常覆盖升级不会删除这些数据。降级默认被安装器阻止，避免新格式数据被旧版本误读。
