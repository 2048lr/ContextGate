use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::config::ProviderConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SSEEvent {
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
    pub retry: Option<String>,
}

pub fn build_client(provider_config: &ProviderConfig) -> Client {
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(provider_config.timeout.unwrap_or(60000)))
        .pool_max_idle_per_host(50)
        .pool_idle_timeout(Duration::from_secs(30))
        .tcp_keepalive(Duration::from_secs(30));

    if let Some(tls) = &provider_config.tls {
        if !tls.reject_unauthorized {
            builder = builder.danger_accept_invalid_certs(true);
        }
    }

    builder.build().unwrap_or_else(|_| Client::new())
}

pub async fn forward_request(
    client: &Client,
    provider_config: &ProviderConfig,
    backend_path: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, String> {
    let url = format!("{}{}", provider_config.base_url.trim_end_matches('/'), backend_path);

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", provider_config.api_key))
        .json(body);

    request = request.timeout(Duration::from_millis(provider_config.timeout.unwrap_or(60000)));

    let retries = 2;
    let mut last_error = String::new();

    for attempt in 0..=retries {
        match request.try_clone().unwrap_or_else(|| request.try_clone().unwrap()).send().await {
            Ok(response) => return Ok(response),
            Err(e) => {
                last_error = e.to_string();
                let should_retry = e.is_timeout() || e.is_connect() || e.is_request();
                if should_retry && attempt < retries {
                    let delay = Duration::from_millis(500 * 2u64.pow(attempt as u32)).min(Duration::from_secs(3));
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Err(last_error);
            }
        }
    }

    Err(last_error)
}

pub async fn forward_chat_request(
    client: &Client,
    provider_config: &ProviderConfig,
    model: &str,
    messages: &serde_json::Value,
    options: &serde_json::Value,
) -> Result<reqwest::Response, String> {
    let url = format!(
        "{}/chat/completions",
        provider_config.base_url.trim_end_matches('/')
    );

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
    });

    if let serde_json::Value::Object(opts) = options {
        if let serde_json::Value::Object(ref mut body_obj) = body {
            for (k, v) in opts {
                body_obj.insert(k.clone(), v.clone());
            }
        }
    }

    client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", provider_config.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())
}

pub fn parse_sse_chunks(raw: &str) -> Vec<SSEEvent> {
    let mut events = Vec::new();
    let mut current_event = SSEEvent {
        event: None,
        data: String::new(),
        id: None,
        retry: None,
    };

    for line in raw.lines() {
        if line.is_empty() {
            if !current_event.data.is_empty() || current_event.event.is_some() {
                events.push(current_event.clone());
            }
            current_event = SSEEvent {
                event: None,
                data: String::new(),
                id: None,
                retry: None,
            };
            continue;
        }
        if let Some(event) = line.strip_prefix("event:") {
            current_event.event = Some(event.trim().to_string());
        } else if let Some(data) = line.strip_prefix("data:") {
            if !current_event.data.is_empty() {
                current_event.data.push('\n');
            }
            current_event.data.push_str(data.trim());
        } else if let Some(id) = line.strip_prefix("id:") {
            current_event.id = Some(id.trim().to_string());
        } else if let Some(retry) = line.strip_prefix("retry:") {
            current_event.retry = Some(retry.trim().to_string());
        }
    }

    if !current_event.data.is_empty() || current_event.event.is_some() {
        events.push(current_event);
    }

    events
}

pub fn serialize_sse_events(events: &[SSEEvent]) -> String {
    let mut output = String::new();
    for evt in events {
        if let Some(id) = &evt.id {
            output.push_str(&format!("id: {}\n", id));
        }
        if let Some(event) = &evt.event {
            output.push_str(&format!("event: {}\n", event));
        }
        if let Some(retry) = &evt.retry {
            output.push_str(&format!("retry: {}\n", retry));
        }
        output.push_str(&format!("data: {}\n\n", evt.data));
    }
    output
}

pub fn extract_msg_preview(messages: &serde_json::Value) -> String {
    if let serde_json::Value::Array(msgs) = messages {
        if let Some(last) = msgs.last() {
            if let Some(content) = last.get("content") {
                let text = match content {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                if text.len() > 80 {
                    format!("{}…", &text[..80])
                } else {
                    text
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    } else {
        String::new()
    }
}

pub async fn collect_stream_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
