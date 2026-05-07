using System.Text.RegularExpressions;
using ContextGate.Core.Models;

namespace ContextGate.Core.Services;

public class RelevanceScorer
{
    private readonly List<string> _fileReferences;
    private readonly List<string> _moduleReferences;
    private readonly List<IntentInfo> _intents;
    private readonly List<string> _keywords;

    public RelevanceScorer(
        List<string> fileReferences,
        List<string> moduleReferences,
        List<IntentInfo> intents,
        List<string> keywords)
    {
        _fileReferences = fileReferences;
        _moduleReferences = moduleReferences;
        _intents = intents;
        _keywords = keywords;
    }

    public int ScoreFile(string filePath, string content)
    {
        var score = 0;
        var fileName = Path.GetFileName(filePath);
        var fileNameLower = fileName.ToLower();
        var filePathLower = filePath.ToLower().Replace('\\', '/');
        var contentLower = content.ToLower();

        foreach (var reference in _fileReferences)
        {
            if (filePathLower.Contains(reference.ToLower().Replace('\\', '/')) ||
                fileNameLower.Contains(reference.ToLower()))
            {
                score += 100;
                break;
            }
        }

        foreach (var module in _moduleReferences)
        {
            var moduleLower = module.ToLower();
            if (fileNameLower.Contains(moduleLower) || filePathLower.Contains(moduleLower))
            {
                score += 50;
                break;
            }
        }

        foreach (var intent in _intents)
        {
            foreach (var pattern in intent.FilePatterns)
            {
                var glob = pattern.ToLower();
                var regexPattern = glob
                    .Replace(".", @"\.")
                    .Replace("*", @"[^/\\]*");

                if (Regex.IsMatch(filePathLower, regexPattern) ||
                    Regex.IsMatch(fileNameLower, regexPattern))
                {
                    score += 30;
                    break;
                }
            }
        }

        foreach (var keyword in _keywords)
        {
            var keywordLower = keyword.ToLower();
            if (fileNameLower.Contains(keywordLower))
            {
                score += 20;
                break;
            }
        }

        foreach (var keyword in _keywords)
        {
            var keywordLower = keyword.ToLower();
            if (filePathLower.Contains(keywordLower))
            {
                score += 10;
                break;
            }
        }

        var contentScore = 0;
        foreach (var keyword in _keywords)
        {
            var keywordLower = keyword.ToLower();
            var idx = 0;
            while ((idx = contentLower.IndexOf(keywordLower, idx)) != -1)
            {
                contentScore += 2;
                idx += keywordLower.Length;
                if (contentScore >= 100) break;
            }
            if (contentScore >= 100) break;
        }
        score += Math.Min(contentScore, 100);

        return score;
    }

    public int ScoreCodeBlock(CodeBlock block, List<string> keywords)
    {
        var score = 0;
        var nameLower = block.Name.ToLower();
        var contentLower = block.Content.ToLower();

        foreach (var keyword in keywords)
        {
            var keywordLower = keyword.ToLower();
            if (nameLower.Contains(keywordLower))
            {
                score += 30;
                break;
            }
        }

        var contentScore = 0;
        foreach (var keyword in keywords)
        {
            var keywordLower = keyword.ToLower();
            if (contentLower.Contains(keywordLower))
            {
                contentScore += 3;
            }
        }
        score += Math.Min(contentScore, 50);

        return score;
    }
}
