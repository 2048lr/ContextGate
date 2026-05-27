use crate::cache::LruCache;
use crate::config::{ConfigManager, DEFAULT_PROXY_HOST, VERSION};
use crate::monitor::{RequestData, TokenMonitor};
use crate::proxy::context_signature::{
    compute_context_signature, get_context_hash, ContextSignature,
};
use crate::proxy::forwarder::{build_client, collect_stream_body, forward_request, SSEEvent};
use crate::proxy::routes::{detect_provider, get_cache_key, should_cache, ALLOWED_V1_PATHS};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

type BoxBody = Full<Bytes>;

fn full<T: Into<Bytes>>(chunk: T) -> BoxBody {
    Full::new(chunk.into())
}

fn ok_json(val: &serde_json::Value) -> Result<Response<BoxBody>, hyper::Error> {
    let body = serde_json::to_string(val).unwrap_or_default();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json")
        .body(full(body))
        .unwrap())
}

fn error_response(status: u16, msg: &str) -> Result<Response<BoxBody>, hyper::Error> {
    let body = serde_json::json!({"error": msg}).to_string();
    Ok(Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("Content-Type", "application/json")
        .body(full(body))
        .unwrap())
}

struct ProxyState {
    config_manager: ConfigManager,
    cache: LruCache,
    context_file: Option<String>,
    workspace: Option<String>,
    context_signature: Option<ContextSignature>,
    clients: HashMap<String, reqwest::Client>,
    token_monitor: Option<TokenMonitor>,
}

impl ProxyState {
    fn new(
        config_manager: ConfigManager,
        context_file: Option<&str>,
        workspace: Option<&str>,
        cache_max_size: usize,
        cache_max_memory_mb: usize,
        token_monitor: Option<TokenMonitor>,
    ) -> Self {
        let mut clients = HashMap::new();
        for (name, provider_config) in config_manager.get_all_providers() {
            let client = build_client(provider_config);
            clients.insert(name.clone(), client);
        }

        let context_signature = context_file
            .as_ref()
            .and_then(|cf| compute_context_signature(cf, workspace));

        Self {
            config_manager,
            cache: LruCache::new(cache_max_size, cache_max_memory_mb),
            context_file: context_file.map(String::from),
            workspace: workspace.map(String::from),
            context_signature,
            clients,
            token_monitor,
        }
    }

    fn get_client(&self, provider: &str) -> Option<&reqwest::Client> {
        self.clients.get(provider)
    }

    fn update_context_signature(&mut self) {
        if let (Some(cf), Some(ws)) = (&self.context_file, &self.workspace) {
            self.context_signature = compute_context_signature(cf, Some(ws));
        }
    }
}

pub struct ProxyServer {
    state: Arc<Mutex<ProxyState>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    running: bool,
    port: u16,
}

impl ProxyServer {
    pub fn new(
        config_path: &str,
        context_file: Option<&str>,
        workspace: Option<&str>,
        cache_max_size: usize,
        cache_max_memory_mb: usize,
    ) -> Self {
        let config_manager = ConfigManager::new(config_path);
        let db_path = config_manager.get_monitor_config().db_path.clone();
        let token_monitor = TokenMonitor::new(&db_path).ok();

        let state = ProxyState::new(
            config_manager,
            context_file,
            workspace,
            cache_max_size,
            cache_max_memory_mb,
            token_monitor,
        );

        Self {
            state: Arc::new(Mutex::new(state)),
            shutdown_tx: None,
            running: false,
            port: 0,
        }
    }

    pub async fn start(&mut self, host: &str, port: u16) -> Result<u16, String> {
        let addr: SocketAddr = format!("{}:{}", host, port)
            .parse()
            .map_err(|e| format!("Invalid address: {}", e))?;

        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| format!("Failed to bind: {}", e))?;

        let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        self.port = actual_port;

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        self.shutdown_tx = Some(shutdown_tx);
        self.running = true;

        let state = self.state.clone();

        tokio::spawn(async move {
            let mut shutdown = shutdown_rx;
            loop {
                tokio::select! {
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((stream, _)) => {
                                let io = TokioIo::new(stream);
                                let state = state.clone();
                                tokio::spawn(async move {
                                    let service = service_fn(move |req| {
                                        let state = state.clone();
                                        async move { handle_request(req, state).await }
                                    });
                                    if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                                        eprintln!("Connection error: {:?}", err);
                                    }
                                });
                            }
                            Err(e) => {
                                eprintln!("Accept error: {}", e);
                            }
                        }
                    }
                    _ = &mut shutdown => {
                        break;
                    }
                }
            }
        });

        Ok(actual_port)
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.running = false;
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn get_port(&self) -> u16 {
        self.port
    }
}

async fn handle_request(
    req: Request<hyper::body::Incoming>,
    state: Arc<Mutex<ProxyState>>,
) -> Result<Response<BoxBody>, hyper::Error> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    let full_path = format!("{}{}", path, query);

    let body_bytes = req.collect().await?.to_bytes();
    let body_str = String::from_utf8_lossy(&body_bytes).to_string();
    let body_json: serde_json::Value = if body_str.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&body_str).unwrap_or(serde_json::json!({}))
    };

    match path.as_str() {
        "/health" => {
            let resp = serde_json::json!({
                "status": "ok",
                "provider": "ContextGate",
                "version": VERSION
            });
            ok_json(&resp)
        }
        "/v1/models" => {
            let state_guard = state.lock();
            let mut models: Vec<serde_json::Value> = Vec::new();
            for (name, provider) in state_guard.config_manager.get_all_providers() {
                for model in &provider.models {
                    models.push(serde_json::json!({
                        "id": model,
                        "object": "model",
                        "owned_by": name
                    }));
                }
            }
            ok_json(&serde_json::json!({
                "object": "list",
                "data": models
            }))
        }
        "/cache" if method == Method::DELETE => {
            state.lock().cache.clear();
            ok_json(&serde_json::json!({"success": true}))
        }
        "/cache/stats" => {
            let state_guard = state.lock();
            ok_json(&serde_json::json!({
                "size": state_guard.cache.len(),
                "memory_usage": state_guard.cache.memory_usage()
            }))
        }
        "/stats" => {
            let state_guard = state.lock();
            if let Some(ref monitor) = state_guard.token_monitor {
                match monitor.get_summary() {
                    Ok(summary) => ok_json(&serde_json::to_value(summary).unwrap_or_default()),
                    Err(e) => error_response(500, &e),
                }
            } else {
                ok_json(&serde_json::json!({}))
            }
        }
        p if p.starts_with("/v1/") => {
            handle_v1_request(method.clone(), &path, &body_json, state).await
        }
        _ => error_response(404, "Not found"),
    }
}

async fn handle_v1_request(
    method: Method,
    path: &str,
    body: &serde_json::Value,
    state: Arc<Mutex<ProxyState>>,
) -> Result<Response<BoxBody>, hyper::Error> {
    let backend_path = path;
    if !ALLOWED_V1_PATHS.iter().any(|p| backend_path.starts_with(p)) {
        return error_response(404, "Endpoint not supported");
    }

    let (provider_name, provider_config) = {
        let state_guard = state.lock();
        let provider_name = detect_provider(backend_path, &state_guard.config_manager);
        match state_guard.config_manager.get_provider(&provider_name) {
            Some(config) => (provider_name, config.clone()),
            None => return error_response(400, &format!("Provider '{}' not configured", provider_name)),
        }
    };

    let context_hash = {
        let mut state_guard = state.lock();
        state_guard.update_context_signature();
        get_context_hash(state_guard.context_signature.as_ref())
    };

    let cache_key = get_cache_key(method.as_str(), path, body, &context_hash);
    let should_use_cache = should_cache(method.as_str()) && !body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);

    if should_use_cache {
        let state_guard = state.lock();
        if let Some(cached) = state_guard.cache.get(&cache_key) {
            return ok_json(&cached);
        }
    }

    let client = {
        let state_guard = state.lock();
        match state_guard.get_client(&provider_name) {
            Some(c) => c.clone(),
            None => return error_response(500, "Client not available"),
        }
    };

    let req_start = std::time::Instant::now();

    match forward_request(&client, &provider_config, backend_path, body).await {
        Ok(response) => {
            let status = response.status();
            let is_stream = body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);

            if is_stream {
                handle_stream_response(response, state, cache_key, provider_name, req_start).await
            } else {
                handle_normal_response(response, status, state, cache_key, should_use_cache, provider_name, req_start).await
            }
        }
        Err(e) => error_response(502, &e),
    }
}

async fn handle_normal_response(
    response: reqwest::Response,
    status: reqwest::StatusCode,
    state: Arc<Mutex<ProxyState>>,
    cache_key: String,
    should_cache: bool,
    provider_name: String,
    req_start: std::time::Instant,
) -> Result<Response<BoxBody>, hyper::Error> {
    let body_bytes = match collect_stream_body(response).await {
        Ok(b) => b,
        Err(e) => return error_response(502, &e),
    };

    let body_str = String::from_utf8_lossy(&body_bytes).to_string();
    let response_json: serde_json::Value = serde_json::from_str(&body_str).unwrap_or(serde_json::json!({}));

    if should_cache && status.is_success() {
        state.lock().cache.set(&cache_key, response_json.clone());
    }

    let response_time = req_start.elapsed().as_millis() as u64;
    record_usage(&state, &provider_name, &response_json, false, response_time);

    Ok(Response::builder()
        .status(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK))
        .header("Content-Type", "application/json")
        .body(full(body_str))
        .unwrap())
}

async fn handle_stream_response(
    mut response: reqwest::Response,
    state: Arc<Mutex<ProxyState>>,
    _cache_key: String,
    provider_name: String,
    req_start: std::time::Instant,
) -> Result<Response<BoxBody>, hyper::Error> {
    use futures::StreamExt;

    let mut full_body = String::new();
    let mut usage_data: Option<(u64, u64)> = None;

    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Stream error: {}", e)).map_err(|e| error_response(502, &e))? {
        let chunk_str = String::from_utf8_lossy(&chunk).to_string();
        full_body.push_str(&chunk_str);

        for line in chunk_str.lines() {
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(usage) = json.get("usage") {
                        let input_tokens = usage.get("prompt_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                        let output_tokens = usage.get("completion_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
                        usage_data = Some((input_tokens, output_tokens));
                    }
                }
            }
        }
    }

    let response_time = req_start.elapsed().as_millis() as u64;
    if let Some((input_tokens, output_tokens)) = usage_data {
        let state_guard = state.lock();
        if let Some(ref monitor) = state_guard.token_monitor {
            let _ = monitor.record_request(&RequestData {
                provider: provider_name,
                model: "".to_string(),
                input_tokens,
                output_tokens,
                cost: None,
                currency: "USD".to_string(),
                cached: false,
                response_time,
            });
        }
    }

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(full(full_body))
        .unwrap())
}

fn record_usage(
    state: &Arc<Mutex<ProxyState>>,
    provider: &str,
    response_json: &serde_json::Value,
    cached: bool,
    response_time: u64,
) {
    let usage = response_json.get("usage");
    if let Some(usage) = usage {
        let input_tokens = usage.get("prompt_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
        let output_tokens = usage.get("completion_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
        let model = response_json.get("model").and_then(|m| m.as_str()).unwrap_or("");

        let state_guard = state.lock();
        if let Some(ref monitor) = state_guard.token_monitor {
            let _ = monitor.record_request(&RequestData {
                provider: provider.to_string(),
                model: model.to_string(),
                input_tokens,
                output_tokens,
                cost: None,
                currency: "USD".to_string(),
                cached,
                response_time,
            });
        }
    }
}
