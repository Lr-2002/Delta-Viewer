# 发布维护指南

Release CD 定义在 `.github/workflows/release.yml`。`main` 的 CI 成功后，workflow
检查 `package.json`、`Cargo.toml`、`Cargo.lock`、Tauri config 和完整 Changelog
版本是否一致；当对应的 `vX.Y.Z` 不存在时，使用仓库 `GITHUB_TOKEN` 自动创建
精确指向当前 `main` commit 的 annotated tag。每个进入 `main` 的 commit 都必须是
完整 release-ready 版本内容，不允许先推普通变更再另推 release commit。

每个 Release 都必须在 `CHANGELOG.md` 中有唯一、带合法日期、至少包含一条具体
变更的当前版本条目。当前版本必须是第一条带日期的版本记录；`Unreleased`、空条目、
`TBD`/`TODO` 和只有 compare 链接都不能替代。publish job 会把该条目直接写入 GitHub
Release 正文，并在公开前回读确认版本标题存在。

## 当前发布模式

当前通道是公开的 unsigned GitHub Release；`UNSIGNED` 表示没有可信发布者身份，不表示 macOS app 可以缺少完整性封印。一次 Release 必须同时包含：

- `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`。
- `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`。
- `DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb`。
- Windows x64 NSIS updater executable、macOS arm64 app tarball、Ubuntu x86_64 deb 各自对应的 Ed25519/Minisign `.sig`，以及三平台 `latest.json`。
- `SHA256SUMS.txt` 和 `release-manifest.json`。
- GitHub build provenance attestations。

Release 标题、说明、安装器文件名、verification report 和 manifest 都必须显示 `UNSIGNED`，不得宣称 Authenticode、Developer ID、Apple notarization 或可信 Linux 包签名已完成。macOS app/main/FFmpeg 必须有本地 ad-hoc seal，但报告必须同时记录 `trustedPublisher:false`。三个构建产物全部成功后，publish job 才创建或更新 draft；远端资产名称与本地集合一致后才解除 draft。已经公开的相同 tag 不允许覆盖。

`main` 允许直接推送，但禁止删除和 force-push。Release controller 和 publish job
只为当前运行申请 `contents: write`，其他 job 保持只读；当前 unsigned 通道不使用
GitHub App ID、private key 或 release Environment。

自动更新签名使用另一组专用凭据：`TAURI_SIGNING_PRIVATE_KEY` 和
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。它们是更新包的 Ed25519/Minisign 私钥与口令，
不是 GitHub App private key，也不参与自动 tag 的 GitHub 鉴权。私钥必须保留受控离线
备份，只能以 GitHub Actions secret 注入三个原生签名 step；不得进入仓库、普通 job env、
日志、artifact、verification report 或 release manifest。公钥嵌入
`src-tauri/tauri.conf.json`，可以公开并由 final job 回读验证。

客户端不访问 GitHub。GitHub Release 只是固定镜像机的签名上游；应用使用
`http://39.155.172.162:17879/latest.json` 与
`http://10.1.11.36:17879/latest.json`。发现更新后，客户端会对两个同版本资产并行发出受限
32 KiB Range 请求，选择实测最快的成功路径；全部测速失败时保留清单路径。`update-service.config.json`、
Tauri endpoint 和发布校验必须保持这两个固定地址一致。服务对受信任的局域网 Host 返回局域网 asset URL，
避免 NAT loopback；任意其他 Host 始终返回公网 URL。

完整代码门禁和 release workflow 回归只在 CI 对同一 commit 执行一次。CI 成功后，
controller 仍会重新核对 main HEAD、clean checkout、版本、Changelog 和 annotated tag，
但不会再次运行完整 `pnpm check`；三个平台从 controller 直接并行开始。CI 与每个平台
使用按操作系统、架构、Rust 工具链和 Cargo lockfile 隔离的依赖编译缓存。缓存不包含
应用 workspace crate、增量编译产物、安装包、封印结果或验证报告，每次 Release 仍会
重新组装并执行全部安装、启动、资源、封印和 hash 门禁。

## 固定依赖

Windows job 固定以下内容：

- FFmpeg static b6.1.1 中的 Gyan 6.1.1 essentials x64 binary、GPLv3 文本和 build README，各自使用 SHA-256 校验。
- Microsoft WebView2 x64 offline installer 的 exact filestreamingservice URL 和 SHA-256，并再次验证 Microsoft Authenticode。Tauri evergreen 跳转只用于解析当前缓存键，workflow 将固定 hash 的已审核文件写入该键；跳转目标变化不能替换实际打包内容。

macOS arm64 job 从 FFmpeg 官方 `n8.1.2` tag 的固定 source archive SHA-256 和 Git commit 构建最小 LGPL sidecar，只启用 JPEG 输入、MPEG-4 编码和 MP4 输出。构建与 staging 会拒绝 `--enable-nonfree`、错误架构和非系统动态库，并执行真实 JPEG 到 MP4 smoke。FFmpeg 构建后先 ad-hoc 签名；app 组装完成后重新封印 FFmpeg、主程序和整个 bundle，并把封印后的 FFmpeg hash 写回 provenance manifest。

Ubuntu deb job 固定运行在 Ubuntu 22.04 x86_64，从同一 FFmpeg `n8.1.2` 固定源码构建最小 LGPL sidecar。Tauri 生成原生 deb，完成 `apt` 安装和启动验证后上传 deb/report artifact。

更新任何 URL、版本、commit、构建选项、许可证或 hash 都需要代码审查和新 tag，不能只重跑旧 Release。

## 验证门禁

Windows 检查 DOHC app、NSIS installer 和 uninstaller 确实没有 Authenticode，随后验证内嵌 WebView2/FFmpeg/许可证/manifest、静默安装、启动 8 秒和静默卸载。

macOS 先用 `codesign --verify --deep --strict` 检查 app、主程序和 FFmpeg 的嵌套代码及 sealed resources，要求三者都是 ad-hoc 且没有 Developer ID team/authority。随后验证版本、最低 macOS 12.0、架构、FFmpeg source/binary/license/manifest hash、只读 UDZO DMG 和 `/Applications` 链接。挂载后的 app 被复制到本地目录并添加合成 quarantine；`syspolicy_check distribution` 正常应报告 `Adhoc Signed App` 和 `Notary Ticket Missing`。

GitHub macOS 15 runner 的 XProtect 服务可能返回 `Internal Xprotect Error`。此时 job 会现场编译、封印一个最小 control app 并执行完全相同的策略检查；只有 control 同样报告内部 XProtect 错误时，才把它作为 `policyServiceAvailable:false` 记录到 verification report。control 正常而产品异常、invalid signature、missing resources 或 damaged 均会阻止发布。最后直接启动隔离的产品副本 8 秒，确认程序本身可以运行。

该 Gatekeeper 结果仍是策略拒绝，不代表普通双击会直接放行。用户必须按[安装与升级](Installation)在系统设置中完成一次性“仍要打开”；只有 Developer ID 签名和 notarization 才能消除这个步骤。

Ubuntu 22.04 deb job 先检查 package/version/amd64/依赖和 unsigned 状态，用 `apt` 安装实际产物，检查应用 ELF 动态库、binary、desktop、AppStream metadata、icon、FFmpeg、许可证和 provenance manifest，并在 Xvfb + D-Bus 中保持启动 10 秒。卸载测试 deb 后上传安装器和报告。任何缺失资源、动态库错误或提前退出都会阻止发布。

每个平台验证正式 installer 后再生成或选择 updater：Windows 使用不内嵌离线 WebView2 的 NSIS updater executable，macOS 将完成 ad-hoc seal 的 arm64 app 打成 tarball，Ubuntu 复用已通过 `apt` 安装与启动检查的正式 deb。三个更新包必须为 1-64 MiB 并分别签名。

final job 重新读取三份报告和安装器，使用应用内嵌公钥逐个验证 updater 签名，核对 target、大小和 SHA-256，再生成 `latest.json`、manifest/checksums/provenance。`latest.json` 只包含 `windows-x86_64-nsis`、`darwin-aarch64-app` 和 `linux-x86_64-deb` 三个 target。完整集合匹配后才公开 Release；任何缺失签名、错误 target、超限或篡改内容都必须失败。hosted runner 检查不能关闭真实 Win10/Win11 断网、目标 Apple Silicon Mac、Ubuntu 22.04 deb 实机、物理 SD 卡和 100 GB/100,000 文件验收缺口。

## 固定 IP 更新镜像

镜像运行在当前 macOS 主机，监听 `0.0.0.0:17879`，公网客户端地址固定为
[http://39.155.172.162:17879/](http://39.155.172.162:17879/)，局域网 fallback 为
`http://10.1.11.36:17879/`。安装或重新加载开机常驻服务：

```bash
pnpm update-mirror:install
curl --fail http://127.0.0.1:17879/healthz
curl --fail http://39.155.172.162:17879/latest.json
curl --fail http://10.1.11.36:17879/latest.json
curl --fail --range 0-32767 http://127.0.0.1:17879/releases/v<version>/<updater-file> -o /dev/null
launchctl print "gui/$(id -u)/com.dohc.viewer.update-mirror"
```

服务每 5 分钟从固定 GitHub `latest.json` 同步一次，也会在启动时立即同步。它会先把三个
updater、三个正式安装包和元数据写入服务自有 partial，检查 target、固定文件名、1-64 MiB
updater 上限、安装包上限、SHA-256 和 Ed25519/Minisign 签名，完整通过后才原子激活。
新版本同步失败时 `healthz` 为 `degraded`，但上一完整版本继续可用；没有任何完整缓存时为
`unavailable`。对外只开放 GET/HEAD，不提供上传接口；版本资产支持单一合法 Range 的 206
响应，以便客户端用 32 KiB 样本选择更快路径；服务不记录客户端地址或业务数据。

缓存位于 `~/Library/Application Support/DOHC Viewer Update Service/`，只保留当前版和上一版。
清理只处理带 `mirror-release.json` marker 的服务自有版本目录，不触碰应用 local-data、源数据
或导出。stdout/stderr 日志也在该目录；日志只包含同步和服务错误，不写请求访问日志。

当前使用固定内网 HTTP，安装完整性完全依赖应用内嵌 Ed25519 公钥。网络攻击者可能阻断或
隐藏更新，但修改包会导致 SHA-256/签名门禁失败，不能安装。如果改用 HTTPS，必须先准备所有
客户端信任的证书链并通过新版本迁移 endpoint，不能使用不受信任的自签名证书直接替换。

## 后续签名

引入签名时必须创建新版本，不能替换现有 unsigned tag 的资产。签名通道至少需要：

- Windows Authenticode 代码签名服务和 RFC 3161 时间戳。
- Apple Developer ID Application、secure timestamp 和 notarization/stapling 凭据。
- 受保护的 GitHub Environment、required reviewer 和最小权限 secrets。
- 恢复 Windows app/installer/uninstaller 签名验证，以及 macOS app/FFmpeg/DMG 的 Developer ID、Gatekeeper 和 notarization 验证。

签名凭据不得进入仓库、日志、artifact、报告或 manifest。

## 版本发布门槛

1. 默认将 patch 位增加 `+0.0.1`；minor/major 或跳号必须由开发负责人明确指定。更新四处应用版本，并在 `CHANGELOG.md` 顶部新增唯一、带日期且非空的版本条目；同步更新 PRD 和用户文档。
2. 在本地私有标准样例上运行 `pnpm check:full`；平台变更运行对应 bundle/目标测试。
3. 确认 staged FFmpeg、私有数据、报告和构建产物没有进入 Git。
4. 将完整版本内容作为一个 release-ready commit 直接推送或合并到 `main`，不创建独立功能 commit 或 release commit；tag pending 期间冻结 `main`。
5. CI 成功后由 workflow 自动创建 annotated tag、构建三个安装包并先写入 draft；三份验证全部通过后自动公开。
6. Release 公开后等待镜像同步，确认 `healthz.version`、根页面三个安装包和 `latest.json` 都是该版本；镜像未成功激活时不得宣告客户端升级完成。
7. 不手工创建、移动或覆盖版本 tag；已创建 tag 对应的代码需要修复时进入下一版本。

## Wiki 发布

Wiki 的可审查源文件位于 `docs/wiki/`。`Publish Wiki` workflow 在 main 更新后校验内部链接并完整同步到已经初始化的 GitHub Wiki；后续不直接在网页维护分叉版本。
