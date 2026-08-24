use crate::error::{AppError, AppResult};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SOURCE_PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const SOURCE_PATH_PROBE_INTERVAL: Duration = Duration::from_millis(25);

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
    use super::{directory_probe_command, wait_for_probe};
    use std::path::Path;
    #[cfg(unix)]
    use std::process::Command;
    use std::process::Stdio;
    use std::time::Duration;
    #[cfg(unix)]
    use std::time::Instant;

    #[test]
    fn accepts_a_responsive_directory() {
        let mut command = directory_probe_command(Path::new("."));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        wait_for_probe(child, Path::new("."), Duration::from_secs(1)).unwrap();
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
        let error = wait_for_probe(child, missing, Duration::from_secs(1))
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
