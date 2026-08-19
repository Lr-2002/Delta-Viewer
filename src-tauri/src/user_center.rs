use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use crate::model::{
    AssignedTask, AssignedTaskActivity, AuthStatus, LoginRequest, SupervisionAccount,
    SupervisionDashboardData, SupervisionEvent, SupervisionTaskDetail, SupervisionTaskImportResult,
    SupervisionUserSummary, UserCenterStatus, UserIdentity,
};
use crate::storage;
use reqwest::{Certificate, Client, Url};
use serde::{Deserialize, Serialize};
use std::error::Error as StdError;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLIENT_CONFIG_SCHEMA_VERSION: u32 = 1;
const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const STRUCTURED_ASSIGNMENTS_CAPABILITY: &str = "structuredTaskAssignmentsV1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserCenterClientConfig {
    schema_version: u32,
    service_id: String,
    server_url: String,
    certificate_pem: String,
    issued_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: String,
    service_id: String,
    setup_required: bool,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    token: String,
    user: UserIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisionAuditResponse {
    users: Vec<SupervisionUserSummary>,
    events: Vec<SupervisionEvent>,
    #[serde(default)]
    task_details: Vec<SupervisionTaskDetail>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisionAccountsResponse {
    users: Vec<SupervisionAccount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    error: Option<String>,
}

pub async fn configure(data_root: &Path, source_path: &Path) -> AppResult<UserCenterStatus> {
    let source = read_client_config(source_path)?;
    validate_client_config(&source)?;
    let client = client_for(&source)?;
    let health = request_health(&client, &source).await?;
    if health.setup_required {
        return Err(AppError::Message(
            "USER_CENTER_SETUP_REQUIRED: 管理员尚未在服务主机完成初始化".into(),
        ));
    }
    let destination = config_path(data_root);
    if destination.exists() {
        let existing = load_config(data_root)?;
        if existing.service_id == source.service_id && existing.server_url == source.server_url {
            return Ok(status_from_config(&existing));
        }
        return Err(AppError::Message(
            "USER_CENTER_ALREADY_CONFIGURED: 当前设备已绑定其他用户中心".into(),
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::Message("用户中心配置路径无效".into()))?;
    fs::create_dir_all(parent)?;
    write_config_noreplace(&source, &destination)?;
    Ok(status_from_config(&source))
}

pub fn auth_status(data_root: &Path, state: &AuthState) -> AppResult<AuthStatus> {
    let path = config_path(data_root);
    let config = match load_config(data_root) {
        Ok(config) => Some(config),
        Err(_) if !path.exists() => None,
        Err(error) => return Err(error),
    };
    Ok(AuthStatus {
        workspace_mode: state.workspace_mode()?,
        user_center: config
            .as_ref()
            .map(status_from_config)
            .unwrap_or(UserCenterStatus {
                configured: false,
                endpoint: None,
                service_id: None,
            }),
        current_user: state.current_user()?,
    })
}

pub async fn login(
    data_root: &Path,
    state: &AuthState,
    request: LoginRequest,
) -> AppResult<UserIdentity> {
    state.require_managed_mode()?;
    let config = load_config(data_root).map_err(|_| {
        AppError::Message("USER_CENTER_NOT_CONFIGURED: 请先导入管理员提供的用户中心配置文件".into())
    })?;
    let client = client_for(&config)?;
    let url = endpoint(&config, "api/v1/auth/login")?;
    let response = client
        .post(url)
        .json(&serde_json::json!({
            "username": request.username,
            "password": request.password,
        }))
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    let result: LoginResponse = response
        .json()
        .await
        .map_err(|error| AppError::Message(format!("用户中心登录响应无效: {error}")))?;
    crate::identity::validate_user_identity(&result.user)?;
    if result.token.len() < 32 {
        return Err(AppError::Message("用户中心登录令牌无效".into()));
    }
    state.set_managed_session(result.user.clone(), result.token)?;
    Ok(result.user)
}

pub async fn record_annotation_audit(
    data_root: &Path,
    state: &AuthState,
    request: crate::model::AnnotationAuditRequest,
) -> AppResult<()> {
    let token = state.managed_token()?;
    let config = load_config(data_root)?;
    let response = client_for(&config)?
        .post(endpoint(&config, "api/v1/audit/events")?)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "taskId": request.task_id,
            "trajectoryCode": request.trajectory_code,
            "action": request.action,
            "occurredAtMs": request.occurred_at_ms,
        }))
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    Ok(())
}

pub async fn assigned_tasks(data_root: &Path, state: &AuthState) -> AppResult<Vec<AssignedTask>> {
    let token = state.managed_token()?;
    let config = load_config(data_root)?;
    let client = client_for(&config)?;
    require_structured_assignments(&request_health(&client, &config).await?)?;
    let response = client
        .get(endpoint(&config, "api/v1/tasks/assigned")?)
        .bearer_auth(token)
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    #[derive(Deserialize)]
    struct AssignedTasksResponse {
        tasks: Vec<AssignedTask>,
    }
    response
        .json::<AssignedTasksResponse>()
        .await
        .map(|result| result.tasks)
        .map_err(|error| AppError::Message(format!("用户中心任务分配响应无效: {error}")))
}

pub async fn assigned_task_activity(
    data_root: &Path,
    state: &AuthState,
    date: &str,
) -> AppResult<AssignedTaskActivity> {
    let token = state.managed_token()?;
    let config = load_config(data_root)?;
    let mut url = endpoint(&config, "api/v1/tasks/assigned/activity")?;
    url.query_pairs_mut().append_pair("date", date);
    let response = client_for(&config)?
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    response
        .json()
        .await
        .map_err(|error| AppError::Message(format!("用户中心任务记录响应无效: {error}")))
}

pub async fn supervision_dashboard(
    data_root: &Path,
    state: &AuthState,
) -> AppResult<SupervisionDashboardData> {
    let user = state.require_managed_user()?;
    if user.role.as_deref() != Some("admin") {
        return Err(AppError::Message(
            "SUPERVISOR_REQUIRED: 当前账号不是监管账户".into(),
        ));
    }
    let token = state.managed_token()?;
    let config = load_config(data_root)?;
    let client = client_for(&config)?;
    let audit_response = client
        .get(endpoint(&config, "api/v1/admin/audit")?)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !audit_response.status().is_success() {
        return Err(AppError::Message(remote_error(audit_response).await));
    }
    let audit: SupervisionAuditResponse = audit_response
        .json()
        .await
        .map_err(|error| AppError::Message(format!("监管数据响应无效: {error}")))?;
    let accounts_response = client
        .get(endpoint(&config, "api/v1/admin/users")?)
        .bearer_auth(token)
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !accounts_response.status().is_success() {
        return Err(AppError::Message(remote_error(accounts_response).await));
    }
    let accounts: SupervisionAccountsResponse = accounts_response
        .json()
        .await
        .map_err(|error| AppError::Message(format!("监管账号响应无效: {error}")))?;
    Ok(SupervisionDashboardData {
        users: audit.users,
        events: audit.events,
        accounts: accounts.users,
        task_details: audit.task_details,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDetailsResponse {
    task_details: Vec<SupervisionTaskDetail>,
}

pub async fn update_task_detail(
    data_root: &Path,
    state: &AuthState,
    task: &str,
    detail: &str,
) -> AppResult<Vec<SupervisionTaskDetail>> {
    require_supervisor(state)?;
    send_task_details(
        data_root,
        state,
        "api/v1/admin/task-details",
        reqwest::Method::PUT,
        vec![serde_json::json!({ "task": task, "detail": detail })],
    )
    .await
}

pub async fn import_task_details(
    data_root: &Path,
    state: &AuthState,
    source_path: &Path,
) -> AppResult<SupervisionTaskImportResult> {
    require_supervisor(state)?;
    let metadata = fs::symlink_metadata(source_path)?;
    if !metadata.file_type().is_file() || metadata.len() > 16 * 1024 {
        return Err(AppError::Message(
            "TASK_DETAIL_IMPORT_INVALID: 任务详情文件必须是小于 16 KiB 的普通 JSON 文件".into(),
        ));
    }
    let value: serde_json::Value = serde_json::from_reader(File::open(source_path)?)
        .map_err(|error| AppError::Message(format!("TASK_DETAIL_IMPORT_INVALID: {error}")))?;
    let tasks = value
        .get("tasks")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::Message("TASK_DETAIL_IMPORT_INVALID: 缺少 tasks 数组".into()))?;
    let mut entries = Vec::with_capacity(tasks.len());
    let mut imported_task_names = Vec::with_capacity(tasks.len());
    for item in tasks {
        let task = item
            .get("task")
            .or_else(|| item.get("label"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let detail = item
            .get("detail")
            .or_else(|| item.get("description"))
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                item.get("descriptions")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(serde_json::Value::as_str)
            })
            .unwrap_or("");
        imported_task_names.push(task.to_owned());
        entries.push(serde_json::json!({ "task": task, "detail": detail }));
    }
    if entries.is_empty() || entries.len() > 500 {
        return Err(AppError::Message(
            "TASK_DETAIL_IMPORT_INVALID: 任务详情数量必须是 1-500".into(),
        ));
    }
    let task_details = send_task_details(
        data_root,
        state,
        "api/v1/admin/task-details/import",
        reqwest::Method::POST,
        entries,
    )
    .await?;
    Ok(SupervisionTaskImportResult {
        task_details,
        imported_task_names,
    })
}

fn require_supervisor(state: &AuthState) -> AppResult<()> {
    let user = state.require_managed_user()?;
    if user.role.as_deref() != Some("admin") {
        return Err(AppError::Message(
            "SUPERVISOR_REQUIRED: 当前账号不是监管账户".into(),
        ));
    }
    Ok(())
}

async fn send_task_details(
    data_root: &Path,
    state: &AuthState,
    endpoint_suffix: &str,
    method: reqwest::Method,
    entries: Vec<serde_json::Value>,
) -> AppResult<Vec<SupervisionTaskDetail>> {
    let token = state.managed_token()?;
    let config = load_config(data_root)?;
    let body = if entries.len() == 1 && method == reqwest::Method::PUT {
        entries
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Message("任务详情内容为空".into()))?
    } else {
        serde_json::json!({ "tasks": entries })
    };
    let response = client_for(&config)?
        .request(method, endpoint(&config, endpoint_suffix)?)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    response
        .json::<TaskDetailsResponse>()
        .await
        .map(|result| result.task_details)
        .map_err(|error| AppError::Message(format!("任务详情响应无效: {error}")))
}

pub async fn set_assigned_tasks(
    data_root: &Path,
    state: &AuthState,
    username: &str,
    assigned_task_quantities: std::collections::BTreeMap<String, u64>,
) -> AppResult<SupervisionAccount> {
    let user = state.require_managed_user()?;
    if user.role.as_deref() != Some("admin") {
        return Err(AppError::Message(
            "SUPERVISOR_REQUIRED: 当前账号不是监管账户".into(),
        ));
    }
    let valid_username = (3..=32).contains(&username.len())
        && username.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        });
    let valid_tasks = assigned_task_quantities.len() <= 500
        && assigned_task_quantities.iter().all(|(task, quantity)| {
            let trimmed = task.trim();
            !trimmed.is_empty()
                && trimmed.chars().count() <= 100
                && trimmed == task
                && (1..=1_000_000).contains(quantity)
        });
    if !valid_username || !valid_tasks {
        return Err(AppError::Message(
            "ASSIGNED_TASKS_INVALID: 任务分配参数无效".into(),
        ));
    }
    let token = state.managed_token()?;
    let config = load_config(data_root)?;
    let client = client_for(&config)?;
    require_structured_assignments(&request_health(&client, &config).await?)?;
    let requested_task_quantities = assigned_task_quantities.clone();
    let response = client
        .put(endpoint(
            &config,
            &format!("api/v1/admin/users/{username}/assignment"),
        )?)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "assignedTasks": assigned_task_quantities.values().sum::<u64>(),
            "assignedTaskQuantities": assigned_task_quantities,
        }))
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    #[derive(Deserialize)]
    struct AssignmentResponse {
        user: SupervisionAccount,
    }
    let saved = response
        .json::<AssignmentResponse>()
        .await
        .map(|result| result.user)
        .map_err(|error| AppError::Message(format!("任务分配响应无效: {error}")))?;
    validate_assignment_response(&requested_task_quantities, &saved)?;
    Ok(saved)
}

fn require_structured_assignments(health: &HealthResponse) -> AppResult<()> {
    if health
        .capabilities
        .iter()
        .any(|capability| capability == STRUCTURED_ASSIGNMENTS_CAPABILITY)
    {
        return Ok(());
    }
    Err(AppError::Message(
        "USER_CENTER_UPGRADE_REQUIRED: 用户中心版本过旧，不支持具体任务分配；请升级并重启用户中心服务".into(),
    ))
}

fn validate_assignment_response(
    requested: &std::collections::BTreeMap<String, u64>,
    saved: &SupervisionAccount,
) -> AppResult<()> {
    let requested_total = requested.values().sum::<u64>();
    let requested_names = requested
        .keys()
        .map(|task| task.to_lowercase())
        .collect::<std::collections::BTreeSet<_>>();
    let saved_names = saved
        .assigned_task_names
        .iter()
        .map(|task| task.to_lowercase())
        .collect::<std::collections::BTreeSet<_>>();
    if saved.assigned_tasks == requested_total
        && saved.assigned_task_quantities == *requested
        && saved_names == requested_names
    {
        return Ok(());
    }
    Err(AppError::Message(
        "USER_CENTER_ASSIGNMENT_MISMATCH: 用户中心未完整保存任务名称和数量；请升级用户中心后重新分配".into(),
    ))
}

async fn request_health(
    client: &Client,
    config: &UserCenterClientConfig,
) -> AppResult<HealthResponse> {
    let response = client
        .get(endpoint(config, "healthz")?)
        .send()
        .await
        .map_err(user_center_request_error)?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    let health: HealthResponse = response
        .json()
        .await
        .map_err(|error| AppError::Message(format!("用户中心健康响应无效: {error}")))?;
    if health.status != "ready" || health.service_id != config.service_id {
        return Err(AppError::Message(
            "USER_CENTER_IDENTITY_MISMATCH: 用户中心身份与导入配置不一致".into(),
        ));
    }
    Ok(health)
}

fn user_center_request_error(error: reqwest::Error) -> AppError {
    let mut details = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        details.push_str(": ");
        details.push_str(&cause.to_string());
        source = cause.source();
    }
    AppError::Message(format!(
        "USER_CENTER_UNAVAILABLE: 无法连接用户中心: {details}"
    ))
}

async fn remote_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.json::<ErrorResponse>().await.ok();
    body.and_then(|value| value.error)
        .unwrap_or_else(|| format!("USER_CENTER_REQUEST_FAILED: 用户中心返回 HTTP {status}"))
}

fn client_for(config: &UserCenterClientConfig) -> AppResult<Client> {
    let certificate = Certificate::from_pem(config.certificate_pem.as_bytes())
        .map_err(|error| AppError::Message(format!("用户中心证书无效: {error}")))?;
    let builder = Client::builder();
    #[cfg(not(target_os = "windows"))]
    let builder = builder.tls_certs_only([certificate]);
    #[cfg(target_os = "windows")]
    let builder = builder.add_root_certificate(certificate);
    builder
        .https_only(true)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .user_agent("DOHC-Viewer-User-Center/1")
        .build()
        .map_err(|error| AppError::Message(format!("无法创建用户中心连接: {error}")))
}

fn endpoint(config: &UserCenterClientConfig, suffix: &str) -> AppResult<Url> {
    let base =
        Url::parse(&config.server_url).map_err(|_| AppError::Message("用户中心地址无效".into()))?;
    base.join(suffix)
        .map_err(|_| AppError::Message("用户中心 API 地址无效".into()))
}

fn read_client_config(path: &Path) -> AppResult<UserCenterClientConfig> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return Err(AppError::Message("用户中心配置文件无效".into()));
    }
    let config: UserCenterClientConfig = serde_json::from_reader(File::open(path)?)?;
    validate_client_config(&config)?;
    Ok(config)
}

fn load_config(data_root: &Path) -> AppResult<UserCenterClientConfig> {
    read_client_config(&config_path(data_root))
}

fn validate_client_config(config: &UserCenterClientConfig) -> AppResult<()> {
    if config.schema_version != CLIENT_CONFIG_SCHEMA_VERSION
        || config.issued_at_ms == 0
        || !valid_service_id(&config.service_id)
        || config.certificate_pem.len() > MAX_CONFIG_BYTES as usize
        || !config.certificate_pem.contains("BEGIN CERTIFICATE")
    {
        return Err(AppError::Message("用户中心配置格式无效".into()));
    }
    let url =
        Url::parse(&config.server_url).map_err(|_| AppError::Message("用户中心地址无效".into()))?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
        || !url.host_str().is_some_and(is_private_lan_ip)
    {
        return Err(AppError::Message(
            "用户中心只能使用固定的局域网 HTTPS IP 地址".into(),
        ));
    }
    Certificate::from_pem(config.certificate_pem.as_bytes())
        .map_err(|_| AppError::Message("用户中心证书无效".into()))?;
    Ok(())
}

fn is_private_lan_ip(value: &str) -> bool {
    let Ok(address) = value.parse::<Ipv4Addr>() else {
        return false;
    };
    address.is_private()
}

fn valid_service_id(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

fn status_from_config(config: &UserCenterClientConfig) -> UserCenterStatus {
    UserCenterStatus {
        configured: true,
        endpoint: Some(config.server_url.clone()),
        service_id: Some(config.service_id.clone()),
    }
}

fn config_path(data_root: &Path) -> PathBuf {
    data_root.join("user-center.json")
}

fn write_config_noreplace(config: &UserCenterClientConfig, output: &Path) -> AppResult<()> {
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Message("用户中心配置缺少目录".into()))?;
    let partial = parent.join(format!(
        ".{}.partial-{}",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("user-center.json"),
        unix_nanos()
    ));
    let result = (|| -> AppResult<()> {
        let mut file = open_private_new(&partial)?;
        serde_json::to_writer_pretty(&mut file, config)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        let verified = read_client_config(&partial)?;
        if verified.service_id != config.service_id || verified.server_url != config.server_url {
            return Err(AppError::Message("用户中心配置回读验证失败".into()));
        }
        storage::publish_noreplace(&partial, output)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    Ok(())
}

fn open_private_new(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn unix_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        is_private_lan_ip, require_structured_assignments, valid_service_id,
        validate_assignment_response, validate_client_config, HealthResponse,
        UserCenterClientConfig, STRUCTURED_ASSIGNMENTS_CAPABILITY,
    };
    use crate::model::SupervisionAccount;
    use std::collections::BTreeMap;

    #[test]
    fn accepts_only_private_lan_ip_configuration() {
        assert!(is_private_lan_ip("10.1.11.200"));
        assert!(is_private_lan_ip("192.168.1.2"));
        assert!(!is_private_lan_ip("39.155.172.162"));
        assert!(!is_private_lan_ip("localhost"));
        assert!(valid_service_id("11111111-1111-4111-8111-111111111111"));
        assert!(!valid_service_id("111111111111111111111111111111111111"));
        assert!(!valid_service_id("11111111a111-4111-8111-111111111111111"));
        assert!(!valid_service_id("bad"));
        let invalid = UserCenterClientConfig {
            schema_version: 1,
            service_id: "11111111-1111-4111-8111-111111111111".into(),
            server_url: "http://10.1.11.200:17880".into(),
            certificate_pem: "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"
                .into(),
            issued_at_ms: 1,
        };
        assert!(validate_client_config(&invalid).is_err());
    }

    #[test]
    fn requires_structured_assignment_capability() {
        let legacy = HealthResponse {
            status: "ready".into(),
            service_id: "11111111-1111-4111-8111-111111111111".into(),
            setup_required: false,
            capabilities: Vec::new(),
        };
        assert!(require_structured_assignments(&legacy).is_err());

        let current = HealthResponse {
            capabilities: vec![STRUCTURED_ASSIGNMENTS_CAPABILITY.into()],
            ..legacy
        };
        assert!(require_structured_assignments(&current).is_ok());
    }

    #[test]
    fn rejects_assignment_response_that_loses_task_names() {
        let requested = BTreeMap::from([("BedMaking".into(), 3)]);
        let legacy_response = SupervisionAccount {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: "operator".into(),
            assigned_tasks: 3,
            assigned_task_names: Vec::new(),
            assigned_task_quantities: BTreeMap::new(),
            created_at_ms: 1,
        };
        assert!(validate_assignment_response(&requested, &legacy_response).is_err());

        let current_response = SupervisionAccount {
            assigned_task_names: vec!["BedMaking".into()],
            assigned_task_quantities: requested.clone(),
            ..legacy_response
        };
        assert!(validate_assignment_response(&requested, &current_response).is_ok());
    }
}
