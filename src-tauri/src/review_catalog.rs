use crate::error::{AppError, AppResult};
use crate::{machine_annotation, source, storage};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRow {
    pub path: String,
    pub status: String,
    pub reviewer: String,
    pub qc: String,
    pub original_seconds: Option<f64>,
    pub effective_seconds: Option<f64>,
    pub timing_source: String,
    pub error: String,
    #[serde(skip)]
    fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCatalog {
    pub scan_id: String,
    pub source_root: String,
    pub scanned_at_ms: u64,
    pub rows: Vec<ReviewRow>,
    pub approved: usize,
    pub rejected: usize,
    pub pending: usize,
    pub errors: usize,
    pub original_seconds: f64,
    pub approved_original_seconds: f64,
    pub effective_seconds: f64,
    pub unknown_original: usize,
    pub unknown_effective: usize,
}

#[derive(Default)]
pub struct ReviewCatalogCache(pub Mutex<Option<(String, ReviewCatalog)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewExport {
    pub output_path: String,
    pub sessions: usize,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
}

fn fail(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}
fn check(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}
fn json(path: &Path) -> AppResult<Option<Value>> {
    machine_annotation::read_bytes(path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(Into::into))
        .transpose()
}
fn regular_directory(path: &Path) -> AppResult<PathBuf> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(fail("请选择普通目录或已挂载共享目录"));
    }
    Ok(fs::canonicalize(path)?)
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn transient(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    matches!(name.as_ref(), ".git" | "@eaDir" | ".DS_Store" | "Thumbs.db")
        || (name.starts_with('.') && (name.ends_with(".lock") || name.contains(".partial-")))
}

// Snapshot every copied file's identity/size/mtime; detect added, removed or changed files.
fn tree_snapshot(root: &Path, cancelled: &AtomicBool) -> AppResult<String> {
    let mut hash = blake3::Hasher::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| !transient(entry))
    {
        check(cancelled)?;
        let entry = entry.map_err(|error| fail(error.to_string()))?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if is_link(&metadata) {
            return Err(fail(format!("数据包含链接：{}", entry.path().display())));
        }
        if !metadata.is_dir() && !metadata.is_file() {
            return Err(fail("数据包含非普通文件"));
        }
        // Directory mtimes include excluded temporary lock/partial creation.
        hash.update(
            entry
                .path()
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .as_bytes(),
        );
        if metadata.is_file() {
            hash.update(&metadata.len().to_le_bytes());
            hash.update(
                &metadata
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
                    .to_le_bytes(),
            );
        }
    }
    Ok(hash.finalize().to_hex().to_string())
}

fn skip(entry: &walkdir::DirEntry) -> bool {
    matches!(
        entry.file_name().to_str(),
        Some(".session_meta" | "@eaDir" | ".git")
    )
}

pub fn scan(
    root: &Path,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64, &str),
) -> AppResult<ReviewCatalog> {
    let root = regular_directory(root)?;
    let mut rows = Vec::new();
    let mut directories = std::collections::BTreeSet::new();
    let mut visited = 0u64;
    progress(0, "正在查找 session");
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !skip(entry))
    {
        check(cancelled)?;
        let entry = entry.map_err(|error| fail(format!("目录扫描不完整：{error}")))?;
        visited += 1;
        if visited.is_multiple_of(500) {
            progress(visited, &entry.path().to_string_lossy());
        }
        if is_link(&fs::symlink_metadata(entry.path())?) {
            return Err(fail(format!(
                "目录扫描不完整，包含链接：{}",
                entry.path().display()
            )));
        }
        if entry.file_type().is_dir()
            && entry
                .path()
                .join(".session_meta/manifest.json")
                .try_exists()?
        {
            directories.insert(entry.path().to_path_buf());
        }
        if entry.file_type().is_file()
            && matches!(
                entry.file_name().to_str(),
                Some("session.json" | "states.jsonl" | "manifest.json")
            )
            && (entry.file_name() != "manifest.json"
                || json(entry.path())
                    .ok()
                    .flatten()
                    .is_some_and(|value| value["streams"].is_object()))
        {
            directories.insert(entry.path().parent().unwrap().to_path_buf());
        }
    }
    for directory in directories {
        check(cancelled)?;
        let mut row = inspect(&directory, cancelled)?;
        row.path = directory
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if row.path.is_empty() {
            row.path = ".".into();
        }
        progress(rows.len() as u64 + 1, &row.path);
        rows.push(row);
    }
    let mut catalog = ReviewCatalog {
        scan_id: String::new(),
        source_root: root.to_string_lossy().into_owned(),
        scanned_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        approved: 0,
        rejected: 0,
        pending: 0,
        errors: 0,
        original_seconds: 0.0,
        approved_original_seconds: 0.0,
        effective_seconds: 0.0,
        unknown_original: 0,
        unknown_effective: 0,
        rows,
    };
    let mut hash = blake3::Hasher::new();
    hash.update(catalog.source_root.as_bytes());
    for row in &catalog.rows {
        hash.update(&serde_json::to_vec(row)?);
        hash.update(row.fingerprint.as_bytes());
        if !row.error.is_empty() {
            catalog.errors += 1;
        }
        match row.status.as_str() {
            "approved" => catalog.approved += 1,
            "rejected" => catalog.rejected += 1,
            _ => catalog.pending += 1,
        }
        if let Some(seconds) = row.original_seconds {
            catalog.original_seconds += seconds;
        } else {
            catalog.unknown_original += 1;
        }
        if row.status == "approved" {
            if let Some(seconds) = row.original_seconds {
                catalog.approved_original_seconds += seconds;
            }
            if let Some(seconds) = row.effective_seconds {
                catalog.effective_seconds += seconds;
            } else {
                catalog.unknown_effective += 1;
            }
        }
    }
    catalog.scan_id = hash.finalize().to_hex().to_string();
    Ok(catalog)
}

fn inspect(root: &Path, cancelled: &AtomicBool) -> AppResult<ReviewRow> {
    let mut row = ReviewRow {
        path: String::new(),
        status: "pending".into(),
        reviewer: String::new(),
        qc: String::new(),
        original_seconds: None,
        effective_seconds: None,
        timing_source: String::new(),
        error: String::new(),
        fingerprint: String::new(),
    };
    let mut hash = blake3::Hasher::new();
    for name in [
        "session.json",
        "description.json",
        "manifest.json",
        ".session_meta/manifest.json",
    ] {
        if name.starts_with(".session_meta/")
            && root.join(".session_meta").exists()
            && regular_directory(&root.join(".session_meta")).is_err()
        {
            row.error = "元数据目录不可为链接".into();
            return Ok(row);
        }
        match machine_annotation::read_bytes(&root.join(name)) {
            Ok(Some(bytes)) => {
                hash.update(name.as_bytes());
                hash.update(&bytes);
            }
            Ok(None) => {}
            Err(error) => {
                hash.update(error.to_string().as_bytes());
            }
        }
    }
    row.fingerprint = hash.finalize().to_hex().to_string();
    let session = match json(&root.join("session.json")) {
        Ok(Some(value)) if value.is_object() => value,
        Ok(None) => {
            row.error = "缺少 session.json".into();
            Value::Null
        }
        Ok(_) => {
            row.error = "session.json 不是对象".into();
            Value::Null
        }
        Err(error) => {
            row.error = format!("session.json：{error}");
            Value::Null
        }
    };
    row.qc = session["qc"].as_str().unwrap_or("").into();
    row.status = match row.qc.trim() {
        "通过" => "approved",
        value
            if value == "不通过"
                || value.starts_with("不通过：")
                || value.starts_with("不通过:") =>
        {
            "rejected"
        }
        _ => "pending",
    }
    .into();
    row.reviewer = session["reviewerName"]
        .as_str()
        .or(session["reviewerUsername"].as_str())
        .unwrap_or("")
        .into();
    let timing = timing(root, cancelled);
    match timing {
        Ok((frames, seconds, label)) => {
            row.original_seconds = Some(seconds);
            row.timing_source = label;
            if row.status == "approved" {
                match effective(root, frames, seconds) {
                    Ok(value) => row.effective_seconds = Some(value),
                    Err(error) => {
                        row.error.push_str(&format!(" {error}"));
                    }
                }
            }
        }
        Err(AppError::Cancelled) => return Err(AppError::Cancelled),
        Err(error) => {
            row.error.push_str(&format!(" {error}"));
        }
    }
    Ok(row)
}

fn timing(root: &Path, cancelled: &AtomicBool) -> AppResult<(u64, f64, String)> {
    for name in ["manifest.json", ".session_meta/manifest.json"] {
        if let Some(value) = json(&root.join(name))? {
            let camera = &value["streams"]["cam0"];
            if let (Some(frames), Some(fps)) =
                (camera["frame_count"].as_u64(), camera["fps"].as_f64())
            {
                if frames > 0 && fps.is_finite() && fps > 0.0 && (frames as f64 / fps).is_finite() {
                    return Ok((frames, frames as f64 / fps, "Camera 0 帧数 / FPS".into()));
                }
            }
        }
    }
    let summary = source::scan_episode(root, None, cancelled)?;
    let camera = summary
        .streams
        .iter()
        .find(|stream| stream.name == "cam0")
        .ok_or_else(|| fail("缺少 Camera 0"))?;
    let (start, end) = summary
        .start_time_ns
        .as_deref()
        .zip(summary.end_time_ns.as_deref())
        .ok_or_else(|| fail("缺少原始时间戳或帧率"))?;
    let start: i128 = start.parse().map_err(|_| fail("原始时间戳无效"))?;
    let end: i128 = end.parse().map_err(|_| fail("原始时间戳无效"))?;
    if end <= start || camera.frame_count < 2 || summary.state_count < 2 {
        return Err(fail("原始时间范围无效"));
    }
    let seconds = (end - start) as f64 / 1e9;
    // A frame occupies one interval; include the last frame without adding camera streams.
    Ok((
        camera.frame_count,
        seconds * summary.state_count as f64 / (summary.state_count - 1) as f64,
        "采集时间戳（含末帧，估算）".into(),
    ))
}

fn effective(root: &Path, frames: u64, seconds: f64) -> AppResult<f64> {
    let document = json(&root.join("description.json"))?
        .ok_or_else(|| fail("缺少人工审核 description.json"))?;
    let review = &document["_human_review"];
    if review["status"].as_str() != Some("approved") {
        return Err(fail("QC 与人工审核结论不一致"));
    }
    let episodes = document["episode_results"]
        .as_array()
        .ok_or_else(|| fail("人工审核缺少视频帧数"))?;
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let matching: Vec<_> = episodes
        .iter()
        .filter(|episode| episode["episode_id"].as_str() == Some(name))
        .collect();
    let episode = if matching.len() == 1 {
        matching[0]
    } else if episodes.len() == 1 {
        &episodes[0]
    } else {
        return Err(fail("无法唯一匹配当前 session 的人工结果"));
    };
    if episode["media"]["frame_count"].as_u64() != Some(frames) {
        return Err(fail("人工审核与原始视频帧数不一致"));
    }
    let segments = review["segments"]
        .as_array()
        .ok_or_else(|| fail("缺少人工保留片段"))?;
    let mut ranges = Vec::new();
    for segment in segments {
        if segment["deleted"].as_bool() == Some(true) {
            continue;
        }
        let start = segment["startFrame"]
            .as_u64()
            .ok_or_else(|| fail("人工片段起始帧无效"))?;
        let end = segment["endFrame"]
            .as_u64()
            .ok_or_else(|| fail("人工片段结束帧无效"))?;
        if start > end || end >= frames {
            return Err(fail("人工片段超出视频范围"));
        }
        ranges.push((start, end + 1));
    }
    if ranges.is_empty() {
        return Err(fail("通过数据没有人工保留片段"));
    }
    ranges.sort_unstable();
    let (mut count, mut last_end) = (0, 0);
    for (start, end) in ranges {
        count += end.saturating_sub(start.max(last_end));
        last_end = last_end.max(end);
    }
    Ok(count as f64 * seconds / frames as f64)
}

pub fn export(
    catalog: &ReviewCatalog,
    destination: &Path,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64, &str),
) -> AppResult<ReviewExport> {
    let started = Instant::now();
    let root = regular_directory(Path::new(&catalog.source_root))?;
    let destination = regular_directory(destination)?;
    if destination.starts_with(&root) || root.starts_with(&destination) {
        return Err(fail("源目录与导出目录不能互相包含"));
    }
    let fresh = scan(&root, cancelled, progress)?;
    if fresh.scan_id != catalog.scan_id {
        return Err(fail("QC 或人工裁剪已变化，请重新扫描后导出"));
    }
    if fresh.approved == 0 {
        return Err(fail("没有通过的数据"));
    }
    if fresh
        .rows
        .iter()
        .any(|row| row.status == "approved" && !row.error.is_empty())
    {
        return Err(fail("通过数据存在核验异常，请先处理异常再导出"));
    }
    let name = format!(
        "dohc-approved-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let output = destination.join(&name);
    let partial = destination.join(format!(".{name}.partial"));
    fs::create_dir(&partial)?;
    let result = (|| {
        let mut total_bytes = 0;
        for row in fresh.rows.iter().filter(|row| row.status == "approved") {
            check(cancelled)?;
            let source = root.join(&row.path);
            let target = partial.join("sessions").join(if row.path == "." {
                "session"
            } else {
                &row.path
            });
            let snapshot = tree_snapshot(&source, cancelled)?;
            for entry in WalkDir::new(&source)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| !transient(entry))
            {
                check(cancelled)?;
                let entry = entry.map_err(|error| fail(error.to_string()))?;
                let relative = entry.path().strip_prefix(&source).unwrap();
                if is_link(&fs::symlink_metadata(entry.path())?) {
                    return Err(fail(format!("不复制链接：{}", entry.path().display())));
                }
                if entry.file_type().is_dir() {
                    fs::create_dir_all(target.join(relative))?;
                    continue;
                }
                if !entry.file_type().is_file() {
                    return Err(fail("数据包含非普通文件"));
                }
                if entry.file_name() == "session.json"
                    && relative != Path::new("session.json")
                    && !relative.starts_with(".session_meta")
                {
                    return Err(fail("session 目录嵌套，无法确定导出边界"));
                }
                total_bytes += copy_verified(entry.path(), &target.join(relative), cancelled)?;
                progress(total_bytes, &row.path);
            }
            if tree_snapshot(&source, cancelled)? != snapshot {
                return Err(fail("复制期间源数据发生变化，请重新扫描"));
            }
            if inspect(&source, cancelled)?.fingerprint != row.fingerprint {
                return Err(fail("复制期间审核记录发生变化，请重新扫描"));
            }
        }
        let end_scan = scan(&root, cancelled, progress)?;
        if end_scan.scan_id != fresh.scan_id {
            return Err(fail("导出期间审核记录发生变化，请重新扫描"));
        }
        let mut manifest = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(partial.join("review-manifest.json"))?;
        serde_json::to_writer_pretty(&mut manifest, &fresh)?;
        manifest.sync_all()?;
        check(cancelled)?;
        storage::publish_noreplace(&partial, &output)?;
        Ok(ReviewExport {
            output_path: output.to_string_lossy().into_owned(),
            sessions: fresh.approved,
            total_bytes,
            elapsed_ms: started.elapsed().as_millis(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    result
}

fn copy_verified(source: &Path, target: &Path, cancelled: &AtomicBool) -> AppResult<u64> {
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(fail("源文件必须为普通文件"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut input = options.open(source)?;
    let before = input.metadata()?;
    if !before.is_file() || is_link(&before) {
        return Err(fail("源文件类型在复制前变化"));
    }
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)?;
    let mut buffer = vec![0; 1024 * 1024];
    let mut hash = blake3::Hasher::new();
    let mut bytes = 0;
    loop {
        check(cancelled)?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        output.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
        bytes += n as u64;
    }
    let after = input.metadata()?;
    if before.len() != bytes
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(fail("源文件在复制期间变化"));
    }
    output.sync_all()?;
    drop(output);
    let mut verify = File::open(target)?;
    let mut actual = blake3::Hasher::new();
    loop {
        check(cancelled)?;
        let n = verify.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        actual.update(&buffer[..n]);
    }
    if verify.metadata()?.len() != bytes || actual.finalize() != hash.finalize() {
        return Err(fail("导出文件大小或 BLAKE3 回读校验失败"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "viewer-qc-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(root.join("source")).unwrap();
            fs::create_dir(root.join("output")).unwrap();
            Self(root)
        }
        fn source(&self) -> PathBuf {
            self.0.join("source")
        }
        fn output(&self) -> PathBuf {
            self.0.join("output")
        }
        fn session(&self, name: &str, qc: &str) -> PathBuf {
            let root = self.source().join(name);
            fs::create_dir_all(root.join(".session_meta")).unwrap();
            write(
                &root.join("session.json"),
                json!({"qc":qc,"reviewerName":"审核甲"}),
            );
            write(
                &root.join(".session_meta/manifest.json"),
                json!({"streams":{"cam0":{"frame_count":300,"fps":30},"cam1":{"frame_count":300,"fps":30}}}),
            );
            // Additional episodes must not break matching the current result.
            write(
                &root.join("description.json"),
                json!({"episode_results":[{"episode_id":root.file_name().unwrap().to_str().unwrap(),"media":{"frame_count":300}}, {"episode_id":"unrelated","media":{"frame_count":123}}],"_human_review":{"status":"approved","segments":[{"startFrame":0,"endFrame":29},{"startFrame":15,"endFrame":59},{"startFrame":60,"endFrame":299,"deleted":true}]}}),
            );
            fs::write(root.join("media.bin"), vec![0x5a; 1024 * 1024 + 37]).unwrap();
            fs::write(root.join(".description.lock"), "temporary").unwrap();
            root
        }
        fn scan(&self) -> ReviewCatalog {
            scan(&self.source(), &AtomicBool::new(false), &mut |_, _| {}).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn write(path: &Path, value: Value) {
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn run_export(f: &Fixture, catalog: &ReviewCatalog) -> AppResult<ReviewExport> {
        export(
            catalog,
            &f.output(),
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
    }

    #[test]
    fn counts_duration_union_deleted_and_unknown_are_distinct() {
        let f = Fixture::new();
        f.session("group/a", "通过");
        f.session("group/b", "不通过：镜头遮挡");
        let pending = f.session("pending", "待审核");
        fs::remove_file(pending.join(".session_meta/manifest.json")).unwrap();
        // This legacy metadata QC must never become a separate session or override root QC.
        write(
            &f.source().join("group/b/.session_meta/session.json"),
            json!({"qc":"通过"}),
        );
        let c = f.scan();
        assert_eq!(
            (c.rows.len(), c.approved, c.rejected, c.pending),
            (3, 1, 1, 1)
        );
        assert_eq!(
            (
                c.original_seconds,
                c.approved_original_seconds,
                c.effective_seconds
            ),
            (20.0, 10.0, 2.0)
        );
        assert_eq!(
            (c.unknown_original, c.unknown_effective, c.errors),
            (1, 0, 1)
        );
    }

    #[test]
    fn copies_only_approved_full_data_preserving_paths_and_source() {
        let f = Fixture::new();
        let a = f.session("one/same", "通过");
        f.session("two/same", "通过");
        f.session("three/rejected", "不通过");
        let before = fs::read(a.join("description.json")).unwrap();
        let result = run_export(&f, &f.scan()).unwrap();
        assert_eq!(result.sessions, 2);
        let output = Path::new(&result.output_path);
        for name in ["one/same", "two/same"] {
            assert_eq!(
                fs::read(output.join("sessions").join(name).join("media.bin")).unwrap(),
                fs::read(a.join("media.bin")).unwrap()
            );
            assert!(!output
                .join("sessions")
                .join(name)
                .join(".description.lock")
                .exists());
        }
        assert!(!output.join("sessions/three").exists());
        assert!(output.join("review-manifest.json").exists());
        assert_eq!(fs::read(a.join("description.json")).unwrap(), before);
        assert!(a.join(".description.lock").exists());
    }

    #[test]
    fn changed_qc_or_trim_requires_rescan() {
        let f = Fixture::new();
        let a = f.session("a", "通过");
        let c = f.scan();
        write(&a.join("session.json"), json!({"qc":"不通过"}));
        assert!(run_export(&f, &c)
            .err()
            .unwrap()
            .to_string()
            .contains("重新扫描"));
        write(&a.join("session.json"), json!({"qc":"通过"}));
        let c = f.scan();
        let mut value = json(&a.join("description.json")).unwrap().unwrap();
        value["_human_review"]["segments"][0]["endFrame"] = json!(90);
        write(&a.join("description.json"), value);
        assert!(run_export(&f, &c)
            .err()
            .unwrap()
            .to_string()
            .contains("重新扫描"));
        assert_eq!(fs::read_dir(f.output()).unwrap().count(), 0);
    }

    #[test]
    fn invalid_approved_ranges_block_export_and_are_not_zero_duration() {
        let f = Fixture::new();
        let a = f.session("a", "通过");
        let mut value = json(&a.join("description.json")).unwrap().unwrap();
        value["_human_review"]["segments"][0]["endFrame"] = json!(300);
        write(&a.join("description.json"), value);
        let c = f.scan();
        assert_eq!((c.approved, c.errors, c.unknown_effective), (1, 1, 1));
        assert_eq!(c.rows[0].effective_seconds, None);
        assert!(run_export(&f, &c).is_err());
        assert_eq!(fs::read_dir(f.output()).unwrap().count(), 0);
    }

    #[test]
    fn cancellation_and_source_changes_remove_partial_output() {
        let f = Fixture::new();
        let a = f.session("a", "通过");
        let c = f.scan();
        let cancel = AtomicBool::new(false);
        let result = export(&c, &f.output(), &cancel, &mut |bytes, _| {
            if bytes > 100 {
                cancel.store(true, Ordering::Release);
            }
        });
        assert!(matches!(result, Err(AppError::Cancelled)));
        assert_eq!(fs::read_dir(f.output()).unwrap().count(), 0);
        let mut changed = false;
        let result = export(&c, &f.output(), &AtomicBool::new(false), &mut |bytes, _| {
            if bytes > 100 && !changed {
                fs::write(a.join("new-file.bin"), "new data").unwrap();
                changed = true;
            }
        });
        assert!(result.err().unwrap().to_string().contains("源数据发生变化"));
        assert_eq!(fs::read_dir(f.output()).unwrap().count(), 0);
    }

    #[test]
    fn exact_session_root_exports_and_nested_destination_is_rejected() {
        let f = Fixture::new();
        let a = f.session("a", "通过");
        let c = scan(&a, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert_eq!(c.rows[0].path, ".");
        let result = run_export(&f, &c).unwrap();
        assert!(Path::new(&result.output_path)
            .join("sessions/session/media.bin")
            .exists());
        assert!(export(&c, &a, &AtomicBool::new(false), &mut |_, _| {}).is_err());
    }

    #[test]
    fn missing_qc_and_oversized_review_are_visible_errors() {
        let f = Fixture::new();
        let a = f.session("a", "通过");
        fs::remove_file(a.join("session.json")).unwrap();
        let c = f.scan();
        assert_eq!((c.pending, c.errors), (1, 1));
        write(&a.join("session.json"), json!({"qc":"通过"}));
        fs::write(a.join("description.json"), vec![b' '; 8 * 1024 * 1024 + 1]).unwrap();
        let c = f.scan();
        assert_eq!(c.unknown_effective, 1);
        assert!(run_export(&f, &c).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_never_silently_skip_data_or_escape_export() {
        let f = Fixture::new();
        f.session("a", "通过");
        std::os::unix::fs::symlink(f.output(), f.source().join("linked")).unwrap();
        assert!(scan(&f.source(), &AtomicBool::new(false), &mut |_, _| {})
            .err()
            .unwrap()
            .to_string()
            .contains("链接"));
    }
}
