//! `#[tauri::command]` functions exposed to the Angular UI via `TauriBridge`.

use serde::Serialize;

use std::path::PathBuf;

use serde_json::{Map, Value};
use tauri::{Emitter, State};

use crate::error::{AppError, AppResult};
use crate::jobs::Jobs;
use crate::storage::{self, CaseSnapshot};
use crate::transforms::{InputEntity, ManifestEntry, TransformEngine, TransformResponse};

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub contract_version: u32,
}

#[tauri::command]
pub fn app_info() -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: "libreOSINT",
        version: env!("CARGO_PKG_VERSION"),
        contract_version: crate::TRANSFORM_CONTRACT_VERSION,
    })
}

/// Load a `.case` file. Runs on a blocking thread so SQLite I/O never stalls the UI.
#[tauri::command]
pub async fn case_open(path: PathBuf) -> AppResult<CaseSnapshot> {
    tauri::async_runtime::spawn_blocking(move || storage::load(&path))
        .await
        .map_err(|e| AppError::Storage(format!("load task failed: {e}")))?
}

/// Write the whole graph to a `.case` file (atomic replace).
#[tauri::command]
pub async fn case_save(path: PathBuf, snapshot: CaseSnapshot) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || storage::save(&path, &snapshot))
        .await
        .map_err(|e| AppError::Storage(format!("save task failed: {e}")))?
}

/// Registered transforms (from `transforms/manifest.json`).
#[tauri::command]
pub fn transform_list(engine: State<'_, std::sync::Arc<TransformEngine>>) -> AppResult<Vec<ManifestEntry>> {
    Ok(engine.manifest()?.transforms.clone())
}

#[derive(Clone, Serialize)]
struct TransformLog {
    job_id: String,
    transform_id: String,
    line: String,
}

/// Run a transform as a cancellable job. stderr lines are emitted as `transform://log` events.
// Each parameter is one named IPC argument; bundling them into a struct would change the JS call shape.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn transform_run(
    app: tauri::AppHandle,
    engine: State<'_, std::sync::Arc<TransformEngine>>,
    jobs: State<'_, Jobs>,
    job_id: String,
    transform_id: String,
    entity: InputEntity,
    params: Option<Map<String, Value>>,
    proxy: Option<String>,
) -> AppResult<TransformResponse> {
    let engine = engine.inner().clone();
    let (jid, tid) = (job_id.clone(), transform_id.clone());
    jobs.run(&job_id, async move {
        let on_log = move |line: &str| {
            let _ = app.emit("transform://log", TransformLog { job_id: jid.clone(), transform_id: tid.clone(), line: line.to_owned() });
        };
        engine.run(&transform_id, entity, params.unwrap_or_default(), proxy, on_log).await
    })
    .await
}

/// Which public IP lookups would come from with this proxy.
#[tauri::command]
pub async fn network_check(engine: State<'_, std::sync::Arc<TransformEngine>>, proxy: Option<String>) -> AppResult<Value> {
    let resp = engine.network_check(proxy).await?;
    Ok(resp.data.unwrap_or(Value::Null))
}

/// Cancel a running transform or Ollama request. Returns false if it already finished.
#[tauri::command]
pub fn job_cancel(jobs: State<'_, Jobs>, job_id: String) -> bool {
    jobs.cancel(&job_id)
}

#[tauri::command]
pub async fn ollama_models(base_url: String) -> AppResult<Vec<String>> {
    crate::ollama::models(&base_url).await
}

/// One `/api/chat` round as a cancellable job.
#[tauri::command]
pub async fn ollama_chat(jobs: State<'_, Jobs>, job_id: String, base_url: String, body: Value) -> AppResult<Value> {
    jobs.run(&job_id, async move { crate::ollama::chat(&base_url, body).await }).await
}
