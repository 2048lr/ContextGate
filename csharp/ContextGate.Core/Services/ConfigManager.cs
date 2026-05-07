using ContextGate.Core.Models;
using ContextGate.Core.Services.Interfaces;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace ContextGate.Core.Services;

/// <summary>
/// 配置管理服务实现
/// </summary>
public class ConfigManager : IConfigManager
{
    private readonly ISerializer _serializer;
    private readonly IDeserializer _deserializer;
    private AppConfig? _cachedConfig;

    public string ConfigPath { get; }

    public ConfigManager(string configPath)
    {
        ConfigPath = configPath;
        
        _serializer = new SerializerBuilder()
            .WithNamingConvention(UnderscoredNamingConvention.Instance)
            .Build();
            
        _deserializer = new DeserializerBuilder()
            .WithNamingConvention(UnderscoredNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            .Build();
    }

    public AppConfig LoadConfig()
    {
        if (_cachedConfig != null)
            return _cachedConfig;

        if (!File.Exists(ConfigPath))
        {
            // 创建默认配置
            _cachedConfig = CreateDefaultConfig();
            SaveConfig(_cachedConfig);
            return _cachedConfig;
        }

        try
        {
            var yaml = File.ReadAllText(ConfigPath);
            _cachedConfig = _deserializer.Deserialize<AppConfig>(yaml) ?? CreateDefaultConfig();
            return _cachedConfig;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to load config: {ex.Message}");
            _cachedConfig = CreateDefaultConfig();
            return _cachedConfig;
        }
    }

    public bool SaveConfig(AppConfig config)
    {
        try
        {
            var yaml = _serializer.Serialize(config);
            
            // 确保目录存在
            var directory = Path.GetDirectoryName(ConfigPath);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }
            
            File.WriteAllText(ConfigPath, yaml);
            _cachedConfig = config;
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to save config: {ex.Message}");
            return false;
        }
    }

    public ProviderConfig? GetProvider(string name)
    {
        var config = LoadConfig();
        return config.Providers.TryGetValue(name, out var provider) ? provider : null;
    }

    public void SetWorkspace(string path)
    {
        var config = LoadConfig();
        config.Workspace = path;
        SaveConfig(config);
    }

    public string? GetWorkspace()
    {
        var config = LoadConfig();
        return config.Workspace;
    }

    public Dictionary<string, ProviderConfig> GetAllProviders()
    {
        var config = LoadConfig();
        return config.Providers;
    }

    public ProxyConfig GetProxyConfig()
    {
        var config = LoadConfig();
        return config.Proxy;
    }

    public MonitorConfig GetMonitorConfig()
    {
        var config = LoadConfig();
        return config.Monitor;
    }

    public CurrencyConfig GetCurrencyConfig()
    {
        var config = LoadConfig();
        return config.Currency;
    }

    private AppConfig CreateDefaultConfig()
    {
        return new AppConfig
        {
            DefaultProvider = "openai",
            Providers = new Dictionary<string, ProviderConfig>
            {
                ["openai"] = new ProviderConfig
                {
                    ApiKey = "your-api-key-here",
                    BaseUrl = "https://api.openai.com/v1",
                    Models = new List<string> { "gpt-4", "gpt-3.5-turbo" }
                }
            },
            Proxy = new ProxyConfig
            {
                Host = "127.0.0.1",
                Port = 12306,
                SanitizeRequests = true
            },
            Monitor = new MonitorConfig
            {
                BudgetLimit = 10m,
                WarningThreshold = 75,
                CriticalThreshold = 90,
                DbPath = "contextgate.db"
            },
            Scanner = new ScannerConfig(),
            Context = new ContextConfig(),
            Currency = new CurrencyConfig()
        };
    }
}
