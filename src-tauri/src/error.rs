use std::io;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("路径不存在: {0}")]
    MissingPath(String),
    #[error("目录中未发现 DOHC 记录: {0}")]
    NoEpisodes(String),
    #[error("无效的数据流: {0}")]
    InvalidStream(String),
    #[error("任务已取消")]
    Cancelled,
    #[error("I/O 错误: {0}")]
    Io(#[from] io::Error),
    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("图像错误: {0}")]
    Image(#[from] image::ImageError),
    #[error("{0}")]
    Message(String),
}

pub type AppResult<T> = Result<T, AppError>;
