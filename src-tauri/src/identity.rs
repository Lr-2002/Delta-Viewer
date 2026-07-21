use crate::error::{AppError, AppResult};
use crate::model::{AuthStatus, LoginRequest, RegisterAccountRequest, UserIdentity};
use crate::storage;
use argon2::password_hash::{rand_core::OsRng, PasswordHash, SaltString};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const ACCOUNT_FORMAT_VERSION: u32 = 1;
const MAX_ACCOUNT_FILE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountRecord {
    format_version: u32,
    username: String,
    display_name: String,
    password_hash: String,
    created_at_ms: u64,
}

#[derive(Clone, Default)]
pub struct AuthState {
    current_user: Arc<Mutex<Option<UserIdentity>>>,
}

impl AuthState {
    pub fn current_user(&self) -> AppResult<Option<UserIdentity>> {
        self.current_user
            .lock()
            .map(|current| current.clone())
            .map_err(|_| AppError::Message("本地登录会话不可用".into()))
    }

    pub fn require_user(&self) -> AppResult<UserIdentity> {
        self.current_user()?
            .ok_or_else(|| AppError::Message("AUTH_REQUIRED: 请先登录本地账号".into()))
    }

    fn set_user(&self, user: Option<UserIdentity>) -> AppResult<()> {
        let mut current = self
            .current_user
            .lock()
            .map_err(|_| AppError::Message("本地登录会话不可用".into()))?;
        *current = user;
        Ok(())
    }
}

pub fn auth_status(data_root: &Path, state: &AuthState) -> AppResult<AuthStatus> {
    Ok(AuthStatus {
        has_accounts: has_accounts(data_root)?,
        current_user: state.current_user()?,
    })
}

pub fn register_account(
    data_root: &Path,
    state: &AuthState,
    request: RegisterAccountRequest,
) -> AppResult<UserIdentity> {
    let username = normalize_username(&request.username)?;
    let display_name = validate_display_name(&request.display_name)?;
    validate_password(&request.password)?;

    let accounts_dir = accounts_dir(data_root);
    fs::create_dir_all(&accounts_dir)?;
    let output = account_path(&accounts_dir, &username);
    if output.exists() {
        return Err(AppError::Message("ACCOUNT_EXISTS: 本地账号已存在".into()));
    }

    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(request.password.as_bytes(), &salt)
        .map_err(|_| AppError::Message("无法创建密码哈希".into()))?
        .to_string();
    let record = AccountRecord {
        format_version: ACCOUNT_FORMAT_VERSION,
        username: username.clone(),
        display_name: display_name.clone(),
        password_hash,
        created_at_ms: unix_millis(),
    };
    write_account(&record, &output)?;

    let user = UserIdentity {
        username,
        display_name,
    };
    state.set_user(Some(user.clone()))?;
    Ok(user)
}

pub fn login_account(
    data_root: &Path,
    state: &AuthState,
    request: LoginRequest,
) -> AppResult<UserIdentity> {
    let username = normalize_username(&request.username)
        .map_err(|_| AppError::Message("AUTH_INVALID: 账号或密码错误".into()))?;
    let path = account_path(&accounts_dir(data_root), &username);
    let record = read_account(&path)
        .map_err(|_| AppError::Message("AUTH_INVALID: 账号或密码错误".into()))?;
    let parsed_hash = PasswordHash::new(&record.password_hash)
        .map_err(|_| AppError::Message("AUTH_INVALID: 账号或密码错误".into()))?;
    Argon2::default()
        .verify_password(request.password.as_bytes(), &parsed_hash)
        .map_err(|_| AppError::Message("AUTH_INVALID: 账号或密码错误".into()))?;

    let user = UserIdentity {
        username: record.username,
        display_name: record.display_name,
    };
    state.set_user(Some(user.clone()))?;
    Ok(user)
}

pub fn logout_account(state: &AuthState) -> AppResult<()> {
    state.set_user(None)
}

pub fn validate_user_identity(user: &UserIdentity) -> AppResult<()> {
    if normalize_username(&user.username)? != user.username
        || validate_display_name(&user.display_name)? != user.display_name
    {
        return Err(AppError::Message("用户身份记录格式无效".into()));
    }
    Ok(())
}

fn has_accounts(data_root: &Path) -> AppResult<bool> {
    let directory = accounts_dir(data_root);
    if !directory.is_dir() {
        return Ok(false);
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("json"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn accounts_dir(data_root: &Path) -> PathBuf {
    data_root.join("accounts")
}

fn account_path(accounts_dir: &Path, username: &str) -> PathBuf {
    accounts_dir.join(format!("{username}.json"))
}

fn normalize_username(value: &str) -> AppResult<String> {
    let username = value.trim().to_ascii_lowercase();
    let valid_length = (3..=32).contains(&username.len());
    let valid_characters = username.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-')
    });
    let valid_edges = username
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
        && username
            .chars()
            .last()
            .is_some_and(|character| character.is_ascii_alphanumeric());
    if !valid_length || !valid_characters || !valid_edges {
        return Err(AppError::Message(
            "账号需为 3-32 位小写字母、数字、点、下划线或连字符，且首尾为字母或数字".into(),
        ));
    }
    Ok(username)
}

fn validate_display_name(value: &str) -> AppResult<String> {
    let display_name = value.trim();
    let character_count = display_name.chars().count();
    if !(1..=40).contains(&character_count) || display_name.chars().any(char::is_control) {
        return Err(AppError::Message("显示名称需为 1-40 个可见字符".into()));
    }
    Ok(display_name.into())
}

fn validate_password(password: &str) -> AppResult<()> {
    let character_count = password.chars().count();
    if !(8..=128).contains(&character_count) {
        return Err(AppError::Message("密码需为 8-128 个字符".into()));
    }
    Ok(())
}

fn write_account(record: &AccountRecord, output: &Path) -> AppResult<()> {
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Message("账号路径缺少父目录".into()))?;
    let partial = parent.join(format!(
        ".{}.partial-{}",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("account.json"),
        unix_nanos()
    ));
    let result = (|| -> AppResult<()> {
        let mut file = open_private_new(&partial)?;
        serde_json::to_writer_pretty(&mut file, record)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        let decoded = read_account(&partial)?;
        if decoded.format_version != record.format_version
            || decoded.username != record.username
            || decoded.display_name != record.display_name
            || decoded.password_hash != record.password_hash
        {
            return Err(AppError::Message("账号文件回读验证失败".into()));
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

fn read_account(path: &Path) -> AppResult<AccountRecord> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_ACCOUNT_FILE_BYTES {
        return Err(AppError::Message("账号文件无效".into()));
    }
    let record: AccountRecord = serde_json::from_reader(File::open(path)?)?;
    if record.format_version != ACCOUNT_FORMAT_VERSION
        || normalize_username(&record.username)? != record.username
        || validate_display_name(&record.display_name)? != record.display_name
    {
        return Err(AppError::Message("账号文件格式无效".into()));
    }
    Ok(record)
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

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{auth_status, login_account, logout_account, register_account, AuthState};
    use crate::model::{LoginRequest, RegisterAccountRequest};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn registers_hashes_logs_in_and_logs_out() {
        let root = test_output("account");
        fs::create_dir_all(&root).unwrap();
        let state = AuthState::default();
        assert!(state.require_user().is_err());
        let user = register_account(
            &root,
            &state,
            RegisterAccountRequest {
                username: "Operator.One".into(),
                display_name: "操作员一".into(),
                password: "correct-horse".into(),
            },
        )
        .unwrap();
        assert_eq!(user.username, "operator.one");
        assert!(auth_status(&root, &state).unwrap().has_accounts);
        let account_bytes = fs::read(root.join("accounts/operator.one.json")).unwrap();
        let account_text = String::from_utf8(account_bytes).unwrap();
        assert!(!account_text.contains("correct-horse"));
        assert!(register_account(
            &root,
            &state,
            RegisterAccountRequest {
                username: "operator.one".into(),
                display_name: "重复账号".into(),
                password: "another-password".into(),
            }
        )
        .is_err());

        logout_account(&state).unwrap();
        assert!(state.current_user().unwrap().is_none());
        assert!(state.require_user().is_err());
        assert!(login_account(
            &root,
            &state,
            LoginRequest {
                username: "operator.one".into(),
                password: "wrong-password".into(),
            }
        )
        .is_err());
        let logged_in = login_account(
            &root,
            &state,
            LoginRequest {
                username: "operator.one".into(),
                password: "correct-horse".into(),
            },
        )
        .unwrap();
        assert_eq!(logged_in.display_name, "操作员一");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unsafe_account_fields() {
        let root = test_output("invalid-account");
        fs::create_dir_all(&root).unwrap();
        let state = AuthState::default();
        for username in ["..", "bad/name", "-leading", "trailing-"] {
            assert!(register_account(
                &root,
                &state,
                RegisterAccountRequest {
                    username: username.into(),
                    display_name: "操作员".into(),
                    password: "valid-password".into(),
                }
            )
            .is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    fn test_output(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-identity-{name}-{nonce}"))
    }
}
