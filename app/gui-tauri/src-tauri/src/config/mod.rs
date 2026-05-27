use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
pub const DEFAULT_PROXY_PORT: u16 = 12306;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub api_key: String,
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub tls: Option<TlsConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsConfig {
    #[serde(default = "default_true")]
    pub reject_unauthorized: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    #[serde(default = "default_proxy_host")]
    pub host: String,
    #[serde(default = "default_proxy_port")]
    pub port: u16,
    #[serde(default = "default_true")]
    pub sanitize_requests: bool,
}

fn default_proxy_host() -> String {
    DEFAULT_PROXY_HOST.to_string()
}

fn default_proxy_port() -> u16 {
    DEFAULT_PROXY_PORT
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorConfig {
    #[serde(default = "default_budget")]
    pub budget_limit: f64,
    #[serde(default = "default_warning")]
    pub warning_threshold: u32,
    #[serde(default = "default_critical")]
    pub critical_threshold: u32,
    #[serde(default = "default_db_path")]
    pub db_path: String,
}

fn default_budget() -> f64 {
    10.0
}
fn default_warning() -> u32 {
    75
}
fn default_critical() -> u32 {
    90
}
fn default_db_path() -> String {
    "contextgate.db".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrencyConfig {
    #[serde(default)]
    pub fixed_currency: Option<String>,
    #[serde(default)]
    pub fixed_rate: Option<f64>,
    #[serde(default)]
    pub exchange_rate_api: Option<String>,
    #[serde(default)]
    pub default_rates: Option<HashMap<String, f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextConfig {
    #[serde(default = "default_output_file")]
    pub output_file: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_true")]
    pub watch_enabled: bool,
    #[serde(default = "default_debounce")]
    pub debounce_seconds: f64,
    #[serde(default)]
    pub dynamic_enabled: bool,
}

fn default_output_file() -> String {
    "full_context.txt".to_string()
}
fn default_max_tokens() -> u32 {
    8000
}
fn default_debounce() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannerConfig {
    #[serde(default = "default_max_file_size")]
    pub max_file_size: u64,
    #[serde(default = "default_extensions")]
    pub include_extensions: Vec<String>,
}

fn default_max_file_size() -> u64 {
    1048576
}
fn default_extensions() -> Vec<String> {
    let exts: Vec<&str> = vec![
        ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs",
        ".c", ".cpp", ".h", ".hpp", ".md", ".txt", ".json", ".yaml",
        ".yml", ".toml", ".xml", ".csv", ".sql", ".sh", ".bash",
        ".css", ".scss", ".less", ".html", ".vue", ".svelte",
    ];
    exts.into_iter().map(String::from).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub workspace: Option<String>,
    pub providers: HashMap<String, ProviderConfig>,
    pub default_provider: Option<String>,
    pub proxy: ProxyConfig,
    pub monitor: MonitorConfig,
    pub currency: CurrencyConfig,
    pub context: ContextConfig,
    pub scanner: ScannerConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            workspace: None,
            providers: HashMap::new(),
            default_provider: None,
            proxy: ProxyConfig::default(),
            monitor: MonitorConfig::default(),
            currency: CurrencyConfig::default(),
            context: ContextConfig::default(),
            scanner: ScannerConfig::default(),
        }
    }
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            host: default_proxy_host(),
            port: default_proxy_port(),
            sanitize_requests: true,
        }
    }
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            budget_limit: default_budget(),
            warning_threshold: default_warning(),
            critical_threshold: default_critical(),
            db_path: default_db_path(),
        }
    }
}

impl Default for CurrencyConfig {
    fn default() -> Self {
        Self {
            fixed_currency: None,
            fixed_rate: None,
            exchange_rate_api: None,
            default_rates: None,
        }
    }
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            output_file: default_output_file(),
            max_tokens: default_max_tokens(),
            watch_enabled: true,
            debounce_seconds: default_debounce(),
            dynamic_enabled: false,
        }
    }
}

impl Default for ScannerConfig {
    fn default() -> Self {
        Self {
            max_file_size: default_max_file_size(),
            include_extensions: default_extensions(),
        }
    }
}

pub struct ConfigManager {
    config_path: String,
    config: AppConfig,
}

impl ConfigManager {
    pub fn new(config_path: &str) -> Self {
        let config = Self::load(config_path).unwrap_or_default();
        Self {
            config_path: config_path.to_string(),
            config,
        }
    }

    fn load(config_path: &str) -> Result<AppConfig, String> {
        let path = Path::new(config_path);
        if !path.exists() {
            return Ok(AppConfig::default());
        }
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_yaml::from_str(&content).map_err(|e| e.to_string())
    }

    pub fn save(&self) -> Result<(), String> {
        let yaml_str = serde_yaml::to_string(&self.config).map_err(|e| e.to_string())?;
        let path = Path::new(&self.config_path);
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        fs::write(&self.config_path, yaml_str).map_err(|e| e.to_string())
    }

    pub fn get_config(&self) -> &AppConfig {
        &self.config
    }

    pub fn get_config_mut(&mut self) -> &mut AppConfig {
        &mut self.config
    }

    pub fn update_config(&mut self, new_config: AppConfig) {
        self.config = new_config;
    }

    pub fn get_workspace(&self) -> Option<&str> {
        self.config.workspace.as_deref()
    }

    pub fn set_workspace(&mut self, workspace: String) -> Result<(), String> {
        self.config.workspace = Some(workspace);
        self.save()
    }

    pub fn get_provider(&self, name: &str) -> Option<&ProviderConfig> {
        self.config.providers.get(name)
    }

    pub fn get_default_provider(&self) -> Option<&str> {
        self.config.default_provider.as_deref()
    }

    pub fn get_all_providers(&self) -> &HashMap<String, ProviderConfig> {
        &self.config.providers
    }

    pub fn get_proxy_config(&self) -> &ProxyConfig {
        &self.config.proxy
    }

    pub fn get_monitor_config(&self) -> &MonitorConfig {
        &self.config.monitor
    }

    pub fn get_currency_config(&self) -> &CurrencyConfig {
        &self.config.currency
    }
}
