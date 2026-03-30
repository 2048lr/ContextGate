"""
任务 2：FastAPI 代理与请求清洗逻辑
负责代理 AI API 请求，强制执行 System-User 双消息模式
注入 full_context.txt 并剔除缓存失效的动态变量
支持多后端路由
"""

import re
import json
import hashlib
import time
import yaml
import random
import socket
from pathlib import Path
from typing import Dict, Any, List, Optional, Callable, Tuple
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import StreamingResponse
import httpx


class ConfigManager:
    """配置管理器 - 管理工作空间和配置"""
    
    def __init__(self, config_path: str = "config.yaml"):
        self.config_path = Path(config_path)
        self.config: Dict[str, Any] = {}
        self._load_config()
    
    def _load_config(self) -> None:
        if self.config_path.exists():
            with open(self.config_path, "r", encoding="utf-8") as f:
                self.config = yaml.safe_load(f) or {}
    
    def _save_config(self) -> None:
        with open(self.config_path, "w", encoding="utf-8") as f:
            yaml.dump(self.config, f, default_flow_style=False, allow_unicode=True)
    
    def get_workspace(self) -> Optional[str]:
        return self.config.get("current_workspace")
    
    def set_workspace(self, workspace_path: str) -> None:
        self.config["current_workspace"] = str(workspace_path)
        self._save_config()
    
    def get_context_file(self) -> str:
        workspace = self.get_workspace()
        if workspace:
            return str(Path(workspace) / "full_context.txt")
        return "full_context.txt"


@dataclass
class CacheEntry:
    cache_key: str
    timestamp: datetime
    hit_count: int = 0


@dataclass
class ProviderConfig:
    name: str
    api_key: str
    base_url: str
    models: List[str] = field(default_factory=list)


class DynamicVariableCleaner:
    """动态变量清洗器 - 剔除导致缓存失效的动态变量"""
    
    def __init__(self):
        self.dynamic_patterns = [
            (re.compile(r'\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?\b'), '[TIMESTAMP]'),
            (re.compile(r'\b\d{4}/\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2}\b'), '[DATETIME]'),
            (re.compile(r'\b\d{10,13}\b'), '[TIMESTAMP_INT]'),
            (re.compile(r'\buuid[:\s]*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b', re.I), '[UUID]'),
            (re.compile(r'\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b', re.I), '[UUID]'),
            (re.compile(r'\brandom[_\s]*\d+\b', re.I), '[RANDOM]'),
            (re.compile(r'\bnonce[_\s]*[:=]\s*["\']?[a-zA-Z0-9]+["\']?\b', re.I), '[NONCE]'),
            (re.compile(r'\brequest[_\s]*id[:\s]*["\']?[a-zA-Z0-9\-]+["\']?\b', re.I), '[REQUEST_ID]'),
            (re.compile(r'\bsession[_\s]*id[:\s]*["\']?[a-zA-Z0-9\-]+["\']?\b', re.I), '[SESSION_ID]'),
        ]
    
    def clean_text(self, text: str) -> str:
        for pattern, replacement in self.dynamic_patterns:
            text = pattern.sub(replacement, text)
        return text
    
    def clean_dict(self, data: Dict[str, Any], depth: int = 0) -> Dict[str, Any]:
        if depth > 10:
            return data
        
        result = {}
        for key, value in data.items():
            if isinstance(value, str):
                result[key] = self.clean_text(value)
            elif isinstance(value, dict):
                result[key] = self.clean_dict(value, depth + 1)
            elif isinstance(value, list):
                result[key] = self.clean_list(value, depth + 1)
            else:
                result[key] = value
        return result
    
    def clean_list(self, data: List[Any], depth: int = 0) -> List[Any]:
        if depth > 10:
            return data
        
        result = []
        for item in data:
            if isinstance(item, str):
                result.append(self.clean_text(item))
            elif isinstance(item, dict):
                result.append(self.clean_dict(item, depth + 1))
            elif isinstance(item, list):
                result.append(self.clean_list(item, depth + 1))
            else:
                result.append(item)
        return result


class MessageTransformer:
    """消息转换器 - 强制执行 System-User 双消息模式"""
    
    def __init__(self, context_file: str = "full_context.txt"):
        self.context_file = Path(context_file)
        self.context_content: Optional[str] = None
        self.context_hash: Optional[str] = None
        self._load_context()
    
    def _load_context(self) -> None:
        if self.context_file.exists():
            with open(self.context_file, "r", encoding="utf-8") as f:
                self.context_content = f.read()
            self.context_hash = hashlib.md5(self.context_content.encode()).hexdigest()[:8]
    
    def reload_context(self) -> bool:
        old_hash = self.context_hash
        self._load_context()
        return self.context_hash != old_hash
    
    def transform_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        transformed = []
        
        has_system = any(m.get("role") == "system" for m in messages)
        
        if not has_system and self.context_content:
            system_content = self._build_system_message()
            transformed.append({"role": "system", "content": system_content})
        
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            
            if role == "system":
                if self.context_content:
                    enhanced_content = self._enhance_system_message(content)
                    transformed.append({"role": "system", "content": enhanced_content})
                else:
                    transformed.append(msg)
            elif role in ("user", "assistant"):
                transformed.append(msg)
        
        if not any(m.get("role") == "user" for m in transformed):
            transformed.append({"role": "user", "content": "请继续"})
        
        return transformed
    
    def _build_system_message(self) -> str:
        return f"""<context>
{self.context_content}
</context>

You have been provided with the complete project context above. Use this information to answer questions accurately and provide relevant code suggestions."""
    
    def _enhance_system_message(self, original: str) -> str:
        if self.context_content:
            return f"""{original}

<project_context hash="{self.context_hash}">
{self.context_content}
</project_context>"""
        return original


class CacheManager:
    """缓存管理器"""
    
    def __init__(self):
        self.cache: Dict[str, CacheEntry] = {}
        self.total_requests = 0
        self.cache_hits = 0
    
    def generate_cache_key(self, messages: List[Dict[str, Any]], model: str) -> str:
        content = json.dumps(messages, sort_keys=True, ensure_ascii=False)
        content_hash = hashlib.md5(content.encode()).hexdigest()
        return f"{model}:{content_hash}"
    
    def check_cache(self, cache_key: str) -> Optional[CacheEntry]:
        self.total_requests += 1
        if cache_key in self.cache:
            self.cache_hits += 1
            self.cache[cache_key].hit_count += 1
            return self.cache[cache_key]
        return None
    
    def store_cache(self, cache_key: str) -> None:
        if cache_key not in self.cache:
            self.cache[cache_key] = CacheEntry(
                cache_key=cache_key,
                timestamp=datetime.now()
            )
    
    def get_hit_rate(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return (self.cache_hits / self.total_requests) * 100


class ProviderRouter:
    """多后端路由器"""
    
    MODEL_PREFIX_MAP = {
        "openai": ["gpt-", "o1-", "o3-"],
        "anthropic": ["claude-"],
        "zhipu": ["glm-", "chatglm"],
        "deepseek": ["deepseek-"],
    }
    
    def __init__(self, config_path: str = "config.yaml"):
        self.providers: Dict[str, ProviderConfig] = {}
        self.default_provider: str = "openai"
        self._load_config(config_path)
    
    def _load_config(self, config_path: str) -> None:
        config_file = Path(config_path)
        if not config_file.exists():
            return
        
        with open(config_file, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)
        
        if not config:
            return
        
        self.default_provider = config.get("default_provider", "openai")
        
        providers_config = config.get("providers", {})
        for name, provider_data in providers_config.items():
            self.providers[name] = ProviderConfig(
                name=name,
                api_key=provider_data.get("api_key", ""),
                base_url=provider_data.get("base_url", ""),
                models=provider_data.get("models", [])
            )
    
    def get_provider_for_model(self, model: str) -> Optional[ProviderConfig]:
        """根据模型名称获取对应的提供商配置"""
        model_lower = model.lower()
        
        for provider_name, prefixes in self.MODEL_PREFIX_MAP.items():
            for prefix in prefixes:
                if model_lower.startswith(prefix):
                    if provider_name in self.providers:
                        return self.providers[provider_name]
        
        for provider_name, provider in self.providers.items():
            for m in provider.models:
                if m.lower() == model_lower:
                    return provider
        
        if self.default_provider in self.providers:
            return self.providers[self.default_provider]
        
        return None


class ProxyMonitor:
    """代理监控器 - 用于收集监控数据"""
    
    _instance = None
    
    def __init__(self):
        self.requests: List[Dict[str, Any]] = []
        self.cache_manager = CacheManager()
        self.on_request: Optional[Callable] = None
        self.on_context_update: Optional[Callable] = None
    
    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    def record_request(self, data: Dict[str, Any]) -> None:
        self.requests.append(data)
        if self.on_request:
            self.on_request(data)


class AIProxy:
    """AI API 代理服务器"""
    
    def __init__(
        self, 
        base_url: str = None,
        api_key: str = None,
        context_file: str = "full_context.txt",
        config_path: str = "config.yaml"
    ):
        self.context_file = context_file
        self.config_path = config_path
        self.cleaner = DynamicVariableCleaner()
        self.transformer = MessageTransformer(context_file)
        self.monitor = ProxyMonitor.get_instance()
        self.router = ProviderRouter(config_path)
        
        self.default_base_url = base_url
        self.default_api_key = api_key
        
        self.app = FastAPI(title="ContextGate Proxy")
        self._setup_routes()
    
    def _setup_routes(self) -> None:
        @self.app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
        async def proxy_request(request: Request, path: str):
            return await self._handle_request(request, path)
        
        @self.app.get("/_proxy/status")
        async def proxy_status():
            return {
                "status": "running",
                "cache_hit_rate": self.monitor.cache_manager.get_hit_rate(),
                "total_requests": self.monitor.cache_manager.total_requests,
                "cache_hits": self.monitor.cache_manager.cache_hits,
                "providers": list(self.router.providers.keys())
            }
    
    def _get_provider_config(self, model: str) -> tuple:
        """获取提供商配置"""
        provider = self.router.get_provider_for_model(model)
        
        if provider:
            return provider.base_url, provider.api_key, provider.name
        
        if self.default_base_url and self.default_api_key:
            return self.default_base_url, self.default_api_key, "default"
        
        raise HTTPException(status_code=400, detail=f"No provider configured for model: {model}")
    
    async def _handle_request(self, request: Request, path: str) -> Response:
        method = request.method
        
        try:
            body = await request.body()
            request_data = {}
            
            if body:
                try:
                    request_data = json.loads(body)
                except json.JSONDecodeError:
                    pass
            
            is_chat_request = "chat/completions" in path or "messages" in path
            
            if is_chat_request and request_data:
                model = request_data.get("model", "gpt-4")
                base_url, api_key, provider_name = self._get_provider_config(model)
                target_url = f"{base_url.rstrip('/')}/{path}"
                request_data = self._process_chat_request(request_data, provider_name)
            else:
                if self.default_base_url:
                    target_url = f"{self.default_base_url.rstrip('/')}/{path}"
                    api_key = self.default_api_key
                else:
                    raise HTTPException(status_code=400, detail="No provider configured")
            
            headers = self._build_headers(request, api_key)
            
            request_body = json.dumps(request_data).encode() if request_data else body
            
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.request(
                    method=method,
                    url=target_url,
                    headers=headers,
                    content=request_body,
                )
            
            if is_chat_request:
                await self._process_response(response, request_data)
            
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.headers.get("content-type")
            )
        
        except httpx.RequestError as e:
            error_msg = f"Proxy error: {str(e)}"
            raise HTTPException(status_code=502, detail=error_msg)
    
    def _build_headers(self, request: Request, api_key: str) -> Dict[str, str]:
        headers = {}
        for key, value in request.headers.items():
            if key.lower() not in ("host", "content-length", "transfer-encoding"):
                headers[key] = value
        
        headers["Authorization"] = f"Bearer {api_key}"
        headers["Content-Type"] = "application/json"
        
        return headers
    
    def _process_chat_request(self, request_data: Dict[str, Any], provider: str = "openai") -> Dict[str, Any]:
        messages = request_data.get("messages", [])
        model = request_data.get("model", "gpt-4")
        
        messages = self.transformer.transform_messages(messages)
        
        cleaned_messages = self.cleaner.clean_list(messages)
        
        cache_key = self.monitor.cache_manager.generate_cache_key(cleaned_messages, model)
        cache_entry = self.monitor.cache_manager.check_cache(cache_key)
        
        is_cache_hit = cache_entry is not None
        
        if is_cache_hit:
            print(f"\n{'='*60}")
            print(f"  ✓ Cache Hit! (Key: {cache_key[:20]}...)")
            print(f"  Hit count: {cache_entry.hit_count}")
            print(f"  Provider: {provider}")
            print(f"{'='*60}\n")
        else:
            self.monitor.cache_manager.store_cache(cache_key)
            print(f"\n{'='*60}")
            print(f"  ✗ Cache Miss - New request cached")
            print(f"  Key: {cache_key[:20]}...")
            print(f"  Provider: {provider}")
            print(f"{'='*60}\n")
        
        request_data["messages"] = messages
        
        if "temperature" not in request_data:
            request_data["temperature"] = 0.0
        
        return request_data
    
    async def _process_response(self, response: Response, request_data: Dict[str, Any]) -> None:
        try:
            if response.status_code == 200:
                content_type = response.headers.get("content-type", "")
                
                if "application/json" in content_type:
                    response_data = json.loads(response.content)
                    usage = response_data.get("usage", {})
                    
                    self.monitor.record_request({
                        "timestamp": datetime.now().isoformat(),
                        "model": request_data.get("model", "unknown"),
                        "input_tokens": usage.get("prompt_tokens", 0),
                        "output_tokens": usage.get("completion_tokens", 0),
                        "total_tokens": usage.get("total_tokens", 0),
                        "cache_hit": self.monitor.cache_manager.cache_hits > 0
                    })
        except Exception:
            pass
    
    def run(self, host: str = "127.0.0.1", port: int = 8080) -> Tuple[int, bool]:
        """
        启动代理服务器，支持智能端口避让
        返回: (实际端口, 是否成功)
        """
        import uvicorn
        
        actual_port = self._find_available_port(host, port)
        
        if actual_port != port:
            print(f"\n[Port] 端口 {port} 已被占用，自动切换到 {actual_port}\n")
        
        uvicorn.run(self.app, host=host, port=actual_port, log_level="warning")
        return actual_port, True
    
    def _is_port_available(self, host: str, port: int) -> bool:
        """检查端口是否可用"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                s.bind((host, port))
                return True
        except (OSError, socket.error):
            return False
    
    def _find_available_port(self, host: str, start_port: int) -> int:
        """查找可用端口，如果默认端口被占用则随机选择"""
        if self._is_port_available(host, start_port):
            return start_port
        
        for _ in range(20):
            random_port = random.randint(10000, 65535)
            if self._is_port_available(host, random_port):
                return random_port
        
        raise RuntimeError("无法找到可用端口 (尝试了 21 个端口)")
