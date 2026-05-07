using ContextGate.Core.Services;

namespace ContextGate.Tests;

public class CodeBlockExtractorTests
{
    private readonly CodeBlockExtractor _extractor = new();

    [Fact]
    public void Extract_JavascriptFunction()
    {
        var code = "function hello() {\n  console.log('hello world from hello');\n  return 'result value';\n}";
        var blocks = _extractor.ExtractBlocks(code, "test.js");
        Assert.True(blocks.Count > 0);
    }

    [Fact]
    public void Extract_PythonClass()
    {
        var code = "class MyClass:\n    def __init__(self):\n        pass\n";
        var blocks = _extractor.ExtractBlocks(code, "test.py");
        Assert.True(blocks.Count > 0);
    }

    [Fact]
    public void Extract_UnknownLanguage_ReturnsFullContent()
    {
        var code = new string('x', 60);
        var blocks = _extractor.ExtractBlocks(code, "test.xyz");
        Assert.Single(blocks);
        Assert.Equal("full", blocks[0].Type);
    }
}
