namespace ContextGate.Core.Models;

public class DailyStats
{
    public string Date { get; set; } = string.Empty;
    public int TotalRequests { get; set; }
    public long TotalTokens { get; set; }
    public decimal TotalCost { get; set; }
    public int CacheHits { get; set; }
}
