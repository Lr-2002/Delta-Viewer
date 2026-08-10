use super::{partial_sibling, ExportContext};
use crate::error::{AppError, AppResult};
use crate::storage;
use serde_json::json;
use std::fs::{self, File};
use std::io::Write;

pub(super) fn write_companion_metadata(
    context: &ExportContext<'_>,
    artifact: &std::path::Path,
) -> AppResult<Option<std::path::PathBuf>> {
    if context.annotation.is_none() {
        return Ok(None);
    }
    let output = if artifact.is_dir() {
        artifact.join("metadata.json")
    } else {
        let stem = artifact
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("export");
        artifact.with_file_name(format!("{stem}.metadata.json"))
    };
    write_metadata(context, &output, Some(artifact))?;
    Ok(Some(output))
}

fn write_metadata(
    context: &ExportContext<'_>,
    output: &std::path::Path,
    artifact: Option<&std::path::Path>,
) -> AppResult<()> {
    let partial = partial_sibling(output);
    let duration_ns = context
        .provenance
        .capture_ended_at_ns
        .parse::<u128>()
        .ok()
        .zip(
            context
                .provenance
                .capture_started_at_ns
                .parse::<u128>()
                .ok(),
        )
        .map(|(end, start)| end.saturating_sub(start).to_string());
    let annotation_metadata = context.annotation.map(|annotation| {
        let segments = annotation
            .segments
            .iter()
            .filter_map(|segment| {
                let start_frame = segment.start_frame.max(context.range.start_frame);
                let end_frame = segment.end_frame.min(context.range.end_frame);
                (start_frame <= end_frame).then(|| {
                    json!({
                        "startFrame": start_frame,
                        "endFrame": end_frame,
                        "title": segment.title,
                        "note": segment.note
                    })
                })
            })
            .collect::<Vec<_>>();
        json!({
            "trajectoryCode": annotation.trajectory_code,
            "taskId": annotation.task_id,
            "taskDescription": annotation.task_description,
            "revision": annotation.revision,
            "processedBy": annotation.processed_by,
            "segments": segments
        })
    });
    let document = json!({
        "formatVersion": 1,
        "type": "dohc_segmented_video_metadata",
        "video": {
            "name": context.data.summary.name,
            "sourceEpisodeRoot": context.source.display().to_string(),
            "startFrame": context.range.start_frame,
            "endFrame": context.range.end_frame,
            "frameBoundary": "inclusive",
            "frameCount": context.data.states.len(),
            "captureStartedAtNs": context.provenance.capture_started_at_ns,
            "captureEndedAtNs": context.provenance.capture_ended_at_ns,
            "durationNs": duration_ns,
            "streams": context.data.summary.streams.iter().map(|stream| json!({
                "name": stream.name,
                "label": stream.label,
                "frameCount": stream.frame_count,
                "width": stream.width,
                "height": stream.height
            })).collect::<Vec<_>>()
        },
        "artifact": artifact.map(|path| json!({
            "path": path.display().to_string(),
            "kind": if path.is_dir() { "directory" } else { "file" }
        })),
        "annotation": annotation_metadata,
        "provenance": {
            "exportedAtMs": context.provenance.exported_at_ms,
            "exportedBy": context.provenance.exported_by,
            "annotationUpdatedAtMs": context.provenance.annotation_updated_at_ms
        }
    });
    let result = (|| -> AppResult<()> {
        let mut file = File::create_new(&partial)?;
        serde_json::to_writer_pretty(&mut file, &document)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        let decoded: serde_json::Value = serde_json::from_reader(File::open(&partial)?)?;
        if decoded != document {
            return Err(AppError::Message("导出片段 Metadata 回读验证失败".into()));
        }
        storage::publish_noreplace(&partial, output)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::write_companion_metadata;
    use crate::export::{ExportContext, ExportProvenance};
    use crate::model::{
        EpisodeAnnotation, EpisodeData, EpisodeSummary, ExportRange, SegmentAnnotation,
        StateRecord, UserIdentity,
    };
    use std::collections::BTreeSet;
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn writes_clipped_metadata_without_overwrite_and_skips_unannotated_exports() {
        let root = std::env::temp_dir().join(format!(
            "dohc-segment-metadata-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let artifact = root.join("trajectory.mcap");
        fs::write(&artifact, b"mcap").unwrap();
        let source = root.join("readonly-source");
        let data = EpisodeData {
            summary: EpisodeSummary {
                root: source.display().to_string(),
                name: "trajectory".into(),
                total_files: 1,
                total_bytes: 4,
                state_count: 2,
                start_time_ns: Some("100".into()),
                end_time_ns: Some("200".into()),
                streams: Vec::new(),
            },
            states: vec![state(10, "100"), state(19, "200")],
            skeleton: None,
            skeleton_error: None,
        };
        let annotation = EpisodeAnnotation {
            format_version: crate::annotations::ANNOTATION_FORMAT_VERSION,
            episode_id: "episode".into(),
            episode_root: source.display().to_string(),
            episode_fingerprint: "1".repeat(64),
            trajectory_code: "oven-001".into(),
            task_id: "close_oven".into(),
            task_description: "关闭烤箱门".into(),
            processed_by: user("operator"),
            revision: 2,
            created_at_ms: 1,
            updated_at_ms: 2,
            edit_started_at_ms: 1,
            edit_duration_ms: 1,
            clip_start_frame: Some(0),
            clip_end_frame: Some(30),
            segments: vec![
                SegmentAnnotation {
                    start_frame: 0,
                    end_frame: 14,
                    title: "准备".into(),
                    note: "接近目标".into(),
                },
                SegmentAnnotation {
                    start_frame: 15,
                    end_frame: 30,
                    title: "完成".into(),
                    note: "关闭".into(),
                },
            ],
        };
        let mut context = ExportContext {
            source: &source,
            destination_parent: &root,
            data: &data,
            range: ExportRange {
                start_frame: 10,
                end_frame: 19,
            },
            full_range: false,
            annotation: Some(&annotation),
            provenance: ExportProvenance {
                capture_started_at_ns: "100".into(),
                capture_ended_at_ns: "200".into(),
                annotation_created_at_ms: Some(1),
                annotation_updated_at_ms: Some(2),
                annotation_edit_started_at_ms: Some(1),
                annotation_edit_duration_ms: Some(1),
                modified_by: Some(user("operator")),
                exported_at_ms: 3,
                exported_by: user("exporter"),
            },
            frame_ids: BTreeSet::from([10, 19]),
            app: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        };

        let output = write_companion_metadata(&context, &artifact)
            .unwrap()
            .unwrap();
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(document["type"], "dohc_segmented_video_metadata");
        assert_eq!(document["annotation"]["trajectoryCode"], "oven-001");
        assert_eq!(document["annotation"]["segments"][0]["startFrame"], 10);
        assert_eq!(document["annotation"]["segments"][0]["endFrame"], 14);
        assert_eq!(document["annotation"]["segments"][1]["startFrame"], 15);
        assert_eq!(document["annotation"]["segments"][1]["endFrame"], 19);
        assert!(write_companion_metadata(&context, &artifact).is_err());
        assert_eq!(fs::read(&artifact).unwrap(), b"mcap");

        context.annotation = None;
        let unannotated = root.join("unannotated.mcap");
        fs::write(&unannotated, b"mcap").unwrap();
        assert_eq!(
            write_companion_metadata(&context, &unannotated).unwrap(),
            None
        );
        assert!(!root.join("unannotated.metadata.json").exists());
        assert!(!source.exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn state(frame_id: i64, capture_time_ns: &str) -> StateRecord {
        StateRecord {
            frame_id,
            capture_time_ns: capture_time_ns.into(),
            position: [0.0; 3],
            velocity: [0.0; 3],
            quaternion: [0.0, 0.0, 0.0, 1.0],
            euler: [0.0; 3],
            omega: [0.0; 3],
            confidence: 1.0,
        }
    }

    fn user(username: &str) -> UserIdentity {
        UserIdentity {
            username: username.into(),
            display_name: username.into(),
        }
    }
}
