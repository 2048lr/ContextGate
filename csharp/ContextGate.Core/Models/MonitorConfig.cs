namespace ContextGate.Core.Models;

/// <summary>
/// 监控配置
/// </summary>
public class MonitorConfig
{
    /// <summary>
    /// 预算限制（美元）
    /// </summary>
    public decimal BudgetLimit { get; set; } = 10m;

    /// <summary>
    /// 警告阈值（百分比）
    /// </summary>
    public int WarningThreshold { get; set; } = 75;

    /// <summary>
    /// 临界阈值（百分比）
    /// </summary>
    public int CriticalThreshold { get; set; } = 90;

    /// <summary>
    /// 数据库路径
    /// </summary>
    public string DbPath { get; set; } = "contextgate.db";
}
