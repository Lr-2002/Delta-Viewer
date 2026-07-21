# 发布维护指南

正式 CD 定义在 `.github/workflows/release.yml`。它只接受已经存在的 annotated `vX.Y.Z` tag，并要求 tag、`package.json`、`Cargo.toml`、`Cargo.lock`、Tauri config 和 Changelog 版本完全一致。

## 发布产物

一次公开 Release 必须同时包含：

- Windows 10/11 x64 signed NSIS offline installer。
- macOS 12+ signed/notarized Apple Silicon DMG。
- macOS 12+ signed/notarized Intel DMG。
- `SHA256SUMS.txt` 和 `release-manifest.json`。
- GitHub build provenance attestations。

三个构建 job 全部成功后，publish job 才创建或更新 draft；远端资产名称与本地集合一致后才解除 draft。已经公开的相同 tag 不允许覆盖。

## GitHub Environment

创建名为 `production-release` 的 Environment，配置 required reviewers，并在其中设置以下 secrets：

- `WINDOWS_CERTIFICATE`：PFX 的单行 Base64。
- `WINDOWS_CERTIFICATE_PASSWORD`。
- `APPLE_CERTIFICATE`：Developer ID Application P12 的单行 Base64。
- `APPLE_CERTIFICATE_PASSWORD`。
- `APPLE_SIGNING_IDENTITY`：完整 Developer ID Application identity。
- `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`：Apple notarization 凭据。

设置以下 Environment variables：

- Windows：`FFMPEG_WINDOWS_URL`、`FFMPEG_WINDOWS_SHA256`、`FFMPEG_WINDOWS_LICENSE_URL`、`FFMPEG_WINDOWS_LICENSE_SHA256`、`FFMPEG_WINDOWS_BUILD_ID`、`WEBVIEW2_WINDOWS_X64_URL`、`WEBVIEW2_WINDOWS_X64_SHA256`、`WINDOWS_TIMESTAMP_URL`。
- macOS arm64：`FFMPEG_MACOS_ARM64_URL`、`FFMPEG_MACOS_ARM64_SHA256`、`FFMPEG_MACOS_ARM64_LICENSE_URL`、`FFMPEG_MACOS_ARM64_LICENSE_SHA256`、`FFMPEG_MACOS_ARM64_BUILD_ID`。
- macOS x64：`FFMPEG_MACOS_X64_URL`、`FFMPEG_MACOS_X64_SHA256`、`FFMPEG_MACOS_X64_LICENSE_URL`、`FFMPEG_MACOS_X64_LICENSE_SHA256`、`FFMPEG_MACOS_X64_BUILD_ID`。

FFmpeg URL 必须是 HTTPS；二进制和对应许可证必须经过负责人审核。工作流会再次检查架构、`mpeg4` encoder、`--enable-nonfree`、动态库可移植性和 SHA-256。macOS 二进制在进入 app 前使用同一 Developer ID 独立签名，manifest 同时保留 upstream 与签名后 SHA-256。WebView2 URL 必须是 Microsoft 当前 x64 evergreen 链接解析出的 exact filestreamingservice URL；URL 或 hash 变化都要求重新审核。变量或签名凭据缺失时必须失败，不允许回退为 unsigned Release。

## Tag 前门槛

1. 更新四处应用版本、Changelog、PRD 和用户文档。
2. 在本地私有标准样例上运行 `pnpm check:full`；平台变更运行对应 bundle/目标测试。
3. 确认 staged FFmpeg、私有数据、报告和构建产物没有进入 Git。
4. 创建独立 release commit，在 clean 状态运行 `node scripts/release-check.mjs --quick --require-clean`。
5. 创建并推送 annotated tag。不得移动或复用失败 tag；修复进入下一版本。

CD 的 hosted-runner 安装/启动 smoke 不能关闭真实 Win10/Win11 断网、目标 Mac、物理 exFAT SD 卡和 100 GB/100,000 文件验收缺口。

## Wiki 发布

Wiki 的可审查源文件位于 `docs/wiki/`。`Publish Wiki` workflow 在 main 更新后将其完整同步到 GitHub Wiki。GitHub 要求第一次在网页上创建 Home page 以初始化 Wiki Git 仓库；完成一次后，后续内容只从仓库源文件同步，不直接在网页上维护。
