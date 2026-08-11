use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use crate::model::{AuthStatus, LoginRequest, UserCenterStatus, UserIdentity};
use crate::storage;
use reqwest::{Certificate, Client, Url};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLIENT_CONFIG_SCHEMA_VERSION: u32 = 1;
const MAX_CONFIG_BYTES: u64 = 256 * 1024;

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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    user: UserIdentity,
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
        .map_err(|error| {
            AppError::Message(format!(
                "USER_CENTER_UNAVAILABLE: 无法连接用户中心: {error}"
            ))
        })?;
    if !response.status().is_success() {
        return Err(AppError::Message(remote_error(response).await));
    }
    let result: LoginResponse = response
        .json()
        .await
        .map_err(|error| AppError::Message(format!("用户中心登录响应无效: {error}")))?;
    crate::identity::validate_user_identity(&result.user)?;
    state.set_user(Some(result.user.clone()))?;
    Ok(result.user)
}

async fn request_health(
    client: &Client,
    config: &UserCenterClientConfig,
) -> AppResult<HealthResponse> {
    let response = client
        .get(endpoint(config, "healthz")?)
        .send()
        .await
        .map_err(|error| {
            AppError::Message(format!(
                "USER_CENTER_UNAVAILABLE: 无法连接用户中心: {error}"
            ))
        })?;
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

async fn remote_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.json::<ErrorResponse>().await.ok();
    body.and_then(|value| value.error)
        .unwrap_or_else(|| format!("USER_CENTER_REQUEST_FAILED: 用户中心返回 HTTP {status}"))
}

fn client_for(config: &UserCenterClientConfig) -> AppResult<Client> {
    let certificate = Certificate::from_pem(config.certificate_pem.as_bytes())
        .map_err(|error| AppError::Message(format!("用户中心证书无效: {error}")))?;
    Client::builder()
        .add_root_certificate(certificate)
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
        is_private_lan_ip, valid_service_id, validate_client_config, UserCenterClientConfig,
    };

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
}
