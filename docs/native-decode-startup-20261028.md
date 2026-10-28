# 1.3.9-rc.cloudqc.9 原生解码与快速进入

基线 4a0131f，独立候选。用户要求对比硬件解码并优化首屏，稍后接入另一块外接硬盘测试。所有真实媒体、机标、审核结果只读，不代领/审核任务，不重启业务服务。

## 三平台对比

| 平台 | Viewer 的连续播放路径 | 可用硬件路径 | 已确认的范围 |
| --- | --- | --- | --- |
| Windows | WebView2 原生 video，经进程内回环 Range 直读媒体 | Media Foundation/DXVA 或 D3D11；不支持时软件回退 | 本版目标机五路真实视频 CDP 均报告 D3D11VideoDecoder、platform decoder=true，不能据此认定每个编码/分辨率/七路负载都可硬解 |
| macOS | WKWebView 原生 video，由系统媒体栈选择解码器 | VideoToolbox，取决于 Mac 芯片、编码、profile/bit depth | 本次没有 Mac 实机，不宣称已测；Intel 与 Apple Silicon 支持范围不能互相代替 |
| Linux | WebKitGTK/GStreamer 原生 video | Intel/AMD 常见 VA-API（va），NVIDIA 常见 NVDEC（nvcodec）；部分设备 V4L2 | 开发机 gst-inspect 未发现新 va/nvcodec 插件，但发现旧 vaapi 1.24.2 的 H.264 解码器；插件存在仍需真实协商验证；本机显式 vaapih264dec 管线已协商 DRM/NV12 并完整解码 3 秒 H.264 隔离样例，该结果不是 Viewer 内实际选用硬解的证明。发行版/驱动/插件必须配套，不能靠禁用沙箱绕过 |

官方依据：[Apple VideoToolbox](https://developer.apple.com/documentation/videotoolbox)、[Microsoft 解码器选择及验证方法](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues)、[GStreamer 硬件解码](https://gstreamer.freedesktop.org/documentation/tutorials/playback/hardware-accelerated-video-decoding.html)、[WebKitGTK DMA-BUF/零复制支持](https://webkitgtk.org/2024/03/27/webkigit-2.44.html)。

硬件解码降低解码 CPU/GPU 压力，不降低原片所需输入带宽，不替代损坏介质恢复，也不加速 GB 状态 JSON 的读取与解析。正常连续回放优先原生 video；逐帧 FFmpeg 是兼容路径，本次不向未经验证的 sidecar 盲加硬解参数。UI“原生播放”仍只表示原生播放器，不保证硬解。

## 本版实现

- 新录制 states 达到 512 KiB 即走首尾有界读取的只读预览直接提供播放、拖动、速度入口。完整数据检查未结束前不挂载机标编辑器，不提前开放审核，也不在首屏抢读机标/草稿。检查成功后恢复完整曲线、片段和原审核逻辑。
- `.session_meta` 大记录首次加载后，已接入相机首帧优先读取；收到全部 loadeddata 或最多 2.5 秒后开始原完整检查。失败的相机不阻断检查，不删除问题；操作仍归原 OperationScope，取消/旧路径回包不能完成新任务。
- 回环媒体首 1 MiB 分成 64 KiB 读取并及时写给播放器，然后继续 1 MiB 顺序块。此前慢盘一次读 1 MiB 才交给播放器，首字节可能多等数秒。保持 Range 字节精确、断开即停止、内存上限不变；不伪造 Content-Length、不截断视频。
- 新录制 times 内存缓存按规范路径、大小/mtime、起点文件、声明帧数和时钟匹配；最多 28 条/200 万帧。读取中变化拒绝缓存，失效重新校验，逐帧兼容路径也复用同一映射。
- 首次预览不遍历 MP4 分段统计容量；未知容量保持零占位，完整索引补齐。回环服务可用时不重复将同一媒体交给 asset protocol 注册；无回环继续精确授权。

## 5 秒目标及测量

“5 秒”定义为：已登录、数据目录可访问，从选择一条记录开始，到所有实际接入的相机均有可见解码画面且只读播放/拖动可用。另报首路可见、完整检查完成/可编辑、各路起播情况，不能把窗口壳显示当作视频就绪。真实新盘接入后，报告首次进入与二次进入，并说明系统缓存影响，不对用户盘执行清缓存、写盘压力或改动源数据。

任意长、任意大、任意格式和任意介质都小于 5 秒无法保证：损坏/休眠硬盘、慢速 USB、文件尾部的 MP4 moov、大 times 文件、驱动不支持、操作系统 IO 超时均有下限。此版本不通过跳过完整检查或乱用标称时间映射兑现目标。记录总长不应再成为重复扫描媒体负载的原因，但完整状态审核就绪仍取决于数据规模。

## 验证

### Windows 目标机真实盘

测试过程中检测到 F:（exFAT、USB Generic Mass Storage Class、约 1.023 TB，109 条 2026-10-26 录制），与先前拔出的旧卡数据不同；未据此断言读卡器/硬盘型号。最大记录 2,048 个主相机帧（约 68.3 秒）、约 721 MB 媒体、3.48 MB 状态文件。这批只有五路真实视频：3840×2160 cam0、1280×720 cam1/cam2、848×800 t265_left/right；extension_left/right 未采集，t265_pose 是姿态数据，不能算第六路视频。

计时从原生目录选择确认开始；每 20 ms 观察新记录 video 的 loadeddata/readyState>=2 和实际视频尺寸；编辑就绪以“新增片段”按钮解除禁用为准（不点击或改动）。最终计时关闭 CDP 函数断点，避免断点额外开销。已登录，未清空操作系统缓存；“首次打开”只表示本次 Viewer 尚未打开该条，不代表硬盘冷缓存。

| 记录 / 场景 | 首路画面 | 全部实际相机画面 | 完整检查后编辑可用 |
| --- | ---: | ---: | ---: |
| 121704_827216，本次首次打开，五路 | 1.675 秒 | 1.853 秒 | 3.093 秒 |
| 085347_002928，最大记录复开，五路 | 1.644 秒 | 1.883 秒 | 2.924 秒 |
| 本机隔离七路 320×180、94 states、9.4 MB 状态样例 | 1.647 秒 | 1.647 秒 | 2.727 秒 |

原 rc8 在 121842_357274 首屏五路 5.603 秒，rc9 复开该条 1.872 秒；缓存顺序不同，仅作现场观测，不能认定为严格等条件加速比。rc9 在 115925_406693（带 IPC 断点）五路 2.899 秒。**085347 首次测量曾出现五路 39.462 秒的离群等待；随后带 IPC 复测 2.946 秒，最终无断点复测 1.883 秒，未复现长等待。该次没有足够分段证据确定发生在系统 IO、目录弹窗还是软件流程，不能说根因已经消除或已稳定满足 5 秒。** 单次有界 2 MiB 读取约 44 MiB/s，不代表冷盘长期吞吐。

五路真实播放器均报告 `D3D11VideoDecoder` 和 `kIsPlatformVideoDecoder=true`，是本版真实硬解证据。连续约 4 秒检查各路 currentTime 均推进、无 media error；跨相机采样率不同，不能直接比较各路 currentTime 来判断同步。七路隔离验收另验证：真实采集时间映射、某一路缓冲不足时全局暂停、恢复后共同播放、暂停拖动对应采集帧、播放结束停在第 89 帧。没有验证七路同时 4K、小时级原片、100 GB 文件或所有 USB/编码。

### 自动检查与构建

- `pnpm check:full` 通过（含 TypeScript/Vite、格式、Clippy、246 项 Rust 单测及 3 项 CLI 测试；15 项既有环境依赖测试 ignored），报告 `artifacts/release-check/2026-10-28T06-09-06-511Z-linux-x64.json`。
- `pnpm test:playback` 47 项通过；原生回放/统一校对/机标视频范围浏览器 39 项通过，首屏只读与延后编辑器读取的专项浏览器回归通过。
- Windows x64 原生候选构建通过，七路控件隔离回归通过；真实 F 盘只读加载/播放通过。Windows 原生媒体专项 6 项通过（2 项外部环境测试 ignored），采集时间专项 1 项通过。
- Linux 显式 `vaapih264dec` 管线通过，但未实测 Viewer 原生播放器最终选用该插件；macOS 无实机，未构建或测试。
- 关键实现为 `src/App.tsx`、`src/lib/preview-priority.ts`、`src/components/FramePanel.tsx` 和 `src-tauri/src/{source,recording_timing,media_stream_server,lib}.rs`；保留原审核/导出门禁。

Windows 已恢复正常桌面启动，调试监听 9227 关闭、临时调试/构建任务停用。Windows 交付是独立 `1.3.9-rc.cloudqc.9` 候选，二进制 SHA256 `D2B223F5181634C99B97958F00ED8F4961A6B2D0E8684936A704119322C4005B`，56,945,664 bytes。交付源清单记录于 `artifacts/rc9-delivery-identity.json`；本报告及 PRD/AGENTS 的实测补充在构建后更新，不改变二进制。未推 main、未打 tag、未发正式 Release。下一门槛是更多真实大文件/长录制、冷启动长等待定位和其他平台实机验证，不能宣称任意介质 5 秒验收完成。
