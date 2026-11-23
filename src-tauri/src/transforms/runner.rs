//! Subprocess runner for one transform invocation (contract v1, see CLAUDE.md).

use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::manifest::ManifestEntry;
use crate::error::{AppError, AppResult};
use crate::model::EntityType;

pub const INPUT_REF: &str = "$input";
/// Environment variables passed through to transforms; everything else is cleared.
const ENV_PASSTHROUGH: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "USERPROFILE", "APPDATA"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputEntity {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type")]
    pub entity_type: EntityType,
    pub value: String,
    #[serde(default)]
    pub properties: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransformRequest {
    pub contract_version: u32,
    pub transform_id: String,
    pub entity: InputEntity,
    pub params: Map<String, Value>,
}

impl TransformRequest {
    pub fn new(transform_id: &str, entity: InputEntity, params: Map<String, Value>) -> Self {
        Self { contract_version: crate::TRANSFORM_CONTRACT_VERSION, transform_id: transform_id.into(), entity, params }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutputEntity {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(rename = "type")]
    pub entity_type: EntityType,
    pub value: String,
    #[serde(default)]
    pub properties: Map<String, Value>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutputEdge {
    pub source: String,
    pub target: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutputMessage {
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransformResponse {
    pub contract_version: u32,
    pub entities: Vec<OutputEntity>,
    /// Always present after validation (defaults to `$input --related_to--> each entity`).
    #[serde(default)]
    pub edges: Vec<OutputEdge>,
    #[serde(default)]
    pub messages: Vec<OutputMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl TransformResponse {
    /// Parse and validate stdout. Fills default edges when the transform sent none.
    pub fn parse(stdout: &[u8]) -> AppResult<Self> {
        let raw: Value = serde_json::from_slice(stdout)
            .map_err(|e| AppError::InvalidInput(format!("transform output is not valid JSON: {e}")))?;
        let had_edges = raw.get("edges").is_some();
        let mut resp: TransformResponse = serde_json::from_value(raw)
            .map_err(|e| AppError::InvalidInput(format!("transform output does not match contract v1: {e}")))?;
        if resp.contract_version != crate::TRANSFORM_CONTRACT_VERSION {
            return Err(AppError::InvalidInput(format!("unsupported contract_version {}", resp.contract_version)));
        }
        let mut refs = HashSet::new();
        for e in &resp.entities {
            if e.reference.is_empty() || e.reference == INPUT_REF || !refs.insert(e.reference.as_str()) {
                return Err(AppError::InvalidInput(format!("invalid or duplicate entity ref {:?}", e.reference)));
            }
            if e.value.trim().is_empty() {
                return Err(AppError::InvalidInput(format!("entity {} has an empty value", e.reference)));
            }
        }
        for edge in &resp.edges {
            let known = |r: &str| r == INPUT_REF || refs.contains(r);
            if !known(&edge.source) || !known(&edge.target) {
                return Err(AppError::InvalidInput(format!("edge {}→{} references an unknown ref", edge.source, edge.target)));
            }
            let valid_label = edge.label.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && edge.label.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            if !valid_label {
                return Err(AppError::InvalidInput(format!("invalid edge label {:?}", edge.label)));
            }
        }
        if !had_edges {
            resp.edges = resp
                .entities
                .iter()
                .map(|e| OutputEdge { source: INPUT_REF.into(), target: e.reference.clone(), label: "related_to".into() })
                .collect();
        }
        Ok(resp)
    }
}

pub struct RunOptions {
    pub max_stdout: usize,
    /// Extra environment for the child (e.g. `OSINT_PROXY`), added after the env is cleared.
    pub env: Vec<(String, String)>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self { max_stdout: 16 * 1024 * 1024, env: Vec::new() }
    }
}

/// Validate a proxy URL from the UI: `http(s)://` or `socks5(h)://`, optional `user:pass@`, host and port.
pub fn validate_proxy(raw: &str) -> AppResult<String> {
    let url = raw.trim();
    let bad = || AppError::InvalidInput(format!("invalid proxy URL {url:?}; expected e.g. socks5h://127.0.0.1:9050 or http://proxy:8080"));
    let (scheme, rest) = url.split_once("://").ok_or_else(bad)?;
    if !["http", "https", "socks5", "socks5h"].contains(&scheme) || rest.contains(char::is_whitespace) {
        return Err(bad());
    }
    let host_port = rest.rsplit_once('@').map_or(rest, |(_, hp)| hp).trim_end_matches('/');
    let (host, port) = host_port.rsplit_once(':').ok_or_else(bad)?;
    if host.is_empty() || host.contains('/') || port.parse::<u16>().map_or(true, |p| p == 0) {
        return Err(bad());
    }
    Ok(url.to_owned())
}

fn program(cmd: &str) -> &str {
    // Windows installs Python as `python`, not `python3`.
    if cfg!(windows) && cmd == "python3" {
        "python"
    } else {
        cmd
    }
}

pub async fn run(
    entry: &ManifestEntry,
    dir: &Path,
    request: &TransformRequest,
    opts: &RunOptions,
    on_log: impl Fn(&str) + Send + Sync + 'static,
) -> AppResult<TransformResponse> {
    let mut cmd = Command::new(program(&entry.command[0]));
    cmd.args(&entry.command[1..])
        .current_dir(dir)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in ENV_PASSTHROUGH {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONDONTWRITEBYTECODE", "1");
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Storage(format!("could not start {} ({}): {e}", entry.id, entry.command[0])))?;

    let input = serde_json::to_vec(request)?;
    let mut stdin = child.stdin.take().ok_or_else(|| AppError::Storage("no stdin".into()))?;
    let mut stdout = child.stdout.take().ok_or_else(|| AppError::Storage("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::Storage("no stderr".into()))?;

    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            on_log(&line);
            tail.push(line);
            if tail.len() > 20 {
                tail.remove(0);
            }
        }
        tail
    });

    let max = opts.max_stdout;
    let work = async move {
        // Write the request and close stdin so the transform sees EOF. A transform that exits without
        // reading it closes the pipe early; its exit status and stderr say why, so don't mask them.
        if let Err(e) = stdin.write_all(&input).await {
            if e.kind() != std::io::ErrorKind::BrokenPipe {
                return Err(e);
            }
        }
        drop(stdin);
        let mut buf = Vec::new();
        let read = (&mut stdout).take(max as u64 + 1).read_to_end(&mut buf).await?;
        if read > max {
            // Over the cap: stop it now instead of letting it block on a full pipe until the timeout.
            let _ = child.start_kill();
        }
        drop(stdout);
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, buf, read))
    };

    let (status, buf, read) = match tokio::time::timeout(Duration::from_secs(entry.timeout_s), work).await {
        Ok(r) => r?,
        Err(_) => {
            stderr_task.abort();
            return Err(AppError::Timeout(format!("{} exceeded {}s", entry.id, entry.timeout_s)));
        }
    };
    let tail = stderr_task.await.unwrap_or_default();

    if read > max {
        return Err(AppError::InvalidInput(format!("{} wrote more than {} bytes to stdout", entry.id, max)));
    }
    if !status.success() {
        let last = tail.iter().rev().find(|l| !l.trim().is_empty()).cloned().unwrap_or_default();
        return Err(AppError::TransformFailed(format!(
            "{} exited with {}{}",
            entry.id,
            status.code().map_or("a signal".to_string(), |c| format!("code {c}")),
            if last.is_empty() { String::new() } else { format!(": {last}") }
        )));
    }
    TransformResponse::parse(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transforms::manifest::RateLimit;
    use std::sync::{Arc, Mutex};

    fn entry(script: &str, timeout_s: u64) -> ManifestEntry {
        ManifestEntry {
            id: "fixture".into(),
            name: "fixture".into(),
            description: String::new(),
            command: vec!["python3".into(), "-c".into(), script.into()],
            input_types: vec![EntityType::Domain],
            output_types: vec![],
            timeout_s,
            rate_limit: RateLimit::default(),
            requires_keys: vec![],
        }
    }

    fn request() -> TransformRequest {
        TransformRequest::new(
            "fixture",
            InputEntity { id: "x".into(), entity_type: EntityType::Domain, value: "example.com".into(), properties: Map::new() },
            Map::new(),
        )
    }

    async fn go(script: &str, timeout_s: u64) -> (AppResult<TransformResponse>, Vec<String>) {
        go_with(script, timeout_s, &request()).await
    }

    async fn go_with(script: &str, timeout_s: u64, req: &TransformRequest) -> (AppResult<TransformResponse>, Vec<String>) {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let l = logs.clone();
        let dir = std::env::temp_dir();
        let res = run(&entry(script, timeout_s), &dir, req, &RunOptions { max_stdout: 4096, env: vec![("OSINT_PROXY".into(), "socks5h://127.0.0.1:9050".into())] }, move |line| {
            l.lock().unwrap().push(line.to_string())
        })
        .await;
        let logs = logs.lock().unwrap().clone();
        (res, logs)
    }

    const ECHO: &str = r#"
import json, sys
req = json.load(sys.stdin)
print("working on " + req["entity"]["value"], file=sys.stderr)
print(json.dumps({"contract_version": 1, "entities": [{"ref": "a", "type": "IPv4", "value": "192.0.2.1"}], "data": {"seen": req["transform_id"]}}))
"#;

    #[tokio::test]
    async fn success_streams_stderr_and_defaults_edges() {
        let (res, logs) = go(ECHO, 10).await;
        let resp = res.unwrap();
        assert_eq!(resp.entities[0].value, "192.0.2.1");
        assert_eq!(resp.edges, vec![OutputEdge { source: "$input".into(), target: "a".into(), label: "related_to".into() }]);
        assert_eq!(resp.data.unwrap()["seen"], "fixture");
        assert_eq!(logs, vec!["working on example.com"]);
    }

    #[tokio::test]
    async fn bad_json_is_rejected() {
        let (res, _) = go("import sys; sys.stdin.read(); print('not json')", 10).await;
        assert!(matches!(res, Err(AppError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn non_zero_exit_reports_last_stderr_line() {
        let (res, _) = go("import sys; sys.stdin.read(); print('[error] boom', file=sys.stderr); sys.exit(3)", 10).await;
        match res {
            Err(AppError::TransformFailed(m)) => assert!(m.contains("code 3") && m.contains("boom"), "{m}"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn timeout_kills_the_process() {
        let (res, _) = go("import time; time.sleep(30)", 1).await;
        assert!(matches!(res, Err(AppError::Timeout(_))));
    }

    #[tokio::test]
    async fn stdout_cap_is_enforced() {
        let (res, _) = go("import sys; sys.stdin.read(); sys.stdout.write('x' * 10000)", 10).await;
        assert!(matches!(res, Err(AppError::InvalidInput(m)) if m.contains("more than")));
    }

    #[tokio::test]
    async fn stdout_overflow_fails_fast_instead_of_timing_out() {
        // Far more than the cap plus the OS pipe buffer: the child must be stopped, not waited on.
        let started = std::time::Instant::now();
        let (res, _) = go("import sys; sys.stdin.read(); sys.stdout.write('x' * 4_000_000)", 20).await;
        assert!(matches!(res, Err(AppError::InvalidInput(ref m)) if m.contains("more than")), "{res:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn exit_without_reading_stdin_reports_the_exit_code() {
        // An input larger than the pipe buffer makes the write fail once the child has exited.
        let mut props = Map::new();
        props.insert("blob".into(), Value::String("x".repeat(1_000_000)));
        let req = TransformRequest::new(
            "fixture",
            InputEntity { id: "x".into(), entity_type: EntityType::Domain, value: "example.com".into(), properties: props },
            Map::new(),
        );
        let (res, _) = go_with("import sys; print('[error] no input wanted', file=sys.stderr); sys.exit(4)", 10, &req).await;
        match res {
            Err(AppError::TransformFailed(m)) => assert!(m.contains("code 4") && m.contains("no input wanted"), "{m}"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn environment_is_cleared() {
        std::env::set_var("OSINT_TEST_SECRET", "leak");
        let script = r#"
import json, os, sys
sys.stdin.read()
v = os.environ.get("OSINT_TEST_SECRET", "absent")
print(json.dumps({"contract_version": 1, "entities": [], "data": {"secret": v, "has_path": "PATH" in os.environ, "proxy": os.environ.get("OSINT_PROXY")}}))
"#;
        let (res, _) = go(script, 10).await;
        let data = res.unwrap().data.unwrap();
        assert_eq!(data["secret"], "absent");
        assert_eq!(data["has_path"], true);
        assert_eq!(data["proxy"], "socks5h://127.0.0.1:9050"); // explicit extra env is passed
    }

    #[test]
    fn validates_proxy_urls() {
        for ok in ["socks5h://127.0.0.1:9050", "socks5://user:pass@10.0.0.2:1080", "http://proxy.local:8080", "https://p:443/"] {
            assert!(validate_proxy(ok).is_ok(), "{ok}");
        }
        for bad in ["127.0.0.1:9050", "ftp://x:21", "socks5h://127.0.0.1", "socks5h://:9050", "http://a b:80", "socks5h://h:0", "socks5h://h:99999"] {
            assert!(validate_proxy(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_unknown_refs_and_bad_labels() {
        let bad_ref = br#"{"contract_version":1,"entities":[],"edges":[{"source":"$input","target":"zz","label":"x"}]}"#;
        assert!(TransformResponse::parse(bad_ref).is_err());
        let bad_label = br#"{"contract_version":1,"entities":[{"ref":"a","type":"Domain","value":"x.com"}],"edges":[{"source":"$input","target":"a","label":"Bad Label"}]}"#;
        assert!(TransformResponse::parse(bad_label).is_err());
        let bad_type = br#"{"contract_version":1,"entities":[{"ref":"a","type":"Planet","value":"Mars"}]}"#;
        assert!(TransformResponse::parse(bad_type).is_err());
    }
}
