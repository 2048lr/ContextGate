namespace ContextGate.Core.Models;

/// <summary>
/// 代理服务器配置
/// </summary>
public class ProxyConfig
{
    /// <summary>
    /// 监听主机地址
    /// </summary>
    public string Host { get; set; } = "127.0.0.1";

    /// <summary>
    /// 监听端口
    /// </summary>
    public int Port { get; set; } = 12306;

    /// <summary>
    /// 是否启用请求清洗
    /// </summary>
    public bool SanitizeRequests { get; set; } = true;
}
