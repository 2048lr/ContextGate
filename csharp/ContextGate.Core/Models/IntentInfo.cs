namespace ContextGate.Core.Models;

public class IntentInfo
{
    public string Name { get; set; } = string.Empty;
    public List<string> Keywords { get; set; } = new();
    public List<string> FilePatterns { get; set; } = new();
    public double Confidence { get; set; }
}
