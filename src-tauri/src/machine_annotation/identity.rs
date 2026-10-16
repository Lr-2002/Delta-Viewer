//! Keep co-located annotations readable after directory relocation.
//! Metadata verification and compatibility loading are distinct states.
use super::{invalid, Document};
use crate::error::AppResult;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

pub(super) fn select(
    document: &Document,
    name: &str,
    root: Option<&Path>,
) -> AppResult<(usize, Option<String>, bool)> {
    let exact: Vec<_> = document
        .episode_results
        .iter()
        .enumerate()
        .filter(|(_, episode)| episode.episode_id == name)
        .map(|(index, _)| index)
        .collect();
    if exact.len() > 1 {
        return Err(invalid("同一数据存在多份机标结果，无法确定当前结果"));
    }
    if let Some(&index) = exact.first() {
        return Ok((index, None, false));
    }
    // Only a bounded file already read from this episode may use relocation
    // compatibility. Raw human/reference parsing still requires the original id.
    if let Some(root) = root {
        let primary: Vec<_> = document
            .asset_id
            .as_str()
            .map(|asset| {
                document
                    .episode_results
                    .iter()
                    .enumerate()
                    .filter(|(_, episode)| !asset.is_empty() && episode.episode_id == asset)
                    .map(|(index, _)| index)
                    .collect()
            })
            .unwrap_or_default();
        let index = match primary.as_slice() {
            [index] => Some(*index),
            [] if document.episode_results.len() == 1 => Some(0),
            _ => None,
        };
        if let Some(index) = index {
            let episode = &document.episode_results[index];
            let verification = verify_metadata(root, episode);
            let verified = verification.is_ok();
            let detail = match verification {
                Ok(()) => "已核对主相机文件列表、大小、修改时间指纹及帧数。".to_owned(),
                Err(reason) => format!("已按当前目录中的机标文件兼容读取；{reason}，来源尚未核实，请回放核对视频与动作是否对应。"),
            };
            return Ok((
                index,
                Some(format!(
                    "当前目录 {} 与机标编号 {} 不同；{detail}原机标及原编号未修改。",
                    preview(name),
                    preview(&episode.episode_id),
                )),
                verified,
            ));
        }
    }
    let ids = document
        .episode_results
        .iter()
        .take(4)
        .map(|episode| preview(&episode.episode_id))
        .collect::<Vec<_>>()
        .join("、");
    Err(invalid(&format!(
        "机标 episode_id 与当前数据目录不匹配（目录：{}；机标：{}）；文件包含多个结果且无法唯一选择主结果，或没有可读取的结果。请选择其他机标来源，或选择人工标注后点击＋重新标注",
        preview(name), if ids.is_empty() { "无" } else { &ids },
    )))
}

fn verify_metadata(root: &Path, episode: &super::Episode) -> Result<(), String> {
    let camera = crate::source::review_camera_summary(root)
        .map_err(|_| "无法读取当前主相机帧数".to_owned())?;
    if camera.frame_count == 0 || camera.frame_count != episode.media.frame_count {
        return Err(format!(
            "机标声明 {} 帧，当前主相机 {} 帧，未改写或缩放片段边界",
            episode.media.frame_count, camera.frame_count
        ));
    }
    let expected = episode
        .quality
        .get("source_fingerprint")
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "机标缺少受支持的来源指纹".to_owned())?;
    let actual =
        video_fingerprint(root).map_err(|_| "当前素材不支持旧版元数据指纹核验".to_owned())?;
    if actual != expected {
        return Err("来源文件元数据指纹不同（目录移动、复制或文件变化均可能影响），不能据此确认视频内容一致".into());
    }
    Ok(())
}

fn preview(value: &str) -> String {
    format!("{:?}", value.chars().take(120).collect::<String>())
}

fn modified_ns(metadata: &fs::Metadata) -> AppResult<u128> {
    metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .map_err(|_| invalid("来源修改时间无效"))
}

// Matches bailian auto_item_fingerprint v3 for flat cam0 MP4 recordings.
// No media bytes are read. Nested/JPEG/BIN/links are deliberately unsupported
// here; compatibility loading must explicitly report that verification is unavailable.
fn video_fingerprint(root: &Path) -> AppResult<String> {
    let cam0 = root.join("cam0");
    let metadata = fs::symlink_metadata(&cam0)?;
    if !metadata.file_type().is_dir() {
        return Err(invalid("主相机不是普通目录"));
    }
    let mut newest = modified_ns(&metadata)?;
    let mut videos = Vec::new();
    for (count, entry) in fs::read_dir(&cam0)?.enumerate() {
        if count >= 4096 {
            return Err(invalid("主相机文件数量超过核验上限"));
        }
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            return Err(invalid("主相机存在嵌套目录或链接"));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| invalid("主相机文件名无效"))?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.file_type().is_file() {
            return Err(invalid("主相机文件类型已改变"));
        }
        newest = newest.max(modified_ns(&metadata)?);
        // Only the producer's fixed-width recording names have unambiguous
        // identical lexicographic/natural ordering on all supported platforms.
        if name.ends_with(".mp4") {
            let number = name
                .strip_prefix("cam0-")
                .and_then(|name| name.strip_suffix(".mp4"));
            if !number.is_some_and(|number| {
                number.len() == 5 && number.bytes().all(|b| b.is_ascii_digit())
            }) || metadata.len() == 0
            {
                return Err(invalid("不支持的主相机分段命名或空文件"));
            }
            videos.push((name, metadata.len(), modified_ns(&metadata)?));
        } else if !name.ends_with(".gst.log") {
            return Err(invalid("主相机存在无法核验的其他来源文件"));
        }
    }
    if videos.is_empty() {
        return Err(invalid("未找到可核验的主相机 MP4"));
    }
    match fs::symlink_metadata(root.join("manifest.json")) {
        Ok(metadata) if metadata.file_type().is_file() => {
            newest = newest.max(modified_ns(&metadata)?)
        }
        Ok(_) => return Err(invalid("来源清单不是普通文件")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(root.join("segments")) {
        Ok(_) => return Err(invalid("不自动匹配混合 BIN 来源")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(hash_video_metadata(newest, videos))
}

fn hash_video_metadata(newest: u128, mut videos: Vec<(String, u64, u128)>) -> String {
    videos.sort();
    let mut hash = Sha256::new();
    hash.update(format!(
        "source_mtime_ns={newest}\0count={}\n",
        videos.len()
    ));
    for (name, size, mtime) in videos {
        hash.update(format!("cam0/{name}\0{size}:{mtime}\n"));
    }
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{machine_annotation, machine_review};
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;
    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        temp: PathBuf,
        root: PathBuf,
        document: Value,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = std::env::temp_dir().join(format!(
                "viewer-renamed-{}-{}-{}",
                std::process::id(),
                FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let root = temp.join("renamed_001");
            fs::create_dir_all(root.join("cam0")).unwrap();
            fs::create_dir_all(root.join(".session_meta")).unwrap();
            fs::write(
                root.join("cam0/cam0-00000.mp4"),
                b"isolated metadata fixture, not decoded",
            )
            .unwrap();
            fs::write(root.join(".session_meta/manifest.json"), serde_json::to_vec(&json!({
                "storage_format":"h264-split-mp4-v1", "streams":{"cam0":{"path":"cam0","frame_count":30,"fps":30,"width":320,"height":180}}
            })).unwrap()).unwrap();
            let fingerprint = video_fingerprint(&root).unwrap();
            let document = json!({"schema_version":4,"asset_id":"original_009", "episode_results":[{
                "episode_id":"original_009", "relative_episode_path":"original_009",
                "media":{"frame_count":30,"frame_index_base":0,"interval_convention":"[start,end)"},
                "quality":{"validation_status":"passed","source_fingerprint":fingerprint},
                "annotations":[{"label_code":"test","start_frame":0,"end_frame":30,"attributes_zh":{"动作描述":"整理物品"}}],
                "segments":[{"label_code":"test","start_frame":0,"end_frame":30}]
            }]});
            Self {
                temp,
                root,
                document,
            }
        }
        fn write(&self) -> Vec<u8> {
            let bytes = serde_json::to_vec(&self.document).unwrap();
            fs::write(self.root.join(machine_annotation::DEFAULT_SOURCE), &bytes).unwrap();
            bytes
        }
        fn load(&self) -> AppResult<crate::model::MachineAnnotation> {
            machine_annotation::load_selected(&self.root, Some(machine_annotation::DEFAULT_SOURCE))
                .map(Option::unwrap)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.temp);
        }
    }

    #[test]
    fn renamed_folder_distinguishes_verified_and_compatible_sources() {
        let mut f = Fixture::new();
        let bytes = f.write();
        let annotation = f.load().unwrap();
        assert_eq!(annotation.episode_id, "original_009");
        assert!(annotation.identity_verified);
        assert!(annotation
            .identity_warning
            .as_ref()
            .unwrap()
            .contains("renamed_001"));
        assert_eq!(annotation.source_json.as_bytes(), bytes);
        assert_eq!(
            annotation.source_hash,
            blake3::hash(&bytes).to_hex().to_string()
        );
        assert_eq!(annotation.segments.len(), 1);
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            bytes
        );
        f.document["episode_results"][0]["media"]["frame_count"] = 31.into();
        f.write();
        let different_frames = f.load().unwrap();
        assert!(!different_frames.identity_verified);
        assert_eq!(different_frames.frame_count, 30);
        assert!(different_frames.timeline_warning.is_some());
        assert!(different_frames.identity_warning.unwrap().contains("31 帧"));
        f.document["episode_results"][0]["media"]["frame_count"] = 30.into();
        f.document["episode_results"][0]["quality"]["source_fingerprint"] = "a".repeat(64).into();
        f.write();
        let unverified = f.load().unwrap();
        assert!(!unverified.identity_verified);
        assert_eq!(unverified.segments.len(), 1);
        let warning = unverified.identity_warning.unwrap();
        assert!(warning.contains("来源尚未核实"));
        assert!(warning.contains("元数据指纹不同"));
        let manual =
            machine_annotation::load_for_review(&f.root, Some(machine_annotation::MANUAL_SOURCE))
                .unwrap()
                .unwrap();
        assert_eq!(manual.frame_count, 30);
        assert!(manual.segments.is_empty());
        assert_eq!(manual.episode_id, "renamed_001");
    }

    #[test]
    fn co_located_unique_results_remain_readable_without_verifiable_metadata() {
        for case in ["no-asset", "wrong-asset", "no-fingerprint", "changed-file"] {
            let mut f = Fixture::new();
            match case {
                "no-asset" => {
                    f.document.as_object_mut().unwrap().remove("asset_id");
                }
                "wrong-asset" => {
                    f.document["asset_id"] = "another_002".into();
                }
                "no-fingerprint" => {
                    f.document["episode_results"][0]["quality"]
                        .as_object_mut()
                        .unwrap()
                        .remove("source_fingerprint");
                }
                "changed-file" => fs::write(
                    f.root.join("cam0/cam0-00000.mp4"),
                    b"changed video metadata",
                )
                .unwrap(),
                _ => unreachable!(),
            }
            f.write();
            let loaded = f.load().unwrap();
            assert_eq!(loaded.episode_id, "original_009", "{case}");
            assert_eq!(loaded.segments.len(), 1, "{case}");
            assert_eq!(
                loaded.identity_verified,
                matches!(case, "no-asset" | "wrong-asset"),
                "{case}"
            );
            assert!(loaded.identity_warning.is_some(), "{case}");
            assert_eq!(
                loaded.source_json.as_bytes(),
                fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap()
            );
        }
    }

    #[test]
    fn ambiguous_primary_results_are_not_silently_selected() {
        for case in ["duplicate-asset", "no-primary", "empty"] {
            let mut f = Fixture::new();
            let mut other = f.document["episode_results"][0].clone();
            if case == "no-primary" {
                other["episode_id"] = "another_002".into();
                f.document.as_object_mut().unwrap().remove("asset_id");
            }
            f.document["episode_results"]
                .as_array_mut()
                .unwrap()
                .push(other);
            if case == "empty" {
                f.document["episode_results"] = serde_json::json!([]);
            }
            f.write();
            assert!(
                f.load()
                    .unwrap_err()
                    .to_string()
                    .contains("无法唯一选择主结果"),
                "{case}"
            );
        }
    }

    #[test]
    fn renamed_copy_with_changed_times_and_missing_legacy_metadata_stays_readable() {
        let mut f = Fixture::new();
        f.document.as_object_mut().unwrap().remove("asset_id");
        f.document["episode_results"][0]["quality"]
            .as_object_mut()
            .unwrap()
            .remove("source_fingerprint");
        let original = f.write();
        let moved_parent = f.temp.join("new-parent");
        fs::create_dir(&moved_parent).unwrap();
        let moved = moved_parent.join("renumbered_777");
        fs::rename(&f.root, &moved).unwrap();
        f.root = moved;
        let loaded = f.load().unwrap();
        assert!(!loaded.identity_verified);
        assert_eq!(loaded.segments.len(), 1);
        assert_eq!(loaded.episode_id, "original_009");
        assert_eq!(loaded.source_json.as_bytes(), original);
        assert!(loaded
            .identity_warning
            .unwrap()
            .contains("缺少受支持的来源指纹"));
        assert!(machine_annotation::parse_human(&original, "renumbered_777").is_err());
        assert!(machine_annotation::parse_human(&original, "original_009").is_ok());
    }

    #[test]
    fn primary_asset_selects_one_episode_and_exact_folder_match_keeps_priority() {
        let mut f = Fixture::new();
        let mut other = f.document["episode_results"][0].clone();
        other["episode_id"] = "original_009-2".into();
        other["annotations"][0]["attributes_zh"]["动作描述"] = "其他片段".into();
        f.document["episode_results"]
            .as_array_mut()
            .unwrap()
            .insert(0, other);
        f.write();
        assert_eq!(f.load().unwrap().segments[0].description, "整理物品");
        f.document["episode_results"][0]["episode_id"] = "renamed_001".into();
        f.write();
        let exact = f.load().unwrap();
        assert!(exact.identity_warning.is_none());
        assert_eq!(exact.segments[0].description, "其他片段");
        f.document["episode_results"][1]["episode_id"] = "renamed_001".into();
        f.write();
        assert!(f.load().is_err());
    }

    #[test]
    fn renamed_review_saves_and_reopens_on_fresh_host_without_rewriting_source_ids() {
        let mut f = Fixture::new();
        // A stale declared count must not discard legal boundaries in this video.
        f.document["episode_results"][0]["media"]["frame_count"] = 29.into();
        f.document["episode_results"][0]["quality"]
            .as_object_mut()
            .unwrap()
            .remove("source_fingerprint");
        let original = f.write();
        let loaded = f.load().unwrap();
        assert!(!loaded.identity_verified);
        assert_eq!(loaded.frame_count, 30);
        assert!(loaded.timeline_warning.is_some());
        let local = f.temp.join("local");
        let initial = machine_review::load_selected(
            &local,
            &f.root,
            Some(machine_annotation::DEFAULT_SOURCE),
        )
        .unwrap();
        let mut edits = initial.segments.clone();
        edits[0].description = "人工核对整理物品".into();
        let saved = machine_review::save_for_user(
            &local,
            machine_review::SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: Some(machine_annotation::DEFAULT_SOURCE.into()),
                source_hash: initial.source_hash,
                expected_revision: initial.revision,
                segments: edits,
                status: Some("approved".into()),
                rejection_reason: None,
            },
            "测试审核员",
            "test-reviewer",
        )
        .unwrap();
        assert_eq!(saved.status, "approved");
        let output = fs::read(f.root.join("description.json")).unwrap();
        let document: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(document["episode_results"][0]["episode_id"], "original_009");
        assert_eq!(document["episode_results"][0]["media"]["frame_count"], 30);
        assert_eq!(
            document["episode_results"][0]["annotations"][0]["attributes_zh"]["动作描述"],
            "人工核对整理物品"
        );
        let fresh = f.temp.join("fresh");
        for source in [machine_annotation::DEFAULT_SOURCE, "./description.json"] {
            let reloaded = machine_review::load_selected(&fresh, &f.root, Some(source)).unwrap();
            assert_eq!(reloaded.status, "approved");
            assert_eq!(reloaded.segments[0].description, "人工核对整理物品");
        }
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            original
        );
    }

    #[test]
    fn producer_metadata_fingerprint_has_a_fixed_cross_platform_vector() {
        assert_eq!(
            hash_video_metadata(
                1_700_000_123_123_456_700,
                vec![("cam0-00000.mp4".into(), 1234, 1_700_000_000_123_456_700)]
            ),
            "ddb8fc37e15d387d18724b164db6dcb79161c83c00b6af8f114bfc2310d94e52"
        );
    }

    #[test]
    #[cfg(unix)]
    fn renamed_source_does_not_follow_media_symlinks() {
        let f = Fixture::new();
        f.write();
        let path = f.root.join("cam0/cam0-00000.mp4");
        let outside = f.temp.join("outside.mp4");
        fs::rename(&path, &outside).unwrap();
        std::os::unix::fs::symlink(outside, path).unwrap();
        let loaded = f.load().unwrap();
        assert!(!loaded.identity_verified);
        assert!(loaded
            .identity_warning
            .unwrap()
            .contains("不支持旧版元数据指纹核验"));
    }
}
