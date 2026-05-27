use crate::config::ConfigManager;
use md5::{Digest, Md5};

pub const ALLOWED_V1_PATHS: &[&str] = &[
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/models",
    "/v1/images/generations",
    "/v1/audio/transcriptions",
    "/v1/audio/translations",
    "/v1/audio/speech",
    "/v1/moderations",
];

pub fn detect_provider(backend_path: &str, config_manager: &ConfigManager) -> String {
    let lower = backend_path.to_lowercase();
    if lower.contains("zhipu") {
        return "zhipu".to_string();
    }
    if lower.contains("deepseek") {
        return "deepseek".to_string();
    }
    if lower.contains("openai") {
        return "openai".to_string();
    }
    if let Some(default) = config_manager.get_default_provider() {
        return default.to_string();
    }
    let providers = config_manager.get_all_providers();
    if providers.len() == 1 {
        return providers.keys().next().unwrap().clone();
    }
    "openai".to_string()
}

pub fn get_cache_key(
    method: &str,
    path: &str,
    body: &serde_json::Value,
    context_hash: &str,
) -> String {
    let model = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown");

    let mut msg_fingerprint = String::new();
    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in messages.iter().rev() {
            if msg.get("role").and_then(|r| r.as_str()) == Some("user") {
                if let Some(content) = msg.get("content") {
                    let text = match content {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    let mut hasher = Md5::new();
                    hasher.update(text.as_bytes());
                    msg_fingerprint = hex::encode(hasher.finalize());
                    msg_fingerprint.truncate(12);
                    break;
                }
            }
        }
    }

    if msg_fingerprint.is_empty() {
        let serialized = body.to_string();
        let mut hasher = Md5::new();
        hasher.update(serialized.as_bytes());
        msg_fingerprint = hex::encode(hasher.finalize());
        msg_fingerprint.truncate(12);
    }

    format!("{}:{}:{}:{}:{}", method, path, model, msg_fingerprint, context_hash)
}

pub fn should_cache(method: &str) -> bool {
    matches!(method, "GET" | "POST")
}
