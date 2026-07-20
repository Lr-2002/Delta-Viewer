use crate::error::{AppError, AppResult};
use crate::model::{ImportManifest, ImportResult, ManifestEntry, ProgressPayload};
use crate::source::emit_progress;
use crate::storage;
use blake3::Hasher;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::AppHandle;

pub fn import_episode(
    source: &Path,
    destination_parent: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<ImportResult> {
    if !source.is_dir() {
        return Err(AppError::MissingPath(source.display().to_string()));
    }
    if !destination_parent.exists() {
        fs::create_dir_all(destination_parent)?;
    }
    if !destination_parent.is_dir() {
        return Err(AppError::Message(format!(
            "导入位置不是目录: {}",
            destination_parent.display()
        )));
    }
    let source = fs::canonicalize(source)?;
    let (preflight, files) =
        storage::inspect_import_with_files(&source, destination_parent, cancelled)?;
    storage::require_import_preflight(&preflight)?;
    if files.is_empty() {
        return Err(AppError::Message("源目录没有可导入文件".into()));
    }
    let planned_files = plan_import_files(&source, files)?;
    let total_bytes = preflight.source_bytes;
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("episode");
    let safe_name = sanitize_name(source_name);
    let partial = storage::create_import_partial(destination_parent, &safe_name, source_name)?;
    let started = Instant::now();

    let mut manifest_entries = Vec::with_capacity(planned_files.len());
    let mut bytes_done = 0_u64;
    let mut dataset_hasher = Hasher::new();
    for (index, planned) in planned_files.iter().enumerate() {
        check_cancelled(cancelled)?;
        let destination_path = partial.join(&planned.destination_relative);
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut input = File::open(&planned.source_path)?;
        let source_before = input.metadata()?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination_path)?;
        let mut hasher = Hasher::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            check_cancelled(cancelled)?;
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            bytes_done += read as u64;
            if bytes_done == total_bytes || bytes_done % (4 * 1024 * 1024) < read as u64 {
                emit_progress(
                    app,
                    ProgressPayload {
                        task: "import".into(),
                        phase: "复制文件".into(),
                        current: index as u64,
                        total: planned_files.len() as u64,
                        bytes_done,
                        total_bytes,
                        current_path: planned.destination_path.clone(),
                        elapsed_ms: started.elapsed().as_millis(),
                    },
                );
            }
        }
        output.flush()?;
        let source_after = input.metadata()?;
        if source_before.len() != source_after.len()
            || source_before.modified().ok() != source_after.modified().ok()
        {
            return Err(AppError::Message(format!(
                "SOURCE_CHANGED_DURING_IMPORT: {}",
                planned.source_path_text
            )));
        }
        let digest = hasher.finalize().to_hex().to_string();
        dataset_hasher.update(planned.source_path_text.as_bytes());
        dataset_hasher.update(&[0]);
        dataset_hasher.update(&source_after.len().to_le_bytes());
        dataset_hasher.update(digest.as_bytes());
        manifest_entries.push(ManifestEntry {
            path: planned.destination_path.clone(),
            source_path: planned.source_path_text.clone(),
            size: source_after.len(),
            blake3: digest,
        });
    }

    let dataset_blake3 = dataset_hasher.finalize().to_hex().to_string();
    let mut verified_bytes = 0_u64;
    for (index, entry) in manifest_entries.iter().enumerate() {
        check_cancelled(cancelled)?;
        let destination_path = partial.join(Path::new(&entry.path));
        verified_bytes = verified_bytes.saturating_add(verify_destination_file(
            &destination_path,
            entry,
            cancelled,
        )?);
        if index % 8 == 0 || index + 1 == manifest_entries.len() {
            emit_progress(
                app,
                ProgressPayload {
                    task: "import".into(),
                    phase: "快速校验".into(),
                    current: (index + 1) as u64,
                    total: manifest_entries.len() as u64,
                    bytes_done: verified_bytes,
                    total_bytes,
                    current_path: entry.path.clone(),
                    elapsed_ms: started.elapsed().as_millis(),
                },
            );
        }
    }
    let manifest = ImportManifest {
        format_version: 2,
        source_name: source_name.into(),
        total_files: planned_files.len() as u64,
        total_bytes,
        dataset_blake3: dataset_blake3.clone(),
        files: manifest_entries,
    };
    let manifest_path = partial.join(".dohc-manifest.json");
    let mut manifest_file = File::create(&manifest_path)?;
    serde_json::to_writer_pretty(&mut manifest_file, &manifest)?;
    manifest_file.write_all(b"\n")?;
    manifest_file.flush()?;
    manifest_file.sync_all()?;
    drop(manifest_file);

    let final_path = unique_destination(destination_parent, &safe_name);
    storage::publish_import_partial(&partial, &final_path)?;
    emit_progress(
        app,
        ProgressPayload {
            task: "import".into(),
            phase: "导入完成".into(),
            current: planned_files.len() as u64,
            total: planned_files.len() as u64,
            bytes_done: total_bytes,
            total_bytes,
            current_path: final_path.display().to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    Ok(ImportResult {
        destination: final_path.display().to_string(),
        total_files: planned_files.len() as u64,
        total_bytes,
        dataset_blake3,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

struct PlannedImportFile {
    source_path: PathBuf,
    source_path_text: String,
    destination_relative: PathBuf,
    destination_path: String,
}

fn plan_import_files(source: &Path, files: Vec<PathBuf>) -> AppResult<Vec<PlannedImportFile>> {
    let mut seen_paths = BTreeMap::<String, String>::new();
    let mut planned = Vec::with_capacity(files.len());
    for source_path in files {
        let relative = source_path
            .strip_prefix(source)
            .map_err(|error| AppError::Message(error.to_string()))?;
        let source_path_text = relative_path_text(relative)?;
        let mut source_prefix = PathBuf::new();
        let mut destination_relative = PathBuf::new();
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err(AppError::Message(format!(
                    "INVALID_SOURCE_PATH: {}",
                    relative.display()
                )));
            };
            let component = component.to_str().ok_or_else(|| {
                AppError::Message(format!(
                    "UNSUPPORTED_FILENAME_ENCODING: {}",
                    relative.display()
                ))
            })?;
            source_prefix.push(component);
            destination_relative.push(sanitize_name(component));
            let collision_key = destination_relative
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            let source_key = source_prefix.to_string_lossy().replace('\\', "/");
            if let Some(existing) = seen_paths.get(&collision_key) {
                if existing != &source_key {
                    return Err(AppError::Message(format!(
                        "SANITIZED_PATH_COLLISION: {existing} 与 {source_key} 会映射到同一路径"
                    )));
                }
            } else {
                seen_paths.insert(collision_key, source_key);
            }
        }
        let destination_path = destination_relative.to_string_lossy().replace('\\', "/");
        planned.push(PlannedImportFile {
            source_path,
            source_path_text,
            destination_relative,
            destination_path,
        });
    }
    Ok(planned)
}

fn relative_path_text(path: &Path) -> AppResult<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(AppError::Message(format!(
                "INVALID_SOURCE_PATH: {}",
                path.display()
            )));
        };
        parts.push(
            component
                .to_str()
                .ok_or_else(|| {
                    AppError::Message(format!("UNSUPPORTED_FILENAME_ENCODING: {}", path.display()))
                })?
                .to_string(),
        );
    }
    Ok(parts.join("/"))
}

fn verify_destination_file(
    destination_path: &Path,
    entry: &ManifestEntry,
    cancelled: &AtomicBool,
) -> AppResult<u64> {
    let destination_size = fs::metadata(destination_path)?.len();
    if destination_size != entry.size {
        return Err(AppError::Message(format!(
            "目标文件大小不匹配: {} ({} != {})",
            entry.path, destination_size, entry.size
        )));
    }
    let mut file = File::open(destination_path)?;
    let mut hasher = Hasher::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check_cancelled(cancelled)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let destination_hash = hasher.finalize().to_hex().to_string();
    if destination_hash != entry.blake3 {
        return Err(AppError::Message(format!(
            "目标文件 BLAKE3 不匹配: {}",
            entry.path
        )));
    }
    Ok(destination_size)
}

fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

fn unique_destination(parent: &Path, name: &str) -> PathBuf {
    let first = parent.join(name);
    if !first.exists() {
        return first;
    }
    for index in 2..10_000 {
        let candidate = parent.join(format!("{name}_{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{name}_{}", std::process::id()))
}

pub fn sanitize_name(value: &str) -> String {
    let mut sanitized: String = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            character if character.is_control() => '-',
            character => character,
        })
        .collect();
    while sanitized.ends_with(' ') || sanitized.ends_with('.') {
        sanitized.pop();
    }
    let stem = sanitized.split('.').next().unwrap_or_default();
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if sanitized.is_empty() {
        "episode".into()
    } else if reserved {
        format!("_{sanitized}")
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::{import_episode, plan_import_files, sanitize_name, verify_destination_file};
    use crate::model::{ImportManifest, ManifestEntry};
    use crate::storage::list_partial_imports;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn makes_windows_safe_episode_names() {
        assert_eq!(sanitize_name("2026-07-13 07:34:12"), "2026-07-13 07-34-12");
        assert_eq!(sanitize_name("CON"), "_CON");
        assert_eq!(sanitize_name("LPT1.log"), "_LPT1.log");
        assert_eq!(sanitize_name("name. "), "name");
    }

    #[test]
    fn plans_windows_safe_relative_paths() {
        let source = PathBuf::from("source");
        let planned =
            plan_import_files(&source, vec![source.join("AUX").join("2026:state?.bin")]).unwrap();
        assert_eq!(planned[0].source_path_text, "AUX/2026:state?.bin");
        assert_eq!(planned[0].destination_path, "_AUX/2026-state-.bin");
    }

    #[test]
    fn rejects_case_or_sanitization_path_collisions() {
        let source = PathBuf::from("source");
        let error = plan_import_files(&source, vec![source.join("a:b/x"), source.join("A?B/y")])
            .err()
            .unwrap();
        assert!(error.to_string().contains("SANITIZED_PATH_COLLISION"));
    }

    #[cfg(not(windows))]
    #[test]
    fn manifest_v2_records_source_to_destination_mapping() {
        let source = test_output("safe-path-source");
        let output = test_output("safe-path-output");
        fs::create_dir_all(source.join("AUX")).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(source.join("AUX/2026:state?.bin"), b"data").unwrap();

        let result = import_episode(&source, &output, None, &AtomicBool::new(false)).unwrap();
        let imported = PathBuf::from(result.destination);
        assert!(imported.join("_AUX/2026-state-.bin").is_file());
        let manifest: ImportManifest =
            serde_json::from_reader(fs::File::open(imported.join(".dohc-manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.format_version, 2);
        assert_eq!(manifest.files[0].source_path, "AUX/2026:state?.bin");
        assert_eq!(manifest.files[0].path, "_AUX/2026-state-.bin");

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn preflight_cancellation_creates_no_output() {
        let source = test_output("cancel-source");
        let output = test_output("cancel-output");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(source.join("states.jsonl"), b"{}\n").unwrap();

        let error = import_episode(&source, &output, None, &AtomicBool::new(true)).unwrap_err();
        assert!(error.to_string().contains("任务已取消"));
        let partials = list_partial_imports(&output).unwrap();
        assert!(partials.is_empty());
        assert_eq!(fs::read_dir(&output).unwrap().count(), 0);

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn target_readback_detects_same_size_tampering() {
        let path = test_output("tampered-target");
        fs::write(&path, b"original").unwrap();
        let entry = ManifestEntry {
            path: "states.jsonl".into(),
            source_path: "states.jsonl".into(),
            size: 8,
            blake3: blake3::hash(b"original").to_hex().to_string(),
        };
        fs::write(&path, b"tampered").unwrap();

        let error = verify_destination_file(&path, &entry, &AtomicBool::new(false)).unwrap_err();
        assert!(error.to_string().contains("BLAKE3"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    #[ignore = "requires DOHC_SAMPLE_ROOT with the private recording sample"]
    fn imports_real_sample_and_verifies_hashes() {
        let sample =
            PathBuf::from(std::env::var("DOHC_SAMPLE_ROOT").expect("DOHC_SAMPLE_ROOT must be set"));
        let output = test_output("import");
        fs::create_dir_all(&output).unwrap();
        let result = import_episode(&sample, &output, None, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.total_files, 981);
        assert_eq!(result.total_bytes, 80_531_730);
        assert_eq!(result.dataset_blake3.len(), 64);
        eprintln!("dataset BLAKE3: {}", result.dataset_blake3);
        let imported = PathBuf::from(&result.destination);
        assert!(imported.join(".dohc-manifest.json").is_file());
        assert!(imported.join("cam0/195.jpg").is_file());
        let manifest: ImportManifest =
            serde_json::from_reader(fs::File::open(imported.join(".dohc-manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.format_version, 2);
        assert!(manifest
            .files
            .iter()
            .all(|entry| entry.path == entry.source_path));
        fs::remove_dir_all(output).unwrap();
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
