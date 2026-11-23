use serde::{Serialize, Serializer};

/// Error type returned by every Tauri command. Serializes to `{ "kind": "...", "message": "..." }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("cancelled")]
    Cancelled,
    #[error("timed out: {0}")]
    Timeout(String),
    #[error("transform failed: {0}")]
    TransformFailed(String),
    #[error("{0}")]
    Unavailable(String),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::InvalidInput(_) => "invalid_input",
            AppError::NotFound(_) => "not_found",
            AppError::Io(_) => "io",
            AppError::Storage(_) => "storage",
            AppError::Json(_) => "json",
            AppError::Cancelled => "cancelled",
            AppError::Timeout(_) => "timeout",
            AppError::TransformFailed(_) => "transform_failed",
            AppError::Unavailable(_) => "unavailable",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
