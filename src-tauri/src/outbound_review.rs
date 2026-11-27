use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use crate::outbound_media::OutboundMediaServer;
use serde_json::Value;
use std::path::Path;

pub async fn call(
    data: &Path,
    auth: &AuthState,
    media: Option<&OutboundMediaServer>,
    mut input: Value,
) -> AppResult<Value> {
    let action = input["action"]
        .as_str()
        .ok_or_else(|| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?
        .to_owned();
    if matches!(
        action.as_str(),
        "media-cache" | "media-cache-pause" | "media-cache-status" | "media-cache-clear"
    ) {
        let media = media
            .ok_or_else(|| AppError::Message("OUTBOUND_MEDIA_TRANSPORT_UNAVAILABLE".into()))?;
        auth.managed_session()?;
        if action == "media-cache-pause" {
            media.pause_prefetch();
            return Ok(serde_json::json!({}));
        }
        if action == "media-cache" {
            let videos = serde_json::from_value(input["videos"].take())
                .map_err(|_| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?;
            media.prefetch(data.to_path_buf(), auth, videos)?;
            return Ok(serde_json::json!({}));
        }
        let media = media.clone();
        let data = data.to_path_buf();
        let status = tokio::task::spawn_blocking(move || {
            media.cache_status(&data, action == "media-cache-clear")
        })
        .await
        .map_err(|_| AppError::Message("OUTBOUND_CACHE_UNAVAILABLE".into()))??;
        return Ok(serde_json::json!(status));
    }
    if matches!(action.as_str(), "media-metadata" | "media-frame-step") {
        if input.as_object().is_none_or(|object| object.len() != 2) {
            return Err(AppError::Message("OUTBOUND_REQUEST_INVALID".into()));
        }
        let url = input["url"]
            .as_str()
            .ok_or_else(|| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?;
        let media = media
            .ok_or_else(|| AppError::Message("OUTBOUND_MEDIA_TRANSPORT_UNAVAILABLE".into()))?;
        if action == "media-frame-step" {
            return Ok(serde_json::json!({"frameStep":media.frame_step(auth,url).await?}));
        }
        let duration = media.metadata(auth, url).await?;
        return Ok(serde_json::json!({"duration":duration}));
    }
    if action == "media-status" {
        if input.as_object().is_none_or(|object| object.len() != 2) {
            return Err(AppError::Message("OUTBOUND_REQUEST_INVALID".into()));
        }
        let url = input["url"]
            .as_str()
            .ok_or_else(|| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?;
        let code = media
            .ok_or_else(|| AppError::Message("OUTBOUND_MEDIA_TRANSPORT_UNAVAILABLE".into()))?
            .status(auth, url)?;
        return Ok(serde_json::json!({"code":code}));
    }
    if action == "release-media" {
        if input.as_object().is_none_or(|object| object.len() != 2) {
            return Err(AppError::Message("OUTBOUND_REQUEST_INVALID".into()));
        }
        let urls: Vec<String> = serde_json::from_value(input["urls"].clone())
            .map_err(|_| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?;
        media
            .ok_or_else(|| AppError::Message("OUTBOUND_MEDIA_TRANSPORT_UNAVAILABLE".into()))?
            .release(auth, &urls)?;
        return Ok(serde_json::json!({"released":true}));
    }
    if !matches!(
        action.as_str(),
        "list"
            | "claim"
            | "release"
            | "decide"
            | "video-url"
            | "save-reason-option"
            | "trim"
            | "trim-status"
            | "trim-resume"
    ) {
        return Err(AppError::Message("OUTBOUND_REQUEST_INVALID".into()));
    }
    let video = action == "video-url";
    // A local scheduling hint only: never forward it to the delivery service
    // or use it to choose an upstream object or bypass its authorization.
    let lane = if video {
        match input
            .as_object_mut()
            .and_then(|object| object.remove("mediaLane"))
        {
            None => 0,
            Some(value) => value
                .as_u64()
                .filter(|lane| *lane < crate::media_origins::CAMERA_COUNT as u64)
                .ok_or_else(|| AppError::Message("OUTBOUND_REQUEST_INVALID".into()))?
                as usize,
        }
    } else {
        0
    };
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
    Ok(serde_json::json!({"url": media.register(auth, session, url, lane)?}))
}
