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

    pub fn require_user(&self) -> AppResult<UserIdentity> {
        match self.workspace_mode()? {
            Some(WorkspaceMode::Offline) => Err(AppError::Message(
                "AUTH_REQUIRED: 离线模式已停用，请登录用户中心账号".into(),
            )),
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

    pub(crate) fn set_workspace_mode(&self, mode: Option<WorkspaceMode>) -> AppResult<()> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| AppError::Message("工作模式会话不可用".into()))?;
        session.workspace_mode = mode;
        session.current_user = None;
        session.user_center_token = None;
        Ok(())
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
    fn session_requires_login_and_clears_on_logout() {
        let state = AuthState::default();
        assert!(state.require_user().is_err());
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        let user = UserIdentity {
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
    fn offline_mode_cannot_bypass_login() {
        let state = AuthState::default();
        state
            .set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        state
            .set_user(Some(UserIdentity {
                username: "operator.one".into(),
                display_name: "操作员一".into(),
                role: None,
            }))
            .unwrap();
        state
            .set_workspace_mode(Some(WorkspaceMode::Offline))
            .unwrap();
        assert_eq!(state.current_user().unwrap(), None);
        assert!(state.require_user().is_err());
        assert!(state.require_managed_user().is_err());
    }

    #[test]
    fn rejects_invalid_identity() {
        assert!(validate_user_identity(&UserIdentity {
            username: "../operator".into(),
            display_name: "Operator".into(),
            role: None,
        })
        .is_err());
    }
}
