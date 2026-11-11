use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use serde_json::Value;
use std::path::Path;

pub async fn call(data: &Path, auth: &AuthState, input: Value) -> AppResult<Value> {
    let action = input["action"]
        .as_str()
        .ok_or_else(|| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?;
    if !matches!(
        action,
        "list" | "claim" | "release" | "decide" | "video-url" | "save-reason-option"
    ) {
        return Err(AppError::Message("OUTBOUND_REQUEST_INVALID".into()));
    }
    crate::user_center::outbound_review_request(data, auth, input).await
}
