//! Cloud task acquisition is explicit; playback still reads verified local directories.
use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use reqwest::{Certificate, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    schema_version: u32,
    origin: String,
    company_id: String,
    token_file: PathBuf,
    certificate_pem: String,
    download_hosts: Vec<String>,
}

fn fail(code: &str) -> AppError {
    AppError::Message(code.into())
}
fn config_path(data: &Path, account: &str) -> PathBuf {
    data.join("cloud-qc").join(format!(
        "config-{:x}.json",
        Sha256::digest(account.as_bytes())
    ))
}
fn bounded(path: &Path) -> AppResult<Vec<u8>> {
    let info = fs::symlink_metadata(path)?;
    if info.file_type().is_symlink() || !info.is_file() || info.len() > 4 * 1024 * 1024 {
        return Err(fail("CLOUD_QC_FILE_INVALID"));
    }
    Ok(fs::read(path)?)
}
fn write_json(path: &Path, value: &Value) -> AppResult<()> {
    let parent = path.parent().ok_or_else(|| fail("CLOUD_QC_PATH_INVALID"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".cloud-partial-{}", nonce()?));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut out = options.open(&temporary)?;
        out.write_all(&serde_json::to_vec(value)?)?;
        out.sync_all()?;
        drop(out);
        crate::storage::replace_file_atomic(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn nonce() -> AppResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| fail("CLOUD_QC_RANDOM_FAILED"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn safe(root: &Path, relative: &str) -> AppResult<PathBuf> {
    if relative.is_empty()
        || relative.contains(['\\', ':', '\0'])
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(fail("CLOUD_QC_PATH_INVALID"));
    }
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(fail("CLOUD_QC_PATH_INVALID"));
        }
        path.push(part);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(fail("CLOUD_QC_SYMLINK_REJECTED"));
        }
    }
    Ok(path)
}
fn client(config: &Config) -> AppResult<Client> {
    let origin =
        reqwest::Url::parse(&config.origin).map_err(|_| fail("CLOUD_QC_ORIGIN_INVALID"))?;
    if config.schema_version != 1
        || origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || config.company_id.is_empty()
        || config.company_id.len() > 80
        || !config
            .company_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || config.download_hosts.is_empty()
        || !config.token_file.is_absolute()
    {
        return Err(fail("CLOUD_QC_CONFIG_INVALID"));
    }
    let cert = Certificate::from_pem(config.certificate_pem.as_bytes())
        .map_err(|_| fail("CLOUD_QC_CERTIFICATE_INVALID"))?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .tls_backend_rustls()
        .tls_certs_only([cert])
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| fail("CLOUD_QC_NETWORK_UNAVAILABLE"))
}
async fn request(
    client: &Client,
    config: &Config,
    path: &str,
    payload: Option<Value>,
) -> AppResult<Value> {
    let token = String::from_utf8(bounded(&config.token_file)?)
        .map_err(|_| fail("CLOUD_QC_TOKEN_INVALID"))?;
    if token.trim().len() < 32 {
        return Err(fail("CLOUD_QC_TOKEN_INVALID"));
    }
    let mut url = reqwest::Url::parse(&format!("{}{}", config.origin.trim_end_matches('/'), path))
        .map_err(|_| fail("CLOUD_QC_PATH_INVALID"))?;
    url.query_pairs_mut()
        .append_pair("tenant", &config.company_id);
    let request = if let Some(body) = payload {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    let response = request
        .bearer_auth(token.trim())
        .send()
        .await
        .map_err(|_| fail("CLOUD_QC_NETWORK_UNAVAILABLE"))?;
    let status = response.status();
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fail("CLOUD_QC_NETWORK_UNAVAILABLE"))?
    {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(fail("CLOUD_QC_RESPONSE_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if !status.is_success() {
        let code = value["error"]["code"]
            .as_str()
            .unwrap_or("CLOUD_QC_REQUEST_FAILED");
        return Err(fail(
            if code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            {
                code
            } else {
                "CLOUD_QC_REQUEST_FAILED"
            },
        ));
    }
    Ok(value)
}
async fn context(data: &Path, auth: &AuthState) -> AppResult<(Config, Client, Value)> {
    let user = auth.require_managed_user()?;
    let config: Config = serde_json::from_slice(&bounded(&config_path(data, &user.username))?)?;
    let http = client(&config)?;
    let identity = request(&http, &config, "/api/review/v1/identity", None).await?;
    if identity["account_id"] != user.username
        || identity["display_name"] != user.display_name
        || (identity["role"] == "admin") != (user.role.as_deref() == Some("admin"))
    {
        return Err(fail("CLOUD_QC_ACCOUNT_MISMATCH"));
    }
    if auth.require_managed_user()?.username != user.username {
        return Err(fail("CLOUD_QC_ACCOUNT_MISMATCH"));
    }
    Ok((config, http, identity))
}
pub async fn configure(data: &Path, auth: &AuthState, file: &Path) -> AppResult<Value> {
    let value: Value = serde_json::from_slice(&bounded(file)?)?;
    let config: Config = serde_json::from_value(value.clone())?;
    let http = client(&config)?;
    let user = auth.require_managed_user()?;
    let identity = request(&http, &config, "/api/review/v1/identity", None).await?;
    if identity["account_id"] != user.username
        || identity["display_name"] != user.display_name
        || (identity["role"] == "admin") != (user.role.as_deref() == Some("admin"))
    {
        return Err(fail("CLOUD_QC_ACCOUNT_MISMATCH"));
    }
    if auth.require_managed_user()?.username != user.username {
        return Err(fail("CLOUD_QC_ACCOUNT_MISMATCH"));
    }
    write_json(&config_path(data, &user.username), &value)?;
    Ok(identity)
}
pub async fn call(data: &Path, auth: &AuthState, action: &str, payload: Value) -> AppResult<Value> {
    let (config, http, identity) = context(data, auth).await?;
    let admin = identity["role"] == "admin";
    let path = match action {
        "identity" => "/api/review/v1/identity".into(),
        "tasks" => {
            if admin {
                "/api/review/v1/admin/batches".into()
            } else {
                "/api/review/v1/tasks".into()
            }
        }
        "policy" | "set_policy" if admin => "/api/review/v1/admin/policy".into(),
        "claim" | "full_review" => {
            if action == "full_review" && !admin {
                return Err(fail("QC_ADMIN_REQUIRED"));
            }
            let job = identifier(&payload["job_id"])?;
            let plan = identifier(&payload["plan_id"])?;
            format!(
                "/api/review/v1/{}jobs/{job}/plans/{plan}/{}",
                if action == "full_review" {
                    "admin/"
                } else {
                    ""
                },
                if action == "full_review" {
                    "full-review"
                } else {
                    "claim"
                }
            )
        }
        _ => return Err(fail("CLOUD_QC_ACTION_INVALID")),
    };
    let body = match action {
        "tasks" | "policy" | "identity" => None,
        "claim" | "full_review" => Some(payload["body"].clone()),
        _ => Some(payload),
    };
    request(&http, &config, &path, body).await
}
fn identifier(value: &Value) -> AppResult<&str> {
    value
        .as_str()
        .filter(|s| {
            s.len() == 32
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| fail("CLOUD_QC_ID_INVALID"))
}

// Preview bindings prove downloaded bytes, never ownership. Resolve ownership
// from the server for the exact job/recording before any native mutation.
fn directory_binding(data: &Path, account: &str, directory: &Path) -> AppResult<Option<Value>> {
    let root = data.join("cloud-qc/data");
    if !root.exists() {
        return Ok(None);
    }
    let directory = directory
        .canonicalize()
        .unwrap_or_else(|_| directory.to_path_buf());
    if !directory.starts_with(root.canonicalize()?) {
        return Ok(None);
    }
    if !owns_directory(data, account, &directory) {
        return Err(fail("CLOUD_QC_BINDING_INVALID"));
    }
    let holder = directory
        .ancestors()
        .find(|p| p.join("binding.json").is_file())
        .ok_or_else(|| fail("CLOUD_QC_BINDING_INVALID"))?;
    Ok(Some(serde_json::from_slice(&bounded(
        &holder.join("binding.json"),
    )?)?))
}

fn find_task<'a>(plans: &'a Value, binding: &Value) -> AppResult<(&'a Value, &'a Value)> {
    for plan in plans["plans"]
        .as_array()
        .ok_or_else(|| fail("CLOUD_QC_RESPONSE_INVALID"))?
    {
        if plan["job_id"] != binding["job_id"] {
            continue;
        }
        for task in plan["tasks"]
            .as_array()
            .ok_or_else(|| fail("CLOUD_QC_RESPONSE_INVALID"))?
        {
            if task["recording_id"] == binding["recording_id"] {
                return Ok((plan, task));
            }
        }
    }
    Err(fail("CLOUD_QC_TASK_UNAVAILABLE"))
}

fn task_access(plan: &Value, task: &Value, account: &str) -> Value {
    let active = !matches!(plan["state"].as_str(), Some("invalidated"));
    let mine = task["assignee"].as_str() == Some(account);
    json!({"cloud":true,"canEdit":active && mine,"claimable":active && task["assignee"].is_null(),
        "assignee":task["assignee"],"reason":if !active {"批次已失效，等待新的标注版本"}
        else if mine {"已领取，可审核"} else if task["assignee"].is_null() {"当前为只读预览；领取后才能修改和审核"}
        else {"此任务已由其他账号领取，当前仅可预览"}})
}

pub async fn access(
    data: &Path,
    auth: &AuthState,
    directory: &Path,
    claim: bool,
) -> AppResult<Value> {
    let user = auth.require_managed_user()?;
    let Some(binding) = directory_binding(data, &user.username, directory)? else {
        return Ok(json!({"cloud":false,"canEdit":true,"claimable":false}));
    };
    let (config, http, identity) = context(data, auth).await?;
    if binding["origin"] != config.origin || binding["company_id"] != config.company_id {
        return Err(fail("CLOUD_QC_BINDING_INVALID"));
    }
    let route = if identity["role"] == "admin" {
        "/api/review/v1/admin/batches"
    } else {
        "/api/review/v1/tasks"
    };
    let plans = request(&http, &config, route, None).await?;
    let (plan, task) = find_task(&plans, &binding)?;
    let status = task_access(plan, task, &user.username);
    if auth.require_managed_user()?.username != user.username {
        return Err(fail("CLOUD_QC_ACCOUNT_MISMATCH"));
    }
    if claim && status["claimable"] == true {
        let path = format!(
            "/api/review/v1/jobs/{}/plans/{}/claim",
            identifier(&binding["job_id"])?,
            identifier(&plan["id"])?
        );
        request(&http, &config, &path, Some(json!({"base_version":plan["version"],"action":"claim",
            "recording_ids":[binding["recording_id"]],"reason":"Viewer 用户显式领取当前任务，保留已有本机记录"}))).await?;
        // A claim response alone is not a grant; confirm current ownership again.
        return Box::pin(access(data, auth, directory, false)).await;
    }
    if auth.require_managed_user()?.username != user.username {
        return Err(fail("CLOUD_QC_ACCOUNT_MISMATCH"));
    }
    Ok(status)
}

pub async fn require_editable(data: &Path, auth: &AuthState, directory: &Path) -> AppResult<()> {
    if auth.workspace_mode()? == Some(crate::model::WorkspaceMode::Offline) {
        auth.require_user()?;
        let managed_cache = data.parent().unwrap_or(data).join("cloud-qc");
        // Local draft durability must never stat an unavailable NAS. Selected
        // source paths are absolute; compare the application cache lexically.
        let key = |path: &Path| {
            let value = path.to_string_lossy().replace('\\', "/");
            let value = value
                .strip_prefix("//?/")
                .unwrap_or(&value)
                .trim_end_matches('/')
                .to_owned();
            if cfg!(windows) {
                value.to_lowercase()
            } else {
                value
            }
        };
        let directory_key = key(directory);
        let cache_key = key(&managed_cache);
        if directory_key == cache_key || directory_key.starts_with(&format!("{cache_key}/")) {
            return Err(fail(
                "离线模式不能修改联网账号的云端工作区，请另选本地展示数据",
            ));
        }
        return Ok(());
    }
    let status = access(data, auth, directory, false).await?;
    if status["canEdit"] != true {
        return Err(fail("QC_TASK_NOT_CLAIMED"));
    }
    Ok(())
}
pub fn decorate_view(
    data: &Path,
    account: &str,
    directory: &Path,
    view: &mut crate::machine_review::ReviewView,
) -> AppResult<()> {
    if !owns_directory(data, account, directory) {
        return Ok(());
    }
    let directory = directory.canonicalize()?;
    let holder = directory
        .ancestors()
        .find(|p| p.join("binding.json").is_file())
        .ok_or_else(|| fail("CLOUD_QC_BINDING_INVALID"))?;
    let binding: Value = serde_json::from_slice(&bounded(&holder.join("binding.json"))?)?;
    view.qc_status = binding["qc"]["decision"]
        .as_str()
        .filter(|v| ["pending", "approved", "rejected"].contains(v))
        .unwrap_or("unknown")
        .into();
    view.qc_rejection_reason = binding["qc"]["reason"].as_str().unwrap_or("").into();
    view.qc_status_error = if view.qc_status == "unknown" {
        "云端当前结论未确认；本机历史 JSON 不代表云端放行".into()
    } else {
        String::new()
    };
    Ok(())
}
pub fn owns_directory(data: &Path, account: &str, directory: &Path) -> bool {
    let Ok(directory) = directory.canonicalize() else {
        return false;
    };
    let Ok(root) = data
        .join("cloud-qc")
        .join("data")
        .join(account)
        .canonicalize()
    else {
        return false;
    };
    if !directory.starts_with(&root) {
        return false;
    }
    let Some(holder) = directory
        .ancestors()
        .take_while(|p| p.starts_with(&root))
        .find(|p| p.join("binding.json").is_file())
    else {
        return false;
    };
    let Ok(bytes) = bounded(&holder.join("binding.json")) else {
        return false;
    };
    let Ok(binding) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    binding["account_id"] == account
        && Path::new(binding["local_directory"].as_str().unwrap_or("")) == directory
}
pub async fn fetch(
    data: &Path,
    auth: &AuthState,
    job: &str,
    recording: &str,
    cancelled: &AtomicBool,
) -> AppResult<String> {
    if SYNC_ACTIVE.swap(true, Ordering::Acquire) {
        return Err(fail("CLOUD_QC_SYNC_BUSY"));
    }
    let _guard = SyncGuard;
    identifier(&json!(job))?;
    identifier(&json!(recording))?;
    let (config, http, identity) = context(data, auth).await?;
    // Signed BOS URLs use normal public trust and never receive the review token.
    let downloads = Client::builder()
        .tls_backend_rustls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| fail("CLOUD_QC_NETWORK_UNAVAILABLE"))?;
    let route = format!("/api/review/v1/jobs/{job}/recordings/{recording}");
    let mut binding = request(&http, &config, &route, None).await?;
    let root = data
        .join("cloud-qc")
        .join("data")
        .join(
            identity["account_id"]
                .as_str()
                .ok_or_else(|| fail("CLOUD_QC_ACCOUNT_MISMATCH"))?,
        )
        .join(&config.company_id)
        .join(job)
        .join(recording);
    fs::create_dir_all(&root)?;
    let root = root.canonicalize()?;
    if root.join("binding.json").exists() {
        let old: Value = serde_json::from_slice(&bounded(&root.join("binding.json"))?)?;
        if old["annotation_revision"] != binding["annotation_revision"]
            || old["base_review_version"] != binding["base_review_version"]
            || old["origin"] != config.origin
        {
            return Err(fail("CLOUD_QC_VERSION_CHANGED"));
        }
        if old["account_id"] != identity["account_id"] || old["company_id"] != config.company_id {
            return Err(fail("CLOUD_QC_BINDING_INVALID"));
        }
        let target = safe(
            &root.join("files"),
            binding["recording_path"]
                .as_str()
                .ok_or_else(|| fail("CLOUD_QC_PATH_INVALID"))?,
        )?;
        for row in old["manifest"]["files"]
            .as_array()
            .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?
        {
            let name = row["path"]
                .as_str()
                .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
            if [
                "session.json",
                "description.json",
                ".description.review-state.json",
            ]
            .contains(&name)
            {
                continue;
            }
            let file = safe(&target, name)?;
            if file.metadata()?.len() != row["size"].as_u64().unwrap_or(u64::MAX)
                || hash(&file)? != row["sha256"].as_str().unwrap_or("")
            {
                return Err(fail("CLOUD_QC_EXISTING_FILE_CHANGED"));
            }
        }
        let mut old = old;
        old["qc"] = binding["qc"].clone();
        old["review_revocation"] = binding["review_revocation"].clone();
        write_json(&root.join("binding.json"), &old)?;
        return Ok(target.to_string_lossy().into());
    }
    let destination = safe(
        &root.join("files"),
        binding["recording_path"]
            .as_str()
            .ok_or_else(|| fail("CLOUD_QC_PATH_INVALID"))?,
    )?;
    let files = binding["manifest"]["files"]
        .as_array()
        .filter(|rows| rows.len() <= 10000)
        .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
    let required = files
        .iter()
        .try_fold(0u64, |sum, row| {
            sum.checked_add(row["size"].as_u64()?)
                .map(Some)
                .unwrap_or(None)
        })
        .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
    let missing = files.iter().try_fold(0u64, |sum, row| {
        let name = row["path"]
            .as_str()
            .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
        let target = safe(&destination, name)?;
        Ok::<u64, AppError>(
            sum + if target.exists() {
                0
            } else {
                row["size"]
                    .as_u64()
                    .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?
            },
        )
    })?;
    if required > 0
        && fs2::statvfs(&root)?.available_space() < missing.saturating_add(1024 * 1024 * 1024)
    {
        return Err(fail("CLOUD_QC_DISK_SPACE_INSUFFICIENT"));
    }
    for row in files {
        check_cancelled(cancelled)?;
        let relative = row["path"]
            .as_str()
            .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
        let target = safe(&destination, relative)?;
        let expected = row["sha256"]
            .as_str()
            .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
        if expected.len() != 64
            || !expected
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(fail("CLOUD_QC_MANIFEST_INVALID"));
        }
        let size = row["size"]
            .as_u64()
            .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
        if target.exists() {
            if hash(&target)? != expected || target.metadata()?.len() != size {
                return Err(fail("CLOUD_QC_EXISTING_FILE_CHANGED"));
            }
            continue;
        }
        let links = request(
            &http,
            &config,
            &format!("{route}/files"),
            Some(json!({"annotation_revision":binding["annotation_revision"],"paths":[relative]})),
        )
        .await?;
        let url = reqwest::Url::parse(
            links["files"][0]["url"]
                .as_str()
                .ok_or_else(|| fail("CLOUD_QC_LINK_INVALID"))?,
        )
        .map_err(|_| fail("CLOUD_QC_LINK_INVALID"))?;
        if url.scheme() != "https"
            || !config
                .download_hosts
                .iter()
                .any(|h| Some(h.as_str()) == url.host_str())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(fail("CLOUD_QC_DOWNLOAD_HOST_FORBIDDEN"));
        }
        fs::create_dir_all(target.parent().unwrap())?;
        let partial = target.with_file_name(format!(".cloud-download-{}", expected));
        if partial.is_symlink() {
            return Err(fail("CLOUD_QC_SYMLINK_REJECTED"));
        }
        let offset = if partial.exists() {
            partial.metadata()?.len()
        } else {
            0
        };
        if offset > size {
            return Err(fail("CLOUD_QC_DOWNLOAD_SIZE_INVALID"));
        }
        let mut total = offset;
        if offset < size || !partial.exists() {
            let mut download = downloads.get(url);
            if offset > 0 {
                download = download.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            }
            let mut response = download
                .send()
                .await
                .map_err(|_| fail("CLOUD_QC_DOWNLOAD_FAILED"))?;
            if !response.status().is_success()
                || (offset > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT)
            {
                return Err(fail("CLOUD_QC_RANGE_RESUME_UNAVAILABLE"));
            }
            if offset > 0 {
                let expected = format!("bytes {offset}-");
                if !response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|h| h.to_str().ok())
                    .is_some_and(|h| h.starts_with(&expected))
                {
                    return Err(fail("CLOUD_QC_RANGE_RESUME_UNAVAILABLE"));
                }
            }
            let mut out = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&partial)?;
            while let Some(bytes) = response
                .chunk()
                .await
                .map_err(|_| fail("CLOUD_QC_DOWNLOAD_FAILED"))?
            {
                check_cancelled(cancelled)?;
                total += bytes.len() as u64;
                if total > size {
                    return Err(fail("CLOUD_QC_DOWNLOAD_SIZE_INVALID"));
                }
                out.write_all(&bytes)?;
            }
            out.sync_all()?;
        }
        if total != size || hash(&partial)? != expected {
            if total == size {
                fs::remove_file(&partial)?;
            }
            return Err(fail("CLOUD_QC_DOWNLOAD_HASH_INVALID"));
        }
        fs::rename(partial, target)?;
    }
    binding["company_id"] = json!(config.company_id);
    binding["account_id"] = identity["account_id"].clone();
    binding["origin"] = json!(config.origin);
    binding["local_directory"] = json!(destination.to_string_lossy());
    // Downloaded old approved files are evidence, never a new human decision.
    binding["last_submission_hash"] = json!(submission_hash(&snapshot(&destination, &binding)?)?);
    binding["withdrawn"] = json!(
        binding["qc"]["decision"] == "pending"
            && binding["base_review_version"].as_u64().unwrap_or(0) > 0
    );
    write_json(&root.join("binding.json"), &binding)?;
    Ok(destination.to_string_lossy().into())
}
fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Acquire) {
        return Err(fail("CLOUD_QC_CANCELLED"));
    }
    Ok(())
}
fn hash(file: &Path) -> AppResult<String> {
    use std::io::Read;
    let mut file = fs::File::open(file)?;
    let mut digest = Sha256::new();
    let mut bytes = vec![0u8; 1024 * 1024];
    loop {
        let size = file.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        digest.update(&bytes[..size]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
static SYNC_ACTIVE: AtomicBool = AtomicBool::new(false);
struct SyncGuard;
impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_ACTIVE.store(false, Ordering::Release);
    }
}
// Reconstruct work from durable native drafts and published JSON after a crash;
// the browser is never the authority for which conclusions still need upload.
fn bindings(data: &Path, account: &str) -> AppResult<Vec<PathBuf>> {
    let base = data.join("cloud-qc").join("data").join(account);
    if !base.exists() {
        return Ok(Vec::new());
    }
    let mut level = vec![base];
    for _ in 0..3 {
        let mut next = Vec::new();
        for parent in level {
            for child in fs::read_dir(parent)? {
                let child = child?;
                if child.file_type()?.is_dir() {
                    next.push(child.path());
                }
            }
        }
        level = next;
    }
    Ok(level
        .into_iter()
        .filter(|p| p.join("binding.json").is_file())
        .collect())
}
fn local_draft(data: &Path, auth: &AuthState, directory: &Path) -> AppResult<bool> {
    let (user, service) = crate::user_center::source_review_owner(data, auth)?;
    crate::source_review_queue::contains_action_draft(
        data,
        &service,
        &user.username,
        &directory.to_string_lossy(),
    )
}
fn snapshot(directory: &Path, binding: &Value) -> AppResult<Value> {
    let session: Value = serde_json::from_slice(&bounded(&directory.join("session.json"))?)?;
    let description = directory.join("description.json");
    let technical = directory.join(".description.review-state.json");
    let mut payload = json!({"submission_id":nonce()?,"annotation_revision":binding["annotation_revision"],
        "base_review_version":binding["base_review_version"],"session":session,"description":null});
    if description.exists() {
        payload["description"] = serde_json::from_slice(&bounded(&description)?)?;
    }
    if technical.exists() {
        payload["technical_review"] = serde_json::from_slice(&bounded(&technical)?)?;
        payload["description_raw"] = json!(String::from_utf8(bounded(&description)?)
            .map_err(|_| fail("CLOUD_QC_DESCRIPTION_INVALID"))?);
    }
    Ok(payload)
}
fn needs_sync(data: &Path, auth: &AuthState, holder: &Path, binding: &Value) -> AppResult<bool> {
    if holder.join("pending.json").exists() {
        return Ok(true);
    }
    let directory = Path::new(
        binding["local_directory"]
            .as_str()
            .ok_or_else(|| fail("CLOUD_QC_BINDING_INVALID"))?,
    );
    if local_draft(data, auth, directory)? {
        return Ok(binding["base_review_version"].as_u64().unwrap_or(0) > 0
            && binding["withdrawn"] != true);
    }
    let payload = snapshot(directory, binding)?;
    if payload["description"].is_null() {
        return Ok(false);
    }
    published_changed(binding, &payload)
}
fn published_changed(binding: &Value, payload: &Value) -> AppResult<bool> {
    Ok(binding["last_submission_hash"] != submission_hash(payload)?)
}
pub fn pending(data: &Path, auth: &AuthState) -> AppResult<Value> {
    let user = auth.require_managed_user()?;
    if !config_path(data, &user.username).exists() {
        return Ok(json!({"items":[]}));
    }
    let (_, service) = crate::user_center::source_review_owner(data, auth)?;
    let _lock = crate::source_review_queue::owner_lock(data, &service, &user.username)?;
    let mut items = Vec::new();
    for holder in bindings(data, &user.username)? {
        let binding: Value = serde_json::from_slice(&bounded(&holder.join("binding.json"))?)?;
        let directory = Path::new(
            binding["local_directory"]
                .as_str()
                .ok_or_else(|| fail("CLOUD_QC_BINDING_INVALID"))?,
        );
        if !owns_directory(data, &user.username, directory) {
            return Err(fail("CLOUD_QC_BINDING_INVALID"));
        }
        if needs_sync(data, auth, &holder, &binding)? {
            items.push(json!({"directory":directory,"jobId":binding["job_id"],"recordingId":binding["recording_id"]}));
        }
    }
    Ok(json!({"items":items}))
}
pub async fn sync(data: &Path, auth: &AuthState, directory: &Path) -> AppResult<Value> {
    if SYNC_ACTIVE.swap(true, Ordering::Acquire) {
        return Err(fail("CLOUD_QC_SYNC_BUSY"));
    }
    let _guard = SyncGuard;
    let (config, http, identity) = context(data, auth).await?;
    let user = auth.require_managed_user()?;
    let (_, service) = crate::user_center::source_review_owner(data, auth)?;
    let directory = directory.canonicalize()?;
    if !owns_directory(data, &user.username, &directory) {
        return Err(fail("CLOUD_QC_BINDING_INVALID"));
    }
    let holder = directory
        .ancestors()
        .find(|p| p.join("binding.json").is_file())
        .ok_or_else(|| fail("CLOUD_QC_BINDING_INVALID"))?;
    let mut binding: Value = serde_json::from_slice(&bounded(&holder.join("binding.json"))?)?;
    if binding["company_id"] != config.company_id
        || binding["account_id"] != identity["account_id"]
        || binding["origin"] != config.origin
    {
        return Err(fail("CLOUD_QC_BINDING_INVALID"));
    }
    let pending = holder.join("pending.json");
    // First acknowledge a prior exact request; only then capture a newer local save.
    for _ in 0..2 {
        let envelope: Value = {
            let _lock = crate::source_review_queue::owner_lock(data, &service, &user.username)?;
            if pending.exists() {
                serde_json::from_slice(&bounded(&pending)?)?
            } else {
                if !needs_sync(data, auth, holder, &binding)? {
                    return Ok(json!({"synchronized":true}));
                }
                let draft = local_draft(data, auth, &directory)?;
                let (kind, payload) = if draft {
                    (
                        "revoke",
                        json!({"annotation_revision":binding["annotation_revision"],
                        "base_review_version":binding["base_review_version"],"submission_id":nonce()?,
                        "reason":"Viewer 本机动作已修改，撤回既有放行，等待重新审核"}),
                    )
                } else {
                    ("decision", snapshot(&directory, &binding)?)
                };
                let value = json!({"kind":kind,"payload":payload,"content_hash":submission_hash(&payload)?});
                write_json(&pending, &value)?;
                value
            }
        };
        let kind = envelope["kind"]
            .as_str()
            .filter(|v| ["decision", "revoke"].contains(v))
            .ok_or_else(|| fail("CLOUD_QC_PENDING_CHANGED"))?;
        let payload = envelope["payload"].clone();
        if payload["annotation_revision"] != binding["annotation_revision"] {
            return Err(fail("CLOUD_QC_VERSION_CHANGED"));
        }
        if kind == "decision" {
            for row in binding["manifest"]["files"]
                .as_array()
                .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?
            {
                let relative = row["path"]
                    .as_str()
                    .ok_or_else(|| fail("CLOUD_QC_MANIFEST_INVALID"))?;
                if [
                    "session.json",
                    "description.json",
                    ".description.review-state.json",
                ]
                .contains(&relative)
                {
                    continue;
                }
                let file = safe(&directory, relative)?;
                if file.metadata()?.len() != row["size"].as_u64().unwrap_or(u64::MAX)
                    || hash(&file)? != row["sha256"].as_str().unwrap_or("")
                {
                    return Err(fail("CLOUD_QC_SOURCE_CHANGED"));
                }
            }
        }
        if auth.require_managed_user()?.username != user.username {
            return Err(fail("CLOUD_QC_ACCOUNT_MISMATCH"));
        }
        let route = format!(
            "/api/review/v1/jobs/{}/recordings/{}/{kind}",
            identifier(&binding["job_id"])?,
            identifier(&binding["recording_id"])?
        );
        let response = request(&http, &config, &route, Some(payload.clone())).await?;
        let expected = payload["base_review_version"]
            .as_u64()
            .ok_or_else(|| fail("CLOUD_QC_PENDING_CHANGED"))?
            + 1;
        if response["accepted_review_version"].as_u64() != Some(expected) {
            return Err(fail("CLOUD_QC_ACK_INVALID"));
        }
        binding["base_review_version"] = json!(expected);
        if kind == "decision" {
            binding["last_submission_hash"] = envelope["content_hash"].clone();
        }
        binding["withdrawn"] = json!(kind == "revoke");
        binding["qc"] = if kind == "revoke" {
            json!({"decision":"pending","reason":null})
        } else {
            json!({"decision":payload["description"]["_human_review"]["status"].as_str().unwrap_or("unknown"),"reason":payload["technical_review"]["review"]["rejectionReason"]})
        };
        // Keep the original request until the version ACK is durable. A restart
        // resends that same submission ID, never invents another conclusion.
        write_json(&holder.join("binding.json"), &binding)?;
        fs::remove_file(&pending)?;
    }
    Ok(json!({"synchronized":true,"accepted_review_version":binding["base_review_version"]}))
}

fn submission_hash(payload: &Value) -> AppResult<String> {
    let mut content = payload.clone();
    let fields = content
        .as_object_mut()
        .ok_or_else(|| fail("CLOUD_QC_PENDING_CHANGED"))?;
    fields.remove("submission_id");
    fields.remove("base_review_version");
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&content)?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_calibration_decimal_survives_viewer_json_roundtrip() {
        let raw = r#"{"calibration":{"profiles":{"main":{"camera_matrix":[[592.2461644153864,0.0,1911.7162939335162]]}}}}"#;
        let value: Value = serde_json::from_str(raw).unwrap();
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(encoded.contains("1911.7162939335162"), "{encoded}");
        let reparsed: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value, reparsed);
    }
    #[test]
    fn preview_permission_requires_exact_server_task_and_owner() {
        let binding = json!({"job_id":"a","recording_id":"b"});
        let mut plans = json!({"plans":[{"job_id":"other","state":"sampling","tasks":[{"recording_id":"b","assignee":"alice"}]},
            {"job_id":"a","state":"sampling","tasks":[{"recording_id":"b","assignee":null}]}]});
        let (plan, task) = find_task(&plans, &binding).unwrap();
        assert_eq!(task_access(plan, task, "alice")["canEdit"], false);
        assert_eq!(task_access(plan, task, "alice")["claimable"], true);
        plans["plans"][1]["tasks"][0]["assignee"] = json!("alice");
        let (plan, task) = find_task(&plans, &binding).unwrap();
        assert_eq!(task_access(plan, task, "alice")["canEdit"], true);
        assert_eq!(task_access(plan, task, "bob")["canEdit"], false);
        assert_eq!(task_access(plan, task, "bob")["claimable"], false);
        plans["plans"][1]["state"] = json!("invalidated");
        let (plan, task) = find_task(&plans, &binding).unwrap();
        assert_eq!(task_access(plan, task, "alice")["canEdit"], false);
        assert!(find_task(&plans, &json!({"job_id":"missing","recording_id":"b"})).is_err());
    }
    #[test]
    fn current_viewer_evidence_is_bound_to_account_and_exact_bytes() {
        use crate::machine_review::{load, save_for_user, SaveReviewRequest};
        let temp = std::env::temp_dir().join(format!("cloud-qc-evidence-{}", nonce().unwrap()));
        let root = temp.join("sample");
        fs::create_dir_all(&root).unwrap();
        let source = json!({"schema_version":3,"episode_results":[{"episode_id":"sample",
            "media":{"frame_count":30,"frame_index_base":0,"interval_convention":"[start,end)"},
            "annotations":[{"id":"a","segment_id":"seg0","label_code":"phase_test","start_frame":0,"end_frame":30,
                "attributes":{"semantic_description":"Synthetic test action"}}]}]});
        let raw = serde_json::to_vec(&source).unwrap();
        fs::write(root.join("bailian_annotation.json"), &raw).unwrap();
        fs::write(
            root.join("session.json"),
            br#"{"session_id":"synthetic-cloud-qc","collector":"fixture"}"#,
        )
        .unwrap();
        let state = load(&temp.join("local"), &root).unwrap();
        save_for_user(
            &temp.join("local"),
            SaveReviewRequest {
                source_path: root.to_string_lossy().into(),
                source_name: Some("bailian_annotation.json".into()),
                source_hash: state.source_hash,
                expected_revision: state.revision,
                segments: state.segments,
                status: Some("approved".into()),
                rejection_reason: None,
            },
            "审核测试",
            "fixture-reviewer",
        )
        .unwrap();
        let description = fs::read(root.join("description.json")).unwrap();
        let technical: Value =
            serde_json::from_slice(&fs::read(root.join(".description.review-state.json")).unwrap())
                .unwrap();
        assert_eq!(
            technical["contentHash"],
            blake3::hash(&description).to_hex().to_string()
        );
        assert_eq!(technical["review"]["reviewerUsername"], "fixture-reviewer");
        assert_eq!(
            technical["review"]["sourceHash"],
            blake3::hash(&raw).to_hex().to_string()
        );
        if let Some(destination) = std::env::var_os("DELTA_QC_EVIDENCE_TEST_OUTPUT") {
            let destination = PathBuf::from(destination);
            fs::create_dir(&destination).unwrap();
            for name in [
                "session.json",
                "description.json",
                ".description.review-state.json",
                "bailian_annotation.json",
            ] {
                fs::copy(root.join(name), destination.join(name)).unwrap();
            }
        }
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn pending_requests_survive_reopen_and_never_become_another_accounts_work() {
        let temp = std::env::temp_dir().join(format!("cloud-native-{}", nonce().unwrap()));
        let holder = temp
            .join("cloud-qc/data/alice/company")
            .join("a".repeat(32))
            .join("b".repeat(32));
        let directory = holder.join("files/recording");
        fs::create_dir_all(&directory).unwrap();
        let binding =
            json!({"account_id":"alice","local_directory":directory,"base_review_version":3});
        write_json(&holder.join("binding.json"), &binding).unwrap();
        let payload = json!({"submission_id":"c".repeat(32),"base_review_version":3,"annotation_revision":"d".repeat(64),"reason":"actual local draft edit"});
        let exact = json!({"kind":"revoke","payload":payload,"content_hash":submission_hash(&payload).unwrap()});
        write_json(&holder.join("pending.json"), &exact).unwrap();
        assert_eq!(bindings(&temp, "alice").unwrap(), vec![holder.clone()]);
        assert!(bindings(&temp, "bob").unwrap().is_empty());
        assert!(owns_directory(&temp, "alice", &directory));
        assert!(!owns_directory(&temp, "bob", &directory));
        let reopened: Value =
            serde_json::from_slice(&bounded(&holder.join("pending.json")).unwrap()).unwrap();
        assert_eq!(reopened, exact);
        assert_eq!(reopened["payload"]["submission_id"], "c".repeat(32));
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn downloaded_approved_bytes_are_only_a_baseline_and_revocation_overrides_local_history() {
        let temp = std::env::temp_dir().join(format!("cloud-baseline-{}", nonce().unwrap()));
        let holder = temp
            .join("cloud-qc/data/alice/company")
            .join("a".repeat(32))
            .join("b".repeat(32));
        let directory = holder.join("files/recording");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("session.json"), br#"{"qc":"approved"}"#).unwrap();
        fs::write(
            directory.join("description.json"),
            br#"{"_human_review":{"status":"approved"}}"#,
        )
        .unwrap();
        let mut binding = json!({"account_id":"alice","local_directory":directory,"base_review_version":4,"annotation_revision":"d".repeat(64),"qc":{"decision":"pending","reason":null},"withdrawn":true});
        let payload = snapshot(&directory, &binding).unwrap();
        binding["last_submission_hash"] = json!(submission_hash(&payload).unwrap());
        write_json(&holder.join("binding.json"), &binding).unwrap();
        assert_eq!(
            binding["last_submission_hash"],
            submission_hash(&snapshot(&directory, &binding).unwrap()).unwrap()
        );
        assert!(!published_changed(&binding, &payload).unwrap());
        let mut new_payload = payload.clone();
        new_payload["description"]["_human_review"]["reviewedAt"] = json!("2026-10-27T00:00:00Z");
        assert!(published_changed(&binding, &new_payload).unwrap());
        let mut view=crate::machine_review::ReviewView {
            pending_event_id: None,
            local_draft:false,review:serde_json::from_value(json!({"sourceHash":"","revision":0,"segments":[],"published":true,"outputHash":null,"updatedAtMs":0,"reviewer":"fixture"})).unwrap(),
            output_name:"description.json".into(),qc_status:"approved".into(),qc_rejection_reason:String::new(),qc_status_error:String::new(),pending_source_write:false,source_write_error:String::new(),qc_content_hash:None,
        };
        decorate_view(&temp, "alice", &directory, &mut view).unwrap();
        assert_eq!(view.qc_status, "pending");
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn paths_and_identifiers_are_bounded() {
        for value in ["../x", "/tmp/x", "x//y", "x/../y", "x\\y", "x:y"] {
            assert!(safe(Path::new("/tmp"), value).is_err());
        }
        assert_eq!(
            safe(Path::new("/tmp"), "batch/recording").unwrap(),
            Path::new("/tmp/batch/recording")
        );
        assert!(identifier(&json!("a".repeat(32))).is_ok());
        assert!(identifier(&json!("Z".repeat(32))).is_err());
    }
}
