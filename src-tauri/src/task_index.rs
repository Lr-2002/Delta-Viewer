use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

fn invalid(message: &str) -> AppError {
    AppError::Message(format!("TASK_INDEX_UNAVAILABLE: {message}"))
}

fn safe_relative(value: &str) -> bool {
    !value.contains(['\\', ':', '\0'])
        && !value.starts_with('/')
        && (value.is_empty()
            || value
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."))
}

fn locations(source: &Path) -> AppResult<(PathBuf, String)> {
    let dataset = source
        .ancestors()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("Delta-D1"))
        })
        .ok_or_else(|| invalid("该目录尚未配置服务器统计索引，请选择 Delta-D1 内的目录"))?;
    let relative = source
        .strip_prefix(dataset)
        .map_err(|_| invalid("目录无效"))?;
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid("目录无效"));
    }
    let relative = relative.to_string_lossy().replace('\\', "/");
    let output = dataset
        .parent()
        .ok_or_else(|| invalid("数据集父目录不可用"))?
        .join("Delta-Viewer-TaskIndex")
        .join("Delta-D1");
    Ok((output, relative))
}

fn read(path: &Path) -> AppResult<Value> {
    let bytes = crate::machine_annotation::read_bytes(path)?
        .ok_or_else(|| invalid("服务器尚未生成统计索引，请联系管理员；不会自动全量扫描"))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn verify_directory(path: &Path) -> AppResult<()> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(invalid("索引目录必须是普通目录"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return Err(invalid("索引目录不能是重解析链接"));
        }
    }
    Ok(())
}

fn validate_node(node: &Value, expected: &str, dataset_relative: &str) -> AppResult<()> {
    if node["relativePath"].as_str() != Some(expected)
        || !safe_relative(expected)
        || node["name"].as_str().is_none()
        || node["session"].as_bool().is_none()
        || node["incomplete"].as_bool().is_none()
        || node["children"].as_array().is_none()
        || !matches!(
            node["status"].as_str(),
            Some("pending" | "approved" | "rejected" | "error")
        )
    {
        return Err(invalid("目录统计格式无效"));
    }
    for field in ["total", "reviewed", "approved", "rejected", "errors"] {
        if node[field].as_u64().is_none_or(|n| n > 250_000) {
            return Err(invalid("目录统计计数无效"));
        }
    }
    let batch = dataset_relative.split('/').next().unwrap_or("");
    let key = format!(
        "{:x}",
        Sha256::digest(format!("delta-d1\n{batch}").as_bytes())
    );
    if node["batchKey"].as_str() != Some(&key)
        || node["reviewed"].as_u64()
            != Some(node["approved"].as_u64().unwrap_or(0) + node["rejected"].as_u64().unwrap_or(0))
        || node["reviewed"].as_u64() > node["total"].as_u64()
    {
        return Err(invalid("目录统计身份或计数不一致"));
    }
    Ok(())
}

pub fn load(source: &Path, relative: &str) -> AppResult<Value> {
    if !safe_relative(relative) {
        return Err(invalid("目录路径无效"));
    }
    let (output, prefix) = locations(source)?;
    verify_directory(output.parent().ok_or_else(|| invalid("索引目录无效"))?)?;
    verify_directory(&output)?;
    let status = read(&output.join("status.json"))?;
    let manifest = match crate::machine_annotation::read_bytes(&output.join("index.json"))? {
        Some(bytes) => serde_json::from_slice::<Value>(&bytes)?,
        None => return Ok(json!({"catalog": null, "server": status})),
    };
    if manifest["schemaVersion"] != 1
        || manifest["dataset"] != "Delta-D1"
        || manifest["completedAtMs"].as_u64().is_none()
        || manifest["updatedAtMs"].as_u64().is_none()
    {
        return Err(invalid("服务器索引版本或数据集不匹配"));
    }
    let selected = [prefix.as_str(), relative]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let leaf = manifest["nodes"][&selected].is_null();
    let shard_path = if leaf {
        selected.rsplit_once('/').map_or("", |(parent, _)| parent)
    } else {
        selected.as_str()
    };
    let digest = manifest["nodes"][shard_path]
        .as_str()
        .ok_or_else(|| invalid("目录不在最近统计结果中，请等待服务器校准"))?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("索引文件标识无效"));
    }
    verify_directory(&output.join("nodes"))?;
    let bytes = crate::machine_annotation::read_bytes(
        &output.join("nodes").join(format!("{digest}.json")),
    )?
    .ok_or_else(|| invalid("目录索引缺失"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(invalid("目录索引校验失败"));
    }
    let mut tree: Value = serde_json::from_slice(&bytes)?;
    if leaf {
        tree = tree["children"]
            .as_array()
            .and_then(|nodes| {
                nodes
                    .iter()
                    .find(|node| node["relativePath"] == selected && node["session"] == true)
            })
            .cloned()
            .ok_or_else(|| invalid("目录不在最近统计结果中，请等待服务器校准"))?;
    }
    validate_node(&tree, &selected, &selected)?;
    let children = tree["children"]
        .as_array_mut()
        .ok_or_else(|| invalid("目录索引无效"))?;
    for child in children {
        let child_path = child["relativePath"]
            .as_str()
            .ok_or_else(|| invalid("子目录无效"))?
            .to_owned();
        let parent = child_path.rsplit_once('/').map_or("", |(parent, _)| parent);
        if parent != selected {
            return Err(invalid("子目录越界"));
        }
        validate_node(child, &child_path, &child_path)?;
        child["relativePath"] = json!(if prefix.is_empty() {
            child_path.as_str()
        } else {
            child_path
                .strip_prefix(&format!("{prefix}/"))
                .ok_or_else(|| invalid("子目录越界"))?
        });
    }
    tree["relativePath"] = json!(relative);
    Ok(
        json!({"catalog": {"sourceRoot": source.to_string_lossy(), "tree": tree}, "server": {
            "completedAtMs": manifest["completedAtMs"], "updatedAtMs": manifest["updatedAtMs"],
            "generation": manifest["generation"], "running": status["running"],
            "heartbeatAtMs": status["heartbeatAtMs"], "startedAtMs": status["startedAtMs"],
            "sessions": status["sessions"], "error": status["error"], "schedule": status["schedule"]
        }}),
    )
}

pub fn request_rebuild(source: &Path) -> AppResult<()> {
    let (output, _) = locations(source)?;
    verify_directory(output.parent().ok_or_else(|| invalid("索引目录无效"))?)?;
    verify_directory(&output)?;
    let manifest = read(&output.join("status.json"))?;
    if manifest["schedule"] != "23:00 Asia/Shanghai" {
        return Err(invalid("服务器统计服务未配置"));
    }
    let target = output.join("rebuild.request.json");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| invalid("系统时间无效"))?
        .as_nanos();
    let temporary = output.join(format!(".request-{}-{nonce}.partial", std::process::id()));
    let result = (|| -> AppResult<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(b"{\"rebuild\":true}")?;
        file.sync_all()?;
        drop(file);
        crate::storage::replace_file_atomic(&temporary, &target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_shards_without_source_scan_and_rejects_corruption_and_traversal() {
        let root = std::env::temp_dir().join(format!("viewer-task-index-{}", std::process::id()));
        let source = root.join("Delta-D1");
        let output = root.join("Delta-Viewer-TaskIndex/Delta-D1");
        fs::create_dir_all(output.join("nodes")).unwrap();
        // Source need not be enumerated or even exist for a cached task summary.
        let key = |batch: &str| {
            format!(
                "{:x}",
                Sha256::digest(format!("delta-d1\n{batch}").as_bytes())
            )
        };
        let leaf = json!({"name":"session", "relativePath":"batch/session", "batchKey":key("batch"),
            "session":true,"status":"rejected","error":"","total":1,"reviewed":1,"approved":0,
            "rejected":1,"errors":0,"incomplete":false,"scanning":false,"children":[],"childrenLoaded":true});
        let batch = json!({"name":"batch", "relativePath":"batch", "batchKey":key("batch"),
            "session":false,"status":"pending","error":"","total":1,"reviewed":1,"approved":0,
            "rejected":1,"errors":0,"incomplete":false,"scanning":false,"children":[leaf],"childrenLoaded":true});
        let bytes = serde_json::to_vec(&batch).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        fs::write(output.join("nodes").join(format!("{digest}.json")), &bytes).unwrap();
        let manifest = json!({"schemaVersion":1,"dataset":"Delta-D1","completedAtMs":123,"updatedAtMs":456,
            "generation":"test","nodes":{"batch":digest}});
        fs::write(
            output.join("index.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            output.join("status.json"),
            r#"{"running":false,"schedule":"23:00 Asia/Shanghai"}"#,
        )
        .unwrap();
        let value = load(&source, "batch").unwrap();
        assert_eq!(
            value["catalog"]["tree"]["children"][0]["relativePath"],
            "batch/session"
        );
        assert_eq!(value["server"]["completedAtMs"], 123);
        let nested = load(&source.join("batch"), "").unwrap();
        assert_eq!(nested["catalog"]["tree"]["relativePath"], "");
        assert_eq!(
            nested["catalog"]["tree"]["children"][0]["relativePath"],
            "session"
        );
        assert_eq!(nested["catalog"]["tree"]["batchKey"], key("batch"));
        assert!(load(&source, "../batch").is_err());
        assert!(load(&source, "batch\\session").is_err());
        request_rebuild(&source).unwrap();
        assert!(output.join("rebuild.request.json").is_file());
        fs::write(output.join("nodes").join(format!("{digest}.json")), b"{}").unwrap();
        assert!(load(&source, "batch")
            .unwrap_err()
            .to_string()
            .contains("校验失败"));
        fs::remove_dir_all(root).unwrap();
    }
}
