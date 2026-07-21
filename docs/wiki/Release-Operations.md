# 发布维护指南

Release CD 定义在 `.github/workflows/release.yml`。它只接受已经存在的 annotated `vX.Y.Z` tag，并要求 tag、`package.json`、`Cargo.toml`、`Cargo.lock`、Tauri config 和 Changelog 版本完全一致。

## 当前发布模式

当前通道是公开的 unsigned GitHub Release。一次 Release 必须同时包含：

- `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`。
- `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`。
- `DOHC-Viewer_<version>_UNSIGNED_macos-x64.dmg`。
- `SHA256SUMS.txt` 和 `release-manifest.json`。
- GitHub build provenance attestations。

Release 标题、说明、安装器文件名、verification report 和 manifest 都必须显示 `UNSIGNED`，不得宣称 Authenticode、Developer ID、Gatekeeper 或 Apple notarization 已完成。三个构建 job 全部成功后，publish job 才创建或更新 draft；远端资产名称与本地集合一致后才解除 draft。已经公开的相同 tag 不允许覆盖。

## 固定依赖

Windows job 固定以下内容：

- FFmpeg static b6.1.1 中的 Gyan 6.1.1 essentials x64 binary、GPLv3 文本和 build README，各自使用 SHA-256 校验。
- Microsoft WebView2 x64 offline installer 的 exact filestreamingservice URL 和 SHA-256，并再次验证 Microsoft Authenticode。

macOS arm64/x64 job 从 FFmpeg 官方 `n8.1.2` tag 的固定 source archive SHA-256 和 Git commit 构建最小 LGPL sidecar，只启用 JPEG 输入、MPEG-4 编码和 MP4 输出。构建与 staging 会拒绝 `--enable-nonfree`、错误架构和非系统动态库，并执行真实 JPEG 到 MP4 smoke。

更新任何 URL、版本、commit、构建选项、许可证或 hash 都需要代码审查和新 tag，不能只重跑旧 Release。

## 验证门禁

Windows 检查 DOHC app、NSIS installer 和 uninstaller 确实没有 Authenticode，随后验证内嵌 WebView2/FFmpeg/许可证/manifest、静默安装、启动 8 秒和静默卸载。

macOS 检查 app/DMG 没有 Developer ID 和 notarization claim，验证版本、最低 macOS 12.0、架构、FFmpeg source/binary/license/manifest hash、只读 UDZO DMG、`/Applications` 链接，并把 app 复制到本地目录直接启动 8 秒。这个 direct-startup smoke 不代表 Gatekeeper 会放行下载后的 unsigned app。

final job 重新读取三份报告和安装器，生成 manifest/checksums/provenance；完整集合匹配后才公开 Release。hosted runner 检查不能关闭真实 Win10/Win11 断网、目标 Mac、物理 exFAT SD 卡和 100 GB/100,000 文件验收缺口。

## 后续签名

引入签名时必须创建新版本，不能替换现有 unsigned tag 的资产。签名通道至少需要：

- Windows Authenticode 代码签名服务和 RFC 3161 时间戳。
- Apple Developer ID Application、secure timestamp 和 notarization/stapling 凭据。
- 受保护的 GitHub Environment、required reviewer 和最小权限 secrets。
- 恢复 Windows app/installer/uninstaller 签名验证，以及 macOS app/FFmpeg/DMG 的 Developer ID、Gatekeeper 和 notarization 验证。

签名凭据不得进入仓库、日志、artifact、报告或 manifest。

## Tag 前门槛

1. 更新四处应用版本、Changelog、PRD 和用户文档。
2. 在本地私有标准样例上运行 `pnpm check:full`；平台变更运行对应 bundle/目标测试。
3. 确认 staged FFmpeg、私有数据、报告和构建产物没有进入 Git。
4. 创建独立 release commit，在 clean 状态运行 `node scripts/release-check.mjs --quick --require-clean`。
5. 创建并推送 annotated tag。不得移动或复用失败 tag；代码修复进入下一版本。

## Wiki 发布

Wiki 的可审查源文件位于 `docs/wiki/`。`Publish Wiki` workflow 在 main 更新后校验内部链接并完整同步到已经初始化的 GitHub Wiki；后续不直接在网页维护分叉版本。
