namespace ContextGate.Core.Models;

/// <summary>
/// 请求日志记录
/// </summary>
public class RequestLog
{
    /// <summary>
    /// 请求 ID
    /// </summary>
    public long Id { get; set; }

    /// <summary>
    /// 时间戳
    /// </summary>
    public DateTime Timestamp { get; set; }

    /// <summary>
    /// 提供商名称
    /// </summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>
    /// 模型名称
    /// </summary>
    public string Model { get; set; } = string.Empty;

    /// <summary>
    /// 总 Token 数
    /// </summary>
    public int TotalTokens { get; set; }

    /// <summary>
    /// 提示 Token 数
    /// </summary>
    public int PromptTokens { get; set; }

    /// <summary>
    /// 完成 Token 数
    /// </summary>
    public int CompletionTokens { get; set; }

    /// <summary>
    /// 成本（美元）
    /// </summary>
    public decimal Cost { get; set; }

    /// <summary>
    /// 是否缓存命中
    /// </summary>
    public bool Cached { get; set; }

    /// <summary>
    /// 请求路径
    /// </summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>
    /// HTTP 方法
    /// </summary>
    public string Method { get; set; } = "POST";

    /// <summary>
    /// 响应时间（毫秒）
    /// </summary>
    public int ResponseTime { get; set; }
}
