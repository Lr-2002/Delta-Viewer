use dohc_viewer_lib::stress::{run_stress, StressConfig};
use std::path::PathBuf;

const USAGE: &str = "Usage:\n  cargo run --release --manifest-path src-tauri/Cargo.toml --example stress-check -- --source <episode> --work-root <new-directory>\n\nOptions:\n  --source <episode>          Source episode on the SD card\n  --work-root <directory>     Dedicated directory that must not already exist\n  --development-fixture      Relax exFAT, scale, release, and Git-tag gates\n  -h, --help                 Show this help";

#[derive(Debug)]
struct Arguments {
    source: PathBuf,
    work_root: PathBuf,
    formal: bool,
}

fn main() {
    let arguments = match parse_arguments(std::env::args().skip(1)) {
        Ok(Some(arguments)) => arguments,
        Ok(None) => {
            println!("{USAGE}");
            return;
        }
        Err(error) => {
            eprintln!("{error}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    let report = match run_stress(StressConfig::new(
        arguments.source,
        arguments.work_root,
        arguments.formal,
    )) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("stress-check could not start or persist its report: {error}");
            std::process::exit(2);
        }
    };
    match serde_json::to_string_pretty(&report) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("stress-check could not serialize its report: {error}");
            std::process::exit(2);
        }
    }
    eprintln!("stress-check report: {}", report.report_path());
    if !report.passed() {
        std::process::exit(1);
    }
}

fn parse_arguments(arguments: impl Iterator<Item = String>) -> Result<Option<Arguments>, String> {
    let mut source = None;
    let mut work_root = None;
    let mut formal = true;
    let mut arguments = arguments.peekable();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "-h" | "--help" => return Ok(None),
            "--source" => source = Some(next_path(&mut arguments, "--source")?),
            "--work-root" => work_root = Some(next_path(&mut arguments, "--work-root")?),
            "--development-fixture" => formal = false,
            _ => return Err(format!("unknown argument: {argument}")),
        }
    }
    Ok(Some(Arguments {
        source: source.ok_or_else(|| "missing required --source".to_string())?,
        work_root: work_root.ok_or_else(|| "missing required --work-root".to_string())?,
        formal,
    }))
}

fn next_path(
    arguments: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<PathBuf, String> {
    let value = arguments
        .next()
        .ok_or_else(|| format!("missing value for {option}"))?;
    if value.is_empty() {
        return Err(format!("empty value for {option}"));
    }
    Ok(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::parse_arguments;

    #[test]
    fn formal_mode_is_the_default() {
        let arguments = parse_arguments(
            ["--source", "source", "--work-root", "work"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap()
        .unwrap();
        assert!(arguments.formal);
    }

    #[test]
    fn development_fixture_must_be_explicit() {
        let arguments = parse_arguments(
            [
                "--source",
                "source",
                "--work-root",
                "work",
                "--development-fixture",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .unwrap()
        .unwrap();
        assert!(!arguments.formal);
    }

    #[test]
    fn rejects_unknown_arguments() {
        let error = parse_arguments(["--unknown"].into_iter().map(str::to_string)).unwrap_err();
        assert!(error.contains("unknown argument"));
    }
}
