# 发布维护指南

Release CD 定义在 `.github/workflows/release.yml`。它只接受已经存在的 annotated `vX.Y.Z` tag，并要求 tag、`package.json`、`Cargo.toml`、`Cargo.lock`、Tauri config 和 Changelog 版本完全一致。

## 当前发布模式

当前通道是公开的 unsigned GitHub Release；`UNSIGNED` 表示没有可信发布者身份，不表示 macOS app 可以缺少完整性封印。一次 Release 必须同时包含：

- `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`。
- `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`。
- `DOHC-Viewer_<version>_UNSIGNED_macos-x64.dmg`。
- `DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb`。
- `DOHC-Viewer_<version>_UNSIGNED_ubuntu-x64.flatpak`。
- `SHA256SUMS.txt` 和 `release-manifest.json`。
- GitHub build provenance attestations。

Release 标题、说明、安装器文件名、verification report 和 manifest 都必须显示 `UNSIGNED`，不得宣称 Authenticode、Developer ID、Apple notarization 或可信 Linux 包签名已完成。macOS app/main/FFmpeg 必须有本地 ad-hoc seal，但报告必须同时记录 `trustedPublisher:false`。五个构建产物全部成功后，publish job 才创建或更新 draft；远端资产名称与本地集合一致后才解除 draft。已经公开的相同 tag 不允许覆盖。

## 固定依赖

Windows job 固定以下内容：

- FFmpeg static b6.1.1 中的 Gyan 6.1.1 essentials x64 binary、GPLv3 文本和 build README，各自使用 SHA-256 校验。
- Microsoft WebView2 x64 offline installer 的 exact filestreamingservice URL 和 SHA-256，并再次验证 Microsoft Authenticode。

macOS arm64/x64 job 从 FFmpeg 官方 `n8.1.2` tag 的固定 source archive SHA-256 和 Git commit 构建最小 LGPL sidecar，只启用 JPEG 输入、MPEG-4 编码和 MP4 输出。构建与 staging 会拒绝 `--enable-nonfree`、错误架构和非系统动态库，并执行真实 JPEG 到 MP4 smoke。FFmpeg 构建后先 ad-hoc 签名；app 组装完成后重新封印 FFmpeg、主程序和整个 bundle，并把封印后的 FFmpeg hash 写回 provenance manifest。

Ubuntu deb job 固定运行在 Ubuntu 22.04 x86_64，从同一 FFmpeg `n8.1.2` 固定源码构建最小 LGPL sidecar。Tauri 生成原生 deb，完成 `apt` 安装和启动验证后上传 deb/report artifact。依赖它的 Ubuntu 24.04 Flatpak job 下载同一 deb，构建固定为 `com.dohc.viewer`、GNOME Platform 50 的 bundle；不能重建另一个 deb。Flatpak 权限只包含 Wayland/fallback X11、DRI、IPC 和 `/media`、`/run/media`、`/mnt`，不包含 network。

更新任何 URL、版本、commit、构建选项、许可证或 hash 都需要代码审查和新 tag，不能只重跑旧 Release。

## 验证门禁

Windows 检查 DOHC app、NSIS installer 和 uninstaller 确实没有 Authenticode，随后验证内嵌 WebView2/FFmpeg/许可证/manifest、静默安装、启动 8 秒和静默卸载。

macOS 先用 `codesign --verify --deep --strict` 检查 app、主程序和 FFmpeg 的嵌套代码及 sealed resources，要求三者都是 ad-hoc 且没有 Developer ID team/authority。随后验证版本、最低 macOS 12.0、架构、FFmpeg source/binary/license/manifest hash、只读 UDZO DMG 和 `/Applications` 链接。挂载后的 app 被复制到本地目录并添加合成 quarantine；`syspolicy_check distribution` 正常应报告 `Adhoc Signed App` 和 `Notary Ticket Missing`。

GitHub macOS 15 runner 的 XProtect 服务可能返回 `Internal Xprotect Error`。此时 job 会现场编译、封印一个最小 control app 并执行完全相同的策略检查；只有 control 同样报告内部 XProtect 错误时，才把它作为 `policyServiceAvailable:false` 记录到 verification report。control 正常而产品异常、invalid signature、missing resources 或 damaged 均会阻止发布。最后直接启动隔离的产品副本 8 秒，确认程序本身可以运行。

该 Gatekeeper 结果仍是策略拒绝，不代表普通双击会直接放行。用户必须按[安装与升级](Installation)在系统设置中完成一次性“仍要打开”；只有 Developer ID 签名和 notarization 才能消除这个步骤。

Ubuntu 22.04 deb job 先检查 package/version/amd64/依赖和 unsigned 状态，用 `apt` 安装实际产物，检查应用 ELF 动态库、binary、desktop、AppStream metadata、icon、FFmpeg、许可证和 provenance manifest，并在 Xvfb + D-Bus 中保持启动 10 秒。卸载测试 deb 后上传安装器和报告。Ubuntu 24.04 Flatpak job 下载该 artifact，构建并安装 bundle，回读实际 runtime/permissions 并重复资源和 10 秒启动检查。任何缺失资源、动态库错误、意外 network 权限或提前退出都会阻止发布。

final job 重新读取五份报告和安装器，生成 manifest/checksums/provenance；完整集合匹配后才公开 Release。hosted runner 检查不能关闭真实 Win10/Win11 断网、目标 Mac、Ubuntu 22.04 deb/Ubuntu 20.04 Flatpak 实机、物理 SD 卡和 100 GB/100,000 文件验收缺口。

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
