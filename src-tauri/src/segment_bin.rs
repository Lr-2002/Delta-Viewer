use crate::error::{AppError, AppResult};
use crate::model::{RawStateRecord, Severity, ValidationIssue};
use crc32fast::Hasher;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const HEADER_MAGIC: &[u8; 4] = b"DHSG";
const TRAILER_MAGIC: &[u8; 4] = b"DHSC";
const FORMAT_VERSION: u8 = 1;
const HEADER_LEN: u64 = 48;
const TRAILER_LEN: u64 = 16;
const MAX_JPEG_PAYLOAD_LEN: u64 = 128 * 1024 * 1024;
const MAX_POSE_PAYLOAD_LEN: u64 = 1024 * 1024;
const LEFT_STREAM_ID: u8 = 4;
const RIGHT_STREAM_ID: u8 = 5;
const POSE_STREAM_ID: u8 = 6;

#[derive(Debug, Clone)]
pub struct SegmentFrame {
    pub frame_id: u64,
    pub segment_index: usize,
    pub record_offset: u64,
    pub payload_offset: u64,
    pub payload_len: u32,
    pub payload_crc32: u32,
    pub record_crc32: u32,
    stream_id: u8,
}

#[derive(Debug, Clone)]
pub struct SegmentEpisodeIndex {
    pub segment_paths: Vec<PathBuf>,
    pub streams: BTreeMap<String, Vec<SegmentFrame>>,
    pub states: Vec<RawStateRecord>,
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug)]
struct RecordHeader {
    bytes: [u8; HEADER_LEN as usize],
    stream_id: u8,
    batch_id: u64,
    persisted_index: u64,
    capture_time_ns: u64,
    payload_len: u32,
    payload_crc32: u32,
}

#[derive(Debug, Deserialize)]
struct PosePayload {
    batch_id: u64,
    persisted_index: u64,
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    pose: Option<PoseValues>,
}

#[derive(Debug, Deserialize)]
struct PoseValues {
    #[serde(default)]
    position: Option<[Option<f64>; 3]>,
    #[serde(default)]
    velocity: [f64; 3],
    #[serde(default)]
    quaternion: [f64; 4],
    #[serde(default)]
    euler: [f64; 3],
    #[serde(default)]
    omega: [f64; 3],
    #[serde(default)]
    confidence: f64,
}

pub fn segment_number_from_name(name: &OsStr) -> Option<u64> {
    let name = name.to_str()?;
    let digits = name.strip_prefix("segment-")?.strip_suffix(".bin")?;
    if digits.is_empty() || !digits.bytes().all(|value| value.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

pub fn is_segment_folder(root: &Path) -> bool {
    fs::read_dir(root).ok().is_some_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            entry
                .file_type()
                .ok()
                .is_some_and(|file_type| file_type.is_file())
                && segment_number_from_name(&entry.file_name()).is_some()
        })
    })
}

pub fn scan_segment_folder(
    root: &Path,
    cancelled: &AtomicBool,
) -> AppResult<Option<SegmentEpisodeIndex>> {
    let mut numbered_paths = Vec::new();
    let mut invalid_names = Vec::new();
    for entry in fs::read_dir(root)? {
        check_cancelled(cancelled)?;
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        if let Some(number) = segment_number_from_name(&name) {
            numbered_paths.push((number, entry.path()));
        } else if name
            .to_str()
            .is_some_and(|name| name.starts_with("segment-") && name.ends_with(".bin"))
        {
            invalid_names.push(name.to_string_lossy().into_owned());
        }
    }
    if numbered_paths.is_empty() {
        return Ok(None);
    }
    numbered_paths.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.as_os_str().cmp(right.1.as_os_str()))
    });

    let mut issues = invalid_names
        .into_iter()
        .map(|name| {
            issue(
                Severity::Warning,
                "INVALID_SEGMENT_FILENAME",
                "segments",
                format!("已忽略无法解析数值编号的 segment 文件: {name}"),
                None,
            )
        })
        .collect::<Vec<_>>();
    if let Some((first_number, _)) = numbered_paths.first() {
        if *first_number != 0 {
            issues.push(issue(
                Severity::Warning,
                "SEGMENT_SEQUENCE_GAP",
                "segments",
                format!("首个 segment 编号为 {first_number}，预期从 0 开始"),
                None,
            ));
        }
    }
    for pair in numbered_paths.windows(2) {
        if pair[0].0 == pair[1].0 {
            issues.push(issue(
                Severity::Error,
                "DUPLICATE_SEGMENT_NUMBER",
                "segments",
                format!(
                    "segment 编号 {} 重复: {} 与 {}",
                    pair[0].0,
                    file_name(&pair[0].1),
                    file_name(&pair[1].1)
                ),
                None,
            ));
        } else if pair[1].0 > pair[0].0 + 1 {
            issues.push(issue(
                Severity::Warning,
                "SEGMENT_SEQUENCE_GAP",
                "segments",
                format!("segment 编号不连续: {} 后直接出现 {}", pair[0].0, pair[1].0),
                None,
            ));
        }
    }

    let segment_paths = numbered_paths
        .iter()
        .map(|(_, path)| path.clone())
        .collect::<Vec<_>>();
    let mut streams = BTreeMap::<String, Vec<SegmentFrame>>::new();
    let mut states = Vec::new();
    let mut previous_batch = None;

    for (segment_index, (_, path)) in numbered_paths.iter().enumerate() {
        check_cancelled(cancelled)?;
        scan_segment_file(
            path,
            segment_index,
            &mut streams,
            &mut states,
            &mut issues,
            &mut previous_batch,
            cancelled,
        )?;
    }

    for (stream_name, frames) in &mut streams {
        frames.sort_by_key(|frame| frame.frame_id);
        for pair in frames.windows(2) {
            if pair[0].frame_id == pair[1].frame_id {
                issues.push(issue(
                    Severity::Error,
                    "DUPLICATE_FRAME_ID",
                    stream_name,
                    format!("多个 segment 记录映射到帧 {}", pair[0].frame_id),
                    i64::try_from(pair[0].frame_id).ok(),
                ));
            }
        }
    }
    states.sort_by_key(|state| state.frame_id);
    for pair in states.windows(2) {
        if pair[0].frame_id == pair[1].frame_id {
            issues.push(issue(
                Severity::Error,
                "DUPLICATE_FRAME_ID",
                "states",
                format!("多个 segment pose 记录映射到帧 {}", pair[0].frame_id),
                Some(pair[0].frame_id),
            ));
        }
    }

    Ok(Some(SegmentEpisodeIndex {
        segment_paths,
        streams,
        states,
        issues,
    }))
}

#[allow(clippy::too_many_arguments)]
fn scan_segment_file(
    path: &Path,
    segment_index: usize,
    streams: &mut BTreeMap<String, Vec<SegmentFrame>>,
    states: &mut Vec<RawStateRecord>,
    issues: &mut Vec<ValidationIssue>,
    previous_batch: &mut Option<u64>,
    cancelled: &AtomicBool,
) -> AppResult<()> {
    let file_len = fs::metadata(path)?.len();
    if file_len == 0 {
        return Err(segment_error(path, 0, "segment 文件为空"));
    }
    let mut file = File::open(path)?;
    let mut offset = 0_u64;
    let mut record_count = 0_u64;
    while offset < file_len {
        check_cancelled(cancelled)?;
        if file_len - offset < HEADER_LEN + TRAILER_LEN {
            return Err(segment_error(path, offset, "记录头或尾被截断"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let header = read_header(&mut file, path, offset)?;
        let payload_offset = offset + HEADER_LEN;
        let payload_end = payload_offset
            .checked_add(u64::from(header.payload_len))
            .ok_or_else(|| segment_error(path, offset, "payload 长度溢出"))?;
        let record_end = payload_end
            .checked_add(TRAILER_LEN)
            .ok_or_else(|| segment_error(path, offset, "记录长度溢出"))?;
        if record_end > file_len {
            return Err(segment_error(
                path,
                offset,
                format!(
                    "记录声明长度 {} 超出文件剩余长度 {}",
                    record_end - offset,
                    file_len - offset
                ),
            ));
        }
        let max_payload = if header.stream_id == POSE_STREAM_ID {
            MAX_POSE_PAYLOAD_LEN
        } else {
            MAX_JPEG_PAYLOAD_LEN
        };
        if u64::from(header.payload_len) > max_payload {
            return Err(segment_error(
                path,
                offset,
                format!("payload 长度 {} 超过安全上限", header.payload_len),
            ));
        }

        let payload = if header.stream_id == POSE_STREAM_ID {
            let mut payload = vec![0; header.payload_len as usize];
            read_exact_context(
                &mut file,
                &mut payload,
                path,
                payload_offset,
                "pose payload",
            )?;
            Some(payload)
        } else {
            verify_jpeg_boundaries(&mut file, path, payload_offset, header.payload_len)?;
            file.seek(SeekFrom::Start(payload_end))?;
            None
        };
        let (trailer_batch_id, record_crc32) = read_trailer(&mut file, path, payload_end)?;
        if trailer_batch_id != header.batch_id {
            return Err(segment_error(
                path,
                offset,
                format!(
                    "记录头 batch_id {} 与记录尾 batch_id {} 不一致",
                    header.batch_id, trailer_batch_id
                ),
            ));
        }

        match header.stream_id {
            LEFT_STREAM_ID | RIGHT_STREAM_ID => {
                let stream_name = stream_name(header.stream_id).expect("known image stream");
                streams
                    .entry(stream_name.to_string())
                    .or_default()
                    .push(SegmentFrame {
                        frame_id: header.batch_id,
                        segment_index,
                        record_offset: offset,
                        payload_offset,
                        payload_len: header.payload_len,
                        payload_crc32: header.payload_crc32,
                        record_crc32,
                        stream_id: header.stream_id,
                    });
            }
            POSE_STREAM_ID => {
                let payload = payload.expect("pose payload was read");
                verify_record_crc(path, offset, &header, &payload, record_crc32)?;
                states.push(parse_pose_payload(path, offset, &header, &payload)?);
            }
            unsupported => {
                issues.push(issue(
                    Severity::Warning,
                    "UNSUPPORTED_SEGMENT_STREAM",
                    "segments",
                    format!(
                        "{} 字节偏移 {} 的流编号 {} 当前不支持，已忽略",
                        file_name(path),
                        offset,
                        unsupported
                    ),
                    i64::try_from(header.batch_id).ok(),
                ));
            }
        }
        if previous_batch.is_some_and(|batch| header.batch_id < batch) {
            issues.push(issue(
                Severity::Warning,
                "SEGMENT_BATCH_ORDER",
                "segments",
                format!(
                    "{} 字节偏移 {} 的 batch_id {} 小于之前记录",
                    file_name(path),
                    offset,
                    header.batch_id
                ),
                i64::try_from(header.batch_id).ok(),
            ));
        }
        *previous_batch = Some(header.batch_id);
        offset = record_end;
        record_count += 1;
    }
    if record_count == 0 {
        return Err(segment_error(path, 0, "segment 中没有记录"));
    }
    Ok(())
}

pub fn read_frame_payload(
    index: &SegmentEpisodeIndex,
    stream: &str,
    frame_id: u64,
) -> AppResult<Vec<u8>> {
    let frames = index
        .streams
        .get(stream)
        .ok_or_else(|| AppError::MissingPath(format!("segment 流 {stream}")))?;
    let position = frames
        .binary_search_by_key(&frame_id, |frame| frame.frame_id)
        .map_err(|_| AppError::MissingPath(format!("{stream} segment 帧 {frame_id}")))?;
    read_frame_at(index, &frames[position])
}

pub fn read_frame_at(index: &SegmentEpisodeIndex, frame: &SegmentFrame) -> AppResult<Vec<u8>> {
    let path = index
        .segment_paths
        .get(frame.segment_index)
        .ok_or_else(|| {
            AppError::Message(format!(
                "SEGMENT_INDEX_INVALID: 帧 {} 的 segment 索引无效",
                frame.frame_id
            ))
        })?;
    let mut file = File::open(path).map_err(|error| {
        segment_error(
            path,
            frame.record_offset,
            format!("无法打开 segment: {error}"),
        )
    })?;
    file.seek(SeekFrom::Start(frame.record_offset))?;
    let header = read_header(&mut file, path, frame.record_offset)?;
    if header.batch_id != frame.frame_id
        || header.stream_id != frame.stream_id
        || header.payload_len != frame.payload_len
        || header.payload_crc32 != frame.payload_crc32
        || frame.payload_offset != frame.record_offset + HEADER_LEN
    {
        return Err(segment_error(
            path,
            frame.record_offset,
            "记录索引与当前文件内容不一致，请重新扫描",
        ));
    }
    let mut payload = vec![0; frame.payload_len as usize];
    read_exact_context(
        &mut file,
        &mut payload,
        path,
        frame.payload_offset,
        "JPEG payload",
    )?;
    let (trailer_batch_id, record_crc32) = read_trailer(
        &mut file,
        path,
        frame.payload_offset + u64::from(frame.payload_len),
    )?;
    if trailer_batch_id != frame.frame_id || record_crc32 != frame.record_crc32 {
        return Err(segment_error(
            path,
            frame.record_offset,
            "记录尾与索引不一致，请重新扫描",
        ));
    }
    verify_record_crc(path, frame.record_offset, &header, &payload, record_crc32)?;
    if payload.len() < 4 || !payload.starts_with(&[0xff, 0xd8]) || !payload.ends_with(&[0xff, 0xd9])
    {
        return Err(segment_error(
            path,
            frame.record_offset,
            "图像 payload 不是完整 JPEG",
        ));
    }
    Ok(payload)
}

fn read_header(file: &mut File, path: &Path, offset: u64) -> AppResult<RecordHeader> {
    let mut bytes = [0_u8; HEADER_LEN as usize];
    read_exact_context(file, &mut bytes, path, offset, "记录头")?;
    if &bytes[0..4] != HEADER_MAGIC {
        return Err(segment_error(path, offset, "记录头 magic 不是 DHSG"));
    }
    if bytes[4] != FORMAT_VERSION {
        return Err(segment_error(
            path,
            offset,
            format!("不支持 segment 记录版本 {}", bytes[4]),
        ));
    }
    if le_u16(&bytes[6..8]) != HEADER_LEN as u16 {
        return Err(segment_error(path, offset, "记录头长度不是 48 字节"));
    }
    Ok(RecordHeader {
        stream_id: bytes[5],
        batch_id: le_u64(&bytes[8..16]),
        persisted_index: le_u64(&bytes[16..24]),
        capture_time_ns: le_u64(&bytes[24..32]),
        payload_len: le_u32(&bytes[40..44]),
        payload_crc32: le_u32(&bytes[44..48]),
        bytes,
    })
}

fn read_trailer(file: &mut File, path: &Path, offset: u64) -> AppResult<(u64, u32)> {
    let mut bytes = [0_u8; TRAILER_LEN as usize];
    read_exact_context(file, &mut bytes, path, offset, "记录尾")?;
    if &bytes[0..4] != TRAILER_MAGIC {
        return Err(segment_error(path, offset, "记录尾 magic 不是 DHSC"));
    }
    Ok((le_u64(&bytes[4..12]), le_u32(&bytes[12..16])))
}

fn verify_jpeg_boundaries(
    file: &mut File,
    path: &Path,
    payload_offset: u64,
    payload_len: u32,
) -> AppResult<()> {
    if payload_len < 4 {
        return Err(segment_error(
            path,
            payload_offset,
            "JPEG payload 长度小于 4",
        ));
    }
    let mut marker = [0_u8; 2];
    file.seek(SeekFrom::Start(payload_offset))?;
    read_exact_context(file, &mut marker, path, payload_offset, "JPEG 起始标记")?;
    if marker != [0xff, 0xd8] {
        return Err(segment_error(
            path,
            payload_offset,
            "JPEG 缺少 SOI 起始标记",
        ));
    }
    let end_offset = payload_offset + u64::from(payload_len) - 2;
    file.seek(SeekFrom::Start(end_offset))?;
    read_exact_context(file, &mut marker, path, end_offset, "JPEG 结束标记")?;
    if marker != [0xff, 0xd9] {
        return Err(segment_error(path, end_offset, "JPEG 缺少 EOI 结束标记"));
    }
    Ok(())
}

fn verify_record_crc(
    path: &Path,
    offset: u64,
    header: &RecordHeader,
    payload: &[u8],
    expected_record_crc32: u32,
) -> AppResult<()> {
    if crc32fast::hash(payload) != header.payload_crc32 {
        return Err(segment_error(path, offset, "payload CRC32 校验失败"));
    }
    let mut hasher = Hasher::new();
    hasher.update(&header.bytes);
    hasher.update(payload);
    if hasher.finalize() != expected_record_crc32 {
        return Err(segment_error(path, offset, "记录 CRC32 校验失败"));
    }
    Ok(())
}

fn parse_pose_payload(
    path: &Path,
    offset: u64,
    header: &RecordHeader,
    payload: &[u8],
) -> AppResult<RawStateRecord> {
    let decoded: PosePayload = serde_json::from_slice(payload)
        .map_err(|error| segment_error(path, offset, format!("pose JSON 无法解析: {error}")))?;
    if decoded.batch_id != header.batch_id || decoded.persisted_index != header.persisted_index {
        return Err(segment_error(
            path,
            offset,
            "pose JSON 的 batch_id/persisted_index 与记录头不一致",
        ));
    }
    if decoded
        .schema
        .as_deref()
        .is_some_and(|schema| schema != "dohc.recording.jpeg-segment.pose.v1")
    {
        return Err(segment_error(path, offset, "不支持 pose JSON schema"));
    }
    let frame_id = i64::try_from(header.batch_id)
        .map_err(|_| segment_error(path, offset, "batch_id 超出 int64 范围"))?;
    let capture_time_ns = i64::try_from(header.capture_time_ns)
        .map_err(|_| segment_error(path, offset, "capture_time_ns 超出 int64 范围"))?;
    let pose = decoded.pose;
    Ok(RawStateRecord {
        frame_id,
        capture_time_ns,
        position: pose.as_ref().and_then(|value| value.position),
        velocity: pose.as_ref().map_or([0.0; 3], |value| value.velocity),
        quaternion: pose
            .as_ref()
            .map_or([0.0, 0.0, 0.0, 1.0], |value| value.quaternion),
        euler: pose.as_ref().map_or([0.0; 3], |value| value.euler),
        omega: pose.as_ref().map_or([0.0; 3], |value| value.omega),
        confidence: pose.as_ref().map_or(0.0, |value| value.confidence),
    })
}

fn stream_name(stream_id: u8) -> Option<&'static str> {
    match stream_id {
        LEFT_STREAM_ID => Some("t265_left"),
        RIGHT_STREAM_ID => Some("t265_right"),
        _ => None,
    }
}

fn read_exact_context(
    file: &mut File,
    bytes: &mut [u8],
    path: &Path,
    offset: u64,
    scope: &str,
) -> AppResult<()> {
    file.read_exact(bytes)
        .map_err(|error| segment_error(path, offset, format!("{scope} 无法读取: {error}")))
}

fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

fn segment_error(path: &Path, offset: u64, message: impl AsRef<str>) -> AppError {
    AppError::Message(format!(
        "SEGMENT_BIN_INVALID: {} 字节偏移 {}: {}",
        file_name(path),
        offset,
        message.as_ref()
    ))
}

fn issue(
    severity: Severity,
    code: &str,
    scope: impl Into<String>,
    message: impl Into<String>,
    frame_id: Option<i64>,
) -> ValidationIssue {
    ValidationIssue {
        severity,
        code: code.into(),
        scope: scope.into(),
        message: message.into(),
        frame_id,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("segment.bin")
        .to_string()
}

fn le_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().expect("two bytes"))
}

fn le_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four bytes"))
}

fn le_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("eight bytes"))
}

#[cfg(test)]
pub(crate) fn write_test_segment(path: &Path, batch_id: u64) {
    use image::codecs::jpeg::JpegEncoder;
    use image::ExtendedColorType;
    use std::io::Write as _;

    let mut jpeg = Vec::new();
    JpegEncoder::new(&mut jpeg)
        .encode(&[batch_id as u8], 1, 1, ExtendedColorType::L8)
        .unwrap();
    let pose = serde_json::json!({
        "batch_id": batch_id,
        "persisted_index": batch_id,
        "pose": {
            "position": [batch_id as f64, 0.0, 0.0],
            "velocity": [0.0, 0.0, 0.0],
            "quaternion": [0.0, 0.0, 0.0, 1.0],
            "euler": [0.0, 0.0, 0.0],
            "omega": [0.0, 0.0, 0.0],
            "confidence": 3.0
        },
        "schema": "dohc.recording.jpeg-segment.pose.v1"
    });
    let mut pose = serde_json::to_vec(&pose).unwrap();
    pose.push(b'\n');
    let mut file = File::create(path).unwrap();
    for (stream_id, payload) in [(4, jpeg.as_slice()), (5, jpeg.as_slice()), (6, &pose)] {
        let mut header = [0_u8; 48];
        header[0..4].copy_from_slice(b"DHSG");
        header[4] = 1;
        header[5] = stream_id;
        header[6..8].copy_from_slice(&48_u16.to_le_bytes());
        header[8..16].copy_from_slice(&batch_id.to_le_bytes());
        header[16..24].copy_from_slice(&batch_id.to_le_bytes());
        header[24..32].copy_from_slice(&(1_000_000_000 + batch_id).to_le_bytes());
        header[32..40].copy_from_slice(&batch_id.to_le_bytes());
        header[40..44].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        header[44..48].copy_from_slice(&crc32fast::hash(payload).to_le_bytes());
        let mut record_hasher = Hasher::new();
        record_hasher.update(&header);
        record_hasher.update(payload);
        let mut trailer = [0_u8; 16];
        trailer[0..4].copy_from_slice(b"DHSC");
        trailer[4..12].copy_from_slice(&batch_id.to_le_bytes());
        trailer[12..16].copy_from_slice(&record_hasher.finalize().to_le_bytes());
        file.write_all(&header).unwrap();
        file.write_all(payload).unwrap();
        file.write_all(&trailer).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::{read_frame_payload, scan_segment_folder, write_test_segment};
    use std::fs::{self, OpenOptions};
    use std::io::{Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sorts_segments_numerically_and_combines_their_records() {
        let root = test_output("numeric-order");
        fs::create_dir(&root).unwrap();
        write_test_segment(&root.join("segment-10.bin"), 2);
        write_test_segment(&root.join("segment-2.bin"), 1);
        fs::write(root.join("notes.txt"), b"ignored").unwrap();

        let index = scan_segment_folder(&root, &AtomicBool::new(false))
            .unwrap()
            .unwrap();

        assert_eq!(
            index
                .segment_paths
                .iter()
                .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["segment-2.bin", "segment-10.bin"]
        );
        assert_eq!(
            index
                .states
                .iter()
                .map(|state| state.frame_id)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(index.streams["t265_left"].len(), 2);
        assert_eq!(index.streams["t265_right"].len(), 2);
        assert!(index
            .issues
            .iter()
            .any(|issue| issue.code == "SEGMENT_SEQUENCE_GAP"));
        assert_eq!(
            read_frame_payload(&index, "t265_left", 2).unwrap()[..2],
            [0xff, 0xd8]
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn warns_about_invalid_segment_names_and_rejects_corrupt_payloads() {
        let root = test_output("corrupt");
        fs::create_dir(&root).unwrap();
        let path = root.join("segment-000000.bin");
        write_test_segment(&path, 1);
        fs::write(root.join("segment-bad.bin"), b"ignored").unwrap();

        let index = scan_segment_folder(&root, &AtomicBool::new(false))
            .unwrap()
            .unwrap();
        assert!(index
            .issues
            .iter()
            .any(|issue| issue.code == "INVALID_SEGMENT_FILENAME"));
        let frame = &index.streams["t265_left"][0];
        let mut file = OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(frame.payload_offset + 8))
            .unwrap();
        file.write_all(&[0xff]).unwrap();
        drop(file);

        let error = read_frame_payload(&index, "t265_left", 1).unwrap_err();
        assert!(error.to_string().contains("CRC32"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_truncated_segment_without_panicking() {
        let root = test_output("truncated");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("segment-000000.bin"), b"DHSG").unwrap();

        let error = scan_segment_folder(&root, &AtomicBool::new(false)).unwrap_err();
        assert!(error.to_string().contains("截断"));

        fs::remove_dir_all(root).unwrap();
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-segment-bin-{label}-{nonce}"))
    }
}
