use crate::error::{AppError, AppResult};
use crate::model::{UserIdentity, WorkspaceMode};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct AuthState {
    session: Arc<Mutex<AuthSession>>,
}

#[derive(Default)]
struct AuthSession {
    workspace_mode: Option<WorkspaceMode>,
    current_user: Option<UserIdentity>,
    user_center_token: Option<String>,
}

impl AuthState {
    pub fn current_user(&self) -> AppResult<Option<UserIdentity>> {
        self.session
            .lock()
            .map(|session| session.current_user.clone())
            .map_err(|_| AppError::Message("用户中心登录会话不可用".into()))
    }

    pub fn workspace_mode(&self) -> AppResult<Option<WorkspaceMode>> {
        self.session
            .lock()
            .map(|session| session.workspace_mode)
            .map_err(|_| AppError::Message("工作模式会话不可用".into()))
    }

    pub fn data_root(&self, base: &std::path::Path) -> AppResult<std::path::PathBuf> {
        Ok(if self.workspace_mode()? == Some(WorkspaceMode::Offline) {
            base.join("offline-local")
        } else {
            base.to_path_buf()
        })
    }

    pub fn require_user(&self) -> AppResult<UserIdentity> {
        match self.workspace_mode()? {
            Some(WorkspaceMode::Offline) => Ok(offline_identity()),
            Some(WorkspaceMode::Managed) => self
                .current_user()?
                .ok_or_else(|| AppError::Message("AUTH_REQUIRED: 请先登录用户中心账号".into())),
            None => Err(AppError::Message(
                "WORKSPACE_MODE_REQUIRED: 请登录用户中心账号".into(),
            )),
        }
    }

    pub fn require_managed_mode(&self) -> AppResult<()> {
        match self.workspace_mode()? {
            Some(WorkspaceMode::Managed) => Ok(()),
            Some(WorkspaceMode::Offline) => Err(AppError::Message(
                "MANAGED_MODE_REQUIRED: 当前为离线模式，不能连接用户中心".into(),
            )),
            None => Err(AppError::Message(
                "WORKSPACE_MODE_REQUIRED: 请先选择统一管理模式".into(),
            )),
        }
    }

    pub fn require_managed_user(&self) -> AppResult<UserIdentity> {
        self.require_managed_mode()?;
        self.current_user()?
            .ok_or_else(|| AppError::Message("AUTH_REQUIRED: 请先登录用户中心账号".into()))
    }

    pub(crate) fn set_user(&self, user: Option<UserIdentity>) -> AppResult<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| AppError::Message("用户中心登录会话不可用".into()))?;
        session.current_user = user;
        if session.current_user.is_none() {
            session.user_center_token = None;
        }
        Ok(())
    }

    pub(crate) fn set_managed_session(&self, user: UserIdentity, token: String) -> AppResult<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| AppError::Message("用户中心登录会话不可用".into()))?;
        session.current_user = Some(user);
        session.user_center_token = Some(token);
        Ok(())
    }

    pub(crate) fn managed_token(&self) -> AppResult<String> {
        self.require_managed_user()?;
        self.session
            .lock()
            .map_err(|_| AppError::Message("用户中心登录会话不可用".into()))?
            .user_center_token
            .clone()
            .ok_or_else(|| AppError::Message("AUTH_REQUIRED: 请重新登录用户中心账号".into()))
    }

    pub(crate) fn managed_session(&self) -> AppResult<(UserIdentity, String)> {
        let session = self
            .session
            .lock()
            .map_err(|_| AppError::Message("用户中心登录会话不可用".into()))?;
        if session.workspace_mode != Some(WorkspaceMode::Managed) {
            return Err(AppError::Message("MANAGED_MODE_REQUIRED".into()));
        }
        match (&session.current_user, &session.user_center_token) {
            (Some(user), Some(token)) => Ok((user.clone(), token.clone())),
            _ => Err(AppError::Message(
                "AUTH_REQUIRED: 请重新登录用户中心账号".into(),
            )),
        }
    }

    pub(crate) fn set_workspace_mode(&self, mode: Option<WorkspaceMode>) -> AppResult<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| AppError::Message("工作模式会话不可用".into()))?;
        session.workspace_mode = mode;
        session.current_user = (mode == Some(WorkspaceMode::Offline)).then(offline_identity);
        session.user_center_token = None;
        Ok(())
    }
}

/// Local provenance only; never a user-center account or management grant.
pub fn offline_identity() -> UserIdentity {
    UserIdentity {
        username: "offline.local".into(),
        display_name: "离线本机".into(),
        role: Some("operator".into()),
        can_manage: false,
    }
}

pub fn logout_account(state: &AuthState) -> AppResult<()> {
    state.set_user(None)
}

pub fn validate_user_identity(user: &UserIdentity) -> AppResult<()> {
    if normalize_username(&user.username)? != user.username
        || validate_display_name(&user.display_name)? != user.display_name
        || !matches!(user.role.as_deref(), Some("admin" | "operator") | None)
    {
        return Err(AppError::Message("用户身份记录格式无效".into()));
    }
    Ok(())
}

pub(crate) fn normalize_username(value: &str) -> AppResult<String> {
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
        return Err(AppError::Message("用户身份记录格式无效".into()));
    }
    Ok(username)
}

fn validate_display_name(value: &str) -> AppResult<String> {
    let display_name = value.trim();
    let character_count = display_name.chars().count();
    if !(1..=40).contains(&character_count) || display_name.chars().any(char::is_control) {
        return Err(AppError::Message("用户身份记录格式无效".into()));
    }
    Ok(display_name.into())
}

#[cfg(test)]
mod tests {
    use super::{logout_account, validate_user_identity, AuthState};
    use crate::model::{UserIdentity, WorkspaceMode};

    #[test]
    fn delegated_management_retains_operator_identity_and_legacy_defaults() {
        let mut user: UserIdentity =
            serde_json::from_str(r#"{"username":"admin","displayName":"Test","role":"operator"}"#)
                .unwrap();
        assert!(!user.is_manager());
        user.can_manage = true;
        assert!(user.is_manager());
        assert_eq!(user.role.as_deref(), Some("operator"));
        let state = AuthState::default();
        assert!(state.require_managed_user().is_err());
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        state
            .set_managed_session(user.clone(), "test-token".into())
            .unwrap();
        assert!(state.require_managed_user().unwrap().is_manager());
        assert_eq!(state.require_managed_user().unwrap().username, "admin");
        logout_account(&state).unwrap();
        assert!(state.require_managed_user().is_err());
    }

    #[test]
    fn session_requires_login_and_clears_on_logout() {
        let state = AuthState::default();
        assert!(state.require_user().is_err());
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        let user = UserIdentity {
            can_manage: false,
            username: "operator.one".into(),
            display_name: "操作员一".into(),
            role: None,
        };
        validate_user_identity(&user).unwrap();
        state.set_user(Some(user.clone())).unwrap();
        assert_eq!(state.require_user().unwrap(), user);
        logout_account(&state).unwrap();
        assert!(state.current_user().unwrap().is_none());
    }

    #[test]
    fn offline_identity_has_local_access_but_never_managed_authority() {
        let state = AuthState::default();
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        state
            .set_user(Some(UserIdentity {
                can_manage: false,
                username: "operator.one".into(),
                display_name: "操作员一".into(),
                role: None,
            }))
            .unwrap();
        state
            .set_workspace_mode(Some(WorkspaceMode::Offline))
            .unwrap();
        assert_eq!(
            state.current_user().unwrap().unwrap().username,
            "offline.local"
        );
        assert_eq!(state.require_user().unwrap(), super::offline_identity());
        assert!(state.require_managed_user().is_err());
        assert!(state.managed_token().is_err());
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        assert!(state.require_user().is_err());
    }

    #[test]
    fn offline_status_ignores_missing_or_broken_config_and_uses_a_separate_store() {
        let root =
            std::env::temp_dir().join(format!("viewer-offline-auth-{}", getrandom::u32().unwrap()));
        std::fs::create_dir_all(&root).unwrap();
        let state = AuthState::default();
        state
            .set_workspace_mode(Some(WorkspaceMode::Offline))
            .unwrap();
        for config in [None, Some("not valid JSON")] {
            if let Some(config) = config {
                std::fs::write(root.join("user-center.json"), config).unwrap();
            }
            let status = crate::user_center::auth_status(&root, &state).unwrap();
            assert!(!status.user_center.configured);
            assert!(status.user_center.endpoint.is_none());
            assert_eq!(status.current_user.unwrap(), super::offline_identity());
        }
        assert_eq!(state.data_root(&root).unwrap(), root.join("offline-local"));
        assert!(state.require_managed_user().is_err());
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        assert_eq!(state.data_root(&root).unwrap(), root);
        assert!(state.current_user().unwrap().is_none());
        assert!(crate::user_center::auth_status(&root, &state).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_invalid_identity() {
        assert!(validate_user_identity(&UserIdentity {
            can_manage: false,
            username: "../operator".into(),
            display_name: "Operator".into(),
            role: None,
        })
        .is_err());
    }

    #[test]
    fn managed_snapshot_keeps_identity_and_token_together_during_account_changes() {
        let state = AuthState::default();
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        let writer = state.clone();
        let thread = std::thread::spawn(move || {
            for index in 0..1000 {
                let username = format!("reviewer{index}");
                writer
                    .set_managed_session(
                        UserIdentity {
                            can_manage: false,
                            username: username.clone(),
                            display_name: username.clone(),
                            role: Some("operator".into()),
                        },
                        username,
                    )
                    .unwrap();
            }
        });
        for _ in 0..1000 {
            if let Ok((user, token)) = state.managed_session() {
                assert_eq!(user.username, token);
            }
        }
        thread.join().unwrap();
        logout_account(&state).unwrap();
        assert!(state.managed_session().is_err());
    }
}
