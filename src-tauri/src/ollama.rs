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
    if rest.is_empty() || rest.contains(|c: char| c.is_whitespace() || c == '?' || c == '#') {
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
    let body = read_json(resp, &base, "/api/tags").await?;
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
    let Some(obj) = body.as_object_mut() else {
        return Err(AppError::InvalidInput("Ollama chat request must be a JSON object".into()));
    };
    obj.insert("stream".into(), Value::Bool(false));
    let resp = client(Duration::from_secs(600))?
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| unreachable(&base, e))?;
    read_json(resp, &base, "/api/chat").await
}

/// The status decides first: an error page from a proxy or the wrong port is reported as its HTTP
/// status, not as a JSON decode error.
async fn read_json(resp: reqwest::Response, base: &str, path: &str) -> AppResult<Value> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| unreachable(base, e))?;
    let json = serde_json::from_str::<Value>(&text).ok();
    if !status.is_success() {
        let detail = json
            .as_ref()
            .and_then(|j| j["error"].as_str().map(str::to_owned))
            .unwrap_or_else(|| text.trim().chars().take(200).collect());
        let detail = if detail.is_empty() { "no details".to_owned() } else { detail };
        return Err(AppError::Unavailable(format!("Ollama {path} returned HTTP {status}: {detail}")));
    }
    json.ok_or_else(|| AppError::Unavailable(format!("{base}{path} did not answer with JSON — is that the Ollama port?")))
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
        assert!(base_url("http://127.0.0.1:11434/?x=1").is_err());
        assert!(base_url("http://127.0.0.1:11434#frag").is_err());
    }

    /// One-shot HTTP server that answers every request with `response`.
    async fn serve(response: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn non_json_error_pages_report_the_http_status() {
        let base = serve("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: 22\r\nConnection: close\r\n\r\n<html>upstream x</html").await;
        let err = models(&base).await.unwrap_err();
        assert!(matches!(err, AppError::Unavailable(ref m) if m.contains("502") && m.contains("upstream")), "{err}");
    }

    #[tokio::test]
    async fn ollama_errors_keep_their_message() {
        let base = serve("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 27\r\nConnection: close\r\n\r\n{\"error\":\"model not found\"}").await;
        let err = chat(&base, serde_json::json!({"model": "x"})).await.unwrap_err();
        assert!(matches!(err, AppError::Unavailable(ref m) if m.contains("404") && m.contains("model not found")), "{err}");
    }

    #[tokio::test]
    async fn chat_body_must_be_an_object() {
        let err = chat("http://127.0.0.1:9", serde_json::json!([1, 2])).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "{err}");
    }

    #[tokio::test]
    async fn unreachable_server_is_a_clear_error() {
        // Port 9 (discard) is essentially never an HTTP server.
        let err = models("http://127.0.0.1:9").await.unwrap_err();
        assert!(matches!(err, AppError::Unavailable(ref m) if m.contains("is it running")), "{err}");
    }
}
