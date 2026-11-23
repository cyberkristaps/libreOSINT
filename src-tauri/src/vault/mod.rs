//! API key vault backed by the OS keychain (`keyring` crate). Implemented in Phase 3.
//! Keys are injected into transform processes as `OSINT_KEY_<NAME>`; never written to `.case` files.

/// Keychain service name under which all keys are stored.
pub const KEYCHAIN_SERVICE: &str = "dev.libreosint.app";
