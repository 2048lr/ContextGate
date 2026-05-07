namespace ContextGate.Core.Models;

/// <summary>
/// 统计数据
/// </summary>
public class Statistics
{
    /// <summary>
    /// 请求数
    /// </summary>
    public int Requests { get; set; }

    /// <summary>
    /// Token 总数
    /// </summary>
    public long Tokens { get; set; }

    /// <summary>
    /// 总成本（美元）
    /// </summary>
    public decimal Cost { get; set; }

    /// <summary>
    /// 缓存命中数
    /// </summary>
    public int CacheHits { get; set; }

    /// <summary>
    /// 节省百分比
    /// </summary>
    public int SavingsPercent { get; set; }

    /// <summary>
    /// 按提供商统计
    /// </summary>
    public List<ProviderStats> ByProvider { get; set; } = new();

    /// <summary>
    /// 运行时间（秒）
    /// </summary>
    public double Uptime { get; set; }
}

/// <summary>
/// 提供商统计
/// </summary>
public class ProviderStats
{
    /// <summary>
    /// 提供商名称
    /// </summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>
    /// 请求数
    /// </summary>
    public int Count { get; set; }

    /// <summary>
    /// Token 总数
    /// </summary>
    public long Tokens { get; set; }

    /// <summary>
    /// 总成本
    /// </summary>
    public decimal Cost { get; set; }
}

/// <summary>
/// 统计摘要
/// </summary>
public class StatisticsSummary
{
    /// <summary>
    /// 今日统计
    /// </summary>
    public Statistics? Today { get; set; }

    /// <summary>
    /// 本月统计
    /// </summary>
    public Statistics? Month { get; set; }

    /// <summary>
    /// 总计统计
    /// </summary>
    public Statistics? Total { get; set; }

    /// <summary>
    /// 今日节省百分比
    /// </summary>
    public int SavingsPercent { get; set; }

    /// <summary>
    /// 本月节省百分比
    /// </summary>
    public int MonthSavingsPercent { get; set; }

    /// <summary>
    /// 运行时间（秒）
    /// </summary>
    public double Uptime { get; set; }
}
