using ContextGate.Core.Models;
using ContextGate.Core.Services.Interfaces;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace ContextGate.Core.Services;

public class CodeScanner : ICodeScanner
{
    private static readonly HashSet<string> BINARY_EXTENSIONS = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
        ".woff", ".woff2", ".ttf", ".eot", ".otf",
        ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
        ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".exe", ".dll", ".so", ".dylib", ".bin",
        ".db", ".sqlite", ".sqlite3",
        ".pyc", ".pyo", ".class", ".o", ".obj",
        ".lock", ".log"
    };

    private static readonly HashSet<string> DEFAULT_EXCLUDE_DIRS = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", ".svn", ".hg", "__pycache__",
        ".tox", ".venv", "venv", "env", ".env",
        "dist", "build", ".next", ".nuxt", ".output",
        "coverage", ".nyc_output", ".pytest_cache",
        ".idea", ".vscode", ".vs",
        "target", "bin", "obj", ".gradle",
        "bower_components", "vendor",
        ".turbo", ".cache", "tmp", "temp"
    };

    private static readonly HashSet<string> DEFAULT_EXTENSIONS = new(StringComparer.OrdinalIgnoreCase)
    {
        ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs",
        ".c", ".cpp", ".h", ".hpp", ".md", ".txt", ".json", ".yaml",
        ".yml", ".toml", ".xml", ".csv", ".sql", ".sh", ".bash",
        ".css", ".scss", ".less", ".html", ".vue", ".svelte", ".cs"
    };

    private readonly ScannerConfig _config;
    private readonly HashSet<string> _excludeDirs;
    private readonly HashSet<string> _includeExtensions;
    private GitIgnoreParser? _gitIgnore;
    private string? _rootPath;

    public CodeScanner(ScannerConfig config)
    {
        _config = config;
        _excludeDirs = new HashSet<string>(
            config.ExcludeDirectories.Count > 0 ? config.ExcludeDirectories : DEFAULT_EXCLUDE_DIRS,
            StringComparer.OrdinalIgnoreCase
        );
        _includeExtensions = new HashSet<string>(
            config.IncludeExtensions.Count > 0 ? config.IncludeExtensions : DEFAULT_EXTENSIONS,
            StringComparer.OrdinalIgnoreCase
        );
    }

    public CodeScanner(string projectPath)
    {
        _config = new ScannerConfig();
        _excludeDirs = new HashSet<string>(DEFAULT_EXCLUDE_DIRS, StringComparer.OrdinalIgnoreCase);
        _includeExtensions = new HashSet<string>(DEFAULT_EXTENSIONS, StringComparer.OrdinalIgnoreCase);
        LoadGitIgnore(projectPath);
    }

    private void LoadGitIgnore(string projectPath)
    {
        _rootPath = Path.GetFullPath(projectPath);
        var gitignorePath = Path.Combine(_rootPath, ".gitignore");
        if (File.Exists(gitignorePath))
        {
            var content = File.ReadAllText(gitignorePath, Encoding.UTF8);
            _gitIgnore = new GitIgnoreParser(content);
        }
    }

    public ScanResult BuildContext(string projectPath, string? outputPath = null)
    {
        var stopwatch = Stopwatch.StartNew();

        outputPath ??= Path.Combine(projectPath, "full_context.txt");

        LoadGitIgnore(projectPath);

        var files = ScanFiles(projectPath);
        var sb = new StringBuilder();

        sb.AppendLine($"# Project Context: {Path.GetFileName(projectPath)}");
        sb.AppendLine($"# Generated: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
        sb.AppendLine($"# Files: {files.Count}");
        sb.AppendLine();

        foreach (var file in files.OrderByDescending(f => f.RelevanceScore))
        {
            sb.AppendLine($"# File: {file.RelativePath}");
            sb.AppendLine("# ============================================================");
            sb.AppendLine();
            sb.AppendLine(file.Content);
            sb.AppendLine();
        }

        var content = sb.ToString();
        File.WriteAllText(outputPath, content, Encoding.UTF8);

        stopwatch.Stop();

        return new ScanResult
        {
            FileCount = files.Count,
            TotalChars = content.Length,
            EstimatedTokens = EstimateTokens(content),
            OutputPath = outputPath,
            ElapsedMilliseconds = stopwatch.ElapsedMilliseconds
        };
    }

    public List<string> Scan(string projectPath)
    {
        LoadGitIgnore(projectPath);
        var rootPath = Path.GetFullPath(projectPath);
        var files = new List<string>();
        WalkDirectory(rootPath, rootPath, files);
        files.Sort(StringComparer.OrdinalIgnoreCase);
        return files;
    }

    private void WalkDirectory(string rootPath, string currentPath, List<string> files)
    {
        try
        {
            var dirName = Path.GetFileName(currentPath);
            if (DEFAULT_EXCLUDE_DIRS.Contains(dirName))
                return;

            if (dirName.StartsWith('.') && dirName != ".")
                return;

            var relativeDir = Path.GetRelativePath(rootPath, currentPath);
            if (relativeDir != "." && _gitIgnore != null && _gitIgnore.IsIgnored(relativeDir + "/", true))
                return;

            foreach (var filePath in Directory.GetFiles(currentPath))
            {
                var relativePath = Path.GetRelativePath(rootPath, filePath);
                var normalizedPath = relativePath.Replace('\\', '/');

                if (_gitIgnore != null && _gitIgnore.IsIgnored(normalizedPath, false))
                    continue;

                if (IsBinary(filePath))
                    continue;

                var ext = Path.GetExtension(filePath);
                if (!_includeExtensions.Contains(ext))
                    continue;

                files.Add(normalizedPath);
            }

            foreach (var subDir in Directory.GetDirectories(currentPath))
            {
                WalkDirectory(rootPath, subDir, files);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error scanning directory {currentPath}: {ex.Message}");
        }
    }

    public bool IsBinary(string filePath)
    {
        var ext = Path.GetExtension(filePath);
        if (BINARY_EXTENSIONS.Contains(ext))
            return true;

        try
        {
            var fileInfo = new FileInfo(filePath);
            if (fileInfo.Length == 0)
                return false;

            var bufferSize = Math.Min((int)fileInfo.Length, 8192);
            var buffer = new byte[bufferSize];
            using var stream = File.OpenRead(filePath);
            var bytesRead = stream.Read(buffer, 0, bufferSize);

            for (var i = 0; i < bytesRead; i++)
            {
                if (buffer[i] == 0)
                    return true;
            }
        }
        catch
        {
        }

        return false;
    }

    public List<CodeFile> ScanFiles(string projectPath)
    {
        var files = new List<CodeFile>();

        try
        {
            ScanDirectory(projectPath, projectPath, files);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error scanning directory: {ex.Message}");
        }

        var intent = ExtractProjectIntent(files);

        foreach (var file in files)
        {
            file.RelevanceScore = CalculateRelevance(file, intent);
        }

        return files;
    }

    private void ScanDirectory(string rootPath, string currentPath, List<CodeFile> files)
    {
        try
        {
            var dirName = Path.GetFileName(currentPath);
            if (_excludeDirs.Contains(dirName))
                return;

            if (dirName.StartsWith('.') && dirName != ".")
                return;

            var relativeDir = Path.GetRelativePath(rootPath, currentPath);
            if (relativeDir != "." && _gitIgnore != null && _gitIgnore.IsIgnored(relativeDir.Replace('\\', '/') + "/", true))
                return;

            foreach (var filePath in Directory.GetFiles(currentPath))
            {
                var relativePath = Path.GetRelativePath(rootPath, filePath);
                var normalizedPath = relativePath.Replace('\\', '/');

                if (_gitIgnore != null && _gitIgnore.IsIgnored(normalizedPath, false))
                    continue;

                if (IsBinary(filePath))
                    continue;

                var ext = Path.GetExtension(filePath);
                if (!_includeExtensions.Contains(ext))
                    continue;

                var fileInfo = new FileInfo(filePath);
                if (fileInfo.Length > _config.MaxFileSize)
                    continue;

                try
                {
                    var content = File.ReadAllText(filePath, Encoding.UTF8);

                    files.Add(new CodeFile
                    {
                        Path = filePath,
                        RelativePath = normalizedPath,
                        Content = content,
                        Size = fileInfo.Length
                    });
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Error reading file {filePath}: {ex.Message}");
                }
            }

            foreach (var subDir in Directory.GetDirectories(currentPath))
            {
                ScanDirectory(rootPath, subDir, files);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error scanning directory {currentPath}: {ex.Message}");
        }
    }

    public SmartExtractionResult BuildPartialContext(string projectPath, string prompt, string? outputPath = null)
    {
        var extractor = new SmartContextExtractor(_config);
        return extractor.BuildContext(projectPath, prompt, outputPath);
    }

    public List<string> GetContextFilesList(string contextFile)
    {
        var files = new List<string>();

        if (!File.Exists(contextFile))
            return files;

        try
        {
            var content = File.ReadAllText(contextFile, Encoding.UTF8);
            var regex = new Regex(@"^#\s*File:\s*(.+)$", RegexOptions.Multiline);
            var matches = regex.Matches(content);

            foreach (Match match in matches)
            {
                if (match.Groups[1].Success)
                {
                    files.Add(match.Groups[1].Value.Trim());
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error reading context file {contextFile}: {ex.Message}");
        }

        return files;
    }

    public string ExtractIntent(string content)
    {
        var keywords = new List<string>();

        var classMatches = Regex.Matches(content, @"\b(?:class|interface|struct|enum)\s+(\w+)", RegexOptions.Multiline);
        foreach (Match match in classMatches)
        {
            keywords.Add(match.Groups[1].Value);
        }

        var functionMatches = Regex.Matches(content, @"\b(?:function|def|func|fn|public|private|protected)\s+(\w+)", RegexOptions.Multiline);
        foreach (Match match in functionMatches)
        {
            keywords.Add(match.Groups[1].Value);
        }

        var commentMatches = Regex.Matches(content, @"//\s*(.+)|/\*\s*(.+?)\s*\*/|#\s*(.+)", RegexOptions.Multiline);
        foreach (Match match in commentMatches)
        {
            var comment = match.Groups[1].Value + match.Groups[2].Value + match.Groups[3].Value;
            var words = Regex.Matches(comment, @"\b[A-Z][a-z]+\b");
            foreach (Match word in words)
            {
                keywords.Add(word.Value);
            }
        }

        return string.Join(" ", keywords.Distinct().Take(50));
    }

    private string ExtractProjectIntent(List<CodeFile> files)
    {
        var allIntents = new StringBuilder();
        foreach (var file in files.Take(10))
        {
            allIntents.Append(ExtractIntent(file.Content));
            allIntents.Append(" ");
        }
        return allIntents.ToString();
    }

    public int CalculateRelevance(CodeFile file, string intent)
    {
        var score = 0;

        score += 20;

        var fileName = Path.GetFileNameWithoutExtension(file.RelativePath).ToLower();
        var intentLower = intent.ToLower();

        if (intentLower.Contains(fileName))
            score += 30;

        var depth = file.RelativePath.Split('/', '\\').Length;
        score -= Math.Min(depth * 5, 20);

        if (file.Size > 100 && file.Size < 50000)
            score += 20;
        else if (file.Size >= 50000)
            score += 10;

        var fileName2 = file.RelativePath.ToLower();
        if (fileName2.Contains("main") || fileName2.Contains("index") || fileName2.Contains("app"))
            score += 30;

        if (fileName2.Contains("config") || fileName2.Contains("setting"))
            score -= 10;

        if (fileName2.Contains("test") || fileName2.Contains("spec"))
            score -= 20;

        return Math.Clamp(score, 0, 100);
    }

    public long EstimateTokens(string text)
    {
        return text.Length / 4;
    }

    private class GitIgnoreParser
    {
        private readonly List<GitIgnoreRule> _rules = new();

        public GitIgnoreParser(string gitignoreContent)
        {
            var lines = gitignoreContent.Split('\n', StringSplitOptions.RemoveEmptyEntries);
            foreach (var line in lines)
            {
                var trimmed = line.TrimEnd('\r').Trim();
                if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith('#'))
                    continue;

                _rules.Add(new GitIgnoreRule(trimmed));
            }
        }

        public bool IsIgnored(string relativePath, bool isDirectory)
        {
            var normalizedPath = relativePath.Replace('\\', '/');
            if (normalizedPath.StartsWith("./"))
                normalizedPath = normalizedPath[2..];

            var result = false;

            foreach (var rule in _rules)
            {
                if (rule.Matches(normalizedPath, isDirectory))
                {
                    result = !rule.Negation;
                }
            }

            return result;
        }
    }

    private class GitIgnoreRule
    {
        public string Pattern { get; }
        public bool Negation { get; }
        public bool DirectoryOnly { get; }
        public Regex? Regex { get; }

        public GitIgnoreRule(string pattern)
        {
            Negation = pattern.StartsWith('!');
            if (Negation)
                pattern = pattern[1..];

            DirectoryOnly = pattern.EndsWith('/');
            if (DirectoryOnly)
                pattern = pattern[..^1];

            Pattern = pattern;
            Regex = CompilePattern(pattern);
        }

        public bool Matches(string path, bool isDirectory)
        {
            if (DirectoryOnly && !isDirectory)
                return false;

            if (Regex == null)
                return false;

            return Regex.IsMatch(path);
        }

        private static Regex? CompilePattern(string pattern)
        {
            try
            {
                var regex = "^";
                var i = 0;

                while (i < pattern.Length)
                {
                    var c = pattern[i];

                    if (c == '*')
                    {
                        if (i + 1 < pattern.Length && pattern[i + 1] == '*')
                        {
                            if (i + 2 < pattern.Length && pattern[i + 2] == '/')
                            {
                                regex += "(.*/)?";
                                i += 3;
                            }
                            else
                            {
                                regex += ".*";
                                i += 2;
                            }
                        }
                        else
                        {
                            regex += "[^/]*";
                            i++;
                        }
                    }
                    else if (c == '?')
                    {
                        regex += "[^/]";
                        i++;
                    }
                    else if (c == '[')
                    {
                        var j = i;
                        while (j < pattern.Length && pattern[j] != ']')
                            j++;
                        if (j < pattern.Length)
                        {
                            regex += pattern[i..(j + 1)];
                            i = j + 1;
                        }
                        else
                        {
                            regex += Regex.Escape(c.ToString());
                            i++;
                        }
                    }
                    else if (".+^${}()|".Contains(c))
                    {
                        regex += Regex.Escape(c.ToString());
                        i++;
                    }
                    else
                    {
                        regex += c;
                        i++;
                    }
                }

                regex += "$";
                return new Regex(regex, RegexOptions.IgnoreCase);
            }
            catch
            {
                return null;
            }
        }
    }
}
