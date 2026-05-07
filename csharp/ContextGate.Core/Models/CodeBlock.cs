namespace ContextGate.Core.Models;

public class CodeBlock
{
    public string Type { get; set; } = "full";
    public string Name { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public int StartLine { get; set; }
    public int EndLine { get; set; }
    public int Score { get; set; }
    public string? File { get; set; }
    public int RelevanceScore { get; set; }
}
