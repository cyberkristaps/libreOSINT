//! `.case` persistence: one SQLite file per investigation (rusqlite, bundled).
//!
//! Saving is snapshot-based: the UI sends the whole graph, which is written to a temporary file
//! in the same directory and atomically renamed over the target, so a crash never leaves a
//! half-written case. Dedup rules are enforced by `UNIQUE` indexes (see CLAUDE.md).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::model::{normalize_value, Edge, Entity, EntityType};

pub const CASE_FORMAT: &str = "libre-osint-case";
pub const CASE_FORMAT_VERSION: u32 = 1;
/// SQLite `PRAGMA user_version` of the current schema.
/// v1: meta, entities, edges. v2: + chat_messages.
const SCHEMA_VERSION: i64 = 2;
pub const CASE_EXTENSION: &str = "case";

const SCHEMA_V1: &str = "
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE entities (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    value       TEXT NOT NULL,
    value_norm  TEXT NOT NULL,
    properties  TEXT NOT NULL DEFAULT '{}',
    notes       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    x           REAL,
    y           REAL,
    UNIQUE (type, value_norm)
);
CREATE TABLE edges (
    id               TEXT PRIMARY KEY,
    source_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    label            TEXT NOT NULL,
    transform_source TEXT NOT NULL,
    timestamp        TEXT NOT NULL,
    UNIQUE (source_id, target_id, label)
);
CREATE INDEX edges_target ON edges(target_id);
";

const SCHEMA_V2: &str = "
CREATE TABLE chat_messages (
    id         TEXT PRIMARY KEY,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT 'null',
    created_at TEXT NOT NULL
);
CREATE INDEX chat_messages_seq ON chat_messages(seq);
";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// One AI-investigator chat turn. `meta` holds UI state (tool-call steps, proposals) as opaque JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub meta: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Wire format shared with the UI (`src/app/core/models/case.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaseSnapshot {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub entities: Vec<Entity>,
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub positions: HashMap<Uuid, Position>,
    #[serde(default)]
    pub chat: Vec<ChatMessage>,
    /// Entities of types this version no longer knows (e.g. removed ASN/Hash), skipped on load with their links.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub skipped_entities: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

fn check_path(path: &Path) -> AppResult<()> {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case(CASE_EXTENSION) => Ok(()),
        _ => Err(AppError::InvalidInput(format!("case files must use the .{CASE_EXTENSION} extension"))),
    }
}

fn storage_err(context: &str, err: impl std::fmt::Display) -> AppError {
    AppError::Storage(format!("{context}: {err}"))
}

/// Write `snap` to `path` (created or replaced atomically).
pub fn save(path: &Path, snap: &CaseSnapshot) -> AppResult<()> {
    check_path(path)?;
    if snap.format != CASE_FORMAT {
        return Err(AppError::InvalidInput(format!("unknown snapshot format {:?}", snap.format)));
    }
    let tmp = tmp_path(path);
    let _ = std::fs::remove_file(&tmp);
    let result = write_db(&tmp, snap).and_then(|()| std::fs::rename(&tmp, path).map_err(AppError::from));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", Uuid::new_v4().simple()));
    path.with_file_name(name)
}

fn write_db(path: &Path, snap: &CaseSnapshot) -> AppResult<()> {
    let mut conn = Connection::open(path).map_err(|e| storage_err("create case file", e))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| storage_err("configure", e))?;
    conn.execute_batch(SCHEMA_V1).map_err(|e| storage_err("create schema", e))?;
    conn.execute_batch(SCHEMA_V2).map_err(|e| storage_err("create schema", e))?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|e| storage_err("set schema version", e))?;

    let tx = conn.transaction().map_err(|e| storage_err("begin", e))?;
    {
        let mut meta = tx
            .prepare("INSERT INTO meta (key, value) VALUES (?1, ?2)")
            .map_err(|e| storage_err("prepare meta", e))?;
        for (k, v) in [
            ("name", snap.name.as_str()),
            ("app_version", env!("CARGO_PKG_VERSION")),
            ("saved_at", &chrono::Utc::now().to_rfc3339()),
        ] {
            meta.execute(params![k, v]).map_err(|e| storage_err("write meta", e))?;
        }

        let mut ins = tx
            .prepare(
                "INSERT INTO entities (id, type, value, value_norm, properties, notes, tags, created_at, x, y)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|e| storage_err("prepare entities", e))?;
        for e in &snap.entities {
            let norm = normalize_value(e.entity_type, &e.value).map_err(AppError::InvalidInput)?;
            let pos = snap.positions.get(&e.id);
            ins.execute(params![
                e.id.to_string(),
                e.entity_type.as_str(),
                e.value,
                norm,
                serde_json::to_string(&e.properties)?,
                e.notes,
                serde_json::to_string(&e.tags)?,
                e.created_at.to_rfc3339(),
                pos.map(|p| p.x),
                pos.map(|p| p.y),
            ])
            .map_err(|err| match err {
                rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                    AppError::InvalidInput(format!("duplicate entity {} {:?}", e.entity_type.as_str(), e.value))
                }
                other => storage_err("write entity", other),
            })?;
        }

        let mut ins = tx
            .prepare(
                "INSERT INTO edges (id, source_id, target_id, label, transform_source, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| storage_err("prepare edges", e))?;
        for e in &snap.edges {
            ins.execute(params![
                e.id.to_string(),
                e.source_id.to_string(),
                e.target_id.to_string(),
                e.label,
                e.transform_source,
                e.timestamp.to_rfc3339(),
            ])
            .map_err(|err| match err {
                rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                    AppError::InvalidInput(format!("edge {} is a duplicate or references a missing entity", e.id))
                }
                other => storage_err("write edge", other),
            })?;
        }

        let mut ins = tx
            .prepare("INSERT INTO chat_messages (id, seq, role, content, meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .map_err(|e| storage_err("prepare chat", e))?;
        for (seq, m) in snap.chat.iter().enumerate() {
            if m.role != "user" && m.role != "assistant" {
                return Err(AppError::InvalidInput(format!("chat message {} has invalid role {:?}", m.id, m.role)));
            }
            ins.execute(params![m.id, seq as i64, m.role, m.content, serde_json::to_string(&m.meta)?, m.created_at.to_rfc3339()])
                .map_err(|e| storage_err("write chat message", e))?;
        }
    }
    tx.commit().map_err(|e| storage_err("commit", e))?;
    conn.close().map_err(|(_, e)| storage_err("close", e))?;
    Ok(())
}

/// Read a `.case` file into a snapshot.
pub fn load(path: &Path) -> AppResult<CaseSnapshot> {
    check_path(path)?;
    if !path.is_file() {
        return Err(AppError::NotFound(path.display().to_string()));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| storage_err("open case file", e))?;
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| storage_err("not a case file", e))?;
    if version == 0 {
        return Err(AppError::InvalidInput("not an libreOSINT case file".into()));
    }
    if version > SCHEMA_VERSION {
        return Err(AppError::InvalidInput(format!(
            "case file schema v{version} is newer than this app (v{SCHEMA_VERSION})"
        )));
    }

    let name: String = conn
        .query_row("SELECT value FROM meta WHERE key = 'name'", [], |r| r.get(0))
        .optional()
        .map_err(|e| storage_err("read meta", e))?
        .unwrap_or_default();

    let mut entities = Vec::new();
    let mut positions = HashMap::new();
    let mut skipped = std::collections::HashSet::new();
    let mut stmt = conn
        .prepare("SELECT id, type, value, properties, notes, tags, created_at, x, y FROM entities ORDER BY rowid")
        .map_err(|e| storage_err("read entities", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<f64>>(7)?,
                r.get::<_, Option<f64>>(8)?,
            ))
        })
        .map_err(|e| storage_err("read entities", e))?;
    for row in rows {
        let (id, ty, value, props, notes, tags, created, x, y) = row.map_err(|e| storage_err("read entity", e))?;
        let id = parse_uuid(&id)?;
        let Some(entity_type) = EntityType::parse(&ty) else {
            skipped.insert(id);
            continue;
        };
        if let (Some(x), Some(y)) = (x, y) {
            positions.insert(id, Position { x, y });
        }
        entities.push(Entity {
            id,
            entity_type,
            value,
            properties: serde_json::from_str(&props)?,
            notes,
            tags: serde_json::from_str(&tags)?,
            created_at: parse_time(&created)?,
        });
    }

    let mut edges = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, source_id, target_id, label, transform_source, timestamp FROM edges ORDER BY rowid")
        .map_err(|e| storage_err("read edges", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| storage_err("read edges", e))?;
    for row in rows {
        let (id, src, dst, label, transform_source, ts) = row.map_err(|e| storage_err("read edge", e))?;
        let (source_id, target_id) = (parse_uuid(&src)?, parse_uuid(&dst)?);
        if skipped.contains(&source_id) || skipped.contains(&target_id) {
            continue;
        }
        edges.push(Edge {
            id: parse_uuid(&id)?,
            source_id,
            target_id,
            label,
            transform_source,
            timestamp: parse_time(&ts)?,
        });
    }

    let mut chat = Vec::new();
    if version >= 2 {
        let mut stmt = conn
            .prepare("SELECT id, role, content, meta, created_at FROM chat_messages ORDER BY seq")
            .map_err(|e| storage_err("read chat", e))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
            })
            .map_err(|e| storage_err("read chat", e))?;
        for row in rows {
            let (id, role, content, meta, created) = row.map_err(|e| storage_err("read chat message", e))?;
            chat.push(ChatMessage { id, role, content, meta: serde_json::from_str(&meta)?, created_at: parse_time(&created)? });
        }
    }

    Ok(CaseSnapshot {
        format: CASE_FORMAT.into(),
        version: CASE_FORMAT_VERSION,
        name,
        entities,
        edges,
        positions,
        chat,
        skipped_entities: skipped.len() as u32,
    })
}

fn parse_uuid(s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| storage_err("bad id", e))
}

fn parse_time(s: &str) -> AppResult<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&chrono::Utc))
        .map_err(|e| storage_err("bad timestamp", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> CaseSnapshot {
        let mut d = Entity::new(EntityType::Domain, "Example.com");
        d.properties.insert("registrar".into(), json!("Example Registrar"));
        d.tags = vec!["seed".into()];
        d.notes = "# Root domain\nIn scope.".into();
        let ip = Entity::new(EntityType::IPv4, "192.0.2.1");
        let edge = Edge::new(d.id, ip.id, "resolves_to", "manual");
        let mut positions = HashMap::new();
        positions.insert(d.id, Position { x: 12.5, y: -3.0 });
        CaseSnapshot {
            format: CASE_FORMAT.into(),
            version: CASE_FORMAT_VERSION,
            name: "ACME recon".into(),
            entities: vec![d, ip],
            edges: vec![edge],
            positions,
            chat: vec![
                ChatMessage { id: "m1".into(), role: "user".into(), content: "Who runs example.com?".into(), meta: serde_json::Value::Null, created_at: chrono::Utc::now() },
                ChatMessage {
                    id: "m2".into(),
                    role: "assistant".into(),
                    content: "It resolves to **192.0.2.1**.".into(),
                    meta: json!({"steps": [{"kind": "tool", "name": "domain_to_dns", "status": "done"}]}),
                    created_at: chrono::Utc::now(),
                },
            ],
            skipped_entities: 0,
        }
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acme.case");
        let snap = sample();
        save(&path, &snap).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back.name, snap.name);
        assert_eq!(back.entities, snap.entities);
        assert_eq!(back.edges, snap.edges);
        assert_eq!(back.positions, snap.positions);
        assert_eq!(back.chat.len(), 2);
        assert_eq!(back.chat[1].content, snap.chat[1].content);
        assert_eq!(back.chat[1].meta, snap.chat[1].meta);
        assert_eq!(back.chat[0].id, "m1");
    }

    #[test]
    fn loads_v1_case_files_without_chat() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.case");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute("INSERT INTO meta (key, value) VALUES ('name', 'Legacy')", []).unwrap();
        conn.execute(
            "INSERT INTO entities (id, type, value, value_norm, created_at) VALUES (?1, 'Domain', 'old.example', 'old.example', '2026-01-01T00:00:00Z')",
            [Uuid::new_v4().to_string()],
        )
        .unwrap();
        drop(conn);
        let snap = load(&path).unwrap();
        assert_eq!((snap.name.as_str(), snap.entities.len(), snap.chat.len()), ("Legacy", 1, 0));
    }

    #[test]
    fn skips_entities_of_removed_types_and_their_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old-types.case");
        let snap = sample();
        save(&path, &snap).unwrap();
        // Simulate a case saved by an older build that still had the ASN type.
        let conn = Connection::open(&path).unwrap();
        let asn = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO entities (id, type, value, value_norm, created_at) VALUES (?1, 'ASN', 'AS13335', 'AS13335', '2026-01-01T00:00:00Z')",
            [&asn],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO edges (id, source_id, target_id, label, transform_source, timestamp) VALUES (?1, ?2, ?3, 'announced_by', 'x', '2026-01-01T00:00:00Z')",
            [Uuid::new_v4().to_string(), snap.entities[1].id.to_string(), asn],
        )
        .unwrap();
        drop(conn);
        let back = load(&path).unwrap();
        assert_eq!((back.entities.len(), back.edges.len(), back.skipped_entities), (2, 1, 1));
    }

    #[test]
    fn rejects_unknown_chat_roles() {
        let dir = tempfile::tempdir().unwrap();
        let mut snap = sample();
        snap.chat[0].role = "system".into();
        assert!(matches!(save(&dir.path().join("x.case"), &snap), Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn save_overwrites_existing_case_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acme.case");
        let mut snap = sample();
        save(&path, &snap).unwrap();
        snap.entities.truncate(1);
        snap.edges.clear();
        save(&path, &snap).unwrap();
        assert_eq!(load(&path).unwrap().entities.len(), 1);
        let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn rejects_duplicate_normalized_entities() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dup.case");
        let mut snap = sample();
        snap.entities.push(Entity::new(EntityType::Domain, "example.COM."));
        let err = save(&path, &snap).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(ref m) if m.contains("duplicate")), "{err}");
        assert!(!path.exists(), "failed save must not create the case");
    }

    #[test]
    fn failed_save_keeps_previous_file_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acme.case");
        save(&path, &sample()).unwrap();
        let mut bad = sample();
        bad.edges.push(Edge::new(Uuid::new_v4(), Uuid::new_v4(), "related_to", "manual"));
        assert!(save(&path, &bad).is_err());
        assert_eq!(load(&path).unwrap().entities.len(), 2);
    }

    #[test]
    fn rejects_invalid_values() {
        let dir = tempfile::tempdir().unwrap();
        let mut snap = sample();
        snap.entities.push(Entity::new(EntityType::IPv4, "999.1.1.1"));
        assert!(matches!(save(&dir.path().join("x.case"), &snap), Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn requires_case_extension() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(save(&dir.path().join("x.db"), &sample()), Err(AppError::InvalidInput(_))));
        assert!(matches!(load(&dir.path().join("x.txt")), Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn load_rejects_foreign_sqlite_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("other.case");
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE t (x);").unwrap();
        assert!(matches!(load(&path), Err(AppError::InvalidInput(_))));
        assert!(matches!(load(&dir.path().join("missing.case")), Err(AppError::NotFound(_))));
    }
}
