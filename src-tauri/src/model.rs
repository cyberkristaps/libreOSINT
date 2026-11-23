//! Rust mirror of `schema/entity.schema.json` and `schema/edge.schema.json`.
//! Keep in sync with `src/app/core/models/entity.ts`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EntityType {
    Domain,
    Subdomain,
    IPv4,
    IPv6,
    Email,
    #[serde(rename = "Phone_Number")]
    PhoneNumber,
    Person,
    Alias,
    Organization,
    #[serde(rename = "Social_Account")]
    SocialAccount,
    Location,
    #[serde(rename = "URL")]
    Url,
    #[serde(rename = "SSL_Cert")]
    SslCert,
    #[serde(rename = "Port_Service")]
    PortService,
}

impl EntityType {
    pub const ALL: [EntityType; 14] = [
        EntityType::Domain,
        EntityType::Subdomain,
        EntityType::IPv4,
        EntityType::IPv6,
        EntityType::Email,
        EntityType::PhoneNumber,
        EntityType::Person,
        EntityType::Alias,
        EntityType::Organization,
        EntityType::SocialAccount,
        EntityType::Location,
        EntityType::Url,
        EntityType::SslCert,
        EntityType::PortService,
    ];
}

impl EntityType {
    /// Wire name, e.g. `SSL_Cert` (as stored in `.case` files and used by transforms).
    pub fn as_str(self) -> &'static str {
        match self {
            EntityType::Domain => "Domain",
            EntityType::Subdomain => "Subdomain",
            EntityType::IPv4 => "IPv4",
            EntityType::IPv6 => "IPv6",
            EntityType::Email => "Email",
            EntityType::PhoneNumber => "Phone_Number",
            EntityType::Person => "Person",
            EntityType::Alias => "Alias",
            EntityType::Organization => "Organization",
            EntityType::SocialAccount => "Social_Account",
            EntityType::Location => "Location",
            EntityType::Url => "URL",
            EntityType::SslCert => "SSL_Cert",
            EntityType::PortService => "Port_Service",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == s)
    }
}

/// Normalize a value into its dedup key (see CLAUDE.md "Deduplication rules").
/// Must match `normalizeValue` in `src/app/core/models/normalize.ts`; both are tested against
/// `schema/dedup-vectors.json`.
pub fn normalize_value(entity_type: EntityType, raw: &str) -> Result<String, String> {
    let v = raw.trim();
    if v.is_empty() {
        return Err(format!("invalid {}: value is empty", entity_type.as_str()));
    }
    let invalid = |reason: &str| format!("invalid {} {:?}: {}", entity_type.as_str(), raw, reason);
    match entity_type {
        EntityType::Domain | EntityType::Subdomain => {
            if v.chars().any(|c| c.is_whitespace() || "/@:?#".contains(c)) {
                return Err(invalid("host names cannot contain spaces or any of / @ : ? #"));
            }
            let lower = v.to_lowercase();
            let d = lower.strip_suffix('.').unwrap_or(&lower);
            if d.is_empty() {
                Err(invalid("value is empty"))
            } else {
                Ok(d.to_owned())
            }
        }
        EntityType::Email => Ok(v.to_lowercase()),
        EntityType::IPv4 => v
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.to_string())
            .map_err(|_| invalid("not a dotted-quad IPv4 address")),
        EntityType::IPv6 => v
            .parse::<std::net::Ipv6Addr>()
            .map(|ip| ip.to_string())
            .map_err(|_| invalid("not a valid IPv6 address")),
        EntityType::Url => Ok(normalize_url(v)),
        EntityType::SocialAccount => {
            normalize_social_account(v).ok_or_else(|| invalid("expected a profile URL, platform/handle or @user@instance"))
        }
        EntityType::PhoneNumber => normalize_phone(v).ok_or_else(|| invalid("expected 5–15 digits, optionally starting with + or 00")),
        EntityType::Alias => {
            let a = collapse_ws(v.strip_prefix('@').unwrap_or(v)).to_lowercase();
            if a.is_empty() {
                Err(invalid("value is empty"))
            } else {
                Ok(a)
            }
        }
        EntityType::Location => normalize_location(v).ok_or_else(|| invalid("coordinates out of range (latitude ±90, longitude ±180)")),
        _ => Ok(v.to_owned()),
    }
}

/// Collapse runs of whitespace to one space and trim.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn digits_between(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// Digits only, `+` kept, `00` international prefix → `+`.
fn normalize_phone(v: &str) -> Option<String> {
    let v = if v.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("tel:")) { &v[4..] } else { v };
    let mut s: String = v.chars().filter(|c| !(c.is_whitespace() || "-.()/".contains(*c))).collect();
    if let Some(rest) = s.strip_prefix("00") {
        s = format!("+{rest}");
    }
    let digits = s.strip_prefix('+').unwrap_or(&s);
    digits_between(digits, 5, 15).then_some(s)
}

fn is_coordinate(s: &str) -> bool {
    let s = s.strip_prefix(['+', '-']).unwrap_or(s);
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    digits_between(int, 1, 3) && frac.map_or(true, |f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `+056.94960` → `56.9496`, `-0.0` → `0`.
fn canon_number(n: &str) -> String {
    let neg = n.starts_with('-');
    let n = n.strip_prefix(['+', '-']).unwrap_or(n);
    let (int, frac) = n.split_once('.').unwrap_or((n, ""));
    let int = int.trim_start_matches('0');
    let int = if int.is_empty() { "0" } else { int };
    let frac = frac.trim_end_matches('0');
    let out = if frac.is_empty() { int.to_owned() } else { format!("{int}.{frac}") };
    if neg && out != "0" {
        format!("-{out}")
    } else {
        out
    }
}

fn split_coordinates(v: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = if v.contains(',') {
        v.split(',').collect()
    } else if v.contains(';') {
        v.split(';').collect()
    } else {
        v.split_whitespace().collect()
    };
    match parts.as_slice() {
        [a, b] if is_coordinate(a.trim()) && is_coordinate(b.trim()) => Some((a.trim().to_owned(), b.trim().to_owned())),
        _ => None,
    }
}

/// Coordinates → canonical `lat, lon` (None if out of range); place names → collapsed, `", "`-joined, lowercase.
fn normalize_location(v: &str) -> Option<String> {
    if let Some((a, b)) = split_coordinates(v) {
        let (lat, lon) = (canon_number(&a), canon_number(&b));
        let ok = lat.parse::<f64>().is_ok_and(|x| x.abs() <= 90.0) && lon.parse::<f64>().is_ok_and(|x| x.abs() <= 180.0);
        return ok.then(|| format!("{lat}, {lon}"));
    }
    let collapsed = collapse_ws(v);
    Some(collapsed.split(',').map(str::trim).collect::<Vec<_>>().join(", ").trim().to_lowercase())
}

/// Hosts whose profile handles are case-insensitive, so the whole path can be lowercased.
const CASE_INSENSITIVE_HOSTS: &[&str] = &[
    "x.com", "instagram.com", "github.com", "gitlab.com", "reddit.com", "linkedin.com", "facebook.com", "tiktok.com", "t.me",
    "threads.net", "bsky.app", "pinterest.com", "twitch.tv", "medium.com", "keybase.io", "snapchat.com", "vk.com", "telegram.me",
];

fn host_alias(host: &str) -> &str {
    match host {
        "twitter.com" => "x.com",
        "telegram.me" => "t.me",
        "fb.com" => "facebook.com",
        other => other,
    }
}

/// `@user@instance.tld` (fediverse) → `instance.tld/@user`.
fn fediverse(v: &str) -> Option<String> {
    let rest = v.strip_prefix('@')?;
    let (user, host) = rest.split_once('@')?;
    let user_ok = !user.is_empty() && user.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    let labels: Vec<&str> = host.split('.').collect();
    let host_ok = labels.len() >= 2
        && labels.iter().all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    (user_ok && host_ok).then(|| format!("{}/@{}", host.to_lowercase(), user.to_lowercase()))
}

/// Canonical `host/path` (e.g. `x.com/jdoe`, `mastodon.social/@jdoe`) or a lowercased bare handle.
/// Must match `normalizeSocialAccount` in `src/app/core/models/normalize.ts`.
fn normalize_social_account(v: &str) -> Option<String> {
    if let Some(f) = fediverse(v) {
        return Some(f);
    }
    // Strip a URL scheme like `https://`.
    let s = match v.find("://") {
        Some(i) if v[..i].chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && v[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) =>
        {
            &v[i + 3..]
        }
        _ => v,
    };
    let s = s.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    if s.is_empty() {
        return None;
    }
    if !s.contains('/') && !s.contains('.') {
        return Some(s.to_lowercase()); // bare handle
    }
    let (host, path) = s.split_once('/').unwrap_or((s, ""));
    let host = host.to_lowercase();
    let host = ["www.", "m.", "mobile."].iter().find_map(|p| host.strip_prefix(p)).unwrap_or(&host).to_owned();
    let host = host_alias(&host).to_owned();
    if host.is_empty() {
        return None;
    }
    let path = if CASE_INSENSITIVE_HOSTS.contains(&host.as_str()) || path.starts_with('@') {
        path.to_lowercase()
    } else {
        path.to_owned()
    };
    Some(if path.is_empty() { host } else { format!("{host}/{path}") })
}

/// Lowercase scheme and host only; userinfo, port, path, query and fragment are kept verbatim.
fn normalize_url(v: &str) -> String {
    let Some(sep) = v.find("://") else {
        return v.to_owned();
    };
    let scheme = v[..sep].to_lowercase();
    let rest = &v[sep + 3..];
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, after) = rest.split_at(auth_end);
    let (userinfo, host_port) = match authority.rfind('@') {
        Some(at) => authority.split_at(at + 1),
        None => ("", authority),
    };
    format!("{scheme}://{userinfo}{}{after}", host_port.to_lowercase())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub entity_type: EntityType,
    pub value: String,
    #[serde(default)]
    pub properties: Map<String, Value>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
}

impl Entity {
    pub fn new(entity_type: EntityType, value: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            entity_type,
            value: value.into(),
            properties: Map::new(),
            notes: String::new(),
            tags: Vec::new(),
            created_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub id: Uuid,
    pub source_id: Uuid,
    pub target_id: Uuid,
    pub label: String,
    pub transform_source: String,
    pub timestamp: DateTime<Utc>,
}

impl Edge {
    pub fn new(source_id: Uuid, target_id: Uuid, label: impl Into<String>, transform_source: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            source_id,
            target_id,
            label: label.into(),
            transform_source: transform_source.into(),
            timestamp: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_type_wire_names_match_schema() {
        let names: Vec<String> = EntityType::ALL
            .iter()
            .map(|t| serde_json::to_value(t).unwrap().as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            names,
            [
                "Domain", "Subdomain", "IPv4", "IPv6", "Email", "Phone_Number", "Person", "Alias", "Organization", "Social_Account", "Location", "URL", "SSL_Cert", "Port_Service"
            ]
        );
    }

    #[test]
    fn as_str_matches_serde_and_parses_back() {
        for t in EntityType::ALL {
            assert_eq!(serde_json::to_value(t).unwrap(), t.as_str());
            assert_eq!(EntityType::parse(t.as_str()), Some(t));
        }
    }

    #[derive(Deserialize)]
    struct Vectors {
        normalize: Vec<(String, String, String)>,
        invalid: Vec<(String, String)>,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../../schema/dedup-vectors.json")).unwrap()
    }

    #[test]
    fn normalization_matches_shared_vectors() {
        for (t, input, expected) in vectors().normalize {
            let ty = EntityType::parse(&t).unwrap();
            assert_eq!(normalize_value(ty, &input).as_deref(), Ok(expected.as_str()), "{t} {input:?}");
        }
    }

    #[test]
    fn invalid_values_match_shared_vectors() {
        for (t, input) in vectors().invalid {
            let ty = EntityType::parse(&t).unwrap();
            assert!(normalize_value(ty, &input).is_err(), "{t} {input:?} should be rejected");
        }
    }

    #[test]
    fn entity_round_trips_through_json() {
        let mut e = Entity::new(EntityType::SslCert, "ab:cd");
        e.properties.insert("issuer".into(), Value::String("R3".into()));
        e.tags.push("ct-log".into());
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains(r#""type":"SSL_Cert""#));
        let back: Entity = serde_json::from_str(&json).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn entity_defaults_optional_fields() {
        let json = r#"{"id":"6f1c1f5e-2a4b-4c3d-9e8f-0a1b2c3d4e5f","type":"Domain","value":"example.com","created_at":"2026-01-01T00:00:00Z"}"#;
        let e: Entity = serde_json::from_str(json).unwrap();
        assert!(e.properties.is_empty() && e.tags.is_empty() && e.notes.is_empty());
    }

    #[test]
    fn edge_round_trips_through_json() {
        let a = Entity::new(EntityType::Domain, "example.com");
        let b = Entity::new(EntityType::IPv4, "192.0.2.1");
        let edge = Edge::new(a.id, b.id, "resolves_to", "domain_to_dns");
        let back: Edge = serde_json::from_str(&serde_json::to_string(&edge).unwrap()).unwrap();
        assert_eq!(back, edge);
    }
}
