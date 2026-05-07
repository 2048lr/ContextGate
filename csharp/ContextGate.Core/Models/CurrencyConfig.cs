namespace ContextGate.Core.Models;

/// <summary>
/// 货币配置
/// </summary>
public class CurrencyConfig
{
    /// <summary>
    /// 固定货币（为空则自动检测）
    /// </summary>
    public string? FixedCurrency { get; set; }

    /// <summary>
    /// 固定汇率（可选）
    /// </summary>
    public decimal? FixedRate { get; set; }

    /// <summary>
    /// 默认汇率（相对于美元）
    /// </summary>
    public Dictionary<string, decimal> DefaultRates { get; set; } = new()
    {
        { "CNY", 7.2m },
        { "EUR", 0.92m }
    };
}
