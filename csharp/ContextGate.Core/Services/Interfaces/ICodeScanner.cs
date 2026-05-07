using ContextGate.Core.Models;

namespace ContextGate.Core.Services.Interfaces;

public interface ICodeScanner
{
    ScanResult BuildContext(string projectPath, string? outputPath = null);

    List<CodeFile> ScanFiles(string projectPath);

    List<string> Scan(string projectPath);

    SmartExtractionResult BuildPartialContext(string projectPath, string prompt, string? outputPath = null);

    List<string> GetContextFilesList(string contextFile);

    bool IsBinary(string filePath);

    string ExtractIntent(string content);

    int CalculateRelevance(CodeFile file, string intent);

    long EstimateTokens(string text);
}
