use crate::{
    error::{AppError, AppResult},
    machine_annotation, machine_review, storage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

fn fail(text: impl Into<String>) -> AppError {
    AppError::Message(format!("TEXT_QUALITY: {}", text.into()))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn read(path: &Path) -> AppResult<Vec<u8>> {
    machine_annotation::read_bytes(path)?
        .ok_or_else(|| fail(format!("文件不存在：{}", path.display())))
}
fn document(bytes: &[u8]) -> AppResult<Value> {
    Ok(serde_json::from_slice(
        bytes.strip_prefix(&[239, 187, 191]).unwrap_or(bytes),
    )?)
}
fn regular(path: &Path) -> AppResult<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(fail("不处理链接路径"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(fail("不处理重解析链接"));
        }
    }
    Ok(())
}
fn within(root: &Path, path: &Path) -> AppResult<PathBuf> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| fail("文件不在扫描目录内"))?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(fail("非法相对路径"));
        }
        current.push(part);
        regular(&current)?;
    }
    Ok(current)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub from: String,
    pub to: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub rules: Vec<Rule>,
    pub whitelist: Vec<String>,
}
impl Default for Policy {
    fn default() -> Self {
        serde_json::from_str(include_str!("../../src/lib/text-quality-defaults.json"))
            .expect("bundled text policy")
    }
}
fn validate_policy(policy: &Policy) -> AppResult<()> {
    if policy.rules.len() > 500 || policy.whitelist.len() > 1000 {
        return Err(fail("术语规则或白名单超限"));
    }
    let mut seen = BTreeSet::new();
    for rule in &policy.rules {
        if rule.from.trim().is_empty()
            || rule.to.trim().is_empty()
            || rule.from == rule.to
            || rule.from.chars().count() > 80
            || rule.to.chars().count() > 80
            || !seen.insert(&rule.from)
        {
            return Err(fail("规则需填写唯一错词和不同的正确词，最多 80 字"));
        }
    }
    if policy
        .whitelist
        .iter()
        .any(|word| word.trim().is_empty() || word.chars().count() > 80)
    {
        return Err(fail("白名单词需为 1 至 80 字"));
    }
    Ok(())
}
fn policy_path(data: &Path, source: Option<&Path>) -> AppResult<PathBuf> {
    if let Some(root) = source {
        let root = fs::canonicalize(root)?;
        let key = hash(root.to_string_lossy().as_bytes());
        return Ok(data.join("text-quality").join(format!("{key}.json")));
    }
    Ok(data.join("text-quality/policy.json"))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyResult {
    pub policy: Policy,
    pub revision: String,
    pub location: String,
}
pub fn get_policy(data: &Path, source: Option<&Path>) -> AppResult<PolicyResult> {
    let path = policy_path(data, source)?;
    let bytes = machine_annotation::read_bytes(&path)?;
    let policy: Policy = bytes
        .as_ref()
        .map(|b| serde_json::from_slice(b))
        .transpose()?
        .unwrap_or_default();
    validate_policy(&policy)?;
    Ok(PolicyResult {
        policy,
        revision: bytes.as_ref().map_or(String::new(), |b| hash(b)),
        location: path.display().to_string(),
    })
}
pub fn save_policy(
    data: &Path,
    source: Option<&Path>,
    policy: Policy,
    revision: &str,
) -> AppResult<PolicyResult> {
    validate_policy(&policy)?;
    let path = policy_path(data, source)?;
    fs::create_dir_all(path.parent().unwrap())?;
    regular(path.parent().unwrap())?;
    let _lock = machine_review::lock_file(&path.with_extension("lock"))?;
    if get_policy(data, source)?.revision != revision {
        return Err(fail("术语库已被更新，请重新读取"));
    }
    machine_review::atomic_json(&path, &serde_json::to_value(policy)?)?;
    get_policy(data, source)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextIssue {
    pub original: String,
    pub suggestion: String,
    pub reason: String,
}
fn inspect(text: &str, policy: &Policy) -> Vec<TextIssue> {
    let mut result = Vec::new();
    let allowed = |word: &str| policy.whitelist.iter().any(|w| w == word || w == text);
    for rule in &policy.rules {
        if text.contains(&rule.from) && !allowed(&rule.from) {
            result.push(TextIssue {
                original: rule.from.clone(),
                suggestion: rule.to.clone(),
                reason: "术语／错字规则".into(),
            });
        }
    }
    let chars: Vec<_> = text.chars().collect();
    let mut seen = BTreeSet::new();
    let mut i = 0;
    while i < chars.len() {
        let mut end = i + 1;
        while end < chars.len() && chars[end] == chars[i] {
            end += 1;
        }
        if end - i >= 3 && ('\u{3400}'..='\u{9fff}').contains(&chars[i]) {
            let word: String = chars[i..end].iter().collect();
            if !allowed(&word) && seen.insert(word.clone()) {
                result.push(TextIssue {
                    original: word,
                    suggestion: chars[i].to_string(),
                    reason: "疑似重复字".into(),
                });
            }
        }
        i = end;
    }
    result
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DescriptionRow {
    pub file_path: String,
    pub relative_path: String,
    pub file_hash: String,
    pub session_hash: String,
    pub segment_index: usize,
    pub start_frame: u64,
    pub end_frame: u64,
    pub description: String,
    pub reviewer: String,
    pub reviewed_at: String,
    pub qc: String,
    pub issues: Vec<TextIssue>,
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub rows: Vec<DescriptionRow>,
    pub errors: Vec<String>,
    pub sessions: usize,
}
pub fn scan(
    root: &Path,
    policy: &Policy,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(usize, &str),
) -> AppResult<ScanResult> {
    regular(root)?;
    let root = fs::canonicalize(root)?;
    let mut result = ScanResult::default();
    let mut stack = vec![root.clone()];
    let mut visited = 0;
    while let Some(dir) = stack.pop() {
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::Cancelled);
        }
        visited += 1;
        if visited > 250_000 {
            return Err(fail("目录超过 250000，请缩小扫描范围"));
        }
        progress(result.sessions, &dir.display().to_string());
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) => {
                result.errors.push(format!("{}: {e}", dir.display()));
                continue;
            }
        };
        let mut children = Vec::new();
        let mut files = Vec::new();
        let mut session = false;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    result.errors.push(e.to_string());
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "@eaDir"
                        | "#recycle"
                        | "Delta-Viewer-Previews"
                        | "Delta-Viewer-TaskIndex"
                        | "Delta-Viewer-TextQuality"
                )
            {
                continue;
            }
            let path = entry.path();
            if let Err(e) = regular(&path) {
                result.errors.push(format!("{}: {e}", path.display()));
                continue;
            }
            if matches!(
                name.as_str(),
                "session.json" | "states.jsonl" | "manifest.json"
            ) {
                session = true;
            }
            if entry.file_type()?.is_dir() {
                children.push(path.clone());
            }
            if matches!(name.as_str(), "description.json" | "desorption.json") {
                files.push(path);
                session = true;
            }
        }
        if session {
            result.sessions += 1;
            for path in files {
                let one = (|| -> AppResult<()> {
                    let bytes = read(&path)?;
                    let session_bytes = read(&dir.join("session.json"))?;
                    let session = document(&session_bytes)?;
                    let parsed = machine_annotation::parse_human(
                        &bytes,
                        dir.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
                    )?;
                    if result.rows.len() + parsed.segments.len() > 200_000 {
                        return Err(fail("描述超过 200000 段，请缩小扫描范围"));
                    }
                    for segment in parsed.segments {
                        result.rows.push(DescriptionRow {
                            file_path: path.display().to_string(),
                            relative_path: path.strip_prefix(&root).unwrap().display().to_string(),
                            file_hash: hash(&bytes),
                            session_hash: hash(&session_bytes),
                            segment_index: segment.source_index,
                            start_frame: segment.start_frame,
                            end_frame: segment.end_frame,
                            issues: inspect(&segment.description, policy),
                            description: segment.description,
                            reviewer: session["reviewerUsername"]
                                .as_str()
                                .or(session["reviewerName"].as_str())
                                .unwrap_or("")
                                .into(),
                            reviewed_at: session["reviewedAt"].as_str().unwrap_or("").into(),
                            qc: session["qc"].as_str().unwrap_or("").into(),
                        });
                    }
                    Ok(())
                })();
                if let Err(e) = one {
                    result.errors.push(format!("{}: {e}", path.display()));
                }
            }
        } else {
            stack.extend(children);
        }
    }
    Ok(result)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Correction {
    pub file_path: String,
    pub file_hash: String,
    pub session_hash: String,
    pub segment_index: usize,
    pub original: String,
    pub replacement: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub id: String,
    pub file_path: String,
    pub reviewer: String,
    pub at_ms: u64,
    pub mode: String,
    pub reason: String,
    pub changes: Vec<Correction>,
    pub before_hash: String,
    pub after_hash: String,
    pub session_before_hash: String,
    pub session_after_hash: String,
    pub status: String,
    pub needs_reexport: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub file_path: String,
    pub history_id: Option<String>,
    pub error: String,
}
fn history_path(data: &Path, id: &str) -> AppResult<PathBuf> {
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(fail("勘误记录 ID 无效"));
    }
    Ok(data
        .join("description-corrections")
        .join(format!("{id}.json")))
}
pub fn history(data: &Path) -> AppResult<Vec<History>> {
    let dir = data.join("description-corrections");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|x| x == "json") {
            result.push(serde_json::from_slice::<History>(&read(&path)?)?);
        }
    }
    result.sort_by_key(|r| std::cmp::Reverse(r.at_ms));
    Ok(result)
}
fn patch_segments(doc: &mut Value, episode_name: &str, changes: &[Correction]) -> AppResult<()> {
    let parsed = machine_annotation::parse_human(&serde_json::to_vec(doc)?, episode_name)?;
    let episode = doc["episode_results"]
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|e| e["episode_id"] == episode_name))
        .ok_or_else(|| fail("人工片段不存在"))?;
    for change in changes {
        let segment = parsed
            .segments
            .iter()
            .find(|s| s.source_index == change.segment_index)
            .ok_or_else(|| fail("片段索引已改变"))?;
        if segment.description != change.original {
            return Err(fail("片段文字已改变，请重新扫描"));
        }
        let original = episode["annotations"][change.segment_index].clone();
        machine_annotation::patch_description(
            &mut episode["annotations"][change.segment_index],
            &change.replacement,
        )?;
        if let Some(mirrors) = episode["segments"].as_array_mut() {
            for mirror in mirrors {
                let linked = ["segment_id", "annotation_id"].iter().any(|k| {
                    mirror[*k].as_str().is_some_and(|id| {
                        ["segment_id", "id"]
                            .iter()
                            .any(|key| original[*key].as_str() == Some(id))
                    })
                });
                let same_range = mirror["start_frame"] == original["start_frame"]
                    && mirror["end_frame"] == original["end_frame"];
                if (linked || same_range)
                    && (mirror.get("attributes").is_some() || mirror.get("attributes_zh").is_some())
                {
                    machine_annotation::patch_description(mirror, &change.replacement)?;
                }
            }
        }
    }
    if let Some(segments) = doc["_human_review"]
        .get_mut("segments")
        .and_then(Value::as_array_mut)
    {
        for change in changes {
            let source = &parsed.segments[change.segment_index];
            let matches: Vec<_> = segments
                .iter_mut()
                .filter(|s| {
                    s["startFrame"].as_u64() == Some(source.start_frame)
                        && s["endFrame"].as_u64() == Some(source.end_frame)
                })
                .collect();
            if matches.len() != 1 {
                return Err(fail("人工元数据片段无法唯一匹配，未写入"));
            }
            for item in matches {
                item["description"] = json!(change.replacement);
            }
        }
    }
    Ok(())
}
fn mark_pending(session: &mut Value, doc: &mut Value) -> AppResult<()> {
    if !session.is_object() {
        return Err(fail("session.json 不是对象"));
    }
    session["qc"] = json!("待审核");
    for key in ["reviewerUsername", "reviewerName", "reviewedAt"] {
        session.as_object_mut().unwrap().remove(key);
    }
    if let Some(accounts) = session.get_mut("qcReviewers") {
        for account in accounts
            .as_object_mut()
            .ok_or_else(|| fail("qcReviewers 不是对象"))?
            .values_mut()
        {
            account["status"] = json!("pending");
            account["updatedAtMs"] = json!(now());
        }
    }
    if let Some(review) = doc.get_mut("_human_review") {
        review["status"] = json!("pending");
        review["rejectionReason"] = json!("");
    }
    Ok(())
}
fn bump_revision(doc: &mut Value) {
    if let Some(review) = doc.get_mut("_human_review") {
        let key = if review["workflowVersion"].as_u64().unwrap_or(0) >= 4 {
            "reviewRevision"
        } else {
            "revision"
        };
        if let Some(revision) = review[key].as_u64() {
            review[key] = json!(revision + 1);
        }
    }
}
pub fn apply(
    data: &Path,
    root: &Path,
    changes: Vec<Correction>,
    mode: &str,
    reason: &str,
    reviewer: &str,
    cancelled: &AtomicBool,
) -> AppResult<Vec<ApplyResult>> {
    if !matches!(mode, "typo" | "semantic")
        || reason.trim().is_empty()
        || reason.chars().count() > 1000
        || changes.is_empty()
        || changes.len() > 10_000
    {
        return Err(fail("勘误类型、原因或数量无效（最多 10000 段）"));
    }
    regular(root)?;
    let root = fs::canonicalize(root)?;
    let mut groups: BTreeMap<String, Vec<Correction>> = BTreeMap::new();
    for c in changes {
        if c.original == c.replacement
            || c.replacement.trim().is_empty()
            || c.replacement.len() > 16_384
        {
            return Err(fail("替换文本为空、未变化或超限"));
        }
        groups.entry(c.file_path.clone()).or_default().push(c);
    }
    fs::create_dir_all(data.join("description-corrections"))?;
    let mut results = Vec::new();
    for (file, changes) in groups {
        if cancelled.load(Ordering::Acquire) {
            results.push(ApplyResult {
                file_path: file,
                history_id: None,
                error: "已取消，未写入".into(),
            });
            continue;
        }
        let result = (|| -> AppResult<String> {
            let path = within(&root, Path::new(&file))?;
            if !matches!(
                path.file_name().and_then(|n| n.to_str()),
                Some("description.json" | "desorption.json")
            ) {
                return Err(fail("仅允许勘误根级人工描述"));
            }
            let episode_root = path.parent().unwrap();
            let write_root = storage::review_write_root(episode_root)?;
            let path = write_root.join(path.file_name().unwrap());
            let _lock = machine_review::lock_file(&write_root.join(".description.lock"))?;
            let bytes = read(&path)?;
            let session_path = write_root.join("session.json");
            let session_bytes = read(&session_path)?;
            let before_hash = hash(&bytes);
            let session_before_hash = hash(&session_bytes);
            let mut indices = BTreeSet::new();
            if changes.iter().any(|c| {
                c.file_hash != before_hash
                    || c.session_hash != session_before_hash
                    || !indices.insert(c.segment_index)
            }) {
                return Err(fail("文件或审核状态已改变，请重新扫描；未覆盖"));
            }
            let mut doc = document(&bytes)?;
            let mut session = document(&session_bytes)?;
            patch_segments(
                &mut doc,
                episode_root
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default(),
                &changes,
            )?;
            if mode == "semantic" {
                mark_pending(&mut session, &mut doc)?;
            }
            bump_revision(&mut doc);
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).map_err(|_| fail("无法创建勘误 ID"))?;
            let id = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
            doc["_text_correction"] = json!({"id":id,"atMs":now(),"reviewer":reviewer,"mode":mode,"reason":reason,"needsReexport":true});
            let after_hash = hash(&serde_json::to_vec_pretty(&doc)?);
            let session_after_hash = if mode == "semantic" {
                hash(&serde_json::to_vec_pretty(&session)?)
            } else {
                session_before_hash.clone()
            };
            let mut record = History {
                id: id.clone(),
                file_path: file.clone(),
                reviewer: reviewer.into(),
                at_ms: now(),
                mode: mode.into(),
                reason: reason.into(),
                changes,
                before_hash,
                after_hash,
                session_before_hash,
                session_after_hash,
                status: "prepared".into(),
                needs_reexport: true,
            };
            let record_path = history_path(data, &id)?;
            machine_review::atomic_json(&record_path, &serde_json::to_value(&record)?)?;
            // Invalidate QC before publishing changed semantics. An interrupted
            // write remains recorded and cannot approve a new meaning.
            if mode == "semantic" {
                machine_review::atomic_json(&session_path, &session)?;
            }
            machine_review::atomic_json(&path, &doc)?;
            record.status = "committed".into();
            machine_review::atomic_json(&record_path, &serde_json::to_value(record)?)?;
            Ok(id)
        })();
        results.push(match result {
            Ok(id) => ApplyResult {
                file_path: file,
                history_id: Some(id),
                error: String::new(),
            },
            Err(e) => ApplyResult {
                file_path: file,
                history_id: None,
                error: e.to_string(),
            },
        });
    }
    Ok(results)
}
pub fn undo(data: &Path, id: &str, reviewer: &str) -> AppResult<()> {
    let record_path = history_path(data, id)?;
    let mut record: History = serde_json::from_slice(&read(&record_path)?)?;
    if !matches!(record.status.as_str(), "committed" | "prepared") {
        return Err(fail("该记录已撤销"));
    }
    let path = Path::new(&record.file_path);
    let root = path.parent().ok_or_else(|| fail("记录路径无效"))?;
    let root = storage::review_write_root(root)?;
    let path = root.join(path.file_name().unwrap());
    regular(&path)?;
    let _lock = machine_review::lock_file(&root.join(".description.lock"))?;
    let bytes = read(&path)?;
    let actual = hash(&bytes);
    let session_bytes = read(&root.join("session.json"))?;
    if hash(&session_bytes) != record.session_after_hash
        && !(record.status == "prepared" && hash(&session_bytes) == record.session_before_hash)
    {
        return Err(fail("审核状态已改变，不能撤销"));
    }
    if actual == record.after_hash {
        let mut doc = document(&bytes)?;
        let reverse: Vec<_> = record
            .changes
            .iter()
            .cloned()
            .map(|mut c| {
                std::mem::swap(&mut c.original, &mut c.replacement);
                c
            })
            .collect();
        patch_segments(
            &mut doc,
            root.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default(),
            &reverse,
        )?;
        bump_revision(&mut doc);
        doc["_text_correction"] =
            json!({"undoOf":id,"reviewer":reviewer,"atMs":now(),"needsReexport":true});
        machine_review::atomic_json(&path, &doc)?;
    } else if !(record.status == "prepared" && actual == record.before_hash) {
        return Err(fail("描述已被再次修改，不能撤销；请重新扫描"));
    }
    record.status = "undone".into();
    record.reason = format!(
        "{}；由 {} 撤销，含义变更保持待复审",
        record.reason, reviewer
    );
    machine_review::atomic_json(&record_path, &serde_json::to_value(record)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{inspect, Policy, Rule};

    #[test]
    fn default_policy_finds_typo_and_repeated_characters() {
        let policy = Policy {
            rules: vec![Rule {
                from: "动做".into(),
                to: "动作".into(),
            }],
            whitelist: Vec::new(),
        };
        let issues = inspect("动做并拿拿拿起", &policy);
        assert!(issues
            .iter()
            .any(|issue| issue.original == "动做" && issue.suggestion == "动作"));
        assert!(issues.iter().any(|issue| issue.original == "拿".repeat(3)));
    }

    #[test]
    fn whitelist_suppresses_known_text() {
        let policy = Policy {
            rules: vec![Rule {
                from: "冰箱们".into(),
                to: "冰箱门".into(),
            }],
            whitelist: vec!["冰箱们".into()],
        };
        assert!(inspect("冰箱们", &policy).is_empty());
    }
}
