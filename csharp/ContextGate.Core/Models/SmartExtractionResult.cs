namespace ContextGate.Core.Models;

public class SmartExtractionResult
{
    public string Mode { get; set; } = "smart";
    public List<string> Keywords { get; set; } = new();
    public List<string> Intents { get; set; } = new();
    public List<string> FileReferences { get; set; } = new();
    public List<string> ModuleReferences { get; set; } = new();
    public List<CodeBlock> Blocks { get; set; } = new();
    public long TotalTokens { get; set; }
    public ExtractionStats Stats { get; set; } = new();
    public string? OutputPath { get; set; }
    public long ContentLength { get; set; }
}

public class ExtractionStats
{
    public int TotalFiles { get; set; }
    public int MatchedFiles { get; set; }
    public int ExtractedBlocks { get; set; }
}
