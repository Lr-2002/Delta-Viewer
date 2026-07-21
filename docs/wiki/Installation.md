# 安装与升级

只从项目的 [GitHub Releases](https://github.com/Lr-2002/Delta-Viewer/releases) 下载正式安装包。Release 页面没有完整的三平台产物时，不应把 Actions 临时 artifact 或本地 debug bundle 当作正式版本。

## Windows 10/11 x64

下载 `DOHC-Viewer_<version>_windows-x64-setup.exe`，双击运行。安装器使用当前用户模式，不要求管理员权限，并内置 WebView2 离线安装器和 reviewed FFmpeg，因此断网也能完成安装和 LeRobot 视频导出。

安装器会在 Windows 10 以下停止。Windows on ARM 当前不在支持范围内。

## macOS 12 及以上

Apple Silicon 机器下载 `DOHC-Viewer_<version>_macos-arm64.dmg`；Intel 机器下载 `DOHC-Viewer_<version>_macos-x64.dmg`。打开 DMG 后，将 `DOHC Viewer.app` 拖入 `Applications`。

可在“关于本机”查看芯片类型。正式 DMG 使用 Developer ID 签名并经过 Apple notarization；如果系统仍提示应用已损坏或开发者无法验证，应停止使用并在[故障排查](Troubleshooting)中核对来源和 hash，不要通过命令绕过 Gatekeeper。

## 校验下载文件

同一 Release 中的 `SHA256SUMS.txt` 记录三个安装器和 `release-manifest.json` 的 SHA-256。

Windows PowerShell：

```powershell
Get-FileHash .\DOHC-Viewer_0.15.0_windows-x64-setup.exe -Algorithm SHA256
```

macOS：

```bash
shasum -a 256 DOHC-Viewer_0.15.0_macos-arm64.dmg
```

结果必须与 `SHA256SUMS.txt` 中对应文件完全一致。GitHub CLI 用户还可以用 `gh attestation verify <file> --repo Lr-2002/Delta-Viewer` 验证构建 provenance。

## 升级

退出正在运行的 DOHC Viewer 后安装新版本。当前用户的本地账号、后台检查报告和 episode 标注保存在系统应用数据目录，正常覆盖升级不会删除这些数据。降级默认被安装器阻止，避免新格式数据被旧版本误读。
