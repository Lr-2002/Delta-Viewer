use super::{map_error, partial_sibling, unique_file, ExportAdapter, ExportContext};
use crate::error::{AppError, AppResult};
use crate::model::ProgressPayload;
use crate::source::{collect_stream_files, emit_progress};
use crate::storage;
use hdf5_pure::{AttrValue, ChunkProvider, File as HdfFile, FileBuilder, FormatError};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;

pub struct Hdf5Adapter;

const JPEG_CHUNK_BYTES: u64 = 1024 * 1024;
const PROGRESS_CHUNK_INTERVAL: u64 = 16;
const CANCELLED_MARKER: &str = "DOHC_HDF5_EXPORT_CANCELLED";

struct JpegSegment {
    path: PathBuf,
    logical_offset: u64,
    len: u64,
}

struct JpegStreamPlan {
    segments: Vec<JpegSegment>,
    offsets: Vec<u64>,
    sizes: Vec<u64>,
    frame_ids: Vec<u64>,
    total_bytes: u64,
}

impl JpegStreamPlan {
    fn chunk_count(&self, chunk_size: u64) -> u64 {
        self.total_bytes.div_ceil(chunk_size)
    }
}

struct ProviderProgress {
    app: Option<AppHandle>,
    stream_name: String,
    chunks_before: u64,
    total_chunks: u64,
    bytes_before: u64,
    total_bytes: u64,
    started: Instant,
}

struct JpegChunkProvider {
    segments: Vec<JpegSegment>,
    total_bytes: u64,
    chunk_size: usize,
    cancelled: Arc<AtomicBool>,
    progress: Option<ProviderProgress>,
}

impl ChunkProvider for JpegChunkProvider {
    fn chunk_bytes(&self, index: usize) -> Result<Vec<u8>, FormatError> {
        check_provider_cancelled(&self.cancelled)?;
        let chunk_size_u64 = u64::try_from(self.chunk_size)
            .map_err(|_| provider_error("HDF5 chunk size does not fit u64"))?;
        let index_u64 = u64::try_from(index)
            .map_err(|_| provider_error("HDF5 chunk index does not fit u64"))?;
        let logical_start = index_u64
            .checked_mul(chunk_size_u64)
            .ok_or_else(|| provider_error("HDF5 chunk offset overflow"))?;
        if logical_start >= self.total_bytes {
            return Err(provider_error(
                "HDF5 requested a JPEG chunk past end of stream",
            ));
        }
        let logical_len = self
            .total_bytes
            .saturating_sub(logical_start)
            .min(chunk_size_u64);
        let logical_len_usize = usize::try_from(logical_len)
            .map_err(|_| provider_error("HDF5 logical chunk size does not fit usize"))?;
        let mut chunk = vec![0_u8; self.chunk_size];
        let mut written = 0_usize;
        let mut logical_offset = logical_start;
        let mut segment_index = self.segments.partition_point(|segment| {
            segment.logical_offset.saturating_add(segment.len) <= logical_offset
        });
        let mut current_path = None;

        while written < logical_len_usize {
            check_provider_cancelled(&self.cancelled)?;
            let segment = self.segments.get(segment_index).ok_or_else(|| {
                provider_error("JPEG stream plan ended before the requested chunk")
            })?;
            if logical_offset < segment.logical_offset {
                return Err(provider_error(
                    "JPEG stream plan contains an unexpected gap",
                ));
            }
            let file_offset = logical_offset - segment.logical_offset;
            if file_offset >= segment.len {
                segment_index += 1;
                continue;
            }
            let remaining_in_file = segment.len - file_offset;
            let remaining_in_chunk = logical_len_usize - written;
            let copy_len = usize::try_from(remaining_in_file.min(remaining_in_chunk as u64))
                .map_err(|_| provider_error("JPEG copy length does not fit usize"))?;
            let mut file = File::open(&segment.path)
                .map_err(|error| provider_io_error("open", &segment.path, error))?;
            let actual_len = file
                .metadata()
                .map_err(|error| provider_io_error("stat", &segment.path, error))?
                .len();
            if actual_len != segment.len {
                return Err(provider_error(format!(
                    "source changed during HDF5 export: {} was {} bytes and is now {} bytes",
                    segment.path.display(),
                    segment.len,
                    actual_len
                )));
            }
            file.seek(SeekFrom::Start(file_offset))
                .map_err(|error| provider_io_error("seek", &segment.path, error))?;
            let target = &mut chunk[written..written + copy_len];
            let mut read_total = 0_usize;
            while read_total < target.len() {
                check_provider_cancelled(&self.cancelled)?;
                let read = file
                    .read(&mut target[read_total..])
                    .map_err(|error| provider_io_error("read", &segment.path, error))?;
                if read == 0 {
                    return Err(provider_error(format!(
                        "source changed during HDF5 export: unexpected EOF in {}",
                        segment.path.display()
                    )));
                }
                read_total += read;
            }
            written += copy_len;
            logical_offset += copy_len as u64;
            current_path = Some(segment.path.as_path());
            if file_offset + copy_len as u64 == segment.len {
                segment_index += 1;
            }
        }

        if let Some(progress) = &self.progress {
            let current = progress.chunks_before + index_u64 + 1;
            if current.is_multiple_of(PROGRESS_CHUNK_INTERVAL) || current == progress.total_chunks {
                emit_progress(
                    progress.app.as_ref(),
                    ProgressPayload {
                        task: "export".into(),
                        phase: format!("写入 HDF5 {}", progress.stream_name),
                        current,
                        total: progress.total_chunks,
                        bytes_done: progress
                            .bytes_before
                            .saturating_add(logical_start)
                            .saturating_add(logical_len)
                            .min(progress.total_bytes),
                        total_bytes: progress.total_bytes,
                        current_path: current_path
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|| progress.stream_name.clone()),
                        elapsed_ms: progress.started.elapsed().as_millis(),
                    },
                );
            }
        }
        Ok(chunk)
    }
}

impl ExportAdapter for Hdf5Adapter {
    fn export(&self, context: &ExportContext<'_>) -> AppResult<PathBuf> {
        if context.data.states.is_empty() {
            return Err(AppError::Message("状态数据为空，无法导出 HDF5".into()));
        }
        let stem = crate::importer::sanitize_name(&context.data.summary.name);
        let output = unique_file(context.destination_parent, &stem, "h5");
        let partial = partial_sibling(&output);
        let started = Instant::now();
        let mut stream_plans = Vec::with_capacity(context.data.summary.streams.len());

        for (index, stream) in context.data.summary.streams.iter().enumerate() {
            if context.cancelled.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let stream_files =
                collect_stream_files(context.source, &stream.name, &context.cancelled)?;
            let plan = plan_jpeg_stream(&stream.name, stream_files.frames, &context.cancelled)?;
            if plan.frame_ids.len() as u64 != stream.frame_count
                || plan.total_bytes != stream.total_bytes
            {
                return Err(AppError::Message(format!(
                    "导出前源数据已变化: {} 的帧数或字节数与扫描结果不一致",
                    stream.name
                )));
            }
            emit_progress(
                context.app,
                ProgressPayload {
                    task: "export".into(),
                    phase: "索引 HDF5 JPEG".into(),
                    current: (index + 1) as u64,
                    total: context.data.summary.streams.len() as u64,
                    bytes_done: 0,
                    total_bytes: context.data.summary.total_bytes,
                    current_path: context.source.join(&stream.name).display().to_string(),
                    elapsed_ms: started.elapsed().as_millis(),
                },
            );
            stream_plans.push(plan);
        }

        let total_jpeg_bytes = stream_plans.iter().try_fold(0_u64, |total, plan| {
            total
                .checked_add(plan.total_bytes)
                .ok_or_else(|| AppError::Message("HDF5 JPEG 总字节数溢出".into()))
        })?;
        let total_chunks = stream_plans.iter().try_fold(0_u64, |total, plan| {
            total
                .checked_add(plan.chunk_count(JPEG_CHUNK_BYTES))
                .ok_or_else(|| AppError::Message("HDF5 JPEG chunk 数溢出".into()))
        })?;

        let mut builder = FileBuilder::new();
        builder.set_attr("format", AttrValue::AsciiString("dohc-hdf5".into()));
        builder.set_attr("format_version", AttrValue::I64(1));
        builder.set_attr(
            "source_name",
            AttrValue::AsciiString(context.data.summary.name.clone()),
        );

        let mut states_group = builder.create_group("states");
        let frame_ids: Vec<i64> = context
            .data
            .states
            .iter()
            .map(|state| state.frame_id)
            .collect();
        let timestamps: Vec<i64> = context
            .data
            .states
            .iter()
            .map(|state| state.capture_time_ns.parse::<i64>())
            .collect::<Result<_, _>>()
            .map_err(map_error)?;
        states_group
            .create_dataset("frame_id")
            .with_i64_data(&frame_ids);
        states_group
            .create_dataset("capture_time_ns")
            .with_i64_data(&timestamps);
        add_vector_dataset(
            &mut states_group,
            "position",
            context.data.states.iter().flat_map(|state| state.position),
            context.data.states.len(),
            3,
        );
        add_vector_dataset(
            &mut states_group,
            "velocity",
            context.data.states.iter().flat_map(|state| state.velocity),
            context.data.states.len(),
            3,
        );
        add_vector_dataset(
            &mut states_group,
            "quaternion",
            context
                .data
                .states
                .iter()
                .flat_map(|state| state.quaternion),
            context.data.states.len(),
            4,
        );
        add_vector_dataset(
            &mut states_group,
            "euler",
            context.data.states.iter().flat_map(|state| state.euler),
            context.data.states.len(),
            3,
        );
        add_vector_dataset(
            &mut states_group,
            "omega",
            context.data.states.iter().flat_map(|state| state.omega),
            context.data.states.len(),
            3,
        );
        let confidence: Vec<f64> = context
            .data
            .states
            .iter()
            .map(|state| state.confidence)
            .collect();
        states_group
            .create_dataset("confidence")
            .with_f64_data(&confidence);
        builder.add_group(states_group.finish());

        let mut images_group = builder.create_group("images");
        let mut chunks_before = 0_u64;
        let mut bytes_before = 0_u64;
        for (stream, plan) in context.data.summary.streams.iter().zip(stream_plans) {
            let JpegStreamPlan {
                segments,
                offsets,
                sizes,
                frame_ids,
                total_bytes,
            } = plan;
            let stream_chunks = total_bytes.div_ceil(JPEG_CHUNK_BYTES);
            let mut stream_group = images_group.create_group(&stream.name);
            stream_group
                .create_dataset("offsets")
                .with_u64_data(&offsets);
            stream_group.create_dataset("sizes").with_u64_data(&sizes);
            stream_group
                .create_dataset("frame_id")
                .with_u64_data(&frame_ids);
            let provider = JpegChunkProvider {
                segments,
                total_bytes,
                chunk_size: JPEG_CHUNK_BYTES as usize,
                cancelled: context.cancelled.clone(),
                progress: Some(ProviderProgress {
                    app: context.app.cloned(),
                    stream_name: stream.name.clone(),
                    chunks_before,
                    total_chunks,
                    bytes_before,
                    total_bytes: total_jpeg_bytes,
                    started,
                }),
            };
            stream_group
                .create_dataset("jpeg_data")
                .with_streamed_u8_data(total_bytes, JPEG_CHUNK_BYTES, Box::new(provider))
                .map_err(map_error)?;
            stream_group.set_attr("mime_type", AttrValue::AsciiString("image/jpeg".into()));
            if let Some(width) = stream.width {
                stream_group.set_attr("width", AttrValue::U32(width));
            }
            if let Some(height) = stream.height {
                stream_group.set_attr("height", AttrValue::U32(height));
            }
            images_group.add_group(stream_group.finish());
            chunks_before = chunks_before.saturating_add(stream_chunks);
            bytes_before = bytes_before.saturating_add(total_bytes);
        }
        builder.add_group(images_group.finish());

        write_builder(builder, &partial, &context.cancelled)?;
        if let Err(error) = verify_hdf5(&partial, context) {
            remove_partial(&partial);
            return Err(error);
        }
        if let Err(error) = storage::publish_noreplace(&partial, &output) {
            remove_partial(&partial);
            return Err(error);
        }
        Ok(output)
    }
}

fn plan_jpeg_stream(
    stream_name: &str,
    frames: Vec<(u64, PathBuf)>,
    cancelled: &AtomicBool,
) -> AppResult<JpegStreamPlan> {
    let mut segments = Vec::with_capacity(frames.len());
    let mut offsets = Vec::with_capacity(frames.len());
    let mut sizes = Vec::with_capacity(frames.len());
    let mut frame_ids = Vec::with_capacity(frames.len());
    let mut total_bytes = 0_u64;
    for (frame_id, path) in frames {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let file = File::open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(AppError::Message(format!(
                "HDF5 源帧不是普通文件: {}",
                path.display()
            )));
        }
        let len = metadata.len();
        offsets.push(total_bytes);
        sizes.push(len);
        frame_ids.push(frame_id);
        segments.push(JpegSegment {
            path,
            logical_offset: total_bytes,
            len,
        });
        total_bytes = total_bytes
            .checked_add(len)
            .ok_or_else(|| AppError::Message("HDF5 JPEG stream 字节数溢出".into()))?;
    }
    if segments.is_empty() || total_bytes == 0 {
        return Err(AppError::Message(format!(
            "视频流 {stream_name} 为空，无法导出 HDF5"
        )));
    }
    Ok(JpegStreamPlan {
        segments,
        offsets,
        sizes,
        frame_ids,
        total_bytes,
    })
}

fn write_builder(builder: FileBuilder, partial: &Path, cancelled: &AtomicBool) -> AppResult<()> {
    let write_result = builder.write(partial).map_err(map_error);
    if let Err(error) = write_result {
        remove_partial(partial);
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        return Err(error);
    }
    if cancelled.load(Ordering::Relaxed) {
        remove_partial(partial);
        return Err(AppError::Cancelled);
    }
    Ok(())
}

fn verify_hdf5(path: &Path, context: &ExportContext<'_>) -> AppResult<()> {
    let file = HdfFile::open_streaming(path).map_err(map_error)?;
    let shape = file
        .dataset("states/frame_id")
        .map_err(map_error)?
        .shape()
        .map_err(map_error)?;
    if shape != [context.data.states.len() as u64] {
        return Err(AppError::Message("HDF5 回读验证失败: 状态数不匹配".into()));
    }
    for stream in &context.data.summary.streams {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let prefix = format!("images/{}", stream.name);
        let jpeg_shape = file
            .dataset(&format!("{prefix}/jpeg_data"))
            .map_err(map_error)?
            .shape()
            .map_err(map_error)?;
        if jpeg_shape != [stream.total_bytes] {
            return Err(AppError::Message(format!(
                "HDF5 回读验证失败: {} JPEG 字节数不匹配",
                stream.name
            )));
        }
        let offsets = file
            .dataset(&format!("{prefix}/offsets"))
            .map_err(map_error)?
            .read_u64()
            .map_err(map_error)?;
        let sizes = file
            .dataset(&format!("{prefix}/sizes"))
            .map_err(map_error)?
            .read_u64()
            .map_err(map_error)?;
        let frame_ids = file
            .dataset(&format!("{prefix}/frame_id"))
            .map_err(map_error)?
            .read_u64()
            .map_err(map_error)?;
        if offsets.len() as u64 != stream.frame_count
            || sizes.len() as u64 != stream.frame_count
            || frame_ids.len() as u64 != stream.frame_count
            || offsets.first().copied() != Some(0)
            || offsets
                .last()
                .copied()
                .zip(sizes.last().copied())
                .and_then(|(offset, size)| offset.checked_add(size))
                != Some(stream.total_bytes)
            || frame_ids.first().copied() != stream.first_frame
            || frame_ids.last().copied() != stream.last_frame
        {
            return Err(AppError::Message(format!(
                "HDF5 回读验证失败: {} 帧索引不匹配",
                stream.name
            )));
        }
    }
    Ok(())
}

fn add_vector_dataset(
    group: &mut hdf5_pure::GroupBuilder,
    name: &str,
    values: impl Iterator<Item = f64>,
    rows: usize,
    columns: u64,
) {
    let values: Vec<f64> = values.collect();
    group
        .create_dataset(name)
        .with_f64_data(&values)
        .with_shape(&[rows as u64, columns]);
}

fn check_provider_cancelled(cancelled: &AtomicBool) -> Result<(), FormatError> {
    if cancelled.load(Ordering::Relaxed) {
        Err(provider_error(CANCELLED_MARKER))
    } else {
        Ok(())
    }
}

fn provider_error(message: impl Into<String>) -> FormatError {
    FormatError::ChunkedReadError(message.into())
}

fn provider_io_error(operation: &str, path: &Path, error: std::io::Error) -> FormatError {
    provider_error(format!(
        "failed to {operation} JPEG {}: {error}",
        path.display()
    ))
}

fn remove_partial(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{plan_jpeg_stream, write_builder, JpegChunkProvider, JPEG_CHUNK_BYTES};
    use crate::error::AppError;
    use hdf5_pure::{ChunkProvider, File as HdfFile, FileBuilder, FormatError};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct NoReadProvider;

    impl ChunkProvider for NoReadProvider {
        fn chunk_bytes(&self, _index: usize) -> Result<Vec<u8>, FormatError> {
            panic!("logical-size test must not read payload chunks")
        }
    }

    #[test]
    fn streams_across_jpeg_files_and_clips_tail_padding() {
        let root = test_output("streamed-roundtrip");
        fs::create_dir_all(&root).unwrap();
        let first = root.join("0.jpg");
        let second = root.join("1.jpg");
        fs::write(&first, b"abc").unwrap();
        fs::write(&second, b"defghi").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let plan =
            plan_jpeg_stream("cam0", vec![(0, first), (1, second)], cancelled.as_ref()).unwrap();
        assert_eq!(plan.offsets, [0, 3]);
        assert_eq!(plan.sizes, [3, 6]);

        let provider = JpegChunkProvider {
            segments: plan.segments,
            total_bytes: plan.total_bytes,
            chunk_size: 4,
            cancelled,
            progress: None,
        };
        assert_eq!(provider.chunk_bytes(0).unwrap(), b"abcd");
        assert_eq!(provider.chunk_bytes(1).unwrap(), b"efgh");
        assert_eq!(provider.chunk_bytes(2).unwrap(), b"i\0\0\0");

        let output = root.join("streamed.h5");
        let mut builder = FileBuilder::new();
        builder
            .create_dataset("jpeg")
            .with_streamed_u8_data(9, 4, Box::new(provider))
            .unwrap();
        builder.write(&output).unwrap();
        let file = HdfFile::open_streaming(&output).unwrap();
        assert_eq!(
            file.dataset("jpeg").unwrap().read_u8().unwrap(),
            b"abcdefghi"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_observes_cancellation_before_io() {
        let root = test_output("streamed-cancel");
        fs::create_dir_all(&root).unwrap();
        let frame = root.join("0.jpg");
        fs::write(&frame, b"jpeg").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let plan = plan_jpeg_stream("cam0", vec![(0, frame)], cancelled.as_ref()).unwrap();
        cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
        let provider = JpegChunkProvider {
            segments: plan.segments,
            total_bytes: plan.total_bytes,
            chunk_size: 4,
            cancelled,
            progress: None,
        };
        assert!(provider
            .chunk_bytes(0)
            .unwrap_err()
            .to_string()
            .contains("CANCELLED"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_removes_the_partial_hdf5_file() {
        let root = test_output("streamed-cancel-cleanup");
        fs::create_dir_all(&root).unwrap();
        let frame = root.join("0.jpg");
        fs::write(&frame, b"jpeg").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let plan = plan_jpeg_stream("cam0", vec![(0, frame)], cancelled.as_ref()).unwrap();
        let provider = JpegChunkProvider {
            segments: plan.segments,
            total_bytes: plan.total_bytes,
            chunk_size: 4,
            cancelled: cancelled.clone(),
            progress: None,
        };
        let mut builder = FileBuilder::new();
        builder
            .create_dataset("jpeg")
            .with_streamed_u8_data(4, 4, Box::new(provider))
            .unwrap();
        cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
        let partial = root.join(".cancelled.partial");
        assert!(matches!(
            write_builder(builder, &partial, cancelled.as_ref()),
            Err(AppError::Cancelled)
        ));
        assert!(!partial.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stages_100_gib_logical_stream_without_payload_allocation() {
        let logical_bytes = 100_u64 * 1024 * 1024 * 1024;
        assert_eq!(logical_bytes.div_ceil(JPEG_CHUNK_BYTES), 102_400);
        let mut builder = FileBuilder::new();
        builder
            .create_dataset("jpeg")
            .with_streamed_u8_data(logical_bytes, JPEG_CHUNK_BYTES, Box::new(NoReadProvider))
            .unwrap();
        drop(builder);
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
