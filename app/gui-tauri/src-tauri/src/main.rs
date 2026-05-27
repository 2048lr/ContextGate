#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use contextgate_lib::commands::AppState;
use contextgate_lib::config::ConfigManager;
use contextgate_lib::monitor::TokenMonitor;
use parking_lot::Mutex;
use std::path::PathBuf;

fn main() {
    let config_dir = dirs_config_dir();
    let config_path = config_dir
        .map(|d| d.join("contextgate").join("config.yaml"))
        .unwrap_or_else(|| PathBuf::from("config.yaml"));

    let config_path_str = config_path.to_string_lossy().to_string();
    let config_manager = ConfigManager::new(&config_path_str);

    let db_path = config_manager.get_monitor_config().db_path.clone();
    let token_monitor = TokenMonitor::new(&db_path).ok();

    let app_state = AppState {
        config_manager: Mutex::new(config_manager),
        proxy_server: Mutex::new(None),
        token_monitor: Mutex::new(token_monitor),
        config_path: config_path_str,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            contextgate_lib::commands::get_config,
            contextgate_lib::commands::save_config,
            contextgate_lib::commands::select_folder,
            contextgate_lib::commands::get_platform,
            contextgate_lib::commands::get_background_url,
            contextgate_lib::commands::get_locale,
            contextgate_lib::commands::window_minimize,
            contextgate_lib::commands::window_maximize,
            contextgate_lib::commands::window_close,
            contextgate_lib::commands::start_proxy,
            contextgate_lib::commands::stop_proxy,
            contextgate_lib::commands::proxy_status,
            contextgate_lib::commands::build_context,
            contextgate_lib::commands::get_stats,
            contextgate_lib::commands::get_memory_usage,
            contextgate_lib::commands::set_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dirs_config_dir() -> Option<PathBuf> {
    std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config"))
        })
}
