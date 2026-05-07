using ContextGate.Core.Models;

namespace ContextGate.Core.Services.Interfaces;

/// <summary>
/// 配置管理服务接口
/// </summary>
public interface IConfigManager
{
    /// <summary>
    /// 加载配置
    /// </summary>
    AppConfig LoadConfig();

    /// <summary>
    /// 保存配置
    /// </summary>
    bool SaveConfig(AppConfig config);

    /// <summary>
    /// 获取提供商配置
    /// </summary>
    ProviderConfig? GetProvider(string name);

    /// <summary>
    /// 设置工作区路径
    /// </summary>
    void SetWorkspace(string path);

    /// <summary>
    /// 获取工作区路径
    /// </summary>
    string? GetWorkspace();

    /// <summary>
    /// 获取所有提供商配置
    /// </summary>
    Dictionary<string, ProviderConfig> GetAllProviders();

    /// <summary>
    /// 获取代理配置
    /// </summary>
    ProxyConfig GetProxyConfig();

    /// <summary>
    /// 获取监控配置
    /// </summary>
    MonitorConfig GetMonitorConfig();

    /// <summary>
    /// 获取货币配置
    /// </summary>
    CurrencyConfig GetCurrencyConfig();

    /// <summary>
    /// 配置文件路径
    /// </summary>
    string ConfigPath { get; }
}
