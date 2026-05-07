namespace ContextGate.Core.Models;

/// <summary>
/// 上下文配置
/// </summary>
public class ContextConfig
{
    /// <summary>
    /// 输出文件名
    /// </summary>
    public string OutputFile { get; set; } = "full_context.txt";

    /// <summary>
    /// 是否启用文件监视
    /// </summary>
    public bool WatchEnabled { get; set; } = true;

    /// <summary>
    /// 防抖延迟（秒）
    /// </summary>
    public double DebounceSeconds { get; set; } = 1.0;
}
