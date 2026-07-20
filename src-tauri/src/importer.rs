use crate::error::{AppError, AppResult};
use crate::model::{ImportManifest, ImportResult, ManifestEntry, ProgressPayload};
use crate::source::{collect_files, emit_progress};
use crate::storage;
use blake3::Hasher;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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
    let preflight = storage::inspect_import(source, destination_parent)?;
    storage::require_import_preflight(&preflight)?;
    let files = collect_files(source)?;
    if files.is_empty() {
        return Err(AppError::Message("源目录没有可导入文件".into()));
    }
    let total_bytes = preflight.source_bytes;
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("episode");
    let safe_name = sanitize_name(source_name);
    let partial = storage::create_import_partial(destination_parent, &safe_name, source_name)?;
    let started = Instant::now();

    let mut manifest_entries = Vec::with_capacity(files.len());
    let mut bytes_done = 0_u64;
    let mut dataset_hasher = Hasher::new();
    for (index, source_path) in files.iter().enumerate() {
        check_cancelled(cancelled)?;
        let relative = source_path
            .strip_prefix(source)
            .map_err(|error| AppError::Message(error.to_string()))?;
        let destination_path = partial.join(relative);
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut input = File::open(source_path)?;
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
                        total: files.len() as u64,
                        bytes_done,
                        total_bytes,
                        current_path: relative.display().to_string(),
                        elapsed_ms: started.elapsed().as_millis(),
                    },
                );
            }
        }
        output.flush()?;
        let digest = hasher.finalize().to_hex().to_string();
        let relative_string = relative.to_string_lossy().replace('\\', "/");
        dataset_hasher.update(relative_string.as_bytes());
        dataset_hasher.update(&[0]);
        dataset_hasher.update(&fs::metadata(source_path)?.len().to_le_bytes());
        dataset_hasher.update(digest.as_bytes());
        manifest_entries.push(ManifestEntry {
            path: relative_string,
            size: fs::metadata(source_path)?.len(),
            blake3: digest,
        });
    }

    let dataset_blake3 = dataset_hasher.finalize().to_hex().to_string();
    let mut verified_bytes = 0_u64;
    for (index, entry) in manifest_entries.iter().enumerate() {
        check_cancelled(cancelled)?;
        let destination_path = partial.join(Path::new(&entry.path));
        let destination_size = fs::metadata(&destination_path)?.len();
        if destination_size != entry.size {
            return Err(AppError::Message(format!(
                "目标文件大小不匹配: {} ({} != {})",
                entry.path, destination_size, entry.size
            )));
        }
        let mut file = File::open(&destination_path)?;
        let mut hasher = Hasher::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            check_cancelled(cancelled)?;
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            verified_bytes += read as u64;
        }
        let destination_hash = hasher.finalize().to_hex().to_string();
        if destination_hash != entry.blake3 {
            return Err(AppError::Message(format!(
                "目标文件 BLAKE3 不匹配: {}",
                entry.path
            )));
        }
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
        format_version: 1,
        source_name: source_name.into(),
        total_files: files.len() as u64,
        total_bytes,
        dataset_blake3: dataset_blake3.clone(),
        files: manifest_entries,
    };
    let manifest_path = partial.join(".dohc-manifest.json");
    let mut manifest_file = File::create(&manifest_path)?;
    serde_json::to_writer_pretty(&mut manifest_file, &manifest)?;
    manifest_file.write_all(b"\n")?;

    let final_path = unique_destination(destination_parent, &safe_name);
    fs::rename(&partial, &final_path)?;
    let _ = storage::finalize_import_partial(&partial);
    emit_progress(
        app,
        ProgressPayload {
            task: "import".into(),
            phase: "导入完成".into(),
            current: files.len() as u64,
            total: files.len() as u64,
            bytes_done: total_bytes,
            total_bytes,
            current_path: final_path.display().to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    Ok(ImportResult {
        destination: final_path.display().to_string(),
        total_files: files.len() as u64,
        total_bytes,
        dataset_blake3,
        elapsed_ms: started.elapsed().as_millis(),
    })
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
    use super::{import_episode, sanitize_name};
    use crate::storage::{cleanup_partial_import, list_partial_imports};
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
    fn cancelled_import_leaves_only_a_marked_cleanable_partial() {
        let source = test_output("cancel-source");
        let output = test_output("cancel-output");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(source.join("states.jsonl"), b"{}\n").unwrap();

        let error = import_episode(&source, &output, None, &AtomicBool::new(true)).unwrap_err();
        assert!(error.to_string().contains("任务已取消"));
        let partials = list_partial_imports(&output).unwrap();
        assert_eq!(partials.len(), 1);
        cleanup_partial_import(&output, PathBuf::from(&partials[0].path).as_path()).unwrap();
        assert_eq!(fs::read_dir(&output).unwrap().count(), 0);

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(output).unwrap();
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
