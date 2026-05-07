namespace ContextGate.Core.Models;

/// <summary>
/// 应用程序配置（根配置）
/// </summary>
public class AppConfig
{
    /// <summary>
    /// 工作区路径
    /// </summary>
    public string? Workspace { get; set; }

    /// <summary>
    /// 默认提供商
    /// </summary>
    public string DefaultProvider { get; set; } = "openai";

    /// <summary>
    /// 提供商配置字典
    /// </summary>
    public Dictionary<string, ProviderConfig> Providers { get; set; } = new();

    /// <summary>
    /// 代理配置
    /// </summary>
    public ProxyConfig Proxy { get; set; } = new();

    /// <summary>
    /// 监控配置
    /// </summary>
    public MonitorConfig Monitor { get; set; } = new();

    /// <summary>
    /// 扫描器配置
    /// </summary>
    public ScannerConfig Scanner { get; set; } = new();

    /// <summary>
    /// 上下文配置
    /// </summary>
    public ContextConfig Context { get; set; } = new();

    /// <summary>
    /// 货币配置
    /// </summary>
    public CurrencyConfig Currency { get; set; } = new();
}
