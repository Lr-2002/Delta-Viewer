use crate::error::{AppError, AppResult};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SOURCE_PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const SOURCE_PATH_PROBE_INTERVAL: Duration = Duration::from_millis(25);
const REVIEW_PROBE_ARG: &str = "--delta-review-storage-probe";
// Two bounded JSON partials plus filesystem metadata, not media capacity.
const REVIEW_MIN_FREE_BYTES: u64 = 32 * 1024 * 1024;

/// Read-only helper, dispatched before Tauri initialization. Keeping statvfs in
/// a child lets us terminate a stuck SMB capacity query BEFORE any save starts.
pub fn run_review_probe_if_requested() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(REVIEW_PROBE_ARG)) {
        return;
    }
    let code = match (args.next(), args.next()) {
        (Some(path), None) => review_probe_code(Path::new(&path), review_available_space),
        _ => 4,
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn review_available_space(path: &Path) -> std::io::Result<u64> {
    fs2::available_space(path)
}

#[cfg(windows)]
fn review_available_space(path: &Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    // Query the caller's available bytes directly, supporting long UNC paths
    // and quotas; fs2 0.4's fixed volume-path buffer loses those distinctions.
    let result = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(available)
    }
}

fn review_probe_code(path: &Path, available: impl FnOnce(&Path) -> std::io::Result<u64>) -> i32 {
    let Ok(resolved) = crate::dataset_layout::resolve(path) else {
        return 2;
    };
    let path = resolved.as_path();
    if !path.is_dir() {
        return 2;
    }
    let Ok(write_root) = crate::storage::review_write_root(path) else {
        return 4;
    };
    match available(&write_root) {
        Ok(bytes) if bytes < REVIEW_MIN_FREE_BYTES => 3,
        Ok(_) => 0,
        Err(_) => 4,
    }
}

pub fn ensure_review_storage_responsive(path: &Path) -> AppResult<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command.arg(REVIEW_PROBE_ARG).arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn().map_err(|error| {
        AppError::Message(format!(
        "REVIEW_STORAGE_PROBE_FAILED: 无法启动数据目录保存检查：{error}。尚未开始写入，请重试。"
    ))
    })?;
    wait_for_review_probe(child, path, SOURCE_PATH_PROBE_TIMEOUT)
}

fn wait_for_review_probe(mut child: Child, path: &Path, timeout: Duration) -> AppResult<()> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(AppError::Message(match status.code() {
                Some(2) => format!("SOURCE_UNAVAILABLE: 数据目录不存在或不可访问：{}。尚未开始写入，请检查共享目录连接。", path.display()),
                Some(3) => format!("REVIEW_STORAGE_FULL: 数据目录所在磁盘/NAS 可用空间不足，原子保存需至少 32 MiB 临时空间：{}。尚未开始本次写入；请管理员释放空间或扩容后重试。此问题与用户中心上传无关。", path.display()),
                _ => format!("REVIEW_STORAGE_PROBE_FAILED: 无法确认数据目录的可用空间：{}。原因未知，尚未开始写入，请检查目录权限和存储状态后重试。", path.display()),
            })),
            Ok(None) if started.elapsed() < timeout => thread::sleep(SOURCE_PATH_PROBE_INTERVAL),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Message(match result {
                    Err(error) => format!("REVIEW_STORAGE_PROBE_FAILED: 保存检查失败：{error}。尚未开始写入，请重试。"),
                    _ => format!("REVIEW_STORAGE_UNRESPONSIVE: 数据目录保存检查在 {} 秒内未响应：{}。尚未开始写入；请检查 NAS 负载、容量及共享目录连接后重试。", timeout.as_secs(), path.display()),
                }));
            }
        }
    }
}

pub fn ensure_directory_responsive(path: &Path) -> AppResult<()> {
    let mut command = directory_probe_command(path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn().map_err(|error| {
        AppError::Message(format!(
            "SOURCE_PROBE_FAILED: 无法检查源目录 {}: {error}",
            path.display()
        ))
    })?;
    wait_for_probe(child, path, SOURCE_PATH_PROBE_TIMEOUT)
}

#[cfg(unix)]
fn directory_probe_command(path: &Path) -> Command {
    let mut command = Command::new("sh");
    command
        .args(["-c", "[ -d \"$1\" ]", "dohc-source-probe"])
        .arg(path);
    command
}

#[cfg(windows)]
fn directory_probe_command(path: &Path) -> Command {
    let mut command = Command::new("powershell.exe");
    command
        .env("DOHC_SOURCE_PROBE_PATH", path)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$probePath = [Environment]::GetEnvironmentVariable('DOHC_SOURCE_PROBE_PATH'); if (Test-Path -LiteralPath $probePath -PathType Container) { exit 0 } else { exit 2 }",
        ]);
    command
}

fn wait_for_probe(mut child: Child, path: &Path, timeout: Duration) -> AppResult<()> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                return Err(AppError::Message(format!(
                    "SOURCE_UNAVAILABLE: 源目录不存在或当前不可访问: {}",
                    path.display()
                )))
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(SOURCE_PATH_PROBE_INTERVAL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Message(format!(
                    "SOURCE_UNRESPONSIVE: 源目录在 {} 秒内没有响应: {}。请检查 NAS 网络或重新配置目录",
                    timeout.as_secs(),
                    path.display()
                )));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Message(format!(
                    "SOURCE_PROBE_FAILED: 无法检查源目录 {}: {error}",
                    path.display()
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        directory_probe_command, review_probe_code, wait_for_probe, REVIEW_MIN_FREE_BYTES,
    };
    use std::path::Path;
    #[cfg(unix)]
    use std::process::Command;
    use std::process::Stdio;
    use std::time::Duration;
    #[cfg(unix)]
    use std::time::Instant;

    #[test]
    fn review_capacity_probe_distinguishes_full_unknown_and_missing_without_writing() {
        let root =
            std::env::temp_dir().join(format!("delta-review-capacity-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        for available in [0, 1, REVIEW_MIN_FREE_BYTES - 1] {
            assert_eq!(review_probe_code(&root, |_| Ok(available)), 3);
        }
        assert_eq!(review_probe_code(&root, |_| Ok(REVIEW_MIN_FREE_BYTES)), 0);
        assert_eq!(
            review_probe_code(&root, |_| Err(std::io::ErrorKind::PermissionDenied.into())),
            4
        );
        assert_eq!(
            review_probe_code(&root.join("missing"), |_| panic!(
                "must not query missing directory"
            )),
            2
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn review_probe_reports_full_without_starting_a_save_and_bounds_stalled_checks() {
        let child = Command::new("sh").args(["-c", "exit 3"]).spawn().unwrap();
        let error =
            super::wait_for_review_probe(child, Path::new("/test NAS"), Duration::from_secs(1))
                .unwrap_err()
                .to_string();
        assert!(error.contains("REVIEW_STORAGE_FULL"));
        assert!(error.contains("尚未开始本次写入"));
        let child = Command::new("sh").args(["-c", "sleep 5"]).spawn().unwrap();
        let started = Instant::now();
        let error =
            super::wait_for_review_probe(child, Path::new("/test NAS"), Duration::from_millis(75))
                .unwrap_err()
                .to_string();
        assert!(error.contains("REVIEW_STORAGE_UNRESPONSIVE"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn accepts_a_responsive_directory() {
        let mut command = directory_probe_command(Path::new("."));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        // Windows may need a cold PowerShell startup longer than one second;
        // use the same bounded probe window as the production path.
        wait_for_probe(child, Path::new("."), Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn rejects_a_missing_directory() {
        let missing = Path::new("dohc-source-probe-directory-that-must-not-exist");
        let mut command = directory_probe_command(missing);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        let error = wait_for_probe(child, missing, Duration::from_secs(5))
            .unwrap_err()
            .to_string();
        assert!(error.contains("SOURCE_UNAVAILABLE"));
    }

    #[cfg(unix)]
    #[test]
    fn terminates_an_unresponsive_probe_at_the_deadline() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 5"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        let started = Instant::now();
        let error = wait_for_probe(
            child,
            Path::new("/unresponsive-test-source"),
            Duration::from_millis(75),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("SOURCE_UNRESPONSIVE"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
