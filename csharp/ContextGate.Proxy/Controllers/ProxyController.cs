using ContextGate.Core.Models;
using ContextGate.Core.Services;
using ContextGate.Core.Services.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;

namespace ContextGate.Proxy.Controllers;

[ApiController]
[Route("")]
public class ProxyController : ControllerBase
{
    private readonly ProxyService _proxyService;
    private readonly IContextSignatureService _contextSignature;
    private readonly ILogger<ProxyController> _logger;
    private readonly string? _contextFile;

    public ProxyController(
        ProxyService proxyService,
        IContextSignatureService contextSignature,
        ILogger<ProxyController> logger,
        IConfiguration configuration)
    {
        _proxyService = proxyService;
        _contextSignature = contextSignature;
        _logger = logger;
        _contextFile = configuration["ContextFile"];
    }

    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(new
        {
            status = "ok",
            provider = "ContextGate",
            version = "4.0.7"
        });
    }

    [HttpGet("context")]
    public IActionResult GetContext()
    {
        if (string.IsNullOrEmpty(_contextFile) || !System.IO.File.Exists(_contextFile))
        {
            return NotFound(new { error = "Context file not found" });
        }

        var content = System.IO.File.ReadAllText(_contextFile);
        return Content(content, "text/plain");
    }

    [HttpGet("context/hash")]
    public IActionResult GetContextHash()
    {
        _contextSignature.ReloadSignature();
        var signature = _contextSignature.ComputeSignature(_contextFile ?? "", null);

        return Ok(new
        {
            contextFile = _contextFile,
            hash = signature?.MainHash,
            combinedHash = signature?.CombinedHash,
            fileCount = signature?.FileCount ?? 0,
            changed = _contextSignature.CheckContextChanged()
        });
    }

    [HttpGet("stats")]
    public IActionResult GetStats()
    {
        return Ok(new
        {
            requestCount = _proxyService.RequestCount,
            cacheSize = _proxyService.CacheSize,
            contextHash = _contextSignature.GetContextHash(),
            uptime = Environment.TickCount64 / 1000.0
        });
    }

    [HttpDelete("cache")]
    public IActionResult ClearCache()
    {
        _proxyService.ClearCache();
        return Ok(new { success = true });
    }

    [HttpPost("v1/{**path}")]
    public async Task<IActionResult> ProxyV1Request(string path)
    {
        try
        {
            _proxyService.InvalidateCacheIfNeeded();

            var backendPath = "/" + path;
            var provider = _proxyService.DetectProvider(backendPath);

            // 读取请求体
            using var reader = new StreamReader(Request.Body);
            var bodyJson = await reader.ReadToEndAsync();
            var request = JsonConvert.DeserializeObject<ChatRequest>(bodyJson);

            if (request == null)
            {
                return BadRequest(new { error = "Invalid request body" });
            }

            _logger.LogInformation($"[{DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}] POST /v1/{path}");

            // 流式响应
            if (request.Stream)
            {
                var providerConfig = _proxyService.GetProviderConfig(provider);
                if (providerConfig == null)
                {
                    return BadRequest(new { error = $"Unknown provider: {provider}" });
                }

                Response.Headers["Content-Type"] = "text/event-stream";
                Response.Headers["Cache-Control"] = "no-cache";
                Response.Headers["Connection"] = "keep-alive";
                Response.Headers["X-Accel-Buffering"] = "no";

                await foreach (var chunk in _proxyService.ForwardStreamingChatRequestAsync(
                    provider, request, HttpContext.RequestAborted))
                {
                    await Response.WriteAsync(chunk);
                    await Response.Body.FlushAsync();
                }

                return new EmptyResult();
            }

            // 非流式响应 - 检查缓存
            var cacheKey = _proxyService.GetCacheKey(Request.Method, Request.Path, request);

            if (_proxyService.TryGetCached(cacheKey, out var cachedResponse) && cachedResponse != null)
            {
                _proxyService.RecordCacheHit(provider, request.Model, cachedResponse);
                return Ok(cachedResponse);
            }

            // 转发请求
            var response = await _proxyService.ForwardChatRequestAsync(provider, request, HttpContext.RequestAborted);

            // 缓存响应
            _proxyService.SetCache(cacheKey, response);

            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError($"Proxy error: {ex.Message}");
            return StatusCode(500, new
            {
                error = ex.Message,
                details = ex.InnerException?.Message
            });
        }
    }

    [HttpPost("proxy/chat")]
    public async Task<IActionResult> ProxyChat([FromBody] ProxyChatRequest request)
    {
        try
        {
            _proxyService.InvalidateCacheIfNeeded();

            var provider = request.Provider ?? "openai";
            var chatRequest = new ChatRequest
            {
                Model = request.Model,
                Messages = request.Messages,
                Temperature = request.Temperature,
                MaxTokens = request.MaxTokens,
                Stream = request.Stream,
                TopP = request.TopP,
                FrequencyPenalty = request.FrequencyPenalty,
                PresencePenalty = request.PresencePenalty
            };

            var cacheKey = _proxyService.GetCacheKey("POST", "/proxy/chat", chatRequest);

            if (_proxyService.TryGetCached(cacheKey, out var cachedResponse) && cachedResponse != null)
            {
                _proxyService.RecordCacheHit(provider, chatRequest.Model, cachedResponse);
                return Ok(cachedResponse);
            }

            var response = await _proxyService.ForwardChatRequestAsync(provider, chatRequest, HttpContext.RequestAborted);
            _proxyService.SetCache(cacheKey, response);

            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError($"Proxy chat error: {ex.Message}");
            return StatusCode(500, new { error = ex.Message });
        }
    }
}

public class ProxyChatRequest
{
    [JsonProperty("provider")]
    public string? Provider { get; set; }

    [JsonProperty("model")]
    public string Model { get; set; } = string.Empty;

    [JsonProperty("messages")]
    public List<ChatMessage> Messages { get; set; } = new();

    [JsonProperty("temperature")]
    public double? Temperature { get; set; }

    [JsonProperty("max_tokens")]
    public int? MaxTokens { get; set; }

    [JsonProperty("stream")]
    public bool Stream { get; set; }

    [JsonProperty("top_p")]
    public double? TopP { get; set; }

    [JsonProperty("frequency_penalty")]
    public double? FrequencyPenalty { get; set; }

    [JsonProperty("presence_penalty")]
    public double? PresencePenalty { get; set; }
}
