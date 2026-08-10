use super::{partial_sibling, ExportContext};
use crate::error::AppResult;
use serde_json::json;
use std::fs::{self, File};
use std::io::Write;

pub(super) fn write_companion_metadata(
    context: &ExportContext<'_>,
    artifact: &std::path::Path,
) -> AppResult<std::path::PathBuf> {
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
    Ok(output)
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
        fs::rename(&partial, output)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}
