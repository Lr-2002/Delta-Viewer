# 安装与升级

## 工作模式与局域网用户中心

应用首次启动时要求进入登录模式。客户端导入管理员提供的 `DOHC-User-Center-Client.json` 后，可登录或点击“注册审核员账号”。服务主机执行 `pnpm user-center:install` 完成一键安装和 LaunchAgent 部署；详细步骤见[用户中心部署](User-Center-Deployment)。

1.0.32 起产品名称为 Delta Viewer，已有账号配置、审核草稿和进度继续保留。Windows 升级继续使用旧安装目录，桌面和开始菜单显示新名称；Linux 安装新 deb 时替换旧包。内部应用标识及 `dohc-viewer` 命令保持兼容。历史 Release 的旧名称资产保持原样。

从 [Delta Viewer 官方 GitHub 最新 Release](https://github.com/Lr-2002/Delta-Viewer/releases/latest) 下载当前平台安装包。公开 Release 必须同时包含 Windows x64、macOS arm64 和 Ubuntu x64 deb。当前安装器仍明确标为 `UNSIGNED`；更新包另有项目 Minisign 完整性签名，不能将其视为 Authenticode、Developer ID 或 notarization。

## Windows 10/11 x64

下载 `Delta-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`，先按本页校验 SHA-256，再双击运行。Windows 会显示未知发布者，SmartScreen 也可能要求选择“更多信息”后确认运行。安装器使用当前用户模式，不要求管理员权限，并内置 WebView2 离线安装器和 reviewed FFmpeg，因此断网也能完成安装和 LeRobot 视频导出。

安装器会在 Windows 10 以下停止。Windows on ARM 当前不在支持范围内。

## macOS 12 及以上 Apple Silicon

Apple Silicon 机器下载 `Delta-Viewer_<version>_UNSIGNED_macos-arm64.dmg`。先校验 SHA-256，打开 DMG 后将 `Delta Viewer.app` 拖入 `Applications`。后续版本不再提供 Intel/x64 DMG；旧 Release 中已有的 x64 资产仅作为不可变历史保留，不再维护。

可在“关于本机”查看芯片类型。当前 app 已通过完整的 ad-hoc 资源封印校验，但 DMG 没有 Developer ID 和 Apple notarization，因此首次启动仍会被 Gatekeeper 阻止。核对来源和 hash 后，先在“应用程序”中尝试打开一次；随后进入“系统设置 -> 隐私与安全性”，在 Delta Viewer 提示旁选择“仍要打开”，完成系统认证后再次确认“打开”。这是每个版本的一次性授权。不要关闭 Gatekeeper，也不要运行移除 quarantine 的命令。

`0.15.0` 的 macOS 包存在无效资源封印，可能被系统提示“已损坏”，已由 `0.15.2` 取代。`0.15.1` tag 在 CI 阶段被阻止，没有公开 Release。macOS 用户不得继续使用 `0.15.0` DMG；请下载 `0.15.2` 或更高版本。Windows `0.15.0` 安装器不受此问题影响。

Delta Viewer 本身不提供 ext4 驱动。需要读取现有 ext4 采集卡时，先按[macOS 使用 Paragon extFS 只读访问 ext4 SD 卡](Paragon-extFS-macOS)安装第三方驱动并确认卷为只读，再从 Viewer 选择系统已经挂载的卡根目录。只读挂载可检查、回放和导出，但不能保存需要写入 `description.json` 的标注；不得为了标注解除唯一原始卡的只读保护。

## Ubuntu 22.04 及以上 x86_64

优先下载 `Delta-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb`。校验 SHA-256 后，在下载目录执行：

```bash
sudo apt update
sudo apt install ./Delta-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb
```

必须保留命令中的 `./`，这样 `apt` 会把参数识别为本地安装包并自动补齐 WebKitGTK、GTK、AppIndicator 和 librsvg 运行时依赖。安装后从应用菜单打开 **Delta Viewer**，也可以在终端运行 `dohc-viewer`。升级时对新版本 deb 重复同一条 `sudo apt install ./...deb` 命令。

原生 deb 可以选择当前 Linux 用户有权读取的已挂载 SD 卡目录。Ubuntu 内核原生支持 ext4，不需要 Paragon；只读挂载可检查、回放和导出。Delta Viewer 不自动复制 session，也不会修改采集文件；保存标注需要可写 episode，以便原子更新 `description.json`。使用期间需保持卷挂载。当前只支持 x86_64 Ubuntu，ARM64 不在发布范围内。

项目不支持 Flatpak，也不保留 Flatpak 打包工具。Ubuntu 22.04 及以上 x86_64 deb 是唯一受支持的 Linux 发布安装包；Ubuntu 20.04 没有当前版本的二进制安装包。

## 校验下载文件

镜像页面列出每个正式安装器的 SHA-256，并提供该版本的 `SHA256SUMS.txt`。下载后必须在本机重新计算并逐字符核对。

Windows PowerShell：

```powershell
Get-FileHash .\Delta-Viewer_1.0.32_UNSIGNED_windows-x64-setup.exe -Algorithm SHA256
```

macOS：

```bash
shasum -a 256 Delta-Viewer_1.0.32_UNSIGNED_macos-arm64.dmg
```

Ubuntu：

```bash
sha256sum 'Delta-Viewer_1.0.32_UNSIGNED_ubuntu-22.04+-x64.deb'
```

结果必须与镜像页面和 `SHA256SUMS.txt` 中对应文件完全一致。发布维护人员仍可在能够访问 GitHub 的机器上用 `gh attestation verify <file> --repo Lr-2002/Delta-Viewer` 验证构建 provenance。

## 升级

从 1.0.63 开始，登录后直接在后台检查 GitHub 官方最新正式 Release，不遮挡数据载入。旧版仍依赖镜像，需要手动安装 1.0.63 一次才能迁移到新来源。

发现新版后，“版本与更新”出现标记，并显示一次轻提示。点击查看更新内容，再主动下载。完成后显示“更新已准备好”，选择“保存并重启更新”或“稍后”；不会自动安装。当前导出、扫描或批量任务需先完成，修改和审核操作需先成功保存，失败会保留当前版本与会话。Ubuntu 安装 deb 时可能出现系统提权确认。

下载保存为本机缓存；重新启动后联网检查到同版本时会重新校验并恢复“已准备好”。缓存损坏或缺失时需重新下载。GitHub 不可达、超时、限流等问题只影响更新，在更新详情中查看原因和重试，不中断审核。

新版首次进入工作区会展示一次中文摘要，关闭后同版本不再重复，完整记录可从历史版本查看。更新不上传账号、数据路径、标注或媒体；应用数据和原审核结论保持不变。
