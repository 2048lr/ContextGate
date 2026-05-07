namespace ContextGate.Desktop.ViewModels;

public class LogEntry
{
    public string Time { get; set; } = string.Empty;
    public string Method { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string Tokens { get; set; } = string.Empty;
    public string Cost { get; set; } = string.Empty;
    public bool IsCacheHit { get; set; }
    public string CacheHitText => IsCacheHit ? "命中" : "未命中";
}
