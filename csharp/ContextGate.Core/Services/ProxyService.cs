using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ContextGate.Core.Models;
using ContextGate.Core.Services.Interfaces;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;

namespace ContextGate.Core.Services;

/// <summary>
/// AI 代理服务
/// </summary>
public class ProxyService
{
    private readonly IConfigManager _configManager;
    private readonly ITokenMonitor _tokenMonitor;
    private readonly IContextSignatureService _contextSignature;
    private readonly LruCache<string, ChatResponse> _cache;
    private readonly HttpClient _httpClient;
    private readonly ILogger<ProxyService>? _logger;
    private readonly CostCalculator _costCalculator = new();
    private int _requestCount;

    public ProxyService(
        IConfigManager configManager,
        ITokenMonitor tokenMonitor,
        IContextSignatureService contextSignature,
        ILogger<ProxyService>? logger = null)
    {
        _configManager = configManager;
        _tokenMonitor = tokenMonitor;
        _contextSignature = contextSignature;
        _cache = new LruCache<string, ChatResponse>(100);
        _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        _logger = logger;
        _requestCount = 0;
    }

    public int RequestCount => _requestCount;
    public int CacheSize => _cache.Count;

    /// <summary>
    /// 检测提供商
    /// </summary>
    public string DetectProvider(string path)
    {
        var lowerPath = path.ToLowerInvariant();
        if (lowerPath.Contains("zhipu")) return "zhipu";
        if (lowerPath.Contains("deepseek")) return "deepseek";
        if (lowerPath.Contains("openai")) return "openai";
        return "openai";
    }

    /// <summary>
    /// 生成缓存键
    /// </summary>
    public string GetCacheKey(string method, string path, object body)
    {
        var contextHash = _contextSignature.GetContextHash();
        var bodyJson = JsonConvert.SerializeObject(body);
        var bodyHash = ComputeMd5(bodyJson).Substring(0, 12);
        var contextHashShort = contextHash.Length > 8 ? contextHash.Substring(0, 8) : contextHash;
        return $"{method}:{path}:{contextHashShort}:{bodyHash}";
    }

    /// <summary>
    /// 检查并清除缓存（如果上下文已变更）
    /// </summary>
    public void InvalidateCacheIfNeeded()
    {
        if (_contextSignature.CheckContextChanged())
        {
            _logger?.LogInformation("[Cache INVALIDATED] Context file changed");
            _cache.Clear();
            _contextSignature.ReloadSignature();
        }
    }

    /// <summary>
    /// 尝试从缓存获取响应
    /// </summary>
    public bool TryGetCached(string cacheKey, out ChatResponse? response)
    {
        if (_cache.TryGet(cacheKey, out response))
        {
            _logger?.LogInformation($"[Cache HIT] {cacheKey}");
            return true;
        }

        response = null;
        return false;
    }

    /// <summary>
    /// 设置缓存
    /// </summary>
    public void SetCache(string cacheKey, ChatResponse response)
    {
        _cache.Set(cacheKey, response);
        _logger?.LogInformation($"[Cache SET] {cacheKey}");
    }

    /// <summary>
    /// 清除所有缓存
    /// </summary>
    public void ClearCache()
    {
        _cache.Clear();
        _logger?.LogInformation("[Cache CLEARED]");
    }

    /// <summary>
    /// 转发聊天请求
    /// </summary>
    public async Task<ChatResponse> ForwardChatRequestAsync(
        string provider,
        ChatRequest request,
        CancellationToken cancellationToken = default)
    {
        var providerConfig = _configManager.GetProvider(provider);
        if (providerConfig == null)
        {
            throw new InvalidOperationException($"Provider '{provider}' not found");
        }

        var url = $"{providerConfig.BaseUrl}/chat/completions";
        var requestJson = JsonConvert.SerializeObject(request);

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, url);
        httpRequest.Headers.Add("Authorization", $"Bearer {providerConfig.ApiKey}");
        httpRequest.Content = new StringContent(requestJson, Encoding.UTF8, "application/json");

        var startTime = DateTime.UtcNow;
        var response = await _httpClient.SendAsync(httpRequest, cancellationToken);
        var responseTime = (int)(DateTime.UtcNow - startTime).TotalMilliseconds;

        response.EnsureSuccessStatusCode();

        var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
        var chatResponse = JsonConvert.DeserializeObject<ChatResponse>(responseJson);

        if (chatResponse == null)
        {
            throw new InvalidOperationException("Failed to deserialize chat response");
        }

        // 记录请求
        RecordRequest(provider, request.Model, chatResponse, false, responseTime);

        Interlocked.Increment(ref _requestCount);

        return chatResponse;
    }

    /// <summary>
    /// 转发流式聊天请求
    /// </summary>
    public async IAsyncEnumerable<string> ForwardStreamingChatRequestAsync(
        string provider,
        ChatRequest request,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var providerConfig = _configManager.GetProvider(provider);
        if (providerConfig == null)
        {
            throw new InvalidOperationException($"Provider '{provider}' not found");
        }

        var url = $"{providerConfig.BaseUrl}/chat/completions";
        var requestJson = JsonConvert.SerializeObject(request);

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, url);
        httpRequest.Headers.Add("Authorization", $"Bearer {providerConfig.ApiKey}");
        httpRequest.Content = new StringContent(requestJson, Encoding.UTF8, "application/json");

        var startTime = DateTime.UtcNow;
        using var response = await _httpClient.SendAsync(
            httpRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        response.EnsureSuccessStatusCode();

        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        string? lastChunkData = null;

        while (!reader.EndOfStream)
        {
            var line = await reader.ReadLineAsync();
            if (string.IsNullOrEmpty(line))
                continue;

            if (line.StartsWith("data: "))
            {
                var data = line.Substring(6);
                if (data == "[DONE]")
                    break;

                lastChunkData = data;
                yield return line + "\n";
            }
            else
            {
                yield return line + "\n";
            }
        }

        // 尝试解析最后一个数据块以记录使用情况
        if (!string.IsNullOrEmpty(lastChunkData))
        {
            try
            {
                var chatResponse = JsonConvert.DeserializeObject<ChatResponse>(lastChunkData);
                if (chatResponse != null)
                {
                    var responseTime = (int)(DateTime.UtcNow - startTime).TotalMilliseconds;
                    RecordRequest(provider, request.Model, chatResponse, false, responseTime);
                }
            }
            catch (Exception ex)
            {
                _logger?.LogWarning($"Failed to parse stream usage: {ex.Message}");
            }
        }

        Interlocked.Increment(ref _requestCount);
    }

    /// <summary>
    /// 记录请求
    /// </summary>
    private void RecordRequest(string provider, string model, ChatResponse response, bool cached, int responseTime)
    {
        try
        {
            var usage = response.Usage;
            var promptTokens = usage?.PromptTokens ?? 0;
            var completionTokens = usage?.CompletionTokens ?? 0;
            var totalTokens = usage?.TotalTokens ?? 0;
            var cost = cached ? 0m : _costCalculator.CalculateCost(model, promptTokens, completionTokens);

            _tokenMonitor.RecordRequest(new RequestLog
            {
                Timestamp = DateTime.UtcNow,
                Provider = provider,
                Model = model,
                PromptTokens = promptTokens,
                CompletionTokens = completionTokens,
                TotalTokens = totalTokens,
                Cost = cost,
                Cached = cached,
                Path = "/chat/completions",
                Method = "POST",
                ResponseTime = responseTime
            });
        }
        catch (Exception ex)
        {
            _logger?.LogError($"Failed to record request: {ex.Message}");
        }
    }

    public void RecordCacheHit(string provider, string model, ChatResponse response)
    {
        RecordRequest(provider, model, response, true, 0);
        _logger?.LogInformation($"[Cache HIT recorded] {provider}/{model}");
    }

    public ProviderConfig? GetProviderConfig(string provider)
    {
        return _configManager.GetProvider(provider);
    }

    private static string ComputeMd5(string input)
    {
        using var md5 = MD5.Create();
        var hash = md5.ComputeHash(Encoding.UTF8.GetBytes(input));
        return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
    }
}
