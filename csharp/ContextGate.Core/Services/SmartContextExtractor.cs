using System.Text;
using ContextGate.Core.Models;

namespace ContextGate.Core.Services;

public class SmartContextExtractor
{
    private readonly IntentExtractor _intentExtractor;
    private readonly CodeBlockExtractor _blockExtractor;
    private readonly CodeScanner _scanner;

    public int MaxTokens { get; set; } = 8000;
    public int MaxFiles { get; set; } = 30;
    public int MaxBlocksPerFile { get; set; } = 5;
    public int MinRelevanceScore { get; set; } = 10;

    public SmartContextExtractor(ScannerConfig? scannerConfig = null)
    {
        _intentExtractor = new IntentExtractor();
        _blockExtractor = new CodeBlockExtractor();
        _scanner = new CodeScanner(scannerConfig ?? new ScannerConfig());
    }

    public SmartExtractionResult Extract(string projectPath, string prompt)
    {
        var intents = _intentExtractor.ExtractIntents(prompt);
        var fileReferences = _intentExtractor.ExtractFileReferences(prompt);
        var moduleReferences = _intentExtractor.ExtractModuleReferences(prompt);
        var keywords = _intentExtractor.GetAllKeywords(prompt);

        var allFiles = _scanner.ScanFiles(projectPath);

        var scorer = new RelevanceScorer(fileReferences, moduleReferences, intents, keywords);

        var scoredFiles = allFiles
            .Select(f => new { File = f, Score = scorer.ScoreFile(f.RelativePath, f.Content) })
            .Where(x => x.Score >= MinRelevanceScore)
            .OrderByDescending(x => x.Score)
            .Take(MaxFiles)
            .ToList();

        var blocks = new List<CodeBlock>();
        var totalTokens = 0L;

        foreach (var scoredFile in scoredFiles)
        {
            var fileBlocks = _blockExtractor.ExtractBlocks(scoredFile.File.Content, scoredFile.File.RelativePath);

            foreach (var block in fileBlocks)
            {
                block.RelevanceScore = scorer.ScoreCodeBlock(block, keywords);
            }

            var topBlocks = fileBlocks
                .Where(b => b.RelevanceScore > 0)
                .OrderByDescending(b => b.RelevanceScore)
                .Take(MaxBlocksPerFile)
                .ToList();

            foreach (var block in topBlocks)
            {
                var blockTokens = block.Content.Length / 4;
                if (totalTokens + blockTokens > MaxTokens)
                {
                    break;
                }

                block.Score = scoredFile.Score;
                blocks.Add(block);
                totalTokens += blockTokens;
            }

            if (totalTokens >= MaxTokens)
            {
                break;
            }
        }

        return new SmartExtractionResult
        {
            Mode = "smart",
            Keywords = keywords,
            Intents = intents.Select(i => i.Name).ToList(),
            FileReferences = fileReferences,
            ModuleReferences = moduleReferences,
            Blocks = blocks,
            TotalTokens = totalTokens,
            Stats = new ExtractionStats
            {
                TotalFiles = allFiles.Count,
                MatchedFiles = scoredFiles.Count,
                ExtractedBlocks = blocks.Count
            }
        };
    }

    public SmartExtractionResult BuildContext(string projectPath, string prompt, string? outputPath = null)
    {
        var result = Extract(projectPath, prompt);

        outputPath ??= Path.Combine(projectPath, "smart_context.txt");

        var sb = new StringBuilder();

        sb.AppendLine("# ContextGate Smart Context");
        sb.AppendLine($"# Generated: {DateTime.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ}");
        sb.AppendLine($"# Mode: {result.Mode}");
        sb.AppendLine($"# Keywords: {string.Join(", ", result.Keywords) ?? "none"}");
        sb.AppendLine($"# Intents: {string.Join(", ", result.Intents) ?? "none"}");
        sb.AppendLine($"# Files Referenced: {string.Join(", ", result.FileReferences) ?? "none"}");
        sb.AppendLine($"# Modules Referenced: {string.Join(", ", result.ModuleReferences) ?? "none"}");
        sb.AppendLine($"# Extracted Blocks: {result.Blocks.Count}");
        sb.AppendLine($"# Estimated Tokens: {result.TotalTokens}");
        sb.AppendLine();

        var fileGroups = new Dictionary<string, List<CodeBlock>>();
        foreach (var block in result.Blocks)
        {
            var file = block.File ?? "unknown";
            if (!fileGroups.ContainsKey(file))
                fileGroups[file] = new List<CodeBlock>();
            fileGroups[file].Add(block);
        }

        foreach (var (file, blocks) in fileGroups)
        {
            sb.AppendLine();
            sb.AppendLine("# ============================================================");
            sb.AppendLine($"# File: {file}");
            sb.AppendLine("# ============================================================");

            foreach (var block in blocks.OrderByDescending(b => b.RelevanceScore))
            {
                if (block.Type == "full")
                {
                    sb.AppendLine(block.Content);
                }
                else
                {
                    sb.AppendLine($"# --- {block.Type}: {block.Name} (lines {block.StartLine}-{block.EndLine}) ---");
                    sb.AppendLine(block.Content);
                }
            }
        }

        var content = sb.ToString();
        File.WriteAllText(outputPath, content, Encoding.UTF8);

        result.OutputPath = outputPath;
        result.ContentLength = content.Length;

        return result;
    }
}
