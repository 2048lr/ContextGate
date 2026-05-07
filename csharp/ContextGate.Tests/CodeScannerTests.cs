using ContextGate.Core.Services;

namespace ContextGate.Tests;

public class CodeScannerTests : IDisposable
{
    private readonly string _testDir;
    private readonly CodeScanner _scanner;

    public CodeScannerTests()
    {
        _testDir = Path.Combine(Path.GetTempPath(), $"cg_test_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_testDir);
        _scanner = new CodeScanner(_testDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(_testDir))
            Directory.Delete(_testDir, true);
    }

    [Fact]
    public void Scan_FindsCodeFiles()
    {
        File.WriteAllText(Path.Combine(_testDir, "test.py"), "print('hello')");
        File.WriteAllText(Path.Combine(_testDir, "test.js"), "console.log('hello')");

        var files = _scanner.Scan(_testDir);
        Assert.Equal(2, files.Count);
    }

    [Fact]
    public void Scan_ExcludesBinaryFiles()
    {
        File.WriteAllText(Path.Combine(_testDir, "test.py"), "code");
        File.WriteAllText(Path.Combine(_testDir, "image.png"), new string('x', 100));

        var files = _scanner.Scan(_testDir);
        Assert.Single(files);
    }

    [Fact]
    public void Scan_ExcludesIgnoredDirectories()
    {
        var subDir = Path.Combine(_testDir, "node_modules");
        Directory.CreateDirectory(subDir);
        File.WriteAllText(Path.Combine(subDir, "lib.js"), "code");
        File.WriteAllText(Path.Combine(_testDir, "main.py"), "code");

        var files = _scanner.Scan(_testDir);
        Assert.Single(files);
    }

    [Fact]
    public void Scan_RespectsGitIgnore()
    {
        File.WriteAllText(Path.Combine(_testDir, ".gitignore"), "*.log\ndist/\n");
        File.WriteAllText(Path.Combine(_testDir, "app.py"), "code");
        File.WriteAllText(Path.Combine(_testDir, "debug.log"), "log");
        var distDir = Path.Combine(_testDir, "dist");
        Directory.CreateDirectory(distDir);
        File.WriteAllText(Path.Combine(distDir, "bundle.js"), "code");

        var files = _scanner.Scan(_testDir);
        Assert.Single(files);
    }

    [Fact]
    public void BuildContext_CreatesOutputFile()
    {
        File.WriteAllText(Path.Combine(_testDir, "main.py"), "print('hello')");
        var outputPath = Path.Combine(_testDir, "context.txt");

        var result = _scanner.BuildContext(_testDir, outputPath);

        Assert.True(File.Exists(outputPath));
        Assert.Equal(1, result.FileCount);
        Assert.True(result.TotalChars > 0);
        Assert.True(result.EstimatedTokens > 0);
    }

    [Fact]
    public void EstimateTokens_ReturnsReasonableEstimate()
    {
        var text = new string('a', 400);
        var tokens = _scanner.EstimateTokens(text);
        Assert.Equal(100, tokens);
    }

    [Fact]
    public void IsBinary_DetectsBinaryByExtension()
    {
        Assert.True(_scanner.IsBinary(Path.Combine(_testDir, "test.png")));
        Assert.True(_scanner.IsBinary(Path.Combine(_testDir, "test.exe")));
        Assert.False(_scanner.IsBinary(Path.Combine(_testDir, "test.py")));
    }
}
