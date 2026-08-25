use crate::error::{AppError, AppResult};
use crate::model::SupervisionReportExportResult;
use crate::storage;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Instant;

const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;

pub fn export(
    destination_parent: &Path,
    kind: &str,
    format: &str,
    report_date: &str,
    generated_at_ms: u64,
    content: &str,
) -> AppResult<SupervisionReportExportResult> {
    let started = Instant::now();
    if !matches!(kind, "daily" | "weekly" | "task")
        || !matches!(format, "json" | "csv" | "html")
        || !valid_date(report_date)
        || generated_at_ms == 0
        || content.is_empty()
        || content.len() > MAX_REPORT_BYTES
        || content.contains('\0')
    {
        return Err(AppError::Message(
            "SUPERVISION_REPORT_INVALID: 报表参数无效".into(),
        ));
    }
    let metadata = fs::metadata(destination_parent)?;
    if !metadata.is_dir() {
        return Err(AppError::Message(
            "SUPERVISION_REPORT_DESTINATION_INVALID: 目标不是文件夹".into(),
        ));
    }
    let file_name = format!("dohc-{kind}-report-{report_date}-{generated_at_ms}.{format}");
    let output = destination_parent.join(file_name);
    let partial = destination_parent.join(format!(
        ".{}.partial-{}",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("report"),
        generated_at_ms
    ));
    let result = (|| -> AppResult<SupervisionReportExportResult> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        let mut file = options.open(&partial)?;
        file.write_all(content.as_bytes())?;
        file.flush()?;
        file.sync_all()?;

        let mut verified = Vec::with_capacity(content.len());
        fs::File::open(&partial)?
            .take((MAX_REPORT_BYTES + 1) as u64)
            .read_to_end(&mut verified)?;
        if verified != content.as_bytes() {
            return Err(AppError::Message(
                "SUPERVISION_REPORT_VERIFY_FAILED: 报表回读不一致".into(),
            ));
        }
        storage::publish_noreplace(&partial, &output)?;
        Ok(SupervisionReportExportResult {
            output_path: output.to_string_lossy().into_owned(),
            total_bytes: verified.len() as u64,
            elapsed_ms: started.elapsed().as_millis(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn valid_date(value: &str) -> bool {
    value.len() == 10
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::export;

    #[test]
    fn writes_and_verifies_report_without_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "dohc-supervision-report-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let first = export(&root, "daily", "json", "2026-08-25", 1, "{}\n").unwrap();
        assert_eq!(std::fs::read_to_string(first.output_path).unwrap(), "{}\n");
        assert!(export(&root, "daily", "json", "2026-08-25", 1, "changed").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
