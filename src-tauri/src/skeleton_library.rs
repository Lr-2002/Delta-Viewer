//! Explicit, read-only companion models. No model or source files are modified.
use crate::error::{AppError, AppResult};
use crate::model::SkeletonSeries;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_CATALOG: u64 = 8 * 1024 * 1024;
const MAX_NPZ: u64 = 64 * 1024 * 1024;
const CONFIG: &str = "skeleton-library.json";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryModel {
    pub id: String,
    pub label: String,
    pub release: String,
    pub input_resolution: Resolution,
    pub experimental: bool,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub relative: String,
    pub session_sha256: String,
    pub npz_path: String,
    pub npz_sha256: String,
    pub npz_bytes: u64,
    pub frame_count: u64,
    pub joint_count: u64,
    pub joint_source: String,
    pub frame_id_source: String,
    pub frame_index_space: String,
    pub topology: String,
    pub coordinate_unit: String,
    pub coordinate_system: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    library_id: String,
    revision: String,
    model: LibraryModel,
    entries: Vec<LibraryEntry>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub root: String,
    pub library_id: String,
    pub revision: String,
    pub model: Option<LibraryModel>,
    pub relatives: Vec<String>,
}
fn fail(message: impl std::fmt::Display) -> AppError {
    AppError::Message(format!("骨架模型库：{message}"))
}
fn cancelled(flag: &AtomicBool) -> AppResult<()> {
    if flag.load(Ordering::Relaxed) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}
fn relative(value: &str) -> AppResult<PathBuf> {
    if value.is_empty()
        || value.contains(['\\', ':', '\0'])
        || value
            .split('/')
            .any(|v| v.is_empty() || v == "." || v == "..")
    {
        return Err(fail("清单相对路径无效"));
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(fail("清单路径越界"));
    }
    Ok(path)
}
fn checked_file(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let mut path = root.to_path_buf();
    let rel = relative(rel)?;
    for part in rel.components() {
        path.push(part);
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            return Err(fail("不读取符号链接"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(fail("不读取重解析路径"));
            }
        }
    }
    if !fs::symlink_metadata(&path)?.is_file() || !path.canonicalize()?.starts_with(root) {
        return Err(fail("文件超出模型库或不是普通文件"));
    }
    Ok(path)
}
fn read_bounded(path: &Path, limit: u64) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(fail("文件超过读取上限"));
    }
    Ok(bytes)
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn catalog(root: &Path) -> AppResult<Catalog> {
    let c: Catalog = serde_json::from_slice(&read_bounded(
        &checked_file(root, "catalog.json")?,
        MAX_CATALOG,
    )?)?;
    if c.schema_version != 1
        || c.library_id.is_empty()
        || c.revision.is_empty()
        || c.model.id.is_empty()
        || c.model.label.is_empty()
        || !c.model.experimental
        || c.entries.len() > 10_000
    {
        return Err(fail("不支持的清单版本或模型信息"));
    }
    let mut paths = BTreeSet::new();
    for e in &c.entries {
        relative(&e.relative)?;
        relative(&e.npz_path)?;
        if !paths.insert(&e.relative)
            || !valid_hash(&e.session_sha256)
            || !valid_hash(&e.npz_sha256)
            || e.npz_bytes == 0
            || e.npz_bytes > MAX_NPZ
            || e.frame_count == 0
            || e.frame_count > 166_666
            || e.joint_count != 24
            || e.joint_source != "smpl_joints"
            || e.frame_id_source != "frame_ids"
            || e.frame_index_space != "cam0_encoded_zero_based"
            || e.topology != "smpl24"
            || e.coordinate_unit != "npz_native_unverified"
            || e.coordinate_system != "npz_native_unverified"
        {
            return Err(fail("条目重复、校验值或骨架格式无效"));
        }
    }
    Ok(c)
}
fn configured_root(data: &Path) -> AppResult<Option<PathBuf>> {
    let config = data.join(CONFIG);
    match fs::symlink_metadata(&config) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => Err(fail("本机配置不是普通文件")),
        Ok(_) => {
            let value: String = serde_json::from_slice(&read_bounded(&config, 32 * 1024)?)?;
            Ok(Some(PathBuf::from(value).canonicalize()?))
        }
    }
}
pub fn info(data: &Path) -> AppResult<LibraryInfo> {
    let Some(root) = configured_root(data)? else {
        return Ok(LibraryInfo::default());
    };
    let c = catalog(&root)?;
    Ok(LibraryInfo {
        root: root.display().to_string(),
        library_id: c.library_id,
        revision: c.revision,
        model: Some(c.model),
        relatives: c.entries.into_iter().map(|e| e.relative).collect(),
    })
}
pub fn configure(data: &Path, root: &str) -> AppResult<LibraryInfo> {
    if root.is_empty() {
        match fs::remove_file(data.join(CONFIG)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        };
        return Ok(LibraryInfo::default());
    }
    let root = Path::new(root).canonicalize()?;
    catalog(&root)?;
    fs::create_dir_all(data)?;
    let partial = data.join(format!(
        ".skeleton-library-{}.partial",
        getrandom::u64().map_err(|e| fail(format!("无法创建配置编号：{e}")))?
    ));
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)?;
        file.write_all(&serde_json::to_vec(&root.display().to_string())?)?;
        file.sync_all()?;
        crate::storage::replace_file_atomic(&partial, &data.join(CONFIG))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    info(data)
}
fn matches_path(path: &Path, rel: &str) -> bool {
    // A complete catalog path suffix, never an episode basename. The containing
    // volume/SMB share may differ between systems. Session bytes bind identity.
    #[cfg(windows)]
    {
        let plain = path.to_string_lossy().replace('\\', "/").to_lowercase();
        plain.ends_with(&format!("/{}", rel.to_lowercase()))
    }
    #[cfg(not(windows))]
    {
        path.ends_with(Path::new(rel))
    }
}
fn entry<'a>(catalog: &'a Catalog, data: &Path, episode: &Path) -> AppResult<&'a LibraryEntry> {
    let mut aliases = vec![episode.to_path_buf()];
    aliases.extend(crate::dataset_layout::historical_paths_cached(
        data, episode,
    )?);
    let found: Vec<_> = catalog
        .entries
        .iter()
        .filter(|e| aliases.iter().any(|p| matches_path(p, &e.relative)))
        .collect();
    if found.len() != 1 {
        return Err(fail("当前完整目录没有唯一的新模型条目，旧骨架仍可使用"));
    }
    Ok(found[0])
}
#[cfg(test)]
pub fn load(
    data: &Path,
    episode: &Path,
    revision: &str,
    flag: &AtomicBool,
) -> AppResult<SkeletonSeries> {
    load_with_aliases(data, data, episode, revision, flag)
}

pub fn load_with_aliases(
    data: &Path,
    alias_data: &Path,
    episode: &Path,
    revision: &str,
    flag: &AtomicBool,
) -> AppResult<SkeletonSeries> {
    cancelled(flag)?;
    let root = configured_root(data)?.ok_or_else(|| fail("尚未选择模型库"))?;
    let c = catalog(&root)?;
    if revision != c.revision {
        return Err(fail("模型库已变更，请刷新后选择"));
    }
    let episode = episode.canonicalize()?;
    let e = entry(&c, alias_data, &episode)?;
    let session = checked_file(&episode, "session.json")?;
    let session_bytes = read_bounded(&session, 16 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&session_bytes)) != e.session_sha256 {
        return Err(fail("当前 session.json 与模型快照不匹配（审核 QC 改写也会造成变化），未加载新模型；请保留旧骨架"));
    }
    cancelled(flag)?;
    let path = checked_file(&root, &e.npz_path)?;
    if fs::metadata(&path)?.len() != e.npz_bytes {
        return Err(fail("新骨架文件大小不匹配"));
    }
    let bytes = read_bounded(&path, MAX_NPZ)?;
    if format!("{:x}", Sha256::digest(&bytes)) != e.npz_sha256 {
        return Err(fail("新骨架 SHA256 校验失败"));
    }
    cancelled(flag)?;
    let mut skeleton = crate::skeleton::load_model_archive(&path, &episode, flag)?;
    if skeleton.frame_count != e.frame_count
        || skeleton.joint_count != e.joint_count
        || skeleton
            .frames
            .iter()
            .enumerate()
            .any(|(i, f)| f.frame_id != i as i64)
        || skeleton
            .frames
            .iter()
            .any(|f| f.timeline_position.is_none())
    {
        return Err(fail("新骨架帧序或主相机时间映射不匹配，未猜测对齐"));
    }
    // Recheck both files after parsing; a concurrently replaced library/source
    // cannot be acknowledged with the previous digest.
    if read_bounded(&path, MAX_NPZ)? != bytes
        || read_bounded(&session, 16 * 1024 * 1024)? != session_bytes
    {
        return Err(fail("文件在读取期间改变，请重新选择"));
    }
    skeleton.source_name = format!("{} · {}", c.model.label, c.model.release);
    Ok(skeleton)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::{Array1, Array3};
    use ndarray_npy::NpzWriter;
    use serde_json::json;
    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("viewer-model-{}", getrandom::u64().unwrap()));
        let library = base.join("library");
        let episode = base.join("source/D1-Daily/2026-10-14-Fridge/Fridge_001");
        fs::create_dir_all(library.join("artifacts")).unwrap();
        fs::create_dir_all(&episode).unwrap();
        let session = b"{\"qc\":\"\",\"session_id\":\"fixture\"}";
        fs::write(episode.join("session.json"), session).unwrap();
        fs::write(episode.join("manifest.json"),serde_json::to_vec(&json!({"storage_format":"h264-split-mp4-v1","timeline_fps":60.0,"streams":{"cam0":{"path":"cam0.mp4","fps":30.0,"frame_count":3}}})).unwrap()).unwrap();
        let mut zip = NpzWriter::new(File::create(library.join("artifacts/test.npz")).unwrap());
        zip.add_array(
            "smpl_joints",
            &Array3::from_shape_fn((3, 24, 3), |(f, j, a)| (f + j + a) as f32),
        )
        .unwrap();
        zip.add_array("raw_smpl_joints", &Array3::from_elem((3, 24, 3), 999.0_f32))
            .unwrap();
        zip.add_array("frame_ids", &Array1::from_vec(vec![0_i64, 1, 2]))
            .unwrap();
        zip.finish().unwrap();
        let bytes = fs::read(library.join("artifacts/test.npz")).unwrap();
        let c = json!({"schemaVersion":1,"libraryId":"test","revision":"v-test","model":{"id":"mhr","label":"1080p实验","release":"2026-10-25","experimental":true,"inputResolution":{"width":1920,"height":1080}},"entries":[{"relative":"D1-Daily/2026-10-14-Fridge/Fridge_001","sessionSha256":format!("{:x}",Sha256::digest(session)),"npzPath":"artifacts/test.npz","npzSha256":format!("{:x}",Sha256::digest(&bytes)),"npzBytes":bytes.len(),"frameCount":3,"jointCount":24,"jointSource":"smpl_joints","frameIdSource":"frame_ids","frameIndexSpace":"cam0_encoded_zero_based","topology":"smpl24","coordinateUnit":"npz_native_unverified","coordinateSystem":"npz_native_unverified"}]});
        fs::write(
            library.join("catalog.json"),
            serde_json::to_vec(&c).unwrap(),
        )
        .unwrap();
        (base, library, episode)
    }
    #[test]
    fn model_loads_processed_coordinates_using_original_camera_clock_and_preserves_files() {
        let (base, library, episode) = fixture();
        let data = base.join("data");
        let session = fs::read(episode.join("session.json")).unwrap();
        let npz = fs::read(library.join("artifacts/test.npz")).unwrap();
        let configured = configure(&data, library.to_str().unwrap()).unwrap();
        assert_eq!(configured.relatives.len(), 1);
        let series = load(&data, &episode, "v-test", &AtomicBool::new(false)).unwrap();
        assert_eq!(series.joint_source, "smpl_joints");
        assert_eq!(series.frames[1].joints[0], [1.0, 2.0, 3.0]);
        assert_eq!(
            series
                .frames
                .iter()
                .map(|f| f.timeline_position)
                .collect::<Vec<_>>(),
            vec![Some(0.0), Some(2.0), Some(4.0)]
        );
        assert_eq!(fs::read(episode.join("session.json")).unwrap(), session);
        assert_eq!(fs::read(library.join("artifacts/test.npz")).unwrap(), npz);
        assert_eq!(info(&data).unwrap().revision, "v-test");
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn rejects_same_name_wrong_batch_changed_session_changed_artifact_or_revision() {
        let (base, library, episode) = fixture();
        let data = base.join("data");
        configure(&data, library.to_str().unwrap()).unwrap();
        let wrong = base.join("source/D1-Daily/2026-10-15-Fridge/Fridge_001");
        fs::create_dir_all(&wrong).unwrap();
        assert!(load(&data, &wrong, "v-test", &AtomicBool::new(false))
            .unwrap_err()
            .to_string()
            .contains("唯一"));
        assert!(load(&data, &episode, "old", &AtomicBool::new(false))
            .unwrap_err()
            .to_string()
            .contains("变更"));
        let session = fs::read(episode.join("session.json")).unwrap();
        fs::write(episode.join("session.json"), b"{\"qc\":\"changed\"}").unwrap();
        assert!(load(&data, &episode, "v-test", &AtomicBool::new(false))
            .unwrap_err()
            .to_string()
            .contains("session.json"));
        fs::write(episode.join("session.json"), session).unwrap();
        let npz = library.join("artifacts/test.npz");
        let mut bytes = fs::read(&npz).unwrap();
        bytes[4] ^= 1;
        fs::write(&npz, &bytes).unwrap();
        assert!(load(&data, &episode, "v-test", &AtomicBool::new(false))
            .unwrap_err()
            .to_string()
            .contains("SHA256"));
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn rejects_unsafe_catalog_paths_and_duplicate_entries_without_replacing_config() {
        let (base, library, _) = fixture();
        let data = base.join("data");
        configure(&data, library.to_str().unwrap()).unwrap();
        let before = fs::read(data.join(CONFIG)).unwrap();
        for path in [
            "../test.npz",
            "/test.npz",
            "artifacts/../test.npz",
            "C:/test.npz",
            "artifacts\\test.npz",
        ] {
            assert!(relative(path).is_err());
        }
        let mut c: serde_json::Value =
            serde_json::from_slice(&fs::read(library.join("catalog.json")).unwrap()).unwrap();
        let duplicate = c["entries"][0].clone();
        c["entries"].as_array_mut().unwrap().push(duplicate);
        fs::write(
            library.join("catalog.json"),
            serde_json::to_vec(&c).unwrap(),
        )
        .unwrap();
        assert!(configure(&data, library.to_str().unwrap()).is_err());
        assert_eq!(fs::read(data.join(CONFIG)).unwrap(), before);
        fs::remove_dir_all(base).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_library_symlinks_and_cancelled_loads() {
        let (base, library, episode) = fixture();
        let data = base.join("data");
        configure(&data, library.to_str().unwrap()).unwrap();
        assert!(matches!(
            load(&data, &episode, "v-test", &AtomicBool::new(true)),
            Err(AppError::Cancelled)
        ));
        fs::rename(library.join("artifacts/test.npz"), base.join("outside.npz")).unwrap();
        std::os::unix::fs::symlink(base.join("outside.npz"), library.join("artifacts/test.npz"))
            .unwrap();
        assert!(load(&data, &episode, "v-test", &AtomicBool::new(false))
            .unwrap_err()
            .to_string()
            .contains("符号链接"));
        fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(test)]
mod real_tests {
    use super::*;
    #[test]
    #[ignore = "explicit read-only private model library smoke"]
    fn real_companion_model_keeps_original_cam0_time_and_processed_source() {
        let data =
            std::env::temp_dir().join(format!("mhr-real-model-{}", getrandom::u64().unwrap()));
        let library = std::env::var("DELTA_MODEL_LIBRARY").unwrap();
        let episode = std::env::var("DELTA_MODEL_EPISODE").unwrap();
        let c = configure(&data, &library).unwrap();
        let series = load(
            &data,
            Path::new(&episode),
            &c.revision,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(series.joint_source, "smpl_joints");
        assert_eq!(series.joint_count, 24);
        assert!(series.frames.iter().all(|f| f.timeline_position.is_some()));
        println!(
            "real model {} frames, first position {:?}, last {:?}",
            series.frame_count,
            series.frames.first().unwrap().timeline_position,
            series.frames.last().unwrap().timeline_position
        );
        fs::remove_dir_all(data).unwrap();
    }
}
