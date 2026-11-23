//! Transform engine: manifest registry, subprocess runner (JSON over stdin/stdout, contract v1 in
//! CLAUDE.md) and per-transform rate limiting.

pub mod manifest;
pub mod runner;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, Semaphore};

pub use manifest::{Manifest, ManifestEntry};
pub use runner::{InputEntity, TransformRequest, TransformResponse};

use crate::error::{AppError, AppResult};

fn run_options(proxy: Option<String>) -> AppResult<runner::RunOptions> {
    let mut opts = runner::RunOptions::default();
    if let Some(p) = proxy.filter(|p| !p.trim().is_empty()) {
        opts.env.push(("OSINT_PROXY".into(), runner::validate_proxy(&p)?));
    }
    Ok(opts)
}

/// Shared state managed by Tauri.
pub struct TransformEngine {
    pub dir: PathBuf,
    manifest: Result<Manifest, String>,
    limits: Mutex<HashMap<String, Arc<Limiter>>>,
}

struct Limiter {
    slots: Semaphore,
    min_interval: Duration,
    last_start: Mutex<Option<Instant>>,
}

impl TransformEngine {
    pub fn load(dir: PathBuf) -> Self {
        let manifest = Manifest::load(&dir.join("manifest.json")).map_err(|e| e.to_string());
        Self { dir, manifest, limits: Mutex::new(HashMap::new()) }
    }

    pub fn manifest(&self) -> AppResult<&Manifest> {
        self.manifest
            .as_ref()
            .map_err(|e| AppError::Storage(format!("transform manifest unavailable: {e}")))
    }

    /// Run a transform, honouring its `rate_limit`. `on_log` receives each stderr line.
    pub async fn run(
        &self,
        transform_id: &str,
        entity: InputEntity,
        params: serde_json::Map<String, serde_json::Value>,
        proxy: Option<String>,
        on_log: impl Fn(&str) + Send + Sync + 'static,
    ) -> AppResult<TransformResponse> {
        let opts = run_options(proxy)?;
        let entry = self
            .manifest()?
            .get(transform_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("transform {transform_id}")))?;
        if !entry.input_types.contains(&entity.entity_type) {
            return Err(AppError::InvalidInput(format!(
                "{} does not accept {} input",
                entry.id,
                entity.entity_type.as_str()
            )));
        }
        if !entry.requires_keys.is_empty() {
            // The keychain vault lands with the rest of Phase 3.
            return Err(AppError::InvalidInput(format!(
                "{} needs API keys ({}); the key vault is not implemented yet",
                entry.id,
                entry.requires_keys.join(", ")
            )));
        }

        let limiter = self.limiter(&entry).await;
        let _slot = limiter
            .slots
            .acquire()
            .await
            .map_err(|_| AppError::Storage("rate limiter closed".into()))?;
        {
            let mut last = limiter.last_start.lock().await;
            if let Some(prev) = *last {
                let wait = limiter.min_interval.saturating_sub(prev.elapsed());
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
            }
            *last = Some(Instant::now());
        }

        let request = TransformRequest::new(&entry.id, entity, params);
        runner::run(&entry, &self.dir, &request, &opts, on_log).await
    }

    /// Settings ▸ Test connection: run `net_check.py` (not a registered lookup) with the given proxy.
    pub async fn network_check(&self, proxy: Option<String>) -> AppResult<TransformResponse> {
        let opts = run_options(proxy)?;
        let entry = ManifestEntry {
            id: "net_check".into(),
            name: "Network check".into(),
            description: String::new(),
            command: vec!["python3".into(), "net_check.py".into()],
            input_types: vec![crate::model::EntityType::Url],
            output_types: vec![],
            timeout_s: 40,
            rate_limit: Default::default(),
            requires_keys: vec![],
        };
        let entity = InputEntity {
            id: String::new(),
            entity_type: crate::model::EntityType::Url,
            value: "https://api.ipify.org".into(),
            properties: Default::default(),
        };
        let request = TransformRequest::new("net_check", entity, Default::default());
        runner::run(&entry, &self.dir, &request, &opts, |_| {}).await
    }

    async fn limiter(&self, entry: &ManifestEntry) -> Arc<Limiter> {
        let mut map = self.limits.lock().await;
        map.entry(entry.id.clone())
            .or_insert_with(|| {
                Arc::new(Limiter {
                    slots: Semaphore::new(entry.rate_limit.max_concurrent.max(1) as usize),
                    min_interval: Duration::from_millis(entry.rate_limit.min_interval_ms),
                    last_start: Mutex::new(None),
                })
            })
            .clone()
    }
}
