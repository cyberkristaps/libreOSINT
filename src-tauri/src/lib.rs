#![deny(unsafe_code)]

pub mod commands;
pub mod error;
pub mod export;
pub mod jobs;
pub mod model;
pub mod ollama;
pub mod storage;
pub mod transforms;
pub mod vault;

/// Version of the transform stdin/stdout JSON contract documented in CLAUDE.md.
pub const TRANSFORM_CONTRACT_VERSION: u32 = 1;

/// Where transform scripts live: `$OSINT_TRANSFORMS_DIR`, else the repo's `transforms/` in debug
/// builds, else the bundled `transforms/` resource directory.
fn transforms_dir(app: &tauri::App) -> std::path::PathBuf {
    use tauri::Manager;
    if let Some(dir) = std::env::var_os("OSINT_TRANSFORMS_DIR") {
        return dir.into();
    }
    if cfg!(debug_assertions) {
        return std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../transforms");
    }
    app.path()
        .resource_dir()
        .map(|d| d.join("transforms"))
        .unwrap_or_else(|_| "transforms".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(jobs::Jobs::default())
        .setup(|app| {
            let engine = transforms::TransformEngine::load(transforms_dir(app));
            app.manage(std::sync::Arc::new(engine));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::case_open,
            commands::case_save,
            commands::transform_list,
            commands::transform_run,
            commands::network_check,
            commands::job_cancel,
            commands::ollama_models,
            commands::ollama_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running libreOSINT");
}
