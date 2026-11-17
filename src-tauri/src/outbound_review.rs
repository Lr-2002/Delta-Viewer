use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use crate::outbound_media::OutboundMediaServer;
use serde_json::Value;
use std::path::Path;

pub async fn call(
    data: &Path,
    auth: &AuthState,
    media: Option<&OutboundMediaServer>,
    input: Value,
) -> AppResult<Value> {
    let action = input["action"]
        .as_str()
        .ok_or_else(|| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?;
    if !matches!(
        action,
        "list" | "claim" | "release" | "decide" | "video-url" | "save-reason-option"
    ) {
        return Err(AppError::Message("OUTBOUND_REQUEST_INVALID".into()));
    }
    let video = action == "video-url";
    let session = auth.managed_session()?;
    let result = crate::user_center::outbound_review_request(data, auth, input).await?;
    if !video {
        return Ok(result);
    }
    let media =
        media.ok_or_else(|| AppError::Message("OUTBOUND_MEDIA_TRANSPORT_UNAVAILABLE".into()))?;
    let url = result["url"]
        .as_str()
        .ok_or_else(|| AppError::Message("OUTBOUND_VIDEO_URL_INVALID".into()))?;
    Ok(serde_json::json!({"url": media.register(auth, session, url)?}))
}
