//! Explicit, read-only directory relocations. Recording identities stay immutable.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

#[derive(Default, Deserialize, Serialize)]
pub struct Registry {
    #[serde(default)]
    moves: Vec<Move>,
}
#[derive(Deserialize, Serialize)]
struct Move {
    source: String,
    destination: String,
    state: String,
}

fn safe(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', ':', '\0'])
        && value
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
        && Path::new(value)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}

pub fn share_root(path: &Path) -> Option<&Path> {
    path.ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("Delta-D1") || n == "一汽data")
        })?
        .parent()
}

impl Registry {
    pub fn read(path: &Path) -> AppResult<Self> {
        let Some(share) = share_root(path) else {
            return Ok(Self::default());
        };
        let file = share.join("Delta-Viewer-TaskIndex/Delta-D1/layout.json");
        let Some(bytes) = crate::machine_annotation::read_bytes(&file)? else {
            return Ok(Self::default());
        };
        let registry: Self = serde_json::from_slice(&bytes)?;
        if registry.moves.len() > 10_000
            || registry.moves.iter().any(|m| {
                !safe(&m.source) || !safe(&m.destination) || !m.destination.starts_with("Delta-D1/")
            })
        {
            return Err(AppError::Message(
                "DATASET_LAYOUT_INVALID: 目录迁移映射无效，未猜测目标目录".into(),
            ));
        }
        let mut sources = std::collections::BTreeSet::new();
        let mut destinations = std::collections::BTreeSet::new();
        for m in registry.moves.iter().filter(|m| m.state == "completed") {
            if !sources.insert(&m.source) || !destinations.insert(&m.destination) {
                return Err(AppError::Message(
                    "DATASET_LAYOUT_INVALID: 目录迁移映射存在歧义".into(),
                ));
            }
        }
        for m in registry.moves.iter().filter(|m| m.state == "completed") {
            let mut value = m.source.clone();
            let mut seen = std::collections::BTreeSet::new();
            seen.insert(value.clone());
            for _ in 0..registry.moves.len() {
                let Some(next) = registry.translate_once(&value, false) else {
                    break;
                };
                if !seen.insert(next.clone()) {
                    return Err(AppError::Message(
                        "DATASET_LAYOUT_INVALID: 目录迁移映射循环".into(),
                    ));
                }
                value = next;
            }
        }
        Ok(registry)
    }

    pub fn translate(&self, value: &str, reverse: bool) -> Option<String> {
        let mut current = value.to_owned();
        let mut seen = std::collections::BTreeSet::new();
        seen.insert(current.clone());
        for _ in 0..self.moves.len() {
            let Some(next) = self.translate_once(&current, reverse) else {
                break;
            };
            if !seen.insert(next.clone()) {
                return None;
            }
            current = next;
        }
        (current != value).then_some(current)
    }

    fn translate_once(&self, value: &str, reverse: bool) -> Option<String> {
        self.moves
            .iter()
            .filter(|m| m.state == "completed")
            .filter_map(|m| {
                let (from, to) = if reverse {
                    (&m.destination, &m.source)
                } else {
                    (&m.source, &m.destination)
                };
                (value == from || value.starts_with(&format!("{from}/")))
                    .then(|| (from.len(), format!("{to}{}", &value[from.len()..])))
            })
            .max_by_key(|(len, _)| *len)
            .map(|(_, value)| value)
    }
}

/// Resolve only registered moves, never search by a repeated episode name.
pub fn resolve(path: &Path) -> AppResult<PathBuf> {
    let Some(share) = share_root(path) else {
        return Ok(path.to_path_buf());
    };
    let registry = Registry::read(path)?;
    let relative = path
        .strip_prefix(share)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let Some(mapped) = registry.translate(&relative, false) else {
        return Ok(path.to_path_buf());
    };
    match std::fs::symlink_metadata(path) {
        Ok(_) => return Ok(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let candidate = share.join(mapped);
    let canonical = candidate.canonicalize()?;
    // Canonicalize the share separately to support Windows extended UNC paths.
    if !canonical.starts_with(share.canonicalize()?) {
        return Err(AppError::Message(
            "DATASET_LAYOUT_INVALID: 迁移目录越界".into(),
        ));
    }
    let mut current = candidate.as_path();
    while current != share {
        let info = std::fs::symlink_metadata(current)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if info.file_attributes() & 0x400 != 0 {
                return Err(AppError::Message(
                    "DATASET_LAYOUT_INVALID: 迁移目录不能经过链接".into(),
                ));
            }
        }
        if info.file_type().is_symlink() {
            return Err(AppError::Message(
                "DATASET_LAYOUT_INVALID: 迁移目录不能经过链接".into(),
            ));
        }
        current = current
            .parent()
            .ok_or_else(|| AppError::Message("迁移目录无效".into()))?;
    }
    Ok(canonical)
}

/// The durable offline queue must never consult the unavailable NAS.
pub fn cache_registry(data_root: &Path, path: &Path) -> AppResult<()> {
    let registry = Registry::read(path)?;
    if share_root(path).is_some() {
        std::fs::create_dir_all(data_root)?;
        crate::machine_review::atomic_json(
            &data_root.join("dataset-layout.json"),
            &serde_json::to_value(registry)?,
        )?;
    }
    Ok(())
}

pub fn historical_paths_cached(data_root: &Path, path: &Path) -> AppResult<Vec<PathBuf>> {
    let Some(share) = share_root(path) else {
        return Ok(vec![]);
    };
    let Some(bytes) =
        crate::machine_annotation::read_bytes(&data_root.join("dataset-layout.json"))?
    else {
        return Ok(vec![]);
    };
    let registry: Registry = serde_json::from_slice(&bytes)?;
    if registry.moves.len() > 10_000
        || registry
            .moves
            .iter()
            .any(|m| !safe(&m.source) || !safe(&m.destination))
    {
        return Err(AppError::Message(
            "DATASET_LAYOUT_INVALID: 本机映射无效".into(),
        ));
    }
    historical_paths(&registry, share, path)
}

fn historical_paths(registry: &Registry, share: &Path, path: &Path) -> AppResult<Vec<PathBuf>> {
    let mut relative = path
        .strip_prefix(share)
        .map_err(|_| AppError::Message("映射目录越界".into()))?
        .to_string_lossy()
        .replace('\\', "/");
    let mut seen = std::collections::BTreeSet::new();
    seen.insert(relative.clone());
    let mut paths = vec![];
    for _ in 0..registry.moves.len() {
        let Some(next) = registry.translate_once(&relative, true) else {
            break;
        };
        if !seen.insert(next.clone()) {
            return Err(AppError::Message(
                "DATASET_LAYOUT_INVALID: 本机映射循环".into(),
            ));
        }
        relative = next;
        paths.push(share.join(&relative));
    }
    Ok(paths)
}

pub fn historical_paths_for(path: &Path) -> AppResult<Vec<PathBuf>> {
    let Some(share) = share_root(path) else {
        return Ok(vec![]);
    };
    historical_paths(&Registry::read(path)?, share, path)
}

#[cfg(test)]
pub fn historical(path: &Path) -> AppResult<PathBuf> {
    let Some(share) = share_root(path) else {
        return Ok(path.to_path_buf());
    };
    let relative = path
        .strip_prefix(share)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Registry::read(path)?
        .translate(&relative, true)
        .map(|mapped| share.join(mapped))
        .unwrap_or_else(|| path.to_path_buf()))
}

pub fn dated(name: &str) -> bool {
    let Some(d) = name.get(..10) else {
        return false;
    };
    if !d.is_ascii() || d.as_bytes()[4] != b'-' || d.as_bytes()[7] != b'-' {
        return false;
    }
    let Some((year, month, day)) = d[..4]
        .parse::<i32>()
        .ok()
        .zip(d[5..7].parse::<u8>().ok())
        .zip(d[8..10].parse::<u8>().ok())
        .map(|((y, m), d)| (y, m, d))
    else {
        return false;
    };
    time::Month::try_from(month)
        .ok()
        .is_some_and(|m| time::Date::from_calendar_date(year, m, day).is_ok())
        && name.as_bytes().get(10).is_none_or(|c| !c.is_ascii_digit())
}

pub fn grouping_name(name: &str) -> bool {
    let normalized: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        normalized.as_str(),
        "d1daily" | "d1validation" | "d1yiqi" | "d1motioncaption"
    )
}

/// First dated folder is the batch; grouping folders never own their descendants.
pub fn batch_relative(relative: &str) -> String {
    let parts: Vec<_> = relative.split('/').filter(|s| !s.is_empty()).collect();
    let count = parts.iter().position(|name| dated(name)).map_or_else(
        || {
            if parts.first().is_some_and(|p| grouping_name(p)) {
                2
            } else {
                1
            }
        },
        |i| i + 1,
    );
    parts[..count.min(parts.len())].join("/")
}

pub fn batch_root(path: &Path) -> Option<PathBuf> {
    let share = share_root(path)?;
    let relative = path
        .strip_prefix(share)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let (dataset, rest) = relative.split_once('/')?;
    if rest.is_empty() {
        return None;
    }
    Some(share.join(dataset).join(batch_relative(rest)))
}

pub fn batch_key(namespace: &str, batch: &str, registry: &Registry) -> String {
    let relative = format!("{namespace}/{batch}");
    let original = registry.translate(&relative, true).unwrap_or(relative);
    let (dataset, batch) = original.split_once('/').unwrap_or((&original, ""));
    format!(
        "{:x}",
        Sha256::digest(format!("{}\n{batch}", dataset.to_lowercase()).as_bytes())
    )
}

/// Adapt legacy server shards after validating their original hashes and keys.
pub fn adapt_node(node: &mut serde_json::Value, source: &Path, prefix: &str, registry: &Registry) {
    let relative = node["relativePath"].as_str().unwrap_or("").to_owned();
    let full = [prefix, &relative]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let batch = batch_relative(&full);
    let dataset = source
        .ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("Delta-D1"))
        })
        .unwrap_or(source);
    let namespace = dataset.file_name().unwrap_or_default().to_string_lossy();
    let grouping = grouping_name(&full)
        || !full.is_empty()
            && !full.split('/').any(dated)
            && node["children"]
                .as_array()
                .is_some_and(|cs| cs.iter().any(|c| c["name"].as_str().is_some_and(dated)));
    node["claimable"] = serde_json::json!(
        !full.is_empty() && !grouping && (full == batch || node["session"] == true)
    );
    node["batchKey"] = serde_json::json!(batch_key(&namespace, &batch, registry));
    node["batchRoot"] = serde_json::json!(dataset.join(&batch).to_string_lossy());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    #[test]
    fn chained_branch_renames_preserve_identity_and_group_names_are_case_independent() {
        let registry: Registry = serde_json::from_value(json!({"moves":[
            {"source":"Delta-D1/2026-09-16-A", "destination":"Delta-D1/D1 daily/2026-09-16-A","state":"completed"},
            {"source":"Delta-D1/D1 daily", "destination":"Delta-D1/D1-Daily","state":"completed"}
        ]})).unwrap();
        assert_eq!(
            registry
                .translate("Delta-D1/2026-09-16-A/001", false)
                .unwrap(),
            "Delta-D1/D1-Daily/2026-09-16-A/001"
        );
        assert_eq!(
            registry
                .translate("Delta-D1/D1-Daily/2026-09-16-A/001", true)
                .unwrap(),
            "Delta-D1/2026-09-16-A/001"
        );
        for name in ["D1-Daily", "D1-Validation", "D1-Yiqi", "D1-Motion caption"] {
            let mut node =
                json!({"relativePath":name,"session":false,"children":[],"childrenLoaded":false});
            adapt_node(&mut node, Path::new("/share/Delta-D1"), "", &registry);
            assert_eq!(node["claimable"], false);
        }
        assert_eq!(
            batch_relative("D1-Motion caption/Skeleton/001"),
            "D1-Motion caption/Skeleton"
        );
        let share = Path::new("/share");
        let paths = historical_paths(
            &registry,
            share,
            &share.join("Delta-D1/D1-Daily/2026-09-16-A/001"),
        )
        .unwrap();
        assert_eq!(
            paths,
            vec![
                share.join("Delta-D1/D1 daily/2026-09-16-A/001"),
                share.join("Delta-D1/2026-09-16-A/001")
            ]
        );
        assert_eq!(
            batch_key("Delta-D1", "D1-Daily/2026-09-16-A", &registry),
            batch_key("Delta-D1", "2026-09-16-A", &Registry::default())
        );
    }

    #[test]
    fn source_scan_discovers_nested_sessions_and_skips_hidden_or_media_subtrees() {
        let root = std::env::temp_dir().join(format!(
            "layout-scan-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for path in [
            "D1 daily/2026-09-16-Test/001",
            "D1 validation/2026-09-16-Test/002",
            "D1 yiqi/2026-10-21/003",
            ".hidden/session",
            "Delta-Viewer-Previews/session",
        ] {
            fs::create_dir_all(root.join(path)).unwrap();
            fs::write(root.join(path).join("session.json"), b"{}").unwrap();
        }
        let result = crate::source::scan_source_catalog(
            &root,
            None,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.episodes.len(), 3);
        assert!(result.episodes.iter().all(|s| s.root.contains("D1 ")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn grouped_batches_are_independent_and_registered_moves_keep_legacy_keys() {
        let registry: Registry = serde_json::from_value(json!({"moves":[
            {"source":"Delta-D1/2026-09-16-A", "destination":"Delta-D1/D1 daily/2026-09-16-A","state":"completed"},
            {"source":"一汽data","destination":"Delta-D1/D1 yiqi","state":"completed"}
        ]})).unwrap();
        let source = Path::new("/share/Delta-D1");
        let node = |relative: &str| json!({"relativePath":relative,"session":false,"children":[]});
        let mut group = node("D1 daily");
        adapt_node(&mut group, source, "", &registry);
        assert_eq!(group["claimable"], false);
        let mut a = node("D1 daily/2026-09-16-A");
        adapt_node(&mut a, source, "", &registry);
        let mut b = node("D1 daily/2026-09-16-B");
        adapt_node(&mut b, source, "", &registry);
        let mut copy = node("D1 validation/2026-09-16-A");
        adapt_node(&mut copy, source, "", &registry);
        assert_eq!(
            batch_root(&source.join("D1 daily/2026-10-14-Kitchen Table/Kitchen_Table_360"))
                .unwrap(),
            source.join("D1 daily/2026-10-14-Kitchen Table")
        );
        assert_ne!(a["batchKey"], b["batchKey"]);
        assert_ne!(a["batchKey"], copy["batchKey"]);
        assert_eq!(
            a["batchKey"],
            batch_key("Delta-D1", "2026-09-16-A", &Registry::default())
        );
        assert_eq!(
            batch_key("Delta-D1", "D1 yiqi/2026-10-15", &registry),
            batch_key("一汽data", "2026-10-15", &Registry::default())
        );
        let mut session = json!({"relativePath":"sample","session":true,"children":[]});
        adapt_node(
            &mut session,
            &source.join("D1 daily/2026-09-16-A"),
            "D1 daily/2026-09-16-A",
            &registry,
        );
        assert_eq!(session["batchKey"], a["batchKey"]);
        assert_eq!(
            session["batchRoot"],
            source
                .join("D1 daily/2026-09-16-A")
                .to_string_lossy()
                .as_ref()
        );
        for invalid in ["2026-02-30", "中文目录测试", "2026-10-210", "2026-13-01"] {
            assert!(!dated(invalid));
        }
    }

    #[test]
    fn explicit_relocation_uses_longest_prefix_and_never_replaces_existing_paths() {
        let root = std::env::temp_dir().join(format!(
            "viewer-layout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dataset = root.join("Delta-D1");
        let out = root.join("Delta-Viewer-TaskIndex/Delta-D1");
        fs::create_dir_all(&out).unwrap();
        let target = dataset.join("D1 daily/2026-10-14-B/new");
        fs::create_dir_all(&target).unwrap();
        let old = dataset.join("2026-10-14-A/old");
        fs::write(out.join("layout.json"),serde_json::to_vec(&json!({"moves":[
            {"source":"Delta-D1/2026-10-14-A","destination":"Delta-D1/D1 validation/2026-10-14-A","state":"completed"},
            {"source":"Delta-D1/2026-10-14-A/old","destination":"Delta-D1/D1 daily/2026-10-14-B/new","state":"completed"}
        ]})).unwrap()).unwrap();
        assert_eq!(resolve(&old).unwrap(), target.canonicalize().unwrap());
        assert_eq!(historical(&target).unwrap(), old);
        fs::create_dir_all(&old).unwrap();
        assert_eq!(resolve(&old).unwrap(), old);
        assert_eq!(
            resolve(&dataset.join("unregistered/sample")).unwrap(),
            dataset.join("unregistered/sample")
        );
        fs::write(
            out.join("layout.json"),
            r#"{"moves":[{"source":"../unsafe","destination":"Delta-D1/x","state":"completed"}]}"#,
        )
        .unwrap();
        assert!(resolve(&old)
            .unwrap_err()
            .to_string()
            .contains("DATASET_LAYOUT_INVALID"));
        fs::remove_dir_all(root).unwrap();
    }
}
