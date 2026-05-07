using ContextGate.Core.Services;

namespace ContextGate.Tests;

public class ConfigManagerTests : IDisposable
{
    private readonly string _testDir;
    private readonly string _configPath;

    public ConfigManagerTests()
    {
        _testDir = Path.Combine(Path.GetTempPath(), $"cg_config_test_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_testDir);
        _configPath = Path.Combine(_testDir, "config.yaml");
    }

    public void Dispose()
    {
        if (Directory.Exists(_testDir))
            Directory.Delete(_testDir, true);
    }

    [Fact]
    public void LoadConfig_CreatesDefaultWhenNotExists()
    {
        var manager = new ConfigManager(_configPath);
        var config = manager.LoadConfig();

        Assert.NotNull(config);
        Assert.Equal("openai", config.DefaultProvider);
        Assert.True(File.Exists(_configPath));
    }

    [Fact]
    public void SaveConfig_PersistsToDisk()
    {
        var manager = new ConfigManager(_configPath);
        var config = new Core.Models.AppConfig { DefaultProvider = "zhipu" };
        manager.SaveConfig(config);

        var manager2 = new ConfigManager(_configPath);
        var loaded = manager2.LoadConfig();
        Assert.Equal("zhipu", loaded.DefaultProvider);
    }

    [Fact]
    public void GetProvider_ReturnsConfiguredProvider()
    {
        var yaml = @"
providers:
  openai:
    api_key: test-key
    base_url: https://api.openai.com/v1
    models:
      - gpt-4
";
        File.WriteAllText(_configPath, yaml);
        var manager = new ConfigManager(_configPath);
        var provider = manager.GetProvider("openai");

        Assert.NotNull(provider);
        Assert.Equal("test-key", provider.ApiKey);
        Assert.Equal("https://api.openai.com/v1", provider.BaseUrl);
    }

    [Fact]
    public void SetWorkspace_UpdatesConfig()
    {
        var manager = new ConfigManager(_configPath);
        manager.SetWorkspace("/test/path");

        Assert.Equal("/test/path", manager.GetWorkspace());
    }
}
