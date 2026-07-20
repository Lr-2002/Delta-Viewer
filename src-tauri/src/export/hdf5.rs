use super::{map_error, partial_sibling, unique_file, ExportAdapter, ExportContext};
use crate::error::{AppError, AppResult};
use crate::model::ProgressPayload;
use crate::source::emit_progress;
use hdf5_pure::{AttrValue, File as HdfFile, FileBuilder};
use std::fs::{self, File};
use std::io::Read;
use std::sync::atomic::Ordering;
use std::time::Instant;

pub struct Hdf5Adapter;

impl ExportAdapter for Hdf5Adapter {
    fn export(&self, context: &ExportContext<'_>) -> AppResult<std::path::PathBuf> {
        if context.data.states.is_empty() {
            return Err(AppError::Message("状态数据为空，无法导出 HDF5".into()));
        }
        let stem = crate::importer::sanitize_name(&context.data.summary.name);
        let output = unique_file(context.destination_parent, &stem, "h5");
        let partial = partial_sibling(&output);
        let started = Instant::now();
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
        let total_frames: u64 = context
            .data
            .summary
            .streams
            .iter()
            .map(|stream| stream.frame_count)
            .sum();
        let mut processed_frames = 0_u64;
        let mut processed_bytes = 0_u64;
        for stream in &context.data.summary.streams {
            if context.cancelled.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let mut stream_group = images_group.create_group(&stream.name);
            let mut jpeg_data = Vec::with_capacity(stream.total_bytes as usize);
            let mut offsets = Vec::with_capacity(stream.frame_count as usize);
            let mut sizes = Vec::with_capacity(stream.frame_count as usize);
            let mut stream_frame_ids = Vec::with_capacity(stream.frame_count as usize);
            if let (Some(first), Some(last)) = (stream.first_frame, stream.last_frame) {
                for frame_id in first..=last {
                    if context.cancelled.load(Ordering::Relaxed) {
                        return Err(AppError::Cancelled);
                    }
                    let path = context
                        .source
                        .join(&stream.name)
                        .join(format!("{frame_id}.jpg"));
                    if !path.is_file() {
                        continue;
                    }
                    offsets.push(jpeg_data.len() as u64);
                    let mut file = File::open(&path)?;
                    let before = jpeg_data.len();
                    file.read_to_end(&mut jpeg_data)?;
                    let frame_bytes = (jpeg_data.len() - before) as u64;
                    sizes.push(frame_bytes);
                    processed_bytes += frame_bytes;
                    stream_frame_ids.push(frame_id);
                    processed_frames += 1;
                    if processed_frames.is_multiple_of(16) || processed_frames == total_frames {
                        emit_progress(
                            context.app,
                            ProgressPayload {
                                task: "export".into(),
                                phase: "构建 HDF5".into(),
                                current: processed_frames,
                                total: total_frames,
                                bytes_done: processed_bytes,
                                total_bytes: context.data.summary.total_bytes,
                                current_path: path.display().to_string(),
                                elapsed_ms: started.elapsed().as_millis(),
                            },
                        );
                    }
                }
            }
            stream_group
                .create_dataset("jpeg_data")
                .with_u8_data(&jpeg_data);
            stream_group
                .create_dataset("offsets")
                .with_u64_data(&offsets);
            stream_group.create_dataset("sizes").with_u64_data(&sizes);
            stream_group
                .create_dataset("frame_id")
                .with_u64_data(&stream_frame_ids);
            stream_group.set_attr("mime_type", AttrValue::AsciiString("image/jpeg".into()));
            if let Some(width) = stream.width {
                stream_group.set_attr("width", AttrValue::U32(width));
            }
            if let Some(height) = stream.height {
                stream_group.set_attr("height", AttrValue::U32(height));
            }
            images_group.add_group(stream_group.finish());
        }
        builder.add_group(images_group.finish());
        builder.write(&partial).map_err(map_error)?;

        let file = HdfFile::open_streaming(&partial).map_err(map_error)?;
        let shape = file
            .dataset("states/frame_id")
            .map_err(map_error)?
            .shape()
            .map_err(map_error)?;
        if shape.first().copied() != Some(context.data.states.len() as u64) {
            return Err(AppError::Message("HDF5 回读验证失败".into()));
        }
        drop(file);
        fs::rename(&partial, &output)?;
        Ok(output)
    }
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
