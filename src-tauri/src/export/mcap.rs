use super::{map_error, output_stem, partial_sibling, unique_file, ExportAdapter, ExportContext};
use crate::error::{AppError, AppResult};
use crate::model::ProgressPayload;
use crate::source::{emit_progress, is_regular_file};
use crate::storage;
use bytes::Bytes;
use foxglove::messages::{CompressedImage, Pose, PoseInFrame, Quaternion, Timestamp, Vector3};
use foxglove::Encode;
use mcap::records::{MessageHeader, Metadata};
use mcap::sans_io::{SummaryReadEvent, SummaryReader, SummaryReaderOptions};
use mcap::Writer;
use prost::Message as ProstMessage;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Instant;

pub struct McapAdapter;

impl ExportAdapter for McapAdapter {
    fn export(&self, context: &ExportContext<'_>) -> AppResult<std::path::PathBuf> {
        if context.data.states.is_empty() {
            return Err(AppError::Message(
                "状态数据为空，无法建立 MCAP 时间轴".into(),
            ));
        }
        let stem = output_stem(context);
        let output = unique_file(context.destination_parent, &stem, "mcap");
        let partial = partial_sibling(&output);
        let file = File::create_new(&partial)?;
        let mut writer = Writer::new(file).map_err(map_error)?;
        let state_schema_id = writer
            .add_schema("dohc.State", "jsonschema", STATE_SCHEMA.as_bytes())
            .map_err(map_error)?;
        let image_schema = CompressedImage::get_schema()
            .ok_or_else(|| AppError::Message("Foxglove CompressedImage schema 不可用".into()))?;
        let image_schema_id = writer
            .add_schema(
                &image_schema.name,
                &image_schema.encoding,
                &image_schema.data,
            )
            .map_err(map_error)?;
        let pose_schema = PoseInFrame::get_schema()
            .ok_or_else(|| AppError::Message("Foxglove PoseInFrame schema 不可用".into()))?;
        let pose_schema_id = writer
            .add_schema(&pose_schema.name, &pose_schema.encoding, &pose_schema.data)
            .map_err(map_error)?;
        let state_channel = writer
            .add_channel(state_schema_id, "/dohc/state", "json", &BTreeMap::new())
            .map_err(map_error)?;
        let pose_channel = writer
            .add_channel(pose_schema_id, "/dohc/pose", "protobuf", &BTreeMap::new())
            .map_err(map_error)?;

        let mut image_channels = BTreeMap::new();
        for stream in &context.data.summary.streams {
            let mut metadata = BTreeMap::new();
            metadata.insert("mime_type".into(), "image/jpeg".into());
            if let Some(width) = stream.width {
                metadata.insert("width".into(), width.to_string());
            }
            if let Some(height) = stream.height {
                metadata.insert("height".into(), height.to_string());
            }
            let channel = writer
                .add_channel(
                    image_schema_id,
                    &format!("/dohc/camera/{}", stream.name),
                    "protobuf",
                    &metadata,
                )
                .map_err(map_error)?;
            image_channels.insert(stream.name.clone(), channel);
        }
        writer
            .write_metadata(&Metadata {
                name: "dohc.dataset".into(),
                metadata: BTreeMap::from([
                    ("source_name".into(), context.data.summary.name.clone()),
                    ("state_count".into(), context.data.states.len().to_string()),
                    (
                        "clip_start_frame".into(),
                        context.range.start_frame.to_string(),
                    ),
                    ("clip_end_frame".into(), context.range.end_frame.to_string()),
                ]),
            })
            .map_err(map_error)?;

        let started = Instant::now();
        let total =
            context.data.states.len() as u64 * (context.data.summary.streams.len() as u64 + 2);
        let mut written = 0_u64;
        for (state_index, state) in context.data.states.iter().enumerate() {
            if context.cancelled.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let timestamp = state
                .capture_time_ns
                .parse::<u64>()
                .map_err(|error| AppError::Message(format!("无效时间戳: {error}")))?;
            let sequence = u32::try_from(state_index).unwrap_or(u32::MAX);
            let state_bytes = serde_json::to_vec(state)?;
            writer
                .write_to_known_channel(
                    &MessageHeader {
                        channel_id: state_channel,
                        sequence,
                        log_time: timestamp,
                        publish_time: timestamp,
                    },
                    &state_bytes,
                )
                .map_err(map_error)?;
            written += 1;

            let pose = PoseInFrame {
                timestamp: Some(foxglove_timestamp(timestamp)?),
                frame_id: "dohc_base".into(),
                pose: Some(Pose {
                    position: Some(Vector3 {
                        x: state.position[0],
                        y: state.position[1],
                        z: state.position[2],
                    }),
                    orientation: Some(Quaternion {
                        x: state.quaternion[0],
                        y: state.quaternion[1],
                        z: state.quaternion[2],
                        w: state.quaternion[3],
                    }),
                }),
            };
            writer
                .write_to_known_channel(
                    &MessageHeader {
                        channel_id: pose_channel,
                        sequence,
                        log_time: timestamp,
                        publish_time: timestamp,
                    },
                    &pose.encode_to_vec(),
                )
                .map_err(map_error)?;
            written += 1;

            if state.frame_id >= 0 {
                for stream in &context.data.summary.streams {
                    let frame_path = context
                        .source
                        .join(&stream.name)
                        .join(format!("{}.jpg", state.frame_id));
                    if !is_regular_file(&frame_path) {
                        continue;
                    }
                    let image = CompressedImage {
                        timestamp: Some(foxglove_timestamp(timestamp)?),
                        frame_id: stream.name.clone(),
                        data: Bytes::from(fs::read(&frame_path)?),
                        format: "jpeg".into(),
                    };
                    writer
                        .write_to_known_channel(
                            &MessageHeader {
                                channel_id: image_channels[&stream.name],
                                sequence,
                                log_time: timestamp,
                                publish_time: timestamp,
                            },
                            &image.encode_to_vec(),
                        )
                        .map_err(map_error)?;
                    written += 1;
                    if written.is_multiple_of(16) || written == total {
                        emit_progress(
                            context.app,
                            ProgressPayload {
                                task: "export".into(),
                                phase: "写入 MCAP".into(),
                                current: written,
                                total,
                                bytes_done: 0,
                                total_bytes: context.data.summary.total_bytes,
                                current_path: frame_path.display().to_string(),
                                elapsed_ms: started.elapsed().as_millis(),
                            },
                        );
                    }
                }
            }
        }
        writer.finish().map_err(map_error)?;
        drop(writer);
        verify_mcap(&partial, written)?;
        storage::publish_noreplace(&partial, &output)?;
        Ok(output)
    }
}

fn verify_mcap(path: &Path, expected_messages: u64) -> AppResult<()> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut reader = SummaryReader::new_with_options(
        SummaryReaderOptions::default()
            .with_file_size(file_size)
            .with_record_length_limit(64 * 1024 * 1024),
    );
    while let Some(event) = reader.next_event() {
        match event.map_err(map_error)? {
            SummaryReadEvent::ReadRequest(bytes) => {
                let read = file.read(reader.insert(bytes))?;
                reader.notify_read(read);
            }
            SummaryReadEvent::SeekRequest(position) => {
                let position = file.seek(position)?;
                reader.notify_seeked(position);
            }
        }
    }
    let summary = reader
        .finish()
        .ok_or_else(|| AppError::Message("MCAP 回读验证失败: 缺少 summary".into()))?;
    let topics = summary
        .channels
        .values()
        .map(|channel| channel.topic.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let expected = [
        "/dohc/state",
        "/dohc/pose",
        "/dohc/camera/cam0",
        "/dohc/camera/cam1",
        "/dohc/camera/cam2",
        "/dohc/camera/t265_left",
        "/dohc/camera/t265_right",
    ]
    .into_iter()
    .collect::<std::collections::BTreeSet<_>>();
    let schemas = summary
        .schemas
        .values()
        .map(|schema| (schema.name.as_str(), schema.encoding.as_str()))
        .collect::<std::collections::BTreeSet<_>>();
    let expected_schemas = [
        ("dohc.State", "jsonschema"),
        ("foxglove.CompressedImage", "protobuf"),
        ("foxglove.PoseInFrame", "protobuf"),
    ]
    .into_iter()
    .collect::<std::collections::BTreeSet<_>>();
    if schemas != expected_schemas
        || topics != expected
        || summary.stats.as_ref().map(|stats| stats.message_count) != Some(expected_messages)
    {
        return Err(AppError::Message(
            "MCAP 回读验证失败: channel 或 schema 不匹配".into(),
        ));
    }

    Ok(())
}

fn foxglove_timestamp(timestamp_ns: u64) -> AppResult<Timestamp> {
    let seconds = u32::try_from(timestamp_ns / 1_000_000_000)
        .map_err(|_| AppError::Message("时间戳超出 Foxglove protobuf 范围".into()))?;
    let nanos = (timestamp_ns % 1_000_000_000) as u32;
    Timestamp::new_checked(seconds, nanos)
        .ok_or_else(|| AppError::Message("时间戳无法规范化为 Foxglove Timestamp".into()))
}

const STATE_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DOHC State",
  "type": "object",
  "required": ["frameId", "captureTimeNs", "position", "velocity", "quaternion", "euler", "omega", "confidence"],
  "properties": {
    "frameId": {"type": "integer"},
    "captureTimeNs": {"type": "string"},
    "position": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
    "velocity": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
    "quaternion": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4},
    "euler": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
    "omega": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
    "confidence": {"type": "number"}
  }
}"#;
