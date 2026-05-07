using System.Text.RegularExpressions;
using ContextGate.Core.Models;

namespace ContextGate.Core.Services;

public class CodeBlockExtractor
{
    private static readonly Dictionary<string, string> ExtensionToLanguage = new()
    {
        [".js"] = "javascript",
        [".jsx"] = "javascript",
        [".mjs"] = "javascript",
        [".cjs"] = "javascript",
        [".ts"] = "typescript",
        [".tsx"] = "typescript",
        [".mts"] = "typescript",
        [".py"] = "python",
        [".go"] = "go",
        [".java"] = "java",
        [".cs"] = "csharp"
    };

    private static readonly Dictionary<string, Dictionary<string, string>> LanguagePatterns = new()
    {
        ["javascript"] = new()
        {
            ["function"] = @"(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(",
            ["arrow"] = @"(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(",
            ["class"] = @"(?:export\s+)?(?:default\s+)?class\s+(\w+)",
            ["method"] = @"(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{"
        },
        ["typescript"] = new()
        {
            ["function"] = @"(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]",
            ["arrow"] = @"(?:export\s+)?(?:const|let|var)\s+(\w+)\s*:\s*(?:\([^)]*\)|\w+)\s*=>",
            ["class"] = @"(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)",
            ["interface"] = @"(?:export\s+)?interface\s+(\w+)",
            ["type"] = @"(?:export\s+)?type\s+(\w+)\s*=",
            ["method"] = @"(?:async\s+)?(?:private|public|protected)?\s*(?:readonly\s+)?(\w+)\s*[<(]"
        },
        ["python"] = new()
        {
            ["function"] = @"def\s+(\w+)\s*\(",
            ["class"] = @"class\s+(\w+)",
            ["method"] = @"def\s+(\w+)\s*\(self"
        },
        ["go"] = new()
        {
            ["function"] = @"func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(",
            ["interface"] = @"type\s+(\w+)\s+interface\s*\{",
            ["struct"] = @"type\s+(\w+)\s+struct\s*\{",
            ["method"] = @"func\s+\([^)]+\)\s+(\w+)\s*\("
        },
        ["java"] = new()
        {
            ["class"] = @"(?:public|private|protected)?\s*(?:abstract|final|static)?\s*class\s+(\w+)",
            ["interface"] = @"(?:public|private|protected)?\s*interface\s+(\w+)",
            ["method"] = @"(?:public|private|protected)?\s*(?:static|abstract|final|synchronized)?\s*\w+(?:<[^>]+>)?\s+(\w+)\s*\("
        },
        ["csharp"] = new()
        {
            ["class"] = @"(?:public|private|protected|internal)?\s*(?:abstract|sealed|static)?\s*class\s+(\w+)",
            ["interface"] = @"(?:public|private|protected|internal)?\s*interface\s+(\w+)",
            ["method"] = @"(?:public|private|protected|internal)?\s*(?:static|virtual|override|async)?\s*\w+\s+(\w+)\s*\([^)]*\)"
        }
    };

    public List<CodeBlock> ExtractBlocks(string content, string filePath)
    {
        var ext = Path.GetExtension(filePath).ToLower();
        if (!ExtensionToLanguage.TryGetValue(ext, out var language))
        {
            return ExtractFullFileBlock(content, filePath);
        }

        if (language == "csharp")
        {
            return ExtractCSharpBlocks(content, filePath);
        }

        if (!LanguagePatterns.TryGetValue(language, out var patterns))
        {
            return ExtractFullFileBlock(content, filePath);
        }

        var blocks = new List<CodeBlock>();
        var lines = content.Split('\n');

        foreach (var (blockType, pattern) in patterns)
        {
            var regex = new Regex(pattern, RegexOptions.Multiline);
            var matches = regex.Matches(content);

            foreach (Match match in matches)
            {
                var name = match.Groups[1].Value;
                var startLine = GetLineNumber(content, match.Index);
                var endLine = FindBlockEnd(lines, startLine - 1);
                var blockContent = GetBlockContent(lines, startLine - 1, endLine - 1);

                if (blockContent.Length >= 50 && blockContent.Length <= 5000)
                {
                    blocks.Add(new CodeBlock
                    {
                        Type = blockType,
                        Name = name,
                        Content = blockContent,
                        StartLine = startLine,
                        EndLine = endLine,
                        File = filePath
                    });
                }
            }
        }

        return blocks.DistinctBy(b => (b.Type, b.Name, b.StartLine)).ToList();
    }

    private List<CodeBlock> ExtractCSharpBlocks(string content, string filePath)
    {
        var blocks = new List<CodeBlock>();
        var lines = content.Split('\n');

        if (!LanguagePatterns.TryGetValue("csharp", out var patterns))
        {
            return blocks;
        }

        foreach (var (blockType, pattern) in patterns)
        {
            var regex = new Regex(pattern, RegexOptions.Multiline);
            var matches = regex.Matches(content);

            foreach (Match match in matches)
            {
                var name = match.Groups[1].Value;
                var startLine = GetLineNumber(content, match.Index);
                var endLine = FindCSharpBlockEnd(lines, startLine - 1);
                var blockContent = GetBlockContent(lines, startLine - 1, endLine - 1);

                if (blockContent.Length >= 50 && blockContent.Length <= 5000)
                {
                    blocks.Add(new CodeBlock
                    {
                        Type = blockType,
                        Name = name,
                        Content = blockContent,
                        StartLine = startLine,
                        EndLine = endLine,
                        File = filePath
                    });
                }
            }
        }

        return blocks.DistinctBy(b => (b.Type, b.Name, b.StartLine)).ToList();
    }

    private int FindCSharpBlockEnd(string[] lines, int startIndex)
    {
        if (startIndex < 0 || startIndex >= lines.Length)
        {
            return startIndex + 1;
        }

        var braceCount = 0;
        var foundOpen = false;

        for (var i = startIndex; i < lines.Length; i++)
        {
            foreach (var c in lines[i])
            {
                if (c == '{')
                {
                    braceCount++;
                    foundOpen = true;
                }
                else if (c == '}')
                {
                    braceCount--;
                }
            }

            if (foundOpen && braceCount <= 0)
            {
                return i + 1;
            }
        }

        return lines.Length;
    }

    private static List<CodeBlock> ExtractFullFileBlock(string content, string filePath)
    {
        if (content.Length < 50)
        {
            return [];
        }

        return
        [
            new CodeBlock
            {
                Type = "full",
                Name = Path.GetFileNameWithoutExtension(filePath),
                Content = content.Length > 5000 ? content[..5000] : content,
                StartLine = 1,
                EndLine = content.Split('\n').Length,
                File = filePath
            }
        ];
    }

    private static int GetLineNumber(string content, int index)
    {
        var lineCount = 1;
        for (var i = 0; i < index && i < content.Length; i++)
        {
            if (content[i] == '\n')
            {
                lineCount++;
            }
        }
        return lineCount;
    }

    private static int FindBlockEnd(string[] lines, int startIndex)
    {
        if (startIndex < 0 || startIndex >= lines.Length)
        {
            return startIndex + 1;
        }

        var braceCount = 0;
        var foundOpen = false;

        for (var i = startIndex; i < lines.Length; i++)
        {
            var line = lines[i];
            var inString = false;
            var escapeNext = false;

            for (var j = 0; j < line.Length; j++)
            {
                if (escapeNext)
                {
                    escapeNext = false;
                    continue;
                }

                if (line[j] == '\\')
                {
                    escapeNext = true;
                    continue;
                }

                if (line[j] == '"' || line[j] == '\'' || line[j] == '`')
                {
                    inString = !inString;
                    continue;
                }

                if (inString) continue;

                if (line[j] == '{')
                {
                    braceCount++;
                    foundOpen = true;
                }
                else if (line[j] == '}')
                {
                    braceCount--;
                }
            }

            if (foundOpen && braceCount <= 0)
            {
                return i + 1;
            }

            if (!foundOpen && i > startIndex + 5)
            {
                return Math.Min(i + 1, lines.Length);
            }
        }

        return lines.Length;
    }

    private static string GetBlockContent(string[] lines, int startLine, int endLine)
    {
        if (startLine < 0) startLine = 0;
        if (endLine >= lines.Length) endLine = lines.Length - 1;
        if (startLine > endLine) return string.Empty;

        var blockLines = lines[startLine..(endLine + 1)];
        return string.Join('\n', blockLines);
    }
}
