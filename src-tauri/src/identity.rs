use crate::error::{AppError, AppResult};
use crate::model::UserIdentity;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct AuthState {
    current_user: Arc<Mutex<Option<UserIdentity>>>,
}

impl AuthState {
    pub fn current_user(&self) -> AppResult<Option<UserIdentity>> {
        self.current_user
            .lock()
            .map(|current| current.clone())
            .map_err(|_| AppError::Message("用户中心登录会话不可用".into()))
    }

    pub fn require_user(&self) -> AppResult<UserIdentity> {
        self.current_user()?
            .ok_or_else(|| AppError::Message("AUTH_REQUIRED: 请先登录用户中心账号".into()))
    }

    pub(crate) fn set_user(&self, user: Option<UserIdentity>) -> AppResult<()> {
        let mut current = self
            .current_user
            .lock()
            .map_err(|_| AppError::Message("用户中心登录会话不可用".into()))?;
        *current = user;
        Ok(())
    }
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
    use crate::model::UserIdentity;

    #[test]
    fn session_requires_login_and_clears_on_logout() {
        let state = AuthState::default();
        assert!(state.require_user().is_err());
        let user = UserIdentity {
            username: "operator.one".into(),
            display_name: "操作员一".into(),
        };
        validate_user_identity(&user).unwrap();
        state.set_user(Some(user.clone())).unwrap();
        assert_eq!(state.require_user().unwrap(), user);
        logout_account(&state).unwrap();
        assert!(state.current_user().unwrap().is_none());
    }

    #[test]
    fn rejects_invalid_identity() {
        assert!(validate_user_identity(&UserIdentity {
            username: "../operator".into(),
            display_name: "Operator".into(),
        })
        .is_err());
    }
}
