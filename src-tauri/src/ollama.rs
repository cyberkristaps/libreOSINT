//! Thin proxy to a local Ollama server (`/api/tags`, `/api/chat`).
//!
//! Requests go through Rust rather than the webview so they are not subject to CORS / CSP and can
//! be cancelled via [`crate::jobs::Jobs`]. Only http(s) base URLs are accepted.

use std::time::Duration;

use serde_json::Value;

use crate::error::{AppError, AppResult};

pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

pub fn base_url(raw: &str) -> AppResult<String> {
    let url = raw.trim().trim_end_matches('/');
    let url = if url.is_empty() { DEFAULT_BASE_URL } else { url };
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| AppError::InvalidInput(format!("Ollama URL must start with http:// or https:// (got {url:?})")))?;
    if rest.is_empty() || rest.contains(char::is_whitespace) {
        return Err(AppError::InvalidInput(format!("invalid Ollama URL {url:?}")));
    }
    Ok(url.to_owned())
}

fn client(timeout: Duration) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| AppError::Storage(format!("http client: {e}")))
}

fn unreachable(base: &str, e: reqwest::Error) -> AppError {
    if e.is_connect() {
        AppError::Unavailable(format!("cannot reach Ollama at {base} — is it running? (`ollama serve`)"))
    } else if e.is_timeout() {
        AppError::Timeout(format!("Ollama at {base} did not answer in time"))
    } else {
        AppError::Unavailable(format!("Ollama request failed: {e}"))
    }
}

/// Names of locally installed models (`GET /api/tags`).
pub async fn models(raw_base: &str) -> AppResult<Vec<String>> {
    let base = base_url(raw_base)?;
    let resp = client(Duration::from_secs(10))?
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|e| unreachable(&base, e))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| unreachable(&base, e))?;
    if !status.is_success() {
        return Err(AppError::Unavailable(format!("Ollama /api/tags returned HTTP {status}")));
    }
    let mut names: Vec<String> = body["models"]
        .as_array()
        .map(|ms| ms.iter().filter_map(|m| m["name"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

/// One non-streaming `POST /api/chat` round. `body` is the Ollama request (model, messages, tools, options).
pub async fn chat(raw_base: &str, mut body: Value) -> AppResult<Value> {
    let base = base_url(raw_base)?;
    body["stream"] = Value::Bool(false);
    let resp = client(Duration::from_secs(600))?
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| unreachable(&base, e))?;
    let status = resp.status();
    let json: Value = resp.json().await.map_err(|e| unreachable(&base, e))?;
    if !status.is_success() {
        let msg = json["error"].as_str().unwrap_or("unknown error");
        return Err(AppError::Unavailable(format!("Ollama returned HTTP {status}: {msg}")));
    }
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_base_url() {
        assert_eq!(base_url("").unwrap(), DEFAULT_BASE_URL);
        assert_eq!(base_url(" http://127.0.0.1:11434/ ").unwrap(), "http://127.0.0.1:11434");
        assert!(base_url("file:///etc/passwd").is_err());
        assert!(base_url("localhost:11434").is_err());
    }

    #[tokio::test]
    async fn unreachable_server_is_a_clear_error() {
        // Port 9 (discard) is essentially never an HTTP server.
        let err = models("http://127.0.0.1:9").await.unwrap_err();
        assert!(matches!(err, AppError::Unavailable(ref m) if m.contains("is it running")), "{err}");
    }
}
