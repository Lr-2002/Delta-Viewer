# 数据导出

导出前先保存 episode 标注并确认裁剪范围。存在错误时导出被阻止；仅有警告时需要明确确认。

所有 adapter 先写带唯一 nonce 的 partial 输出，完成格式回读后再原子发布。已有文件或目录不会被覆盖，同名结果会获得确定性后缀。

## MCAP

生成单个 `.mcap` 文件，包含状态 JSON、Foxglove `PoseInFrame` 位姿和五路 `CompressedImage` JPEG。原始 `capture_time_ns` 用作消息时间。Foxglove Desktop 可以直接打开。

macOS 上如果 Foxglove 的“最近文件”权限句柄已经失效，可能显示 `Permission denied`。使用 **Open local file(s)** 重新选择文件即可；这不是 MCAP 编码错误。

## HDF5

生成单个 `.h5` 文件，包含状态 dataset、五路 JPEG 字节和索引。实现使用纯 Rust HDF5，不要求 Windows 额外安装 HDF5 DLL；大图像数据以固定 1 MiB chunk 流式写入。

## LeRobot v2.1

生成一个目录，包含 Parquet、五路 MP4 和 v2.1 metadata。视频由安装包内置 FFmpeg 编码。原始状态没有 `action` 字段，因此导出不会创建零数组或其他虚假 action。

标准视频时间轴按估算 FPS 对齐，原始纳秒时间同时保存在 `observation.capture_time_ns`。

## 完成结果

导出完成后会显示输出路径、文件数、大小和耗时，并可在资源管理器或 Finder 中定位结果。每种格式都在发布正式名称前执行最低回读验证。
