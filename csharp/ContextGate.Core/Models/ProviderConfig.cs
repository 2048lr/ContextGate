namespace ContextGate.Core.Models;

/// <summary>
/// AI 提供商配置
/// </summary>
public class ProviderConfig
{
    /// <summary>
    /// API 密钥
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// 基础 URL
    /// </summary>
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>
    /// 支持的模型列表
    /// </summary>
    public List<string> Models { get; set; } = new();
}
