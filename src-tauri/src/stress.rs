use crate::error::{AppError, AppResult};
use crate::model::{ExportFormat, ImportManifest, Severity, VolumeInfo};
use crate::{export, importer, source, storage, validation};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FORMAL_MIN_BYTES: u64 = 100_000_000_000;
const FORMAL_MIN_FILES: u64 = 100_000;
const WORKSPACE_MARKER: &str = ".dohc-stress-work-v1.json";
const REPORT_NAME: &str = "stress-report.json";

#[derive(Debug, Clone)]
pub struct StressConfig {
    source: PathBuf,
    work_root: PathBuf,
    formal: bool,
}

impl StressConfig {
    pub fn new(source: PathBuf, work_root: PathBuf, formal: bool) -> Self {
        Self {
            source,
            work_root,
            formal,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StressReport {
    schema_version: u32,
    application: &'static str,
    app_version: &'static str,
    formal: bool,
    status: String,
    started_at_unix_ms: u64,
    finished_at_unix_ms: u64,
    duration_ms: u64,
    source_path: String,
    work_root: String,
    report_path: String,
    host: HostEvidence,
    git: GitEvidence,
    thresholds: ThresholdEvidence,
    source_volume: Option<serde_json::Value>,
    work_volume: Option<serde_json::Value>,
    source_total_files: Option<u64>,
    source_total_bytes: Option<u64>,
    required_work_bytes: Option<u64>,
    source_fingerprint_before: Option<String>,
    source_fingerprint_after: Option<String>,
    import_dataset_blake3: Option<String>,
    source_dataset_blake3_after: Option<String>,
    imported_path: Option<String>,
    validation: Option<ValidationEvidence>,
    cancellation: Option<CancellationEvidence>,
    ffmpeg: Option<FfmpegEvidence>,
    outputs: Vec<OutputEvidence>,
    phases: Vec<PhaseEvidence>,
    peak_rss_bytes: Option<u64>,
    failure: Option<String>,
}

impl StressReport {
    pub fn passed(&self) -> bool {
        self.status == "passed"
    }

    pub fn report_path(&self) -> &str {
        &self.report_path
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEvidence {
    os: &'static str,
    arch: &'static str,
    profile: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitEvidence {
    head: Option<String>,
    exact_tag: Option<String>,
    exact_tag_annotated: Option<bool>,
    clean: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThresholdEvidence {
    minimum_bytes: u64,
    minimum_files: u64,
    require_exfat: bool,
    require_release_profile: bool,
    require_clean_version_tag: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationEvidence {
    status: String,
    checked_files: u64,
    parsed_state_count: u64,
    warning_codes: Vec<String>,
    error_codes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancellationEvidence {
    trigger: &'static str,
    latency_ms: u64,
    maximum_latency_ms: u64,
    partials_found: u64,
    partials_cleaned: u64,
    published_output: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegEvidence {
    command: String,
    explicit_path: bool,
    version: String,
    size_bytes: Option<u64>,
    blake3: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvidence {
    format: String,
    path: String,
    total_files: u64,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseEvidence {
    name: String,
    status: String,
    duration_ms: u64,
    logical_bytes: u64,
    logical_throughput_bytes_per_second: Option<u64>,
    peak_rss_before_bytes: Option<u64>,
    peak_rss_after_bytes: Option<u64>,
    peak_rss_delta_bytes: Option<u64>,
    error: Option<String>,
}

pub fn run_stress(mut config: StressConfig) -> Result<StressReport, String> {
    let source = fs::canonicalize(&config.source).map_err(|error| error.to_string())?;
    let work_root = prepare_work_root(&source, &config.work_root, config.formal)
        .map_err(|error| error.to_string())?;
    config.source = source;
    config.work_root = work_root;
    let started = Instant::now();
    let started_at_unix_ms = unix_millis();
    let git = git_evidence();
    let report_path = config.work_root.join(REPORT_NAME);
    let mut report = StressReport {
        schema_version: 1,
        application: "DOHC Viewer",
        app_version: env!("CARGO_PKG_VERSION"),
        formal: config.formal,
        status: "running".into(),
        started_at_unix_ms,
        finished_at_unix_ms: 0,
        duration_ms: 0,
        source_path: config.source.display().to_string(),
        work_root: config.work_root.display().to_string(),
        report_path: report_path.display().to_string(),
        host: HostEvidence {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
        },
        git,
        thresholds: ThresholdEvidence {
            minimum_bytes: if config.formal { FORMAL_MIN_BYTES } else { 1 },
            minimum_files: if config.formal { FORMAL_MIN_FILES } else { 1 },
            require_exfat: config.formal,
            require_release_profile: config.formal,
            require_clean_version_tag: config.formal,
        },
        source_volume: None,
        work_volume: None,
        source_total_files: None,
        source_total_bytes: None,
        required_work_bytes: None,
        source_fingerprint_before: None,
        source_fingerprint_after: None,
        import_dataset_blake3: None,
        source_dataset_blake3_after: None,
        imported_path: None,
        validation: None,
        cancellation: None,
        ffmpeg: None,
        outputs: Vec::new(),
        phases: Vec::new(),
        peak_rss_bytes: peak_rss_bytes(),
        failure: None,
    };
    let heartbeat = ConsoleHeartbeat::start(started);
    let outcome = run_inner(&config, &mut report, &heartbeat);
    drop(heartbeat);
    match outcome {
        Ok(()) => report.status = "passed".into(),
        Err(error) => {
            report.status = "failed".into();
            report.failure = Some(error.to_string());
        }
    }
    report.finished_at_unix_ms = unix_millis();
    report.duration_ms = elapsed_millis(started);
    report.peak_rss_bytes = peak_rss_bytes();
    write_report(&report_path, &report).map_err(|error| error.to_string())?;
    Ok(report)
}

fn run_inner(
    config: &StressConfig,
    report: &mut StressReport,
    heartbeat: &ConsoleHeartbeat,
) -> AppResult<()> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let git = report.git.clone();
    let ffmpeg = record_phase(report, heartbeat, "environment preflight", 0, || {
        environment_preflight(config, &git)
    })?;
    report.ffmpeg = Some(ffmpeg);

    let summary = record_phase(report, heartbeat, "source scan", 0, || {
        source::scan_episode(&config.source, None, &cancelled)
    })?;
    report.source_total_files = Some(summary.total_files);
    report.source_total_bytes = Some(summary.total_bytes);

    let source_volume = storage::volume_info(&config.source)?;
    report.source_volume = Some(serde_json::to_value(&source_volume)?);
    let work_volume = storage::volume_info(&config.work_root)?;
    report.work_volume = Some(serde_json::to_value(&work_volume)?);
    let required_work_bytes = required_work_bytes(summary.total_bytes)?;
    report.required_work_bytes = Some(required_work_bytes);
    record_phase(report, heartbeat, "scale and storage gate", 0, || {
        enforce_scale_and_storage(
            config,
            summary.total_files,
            summary.total_bytes,
            &source_volume,
            &work_volume,
            required_work_bytes,
        )
    })?;

    let fingerprint_before =
        record_phase(report, heartbeat, "source fingerprint before", 0, || {
            source::episode_fingerprint(&config.source, &cancelled)
        })?;
    report.source_fingerprint_before = Some(fingerprint_before);

    let cancellation = record_phase(report, heartbeat, "import cancellation probe", 0, || {
        import_cancellation_probe(config)
    })?;
    report.cancellation = Some(cancellation);

    let imports = config.work_root.join("imports");
    let import_result = record_phase(
        report,
        heartbeat,
        "verified import",
        summary.total_bytes.saturating_mul(2),
        || importer::import_episode(&config.source, &imports, None, &cancelled),
    )?;
    report.import_dataset_blake3 = Some(import_result.dataset_blake3.clone());
    report.imported_path = Some(import_result.destination.clone());
    let imported = PathBuf::from(&import_result.destination);
    let manifest: ImportManifest =
        serde_json::from_reader(File::open(imported.join(".dohc-manifest.json"))?)?;
    if manifest.dataset_blake3 != import_result.dataset_blake3 {
        return Err(AppError::Message(
            "STRESS_IMPORT_MANIFEST_HASH_MISMATCH".into(),
        ));
    }

    let validation_report = record_phase(
        report,
        heartbeat,
        "full validation",
        summary.total_bytes,
        || validation::validate_episode(&imported, None, &cancelled),
    )?;
    let warning_codes = validation_report
        .issues
        .iter()
        .filter(|issue| issue.severity == Severity::Warning)
        .map(|issue| issue.code.clone())
        .collect::<Vec<_>>();
    let error_codes = validation_report
        .issues
        .iter()
        .filter(|issue| issue.severity == Severity::Error)
        .map(|issue| issue.code.clone())
        .collect::<Vec<_>>();
    report.validation = Some(ValidationEvidence {
        status: validation_report.status.clone(),
        checked_files: validation_report.checked_files,
        parsed_state_count: validation_report.parsed_state_count,
        warning_codes,
        error_codes: error_codes.clone(),
    });
    if !error_codes.is_empty() {
        return Err(AppError::Message(format!(
            "STRESS_VALIDATION_ERRORS: {}",
            error_codes.join(", ")
        )));
    }

    let exports = config.work_root.join("exports");
    for format in [
        ExportFormat::Mcap,
        ExportFormat::Hdf5,
        ExportFormat::LerobotV2,
    ] {
        let format_name = format.as_str();
        let phase_name = format!("{format_name} export and readback");
        let result = record_phase(report, heartbeat, &phase_name, summary.total_bytes, || {
            export::export_episode(export::ExportJob {
                format,
                source_path: &imported,
                destination_parent: &exports,
                validation_report: &validation_report,
                acknowledge_warnings: true,
                requested_range: None,
                app: None,
                cancelled: &cancelled,
            })
        })?;
        report.outputs.push(OutputEvidence {
            format: result.format,
            path: result.output_path,
            total_files: result.total_files,
            total_bytes: result.total_bytes,
        });
    }

    let source_dataset_blake3 = record_phase(
        report,
        heartbeat,
        "source BLAKE3 after workflow",
        summary.total_bytes,
        || importer::verify_source_against_manifest(&config.source, &manifest, &cancelled),
    )?;
    if source_dataset_blake3 != import_result.dataset_blake3 {
        return Err(AppError::Message(
            "STRESS_SOURCE_DATASET_HASH_CHANGED".into(),
        ));
    }
    report.source_dataset_blake3_after = Some(source_dataset_blake3);

    let fingerprint_after = record_phase(report, heartbeat, "source fingerprint after", 0, || {
        source::episode_fingerprint(&config.source, &cancelled)
    })?;
    if report.source_fingerprint_before.as_deref() != Some(fingerprint_after.as_str()) {
        return Err(AppError::Message(
            "STRESS_SOURCE_METADATA_FINGERPRINT_CHANGED".into(),
        ));
    }
    report.source_fingerprint_after = Some(fingerprint_after);
    Ok(())
}

fn import_cancellation_probe(config: &StressConfig) -> AppResult<CancellationEvidence> {
    const MAXIMUM_LATENCY_MS: u64 = 1_000;
    let destination = config.work_root.join("cancellation-probe");
    fs::create_dir(&destination)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let completed = Arc::new(AtomicBool::new(false));
    let thread_cancelled = cancelled.clone();
    let thread_completed = completed.clone();
    let thread_destination = destination.clone();
    let (trigger_sender, trigger_receiver) = mpsc::sync_channel(1);
    let trigger = thread::spawn(move || loop {
        if partial_directory_exists(&thread_destination) {
            let triggered_at = Instant::now();
            thread_cancelled.store(true, Ordering::Release);
            let _ = trigger_sender.send(Some(triggered_at));
            break;
        }
        if thread_completed.load(Ordering::Acquire) {
            let _ = trigger_sender.send(None);
            break;
        }
        thread::sleep(Duration::from_millis(10));
    });

    let import_result =
        importer::import_episode(&config.source, &destination, None, cancelled.as_ref());
    completed.store(true, Ordering::Release);
    trigger
        .join()
        .map_err(|_| AppError::Message("STRESS_CANCELLATION_TRIGGER_PANICKED".into()))?;
    let triggered_at = trigger_receiver
        .recv()
        .map_err(|error| AppError::Message(error.to_string()))?
        .ok_or_else(|| AppError::Message("STRESS_IMPORT_COMPLETED_BEFORE_CANCELLATION".into()))?;
    let latency_ms = elapsed_millis(triggered_at);

    let partials = storage::list_partial_imports(&destination)?;
    let partials_found = partials.len() as u64;
    for partial in &partials {
        storage::cleanup_partial_import(&destination, Path::new(&partial.path))?;
    }
    let partials_cleaned = partials_found;
    if !storage::list_partial_imports(&destination)?.is_empty() {
        return Err(AppError::Message(
            "STRESS_CANCELLATION_PARTIAL_CLEANUP_FAILED".into(),
        ));
    }

    match import_result {
        Err(AppError::Cancelled) => {}
        Err(error) => {
            return Err(AppError::Message(format!(
                "STRESS_CANCELLATION_UNEXPECTED_ERROR: {error}"
            )));
        }
        Ok(result) => {
            return Err(AppError::Message(format!(
                "STRESS_CANCELLATION_PUBLISHED_OUTPUT: {}",
                result.destination
            )));
        }
    }
    if partials_found == 0 {
        return Err(AppError::Message(
            "STRESS_CANCELLATION_PARTIAL_NOT_FOUND".into(),
        ));
    }
    if latency_ms > MAXIMUM_LATENCY_MS {
        return Err(AppError::Message(format!(
            "STRESS_CANCELLATION_TOO_SLOW: {latency_ms} ms"
        )));
    }
    Ok(CancellationEvidence {
        trigger: "import partial created",
        latency_ms,
        maximum_latency_ms: MAXIMUM_LATENCY_MS,
        partials_found,
        partials_cleaned,
        published_output: false,
    })
}

fn partial_directory_exists(destination: &Path) -> bool {
    fs::read_dir(destination).ok().is_some_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            entry.file_type().ok().is_some_and(|kind| kind.is_dir())
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.contains(".partial-"))
        })
    })
}

fn environment_preflight(config: &StressConfig, git: &GitEvidence) -> AppResult<FfmpegEvidence> {
    if config.formal && cfg!(debug_assertions) {
        return Err(AppError::Message(
            "FORMAL_STRESS_REQUIRES_RELEASE_PROFILE".into(),
        ));
    }
    if config.formal {
        if git.clean != Some(true) {
            return Err(AppError::Message("FORMAL_STRESS_REQUIRES_CLEAN_GIT".into()));
        }
        let expected_tag = format!("v{}", env!("CARGO_PKG_VERSION"));
        if git.exact_tag.as_deref() != Some(expected_tag.as_str()) {
            return Err(AppError::Message(format!(
                "FORMAL_STRESS_REQUIRES_TAG: expected {expected_tag}"
            )));
        }
        if git.exact_tag_annotated != Some(true) {
            return Err(AppError::Message(
                "FORMAL_STRESS_REQUIRES_ANNOTATED_TAG".into(),
            ));
        }
    }
    ffmpeg_evidence(config.formal)
}

fn enforce_scale_and_storage(
    config: &StressConfig,
    total_files: u64,
    total_bytes: u64,
    source_volume: &VolumeInfo,
    work_volume: &VolumeInfo,
    required_work_bytes: u64,
) -> AppResult<()> {
    if config.formal {
        if total_files < FORMAL_MIN_FILES || total_bytes < FORMAL_MIN_BYTES {
            return Err(AppError::Message(format!(
                "FORMAL_STRESS_SCALE_TOO_SMALL: {total_files} files/{total_bytes} bytes"
            )));
        }
        if !source_volume
            .filesystem
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("exfat"))
        {
            return Err(AppError::Message(format!(
                "FORMAL_STRESS_REQUIRES_EXFAT: detected {}",
                source_volume.filesystem.as_deref().unwrap_or("unknown")
            )));
        }
        if source_volume.root.eq_ignore_ascii_case(&work_volume.root) {
            return Err(AppError::Message(format!(
                "FORMAL_STRESS_WORK_ROOT_ON_SOURCE_VOLUME: {}",
                source_volume.root
            )));
        }
    }
    if work_volume.available_bytes < required_work_bytes {
        return Err(AppError::Message(format!(
            "STRESS_INSUFFICIENT_WORK_SPACE: {} available, {required_work_bytes} required",
            work_volume.available_bytes
        )));
    }
    Ok(())
}

fn required_work_bytes(source_bytes: u64) -> AppResult<u64> {
    let four_copies = source_bytes
        .checked_mul(4)
        .ok_or_else(|| AppError::Message("压力测试空间估算溢出".into()))?;
    let reserve = (source_bytes / 4).max(64 * 1024 * 1024);
    four_copies
        .checked_add(reserve)
        .ok_or_else(|| AppError::Message("压力测试空间估算溢出".into()))
}

fn prepare_work_root(source: &Path, requested: &Path, formal: bool) -> AppResult<PathBuf> {
    if requested.exists() {
        return Err(AppError::Message(format!(
            "STRESS_WORK_ROOT_ALREADY_EXISTS: {}",
            requested.display()
        )));
    }
    let parent = requested.parent().ok_or_else(|| {
        AppError::Message("STRESS_WORK_ROOT must have an existing parent directory".into())
    })?;
    let name = requested.file_name().ok_or_else(|| {
        AppError::Message("STRESS_WORK_ROOT must name a dedicated directory".into())
    })?;
    let parent = fs::canonicalize(parent)?;
    let work_root = parent.join(name);
    if work_root.starts_with(source) {
        return Err(AppError::Message(
            "STRESS_WORK_ROOT cannot be inside the source episode".into(),
        ));
    }
    fs::create_dir(&work_root)?;
    fs::create_dir(work_root.join("imports"))?;
    fs::create_dir(work_root.join("exports"))?;
    let marker = serde_json::json!({
        "schemaVersion": 1,
        "application": "DOHC Viewer",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "formal": formal,
        "sourcePath": source.display().to_string(),
        "createdAtUnixMs": unix_millis(),
    });
    let mut marker_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(work_root.join(WORKSPACE_MARKER))?;
    serde_json::to_writer_pretty(&mut marker_file, &marker)?;
    marker_file.write_all(b"\n")?;
    marker_file.sync_all()?;
    Ok(fs::canonicalize(work_root)?)
}

fn record_phase<T>(
    report: &mut StressReport,
    heartbeat: &ConsoleHeartbeat,
    name: &str,
    logical_bytes: u64,
    operation: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    heartbeat.set_phase(name);
    eprintln!("[stress-check] START {name}");
    let started = Instant::now();
    let peak_before = peak_rss_bytes();
    let result = operation();
    let duration_ms = elapsed_millis(started);
    let peak_after = peak_rss_bytes();
    let throughput = if logical_bytes > 0 && duration_ms > 0 {
        Some(
            (u128::from(logical_bytes) * 1000 / u128::from(duration_ms)).min(u128::from(u64::MAX))
                as u64,
        )
    } else {
        None
    };
    let error = result.as_ref().err().map(ToString::to_string);
    let status = if error.is_some() { "failed" } else { "passed" };
    report.phases.push(PhaseEvidence {
        name: name.into(),
        status: status.into(),
        duration_ms,
        logical_bytes,
        logical_throughput_bytes_per_second: throughput,
        peak_rss_before_bytes: peak_before,
        peak_rss_after_bytes: peak_after,
        peak_rss_delta_bytes: peak_before
            .zip(peak_after)
            .map(|(before, after)| after.saturating_sub(before)),
        error,
    });
    eprintln!(
        "[stress-check] {} {name} ({duration_ms} ms)",
        status.to_uppercase()
    );
    result
}

fn ffmpeg_evidence(formal: bool) -> AppResult<FfmpegEvidence> {
    let explicit = std::env::var_os("DOHC_FFMPEG").map(PathBuf::from);
    if formal && explicit.is_none() {
        return Err(AppError::Message(
            "FORMAL_STRESS_REQUIRES_DOHC_FFMPEG".into(),
        ));
    }
    if formal && explicit.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err(AppError::Message(
            "FORMAL_STRESS_REQUIRES_ABSOLUTE_FFMPEG_PATH".into(),
        ));
    }
    let command = explicit.clone().unwrap_or_else(|| {
        PathBuf::from(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        })
    });
    let output = Command::new(&command)
        .arg("-version")
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(AppError::Message(format!(
            "STRESS_FFMPEG_VERSION_FAILED: {}",
            command.display()
        )));
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("unknown")
        .to_string();
    let (size_bytes, blake3) = if let Some(path) = &explicit {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Message(
                "STRESS_FFMPEG_PATH_NOT_REGULAR_FILE".into(),
            ));
        }
        (Some(metadata.len()), Some(blake3_file(path)?))
    } else {
        (None, None)
    };
    Ok(FfmpegEvidence {
        command: command.display().to_string(),
        explicit_path: explicit.is_some(),
        version,
        size_bytes,
        blake3,
    })
}

fn blake3_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn write_report(path: &Path, report: &StressReport) -> AppResult<()> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(REPORT_NAME);
    let partial = path.with_file_name(format!(
        ".{name}.partial-{}-{}",
        std::process::id(),
        unix_nanos()
    ));
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)?;
        serde_json::to_writer_pretty(&mut file, report)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        storage::publish_noreplace(&partial, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn git_evidence() -> GitEvidence {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")));
    let head = git_output(repository, &["rev-parse", "HEAD"]);
    let exact_tag = git_output(repository, &["describe", "--tags", "--exact-match", "HEAD"]);
    let exact_tag_annotated = exact_tag.as_ref().and_then(|tag| {
        git_output(repository, &["cat-file", "-t", &format!("refs/tags/{tag}")])
            .map(|kind| kind == "tag")
    });
    let clean = Command::new("git")
        .args(["status", "--porcelain=v1"])
        .current_dir(repository)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output.stdout.is_empty());
    GitEvidence {
        head,
        exact_tag,
        exact_tag_annotated,
        clean,
    }
}

fn git_output(repository: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .current_dir(repository)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|output| !output.is_empty())
}

struct ConsoleHeartbeat {
    phase: Arc<Mutex<String>>,
    stop: Option<mpsc::Sender<()>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ConsoleHeartbeat {
    fn start(started: Instant) -> Self {
        let phase = Arc::new(Mutex::new(String::from("startup")));
        let thread_phase = phase.clone();
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || loop {
            match receiver.recv_timeout(Duration::from_secs(30)) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {
                    let current = thread_phase
                        .lock()
                        .map(|value| value.clone())
                        .unwrap_or_else(|_| "unknown".into());
                    eprintln!(
                        "[stress-check] RUNNING {current} ({} s)",
                        started.elapsed().as_secs()
                    );
                }
            }
        });
        Self {
            phase,
            stop: Some(sender),
            handle: Some(handle),
        }
    }

    fn set_phase(&self, value: &str) {
        if let Ok(mut phase) = self.phase.lock() {
            value.clone_into(&mut phase);
        }
    }
}

impl Drop for ConsoleHeartbeat {
    fn drop(&mut self) {
        if let Some(sender) = self.stop.take() {
            let _ = sender.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(unix)]
fn peak_rss_bytes() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage initializes the provided rusage when it returns zero.
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    // SAFETY: the successful getrusage call above initialized usage.
    let rss = unsafe { usage.assume_init() }.ru_maxrss;
    let rss = u64::try_from(rss).ok()?;
    if cfg!(target_os = "macos") {
        Some(rss)
    } else {
        rss.checked_mul(1024)
    }
}

#[cfg(windows)]
fn peak_rss_bytes() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    counters.cb = u32::try_from(std::mem::size_of::<PROCESS_MEMORY_COUNTERS>()).ok()?;
    let size = counters.cb;
    // SAFETY: counters points to a correctly sized writable structure and the
    // pseudo handle returned by GetCurrentProcess is valid in this process.
    let result = unsafe {
        GetProcessMemoryInfo(GetCurrentProcess(), std::ptr::addr_of_mut!(counters), size)
    };
    (result != 0)
        .then(|| u64::try_from(counters.PeakWorkingSetSize).ok())
        .flatten()
}

#[cfg(not(any(unix, windows)))]
fn peak_rss_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::{enforce_scale_and_storage, required_work_bytes, StressConfig};
    use crate::model::VolumeInfo;
    use std::path::PathBuf;

    fn volume(root: &str, filesystem: &str, available_bytes: u64) -> VolumeInfo {
        VolumeInfo {
            root: root.into(),
            filesystem: Some(filesystem.into()),
            drive_type: "fixed".into(),
            total_bytes: available_bytes,
            available_bytes,
        }
    }

    #[test]
    fn formal_scale_gate_requires_exfat_and_full_size() {
        let config = StressConfig::new(PathBuf::from("source"), PathBuf::from("work"), true);
        let source = volume("/Volumes/DOHC", "exFAT", 100_000_000_000);
        let work = volume("/", "APFS", 500_000_000_000);
        assert!(enforce_scale_and_storage(
            &config,
            100_000,
            100_000_000_000,
            &source,
            &work,
            425_000_000_000,
        )
        .is_ok());
        assert!(enforce_scale_and_storage(
            &config,
            99_999,
            100_000_000_000,
            &source,
            &work,
            425_000_000_000,
        )
        .is_err());
        let wrong_filesystem = volume("/Volumes/DOHC", "APFS", 100_000_000_000);
        assert!(enforce_scale_and_storage(
            &config,
            100_000,
            100_000_000_000,
            &wrong_filesystem,
            &work,
            425_000_000_000,
        )
        .is_err());
        let windows_source = volume("E:\\", "exFAT", 100_000_000_000);
        let same_windows_volume = volume("e:\\", "NTFS", 500_000_000_000);
        assert!(enforce_scale_and_storage(
            &config,
            100_000,
            100_000_000_000,
            &windows_source,
            &same_windows_volume,
            425_000_000_000,
        )
        .is_err());
    }

    #[test]
    fn work_space_budget_covers_four_outputs_and_reserve() {
        assert_eq!(
            required_work_bytes(100_000_000_000).unwrap(),
            425_000_000_000
        );
        assert_eq!(required_work_bytes(80_000_000).unwrap(), 387_108_864);
    }
}
