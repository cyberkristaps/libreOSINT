//! `transforms/manifest.json` registry (see `schema/manifest.schema.json`).

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::model::EntityType;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RateLimit {
    #[serde(default = "one")]
    pub max_concurrent: u32,
    #[serde(default)]
    pub min_interval_ms: u64,
}

fn one() -> u32 {
    1
}

impl Default for RateLimit {
    fn default() -> Self {
        Self { max_concurrent: 1, min_interval_ms: 0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub command: Vec<String>,
    pub input_types: Vec<EntityType>,
    #[serde(default)]
    pub output_types: Vec<EntityType>,
    pub timeout_s: u64,
    #[serde(default)]
    pub rate_limit: RateLimit,
    #[serde(default)]
    pub requires_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub contract_version: u32,
    pub transforms: Vec<ManifestEntry>,
}

impl Manifest {
    pub fn load(path: &Path) -> AppResult<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| AppError::NotFound(format!("{}: {e}", path.display())))?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> AppResult<Self> {
        let m: Manifest = serde_json::from_str(text)?;
        if m.contract_version != crate::TRANSFORM_CONTRACT_VERSION {
            return Err(AppError::InvalidInput(format!(
                "manifest contract_version {} is not supported",
                m.contract_version
            )));
        }
        let mut ids = HashSet::new();
        for t in &m.transforms {
            let valid_id = t.id.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && t.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            if !valid_id {
                return Err(AppError::InvalidInput(format!("invalid transform id {:?}", t.id)));
            }
            if !ids.insert(t.id.as_str()) {
                return Err(AppError::InvalidInput(format!("duplicate transform id {}", t.id)));
            }
            if t.command.is_empty() || t.input_types.is_empty() || t.timeout_s == 0 || t.timeout_s > 3600 {
                return Err(AppError::InvalidInput(format!("transform {} has an invalid command, input_types or timeout", t.id)));
            }
        }
        Ok(m)
    }

    pub fn get(&self, id: &str) -> Option<&ManifestEntry> {
        self.transforms.iter().find(|t| t.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_manifest_is_valid() {
        let m = Manifest::parse(include_str!("../../../transforms/manifest.json")).unwrap();
        for id in ["domain_to_dns", "domain_to_crtsh", "ip_to_rdap", "url_to_headers", "web_search", "fetch_page_text"] {
            assert!(m.get(id).is_some(), "{id} missing");
        }
    }

    #[test]
    fn rejects_duplicates_and_bad_ids() {
        let entry = r#"{"id":"x_y","name":"n","command":["true"],"input_types":["Domain"],"timeout_s":5}"#;
        let dup = format!(r#"{{"contract_version":1,"transforms":[{entry},{entry}]}}"#);
        assert!(Manifest::parse(&dup).is_err());
        let bad = r#"{"contract_version":1,"transforms":[{"id":"Bad-Id","name":"n","command":["true"],"input_types":["Domain"],"timeout_s":5}]}"#;
        assert!(Manifest::parse(bad).is_err());
    }
}
