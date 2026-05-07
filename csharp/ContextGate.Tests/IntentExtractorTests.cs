using ContextGate.Core.Services;

namespace ContextGate.Tests;

public class IntentExtractorTests
{
    private readonly IntentExtractor _extractor = new();

    [Fact]
    public void ExtractIntents_DetectsAuthIntent()
    {
        var intents = _extractor.ExtractIntents("How does the login authentication work?");
        Assert.Contains(intents, i => i.Name == "auth");
    }

    [Fact]
    public void ExtractIntents_DetectsDatabaseIntent()
    {
        var intents = _extractor.ExtractIntents("Show me the database model schema");
        Assert.Contains(intents, i => i.Name == "database");
    }

    [Fact]
    public void ExtractFileReferences_DetectsFileReferences()
    {
        var references = _extractor.ExtractFileReferences("Look at 'app.js' and 'utils.py'");
        Assert.True(references.Count >= 2);
    }

    [Fact]
    public void ExtractModuleReferences_DetectsModuleReferences()
    {
        var references = _extractor.ExtractModuleReferences("Check the AuthService and UserController");
        Assert.True(references.Count >= 2);
    }

    [Fact]
    public void GetAllKeywords_ReturnsCombinedKeywords()
    {
        var keywords = _extractor.GetAllKeywords("Fix the auth login in 'auth.py'");
        Assert.True(keywords.Count > 0);
    }

    [Fact]
    public void ExtractIntents_DetectsChineseKeywords()
    {
        var intents = _extractor.ExtractIntents("修复用户登录的认证问题");
        Assert.Contains(intents, i => i.Name == "auth");
        Assert.Contains(intents, i => i.Name == "user");
    }
}
