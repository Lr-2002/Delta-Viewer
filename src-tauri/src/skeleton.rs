use crate::error::{AppError, AppResult};
use crate::model::{SkeletonFrame, SkeletonSeries, StateRecord};
use ndarray::{ArrayD, IxDyn};
use ndarray_npy::NpzReader;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COORDINATES: usize = 12_000_000;
const JOINT_ARRAY_NAMES: [&str; 8] = [
    "joints",
    "joint_positions",
    "smpl_joints",
    "skeleton",
    "skeletons",
    "keypoints3d",
    "keypoints_3d",
    "poses",
];
const FRAME_ID_ARRAY_NAMES: [&str; 4] = ["frame_ids", "frame_id", "frame_indices", "frames"];

pub fn load_optional_skeleton(
    root: &Path,
    states: &[StateRecord],
    cancelled: &AtomicBool,
) -> AppResult<(Option<SkeletonSeries>, Option<String>)> {
    let archive = match find_skeleton_archive(root, cancelled) {
        Ok(archive) => archive,
        Err(AppError::Cancelled) => return Err(AppError::Cancelled),
        Err(error) => return Ok((None, Some(format!("无法检查骨架数据: {error}")))),
    };
    let Some(archive) = archive else {
        return Ok((None, None));
    };

    match load_skeleton_archive(&archive, states, cancelled) {
        Ok(skeleton) => Ok((Some(skeleton), None)),
        Err(AppError::Cancelled) => Err(AppError::Cancelled),
        Err(error) => Ok((
            None,
            Some(format!(
                "无法读取 {}: {error}",
                archive
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("骨架文件")
            )),
        )),
    }
}

fn find_skeleton_archive(root: &Path, cancelled: &AtomicBool) -> AppResult<Option<PathBuf>> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)? {
        check_cancelled(cancelled)?;
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let normalized = name.to_ascii_lowercase();
        if normalized.ends_with(".npz")
            && (normalized.contains("smpl") || normalized.contains("skeleton"))
        {
            candidates.push(path);
        }
    }
    candidates.sort_by(|left, right| {
        skeleton_archive_priority(left)
            .cmp(&skeleton_archive_priority(right))
            .then_with(|| left.cmp(right))
    });
    Ok(candidates.into_iter().next())
}

fn skeleton_archive_priority(path: &Path) -> u8 {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) if name.eq_ignore_ascii_case("smpl_skeleton.npz") => 0,
        Some(name) if name.to_ascii_lowercase().contains("smpl") => 1,
        _ => 2,
    }
}

fn load_skeleton_archive(
    path: &Path,
    states: &[StateRecord],
    cancelled: &AtomicBool,
) -> AppResult<SkeletonSeries> {
    check_cancelled(cancelled)?;
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(AppError::Message(format!(
            "骨架 NPZ 超过 {} MiB 的交互加载上限",
            MAX_ARCHIVE_BYTES / 1024 / 1024
        )));
    }

    let file = File::open(path)?;
    let mut archive = NpzReader::new(file)
        .map_err(|error| AppError::Message(format!("NPZ 容器无效: {error}")))?;
    let names = archive
        .names()
        .map_err(|error| AppError::Message(format!("无法列出 NPZ 字段: {error}")))?;
    let mut joints = None;
    for name in joint_array_candidates(&names) {
        check_cancelled(cancelled)?;
        if let Some(value) = read_joint_frames(&mut archive, &name, cancelled)? {
            joints = Some(value);
            break;
        }
    }
    let Some(joints) = joints else {
        return Err(AppError::Message(format!(
            "未找到形状为 (帧, 关节, XYZ) 的浮点关节数组（字段: {}）",
            names.join(", ")
        )));
    };
    let frame_count = joints.len();
    let joint_count = joints.first().map_or(0, Vec::len);
    if frame_count == 0 || joint_count < 2 {
        return Err(AppError::Message("骨架数组为空".into()));
    }

    let frame_ids = read_frame_ids(&mut archive, &names, frame_count)
        .unwrap_or_else(|| fallback_frame_ids(states, frame_count));
    let frames = joints
        .into_iter()
        .zip(frame_ids)
        .map(|(joints, frame_id)| SkeletonFrame { frame_id, joints })
        .collect::<Vec<_>>();
    Ok(SkeletonSeries {
        source_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skeleton.npz")
            .to_string(),
        frame_count: frame_count as u64,
        joint_count: joint_count as u64,
        frames,
    })
}

fn joint_array_candidates(names: &[String]) -> Vec<String> {
    let mut candidates = Vec::new();
    for preferred in JOINT_ARRAY_NAMES {
        if let Some(name) = names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(preferred))
        {
            candidates.push(name.clone());
        }
    }
    for name in names {
        if !candidates.iter().any(|candidate| candidate == name) {
            candidates.push(name.clone());
        }
    }
    candidates
}

fn read_joint_frames(
    archive: &mut NpzReader<File>,
    name: &str,
    cancelled: &AtomicBool,
) -> AppResult<Option<Vec<Vec<[f32; 3]>>>> {
    let float32: Result<ArrayD<f32>, _> = archive.by_name(name);
    if let Ok(array) = float32 {
        return match coordinates_from_f32(array, cancelled) {
            Ok(frames) => Ok(Some(frames)),
            Err(AppError::Cancelled) => Err(AppError::Cancelled),
            Err(_) => Ok(None),
        };
    }
    let float64: Result<ArrayD<f64>, _> = archive.by_name(name);
    if let Ok(array) = float64 {
        return match coordinates_from_f64(array, cancelled) {
            Ok(frames) => Ok(Some(frames)),
            Err(AppError::Cancelled) => Err(AppError::Cancelled),
            Err(_) => Ok(None),
        };
    }
    Ok(None)
}

fn coordinates_from_f32(
    array: ArrayD<f32>,
    cancelled: &AtomicBool,
) -> AppResult<Vec<Vec<[f32; 3]>>> {
    coordinates_from_array(array, |value| value, cancelled)
}

fn coordinates_from_f64(
    array: ArrayD<f64>,
    cancelled: &AtomicBool,
) -> AppResult<Vec<Vec<[f32; 3]>>> {
    coordinates_from_array(array, |value| value as f32, cancelled)
}

fn coordinates_from_array<T: Copy>(
    array: ArrayD<T>,
    convert: impl Fn(T) -> f32,
    cancelled: &AtomicBool,
) -> AppResult<Vec<Vec<[f32; 3]>>> {
    let shape = array.shape();
    if shape.len() != 3 {
        return Err(AppError::Message("不是三维关节数组".into()));
    }
    let (frame_count, joint_count, coordinates_last) = if (3..=4).contains(&shape[2]) {
        (shape[0], shape[1], true)
    } else if (3..=4).contains(&shape[1]) {
        (shape[0], shape[2], false)
    } else {
        return Err(AppError::Message("关节数组缺少 XYZ 坐标轴".into()));
    };
    if frame_count == 0
        || joint_count < 2
        || frame_count.saturating_mul(joint_count).saturating_mul(3) > MAX_COORDINATES
    {
        return Err(AppError::Message("骨架数组尺寸不在交互加载范围内".into()));
    }

    let mut frames = Vec::with_capacity(frame_count);
    for frame in 0..frame_count {
        if frame % 64 == 0 {
            check_cancelled(cancelled)?;
        }
        let mut joints = Vec::with_capacity(joint_count);
        for joint in 0..joint_count {
            let mut point = [0.0_f32; 3];
            for (axis, coordinate) in point.iter_mut().enumerate() {
                let index = if coordinates_last {
                    IxDyn(&[frame, joint, axis])
                } else {
                    IxDyn(&[frame, axis, joint])
                };
                let value = array
                    .get(index)
                    .copied()
                    .ok_or_else(|| AppError::Message("骨架数组索引无效".into()))?;
                *coordinate = convert(value);
                if !coordinate.is_finite() {
                    return Err(AppError::Message("骨架数组包含非有限坐标".into()));
                }
            }
            joints.push(point);
        }
        frames.push(joints);
    }
    Ok(frames)
}

fn read_frame_ids(
    archive: &mut NpzReader<File>,
    names: &[String],
    expected_len: usize,
) -> Option<Vec<i64>> {
    for preferred in FRAME_ID_ARRAY_NAMES {
        let Some(name) = names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(preferred))
        else {
            continue;
        };
        if let Some(ids) = read_integer_array(archive, name) {
            if ids.len() == expected_len && ids.iter().all(|id| *id >= 0) {
                return Some(ids);
            }
        }
    }
    None
}

fn read_integer_array(archive: &mut NpzReader<File>, name: &str) -> Option<Vec<i64>> {
    read_integer_array_as::<i64>(archive, name)
        .or_else(|| {
            read_integer_array_as::<i32>(archive, name)
                .map(|values| values.into_iter().map(i64::from).collect())
        })
        .or_else(|| {
            read_integer_array_as::<u64>(archive, name).and_then(|values| {
                values
                    .into_iter()
                    .map(|value| i64::try_from(value).ok())
                    .collect::<Option<Vec<_>>>()
            })
        })
        .or_else(|| {
            read_integer_array_as::<u32>(archive, name)
                .map(|values| values.into_iter().map(i64::from).collect())
        })
}

fn read_integer_array_as<T>(archive: &mut NpzReader<File>, name: &str) -> Option<Vec<T>>
where
    T: ndarray_npy::ReadableElement + Copy,
{
    let array: ArrayD<T> = archive.by_name(name).ok()?;
    (array.ndim() == 1).then(|| array.iter().copied().collect())
}

fn fallback_frame_ids(states: &[StateRecord], frame_count: usize) -> Vec<i64> {
    if states.len() >= frame_count {
        return states
            .iter()
            .take(frame_count)
            .map(|state| state.frame_id)
            .collect();
    }
    (0..frame_count).map(|frame| frame as i64).collect()
}

fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::load_optional_skeleton;
    use crate::model::StateRecord;
    use ndarray::{Array1, Array3};
    use ndarray_npy::NpzWriter;
    use std::fs::{self, File};
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reads_smpl_skeleton_and_uses_its_frame_ids() {
        let root = test_root("smpl");
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("smpl_skeleton.npz");
        let joints = Array3::from_shape_fn((2, 24, 3), |(frame, joint, axis)| {
            (frame * 100 + joint * 10 + axis) as f32 / 10.0
        });
        let frame_ids = Array1::from_vec(vec![42_i64, 44]);
        let mut archive = NpzWriter::new(File::create(&archive_path).unwrap());
        archive.add_array("joints", &joints).unwrap();
        archive.add_array("frame_ids", &frame_ids).unwrap();
        archive.finish().unwrap();

        let (skeleton, error) =
            load_optional_skeleton(&root, &[state(0), state(1)], &AtomicBool::new(false))
                .expect("load should not fail");
        let skeleton = skeleton.expect("skeleton should load");
        assert_eq!(error, None);
        assert_eq!(skeleton.source_name, "smpl_skeleton.npz");
        assert_eq!(skeleton.frame_count, 2);
        assert_eq!(skeleton.joint_count, 24);
        assert_eq!(skeleton.frames[0].frame_id, 42);
        assert_eq!(skeleton.frames[1].frame_id, 44);
        assert_eq!(skeleton.frames[1].joints[23], [33.0, 33.1, 33.2]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_episode_loading_available_when_skeleton_is_invalid() {
        let root = test_root("invalid");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("smpl_skeleton.npz"), b"not a zip archive").unwrap();
        let (skeleton, error) = load_optional_skeleton(&root, &[state(0)], &AtomicBool::new(false))
            .expect("invalid optional data should not fail episode loading");
        assert!(skeleton.is_none());
        assert!(error.is_some());
        fs::remove_dir_all(root).unwrap();
    }

    fn state(frame_id: i64) -> StateRecord {
        StateRecord {
            frame_id,
            capture_time_ns: "0".into(),
            position: [0.0; 3],
            velocity: [0.0; 3],
            quaternion: [0.0; 4],
            euler: [0.0; 3],
            omega: [0.0; 3],
            confidence: 1.0,
        }
    }

    fn test_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-skeleton-{label}-{nonce}"))
    }
}
