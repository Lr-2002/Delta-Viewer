//! Optional per-frame capture times for the new recording layout.
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Clone, PartialEq, Eq)]
struct Stamp(PathBuf, u64, SystemTime);
#[derive(Clone, PartialEq, Eq)]
struct Key {
    times: Stamp,
    origin: Stamp,
    count: u64,
    fps: u64,
}
type TimingCache = BTreeMap<PathBuf, (Key, Arc<Vec<f64>>)>;
static CACHE: OnceLock<Mutex<TimingCache>> = OnceLock::new();
fn stamp(path: &Path) -> AppResult<Stamp> {
    let path = path.canonicalize()?;
    let meta = fs::metadata(&path)?;
    Ok(Stamp(path, meta.len(), meta.modified()?))
}
const MAX_FRAMES: u64 = 500_000;
#[derive(Deserialize)]
struct Times {
    schema: String,
    clock: String,
    stream: String,
    unit: String,
    timestamps_ns: Vec<u64>,
}
#[derive(Deserialize)]
struct Origin {
    batch_id: Option<u64>,
    frame_id: Option<u64>,
    capture_boottime_ns: u64,
}

pub fn load(
    root: &Path,
    stream: &str,
    frame_count: u64,
    timeline_fps: f64,
) -> AppResult<Option<Arc<Vec<f64>>>> {
    let path = root.join("times").join(format!("{stream}.json"));
    if !crate::source::is_regular_directory(&root.join("times"))
        || !crate::source::is_regular_file(&path)
    {
        return Ok(None);
    }
    let origin_path = root.join("states.jsonl");
    let key = Key {
        times: stamp(&path)?,
        origin: stamp(&origin_path)?,
        count: frame_count,
        fps: timeline_fps.to_bits(),
    };
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((old, frames)) = guard.get(&key.times.0) {
            if old == &key {
                return Ok(Some(frames.clone()));
            }
        }
    }
    let invalid =
        || AppError::Message("真实采集时间无效，已使用标称帧率；跨相机可能存在时间偏差".into());
    if frame_count == 0 || frame_count > MAX_FRAMES || key.times.1 > 16 * 1024 * 1024 {
        return Err(invalid());
    }
    let times: Times = serde_json::from_reader(BufReader::new(
        File::open(&path)?.take(16 * 1024 * 1024 + 1),
    ))?;
    if times.schema != "dohc.recording.stream-times.v1"
        || times.clock != "CLOCK_BOOTTIME"
        || times.unit != "ns"
        || times.stream != stream
        || times.timestamps_ns.len() as u64 != frame_count
        || times
            .timestamps_ns
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid());
    }
    let mut line = String::new();
    BufReader::new(File::open(&origin_path)?.take(128 * 1024)).read_line(&mut line)?;
    let origin: Origin = serde_json::from_str(&line)?;
    let batch = origin.frame_id.or(origin.batch_id).ok_or_else(invalid)?;
    let frames: Vec<_> = times
        .timestamps_ns
        .iter()
        .map(|time| {
            batch as f64
                + (*time as i128 - origin.capture_boottime_ns as i128) as f64 / 1e9 * timeline_fps
        })
        .collect();
    if frames.iter().any(|frame| {
        !frame.is_finite()
            || *frame < batch as f64 - timeline_fps
            || *frame > batch as f64 + 24.0 * 3600.0 * timeline_fps
    }) {
        return Err(invalid());
    }
    if key.times != stamp(&path)? || key.origin != stamp(&origin_path)? {
        return Err(AppError::Message(
            "采集时间文件在读取期间变化，请重新载入".into(),
        ));
    }
    let frames = Arc::new(frames);
    if let Ok(mut guard) = cache.lock() {
        guard.remove(&key.times.0);
        if guard.len() >= 28
            || guard
                .values()
                .map(|(_, frames)| frames.len())
                .sum::<usize>()
                + frames.len()
                > 2_000_000
        {
            guard.clear();
        }
        guard.insert(key.times.0.clone(), (key, frames.clone()));
    }
    Ok(Some(frames))
}

pub fn index_for(times: &[f64], frame: u64) -> u64 {
    times
        .partition_point(|time| *time <= frame as f64 + 1e-7)
        .saturating_sub(1) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_timestamps_map_dropped_frames_and_reject_mismatched_clock() {
        let root = std::env::temp_dir().join(format!(
            "delta-capture-clock-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("times")).unwrap();
        fs::write(
            root.join("states.jsonl"),
            "{\"batch_id\":20,\"capture_boottime_ns\":1000000000}\n",
        )
        .unwrap();
        let path = root.join("times/cam0.json");
        let value = serde_json::json!({"schema":"dohc.recording.stream-times.v1","clock":"CLOCK_BOOTTIME","unit":"ns","stream":"cam0","timestamps_ns":[1000000000_u64,1033333333,1100000000]});
        fs::write(&path, value.to_string()).unwrap();
        let times = load(&root, "cam0", 3, 30.0).unwrap().unwrap();
        let again = load(&root, "cam0", 3, 30.0).unwrap().unwrap();
        assert!(Arc::ptr_eq(&times, &again));
        assert!((times[2] - 23.0).abs() < 1e-6);
        assert_eq!(index_for(&times, 22), 1);
        assert_eq!(index_for(&times, 23), 2);
        assert!(load(&root, "cam0", 4, 30.0).is_err());
        fs::write(
            root.join("states.jsonl"),
            "{\"batch_id\":25,\"capture_boottime_ns\":1000000000}\n ",
        )
        .unwrap();
        let changed = load(&root, "cam0", 3, 30.0).unwrap().unwrap();
        assert!(!Arc::ptr_eq(&times, &changed));
        assert_eq!(changed[0], 25.0);
        let mut invalid = value.clone();
        invalid["clock"] = "UTC".into();
        fs::write(&path, invalid.to_string()).unwrap();
        assert!(load(&root, "cam0", 3, 30.0).is_err());
        invalid = value;
        invalid["timestamps_ns"] = serde_json::json!([1000000000_u64, 1000000000, 1100000000]);
        fs::write(&path, invalid.to_string()).unwrap();
        assert!(load(&root, "cam0", 3, 30.0).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
