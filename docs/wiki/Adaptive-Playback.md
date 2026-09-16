# NAS 自适应预览

Delta Viewer 可从独立的预览目录读取低清晰度 HLS，按网络吞吐自动切换 480p、720p 和 1080p。原始 4K 文件不会被修改。

## 服务器生成

生成器需要支持 H.264 解码、`libx264` 编码、HLS muxer 的 FFmpeg，以及对应的 `ffprobe`。在数据服务器上执行：

```bash
node scripts/generate-previews.mjs \
  --source-root /volume8/Datasets/Delta-D1 \
  --output-root /volume8/Datasets/Delta-Viewer-Previews/Delta-D1 \
  --ffmpeg /path/to/ffmpeg \
  --ffprobe /path/to/ffprobe
```

输出目录必须与原片目录互不包含。任务可重复执行：未变更的 session 会跳过，生成过程中断不会留下可用的半成品。建议使用 NAS 的计划任务定期运行，并限制为一个并发实例。

当前群晖系统自带的精简 FFmpeg 可能没有 H.264 解码器或 `ffprobe`，需要提供完整的静态 FFmpeg 工具路径后再执行批处理。

## 客户端配置

在播放器的“预览设置”中选择客户端可访问的原片根目录和预览根目录。Windows 映射盘可填写例如 `\\10.1.40.2\Datasets\Delta-D1` 与 `\\10.1.40.2\Datasets\Delta-Viewer-Previews\Delta-D1`；两者必须指向同一相对 session 树。

播放器会验证预览清单和原片指纹。预览缺失、过期或播放失败时自动回退原始视频，并显示提示。
