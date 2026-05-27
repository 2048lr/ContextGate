use crate::cache::LruCache;
use crate::config::{AppConfig, ConfigManager, DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT};
use crate::monitor::TokenMonitor;
use crate::proxy::ProxyServer;
use crate::scanner::{BuildContextResult, CodeScanner};
use parking_lot::Mutex;
use serde_json::json;
use std::sync::Arc;
use tauri::{Manager, State};

pub struct AppState {
    pub config_manager: Mutex<ConfigManager>,
    pub proxy_server: Mutex<Option<ProxyServer>>,
    pub token_monitor: Mutex<Option<TokenMonitor>>,
    pub config_path: String,
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cm = state.config_manager.lock();
    let config = cm.get_config();
    serde_json::to_value(config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_config(
    state: State<'_, AppState>,
    config: AppConfig,
) -> Result<(), String> {
    let mut cm = state.config_manager.lock();
    cm.update_config(config);
    cm.save()
}

#[tauri::command]
pub async fn select_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let folder = app
        .dialog()
        .file()
        .blocking_pick_folder();

    Ok(folder.map(|p| p.to_string()))
}

#[tauri::command]
pub fn get_platform() -> String {
    #[cfg(target_os = "linux")]
    return "linux".to_string();
    #[cfg(target_os = "windows")]
    return "windows".to_string();
    #[cfg(target_os = "macos")]
    return "macos".to_string();
}

#[tauri::command]
pub fn get_background_url() -> String {
    "https://images.unsplash.com/photo-1451187585482-931da21b782b?w=1920&q=80".to_string()
}

#[tauri::command]
pub fn get_locale() -> String {
    std::env::var("LANG")
        .unwrap_or_else(|_| "en_US.UTF-8".to_string())
        .split('.')
        .next()
        .unwrap_or("en_US")
        .to_string()
}

#[tauri::command]
pub fn window_minimize(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn window_maximize(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            window.maximize()
        };
    }
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

#[tauri::command]
pub async fn start_proxy(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    port: u16,
) -> Result<serde_json::Value, String> {
    {
        let proxy_guard = state.proxy_server.lock();
        if let Some(existing) = proxy_guard.as_ref() {
            if existing.is_running() {
                return Ok(json!({
                    "success": false,
                    "error": "Proxy already running"
                }));
            }
        }
    }

    let config_path = state.config_path.clone();
    let workspace = {
        let cm = state.config_manager.lock();
        cm.get_workspace().map(String::from)
    };
    let context_file = workspace.as_ref().map(|w| {
        std::path::PathBuf::from(w)
            .join("full_context.txt")
            .to_string_lossy()
            .to_string()
    });

    let mut server = ProxyServer::new(
        &config_path,
        context_file.as_deref(),
        workspace.as_deref(),
        200,
        100,
    );

    server.set_app_handle(app);

    let actual_port = server.start(DEFAULT_PROXY_HOST, port).await?;

    {
        let mut proxy_guard = state.proxy_server.lock();
        *proxy_guard = Some(server);
    }

    Ok(json!({
        "success": true,
        "port": actual_port
    }))
}

#[tauri::command]
pub fn stop_proxy(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut proxy_guard = state.proxy_server.lock();
    if let Some(ref mut server) = *proxy_guard {
        server.stop();
    }
    *proxy_guard = None;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub fn proxy_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let proxy_guard = state.proxy_server.lock();
    match proxy_guard.as_ref() {
        Some(server) if server.is_running() => Ok(json!({
            "running": true,
            "port": server.get_port()
        })),
        _ => Ok(json!({
            "running": false,
            "port": null
        })),
    }
}

#[tauri::command]
pub async fn build_context(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<serde_json::Value, String> {
    let config = {
        let cm = state.config_manager.lock();
        cm.get_config().clone()
    };

    let scanner = CodeScanner::new(&project_path, &config);
    let result = scanner.build_context(None)?;

    Ok(json!({
        "success": true,
        "fileCount": result.file_count,
        "totalChars": result.total_chars,
        "estimatedTokens": result.estimated_tokens,
        "outputPath": result.output_path
    }))
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let monitor_guard = state.token_monitor.lock();
    match monitor_guard.as_ref() {
        Some(monitor) => {
            let summary = monitor.get_summary()?;
            serde_json::to_value(summary).map_err(|e| e.to_string())
        }
        None => Ok(json!({})),
    }
}

#[tauri::command]
pub fn get_memory_usage() -> Result<serde_json::Value, String> {
    let usage = get_process_memory();
    Ok(json!({
        "rss": usage,
        "heapTotal": usage,
        "heapUsed": usage,
        "external": 0
    }))
}

fn get_process_memory() -> u64 {
    #[cfg(target_os = "linux")]
    {
        use std::fs;
        let statm = fs::read_to_string("/proc/self/statm").unwrap_or_default();
        let fields: Vec<&str> = statm.split_whitespace().collect();
        if fields.len() >= 2 {
            let rss_pages: u64 = fields[1].parse().unwrap_or(0);
            return rss_pages * 4096;
        }
    }
    0
}

#[tauri::command]
pub fn set_workspace(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<(), String> {
    let mut cm = state.config_manager.lock();
    cm.set_workspace(workspace)
}
