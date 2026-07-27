# 数据导出

导出前先保存 episode 标注并确认裁剪范围。存在错误时导出被阻止；仅有警告时需要明确确认。

所有 adapter 先写带唯一 nonce 的 partial 输出，完成格式回读后再原子发布。已有文件或目录不会被覆盖，同名结果会获得确定性后缀。

## 批量导出

“批量”页读取当前电脑中每个 episode 的最新标注，可以一次选择多条轨迹，并以同一种 MCAP、HDF5 或 LeRobot v2.1 格式导出到同一个目标目录。批量导出首版处理完整 episode，不使用回放页临时选择的裁剪范围。

标注只保存任务、轨迹码、处理人、原始源路径和数据指纹，不保存 JPEG 或状态数据。因此原始 SD 卡或目录仍须挂载在标注时的路径；源断开的条目会显示但不能选择。后端对每条数据重新核对路径身份和指纹、执行健康检查，再使用可信检查结果调用现有 adapter。路径被替换、内容变化或存在 error 时该条失败，但后续条目继续；warning 在开始批量任务前一次确认后允许导出。

批量任务按顺序执行，避免多个大型 adapter 同时竞争磁盘和内存。取消会中止当前未完成条目并停止尚未开始的条目，已经完成回读并原子发布的输出会保留。结果列表逐条显示成功路径或失败原因。

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
