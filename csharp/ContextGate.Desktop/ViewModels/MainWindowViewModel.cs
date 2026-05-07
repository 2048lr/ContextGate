using System;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Input.Platform;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ContextGate.Core.Models;
using ContextGate.Core.Services;
using ContextGate.Core.Services.Interfaces;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace ContextGate.Desktop.ViewModels;

public partial class MainWindowViewModel : ViewModelBase
{
    private WebApplication? _proxyApp;
    private ITokenMonitor? _tokenMonitor;
    private IConfigManager? _configManager;
    private IContextSignatureService? _contextSignature;
    private ProxyService? _proxyService;
    private ICodeScanner? _codeScanner;
    private string _configPath = "config.yaml";
    private string _dbPath = "contextgate.db";
    private string _contextFile = "full_context.txt";

    [ObservableProperty]
    private bool _isProxyRunning;

    [ObservableProperty]
    private int _proxyPort = 12306;

    [ObservableProperty]
    private string _proxyStatusText = "未启动";

    [ObservableProperty]
    private string _projectPath = string.Empty;

    [ObservableProperty]
    private bool _isProjectLoaded;

    [ObservableProperty]
    private string _fileCount = "0";

    [ObservableProperty]
    private string _charCount = "0";

    [ObservableProperty]
    private string _tokenEstimate = "0";

    [ObservableProperty]
    private string _todayRequests = "0";

    [ObservableProperty]
    private string _todayTokens = "0";

    [ObservableProperty]
    private string _todaySavings = "$0.00";

    [ObservableProperty]
    private string _cacheHitRate = "0%";

    [ObservableProperty]
    private string _savingsPercent = "0%";

    [ObservableProperty]
    private string _contextHash = "none";

    [ObservableProperty]
    private string _connectionStatus = "未连接";

    [ObservableProperty]
    private string _memoryUsage = "0 MB";

    [ObservableProperty]
    private ObservableCollection<LogEntry> _logEntries = new();

    [ObservableProperty]
    private ObservableCollection<string> _providers = new() { "openai", "deepseek", "zhipu" };

    [ObservableProperty]
    private string _selectedProvider = "openai";

    [ObservableProperty]
    private string _providerApiKey = string.Empty;

    [ObservableProperty]
    private string _providerBaseUrl = string.Empty;

    [ObservableProperty]
    private string _providerModels = string.Empty;

    [ObservableProperty]
    private string _proxyHost = "127.0.0.1";

    [ObservableProperty]
    private string _proxyPortSetting = "12306";

    [ObservableProperty]
    private string _budgetLimit = "10";

    [ObservableProperty]
    private bool _isSettingsOpen;

    [ObservableProperty]
    private int _settingsTabIndex;

    [ObservableProperty]
    private string _buildStatusText = string.Empty;

    [ObservableProperty]
    private bool _isBuilding;

    [ObservableProperty]
    private string _proxyToggleText = "启动代理";

    [ObservableProperty]
    private string _projectStatusText = "未选择";

    [ObservableProperty]
    private string _proxyRunStatusText = "已停止";

    [ObservableProperty]
    private string _statusColor = "#e74c3c";

    [ObservableProperty]
    private string _projectBadgeColor = "#e74c3c";

    [ObservableProperty]
    private bool _isTab0Visible = true;

    [ObservableProperty]
    private bool _isTab1Visible;

    [ObservableProperty]
    private bool _isTab2Visible;

    [ObservableProperty]
    private bool _isTab3Visible;

    [ObservableProperty]
    private bool _isTab4Visible;

    [ObservableProperty]
    private bool _isTab5Visible;

    public ObservableCollection<ToolConfigItem> ToolConfigs { get; } = new()
    {
        new() { Icon = "🔵", Name = "Cursor" },
        new() { Icon = "⚡", Name = "Cline" },
        new() { Icon = "▶", Name = "Continue" },
        new() { Icon = "🌀", Name = "Windsurf" }
    };

    public MainWindowViewModel()
    {
        LoadExistingConfig();
    }

    private void LoadExistingConfig()
    {
        try
        {
            if (File.Exists(_configPath))
            {
                _configManager = new ConfigManager(_configPath);
                var config = _configManager.LoadConfig();
                ProxyPort = config.Proxy.Port;
                ProxyHost = config.Proxy.Host;
                ProxyPortSetting = config.Proxy.Port.ToString();
                BudgetLimit = config.Monitor.BudgetLimit.ToString();
                SelectedProvider = config.DefaultProvider;

                if (config.Providers.Count > 0)
                {
                    Providers = new ObservableCollection<string>(config.Providers.Keys);
                    SelectedProvider = config.DefaultProvider;

                    if (config.Providers.TryGetValue(config.DefaultProvider, out var providerConfig))
                    {
                        ProviderApiKey = providerConfig.ApiKey;
                        ProviderBaseUrl = providerConfig.BaseUrl;
                        ProviderModels = string.Join(", ", providerConfig.Models);
                    }
                }

                if (!string.IsNullOrEmpty(config.Workspace) && Directory.Exists(config.Workspace))
                {
                    ProjectPath = config.Workspace;
                    IsProjectLoaded = true;
                }
            }
            else
            {
                _configManager = new ConfigManager(_configPath);
            }
        }
        catch
        {
            _configManager = new ConfigManager(_configPath);
        }
    }

    [RelayCommand]
    private async Task SelectProject()
    {
        var topLevel = App.Current?.ApplicationLifetime is Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime desktop
            ? desktop.MainWindow
            : null;

        if (topLevel == null) return;

        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(
            new Avalonia.Platform.Storage.FolderPickerOpenOptions { AllowMultiple = false, Title = "选择项目文件夹" });

        if (folders.Count > 0)
        {
            var path = folders[0].Path.LocalPath;
            ProjectPath = path;
            IsProjectLoaded = true;

            if (_configManager != null)
            {
                _configManager.SetWorkspace(path);
            }

            _contextFile = Path.Combine(path, "full_context.txt");
            UpdateContextHash();
        }
    }

    [RelayCommand]
    private async Task BuildContext()
    {
        if (string.IsNullOrEmpty(ProjectPath) || !Directory.Exists(ProjectPath))
        {
            BuildStatusText = "请先选择项目路径";
            return;
        }

        IsBuilding = true;
        BuildStatusText = "正在构建上下文...";

        try
        {
            var scannerConfig = new ScannerConfig();
            _codeScanner = new CodeScanner(scannerConfig);

            var result = await Task.Run(() => _codeScanner.BuildContext(ProjectPath, _contextFile));

            FileCount = result.FileCount.ToString();
            CharCount = FormatNumber(result.TotalChars);
            TokenEstimate = FormatNumber(result.EstimatedTokens);
            BuildStatusText = $"构建完成！{result.FileCount} 文件，耗时 {result.ElapsedMilliseconds}ms";

            _contextFile = result.OutputPath;
            UpdateContextHash();

            if (_contextSignature != null && IsProxyRunning)
            {
                _contextSignature.ReloadSignature();
            }
        }
        catch (Exception ex)
        {
            BuildStatusText = $"构建失败: {ex.Message}";
        }
        finally
        {
            IsBuilding = false;
        }
    }

    [RelayCommand]
    private async Task ToggleProxy()
    {
        if (IsProxyRunning)
        {
            await StopProxy();
        }
        else
        {
            await StartProxy();
        }
    }

    private async Task StartProxy()
    {
        try
        {
            ProxyStatusText = "正在启动...";

            var builder = WebApplication.CreateBuilder();
            builder.WebHost.ConfigureKestrel(options => options.ListenAnyIP(ProxyPort));
            builder.Services.AddControllers().AddNewtonsoftJson();
            builder.Services.AddEndpointsApiExplorer();

            _configManager ??= new ConfigManager(_configPath);
            _tokenMonitor ??= new TokenMonitor(_dbPath);
            _contextSignature ??= new ContextSignatureService(_contextFile, ProjectPath);

            builder.Services.AddSingleton(_configManager);
            builder.Services.AddSingleton(_tokenMonitor);
            builder.Services.AddSingleton(_contextSignature);
            builder.Services.AddSingleton<ProxyService>();

            builder.Logging.ClearProviders();
            builder.Logging.AddConsole();

            _proxyApp = builder.Build();

            if (_proxyApp.Environment.EnvironmentName == "Development")
            {
                _proxyApp.UseSwagger();
                _proxyApp.UseSwaggerUI();
            }

            _proxyApp.MapControllers();

            var tcs = new TaskCompletionSource<bool>();
            _ = Task.Run(async () =>
            {
                try
                {
                    await _proxyApp.StartAsync();
                    tcs.SetResult(true);
                }
                catch (Exception ex)
                {
                    tcs.SetException(ex);
                }
            });

            await tcs.Task;

            IsProxyRunning = true;
            ProxyStatusText = $"运行中 :{ProxyPort}";
            ConnectionStatus = $"http://{ProxyHost}:{ProxyPort}";

            _proxyService = _proxyApp.Services.GetRequiredService<ProxyService>();
        }
        catch (Exception ex)
        {
            ProxyStatusText = $"启动失败: {ex.Message}";
            IsProxyRunning = false;
        }
    }

    private async Task StopProxy()
    {
        try
        {
            if (_proxyApp != null)
            {
                await _proxyApp.StopAsync();
                await _proxyApp.DisposeAsync();
                _proxyApp = null;
            }

            IsProxyRunning = false;
            ProxyStatusText = "已停止";
            ConnectionStatus = "未连接";
            _proxyService = null;
        }
        catch (Exception ex)
        {
            ProxyStatusText = $"停止失败: {ex.Message}";
        }
    }

    [RelayCommand]
    private void ClearCache()
    {
        _proxyService?.ClearCache();
    }

    [RelayCommand]
    private void OpenSettings()
    {
        IsSettingsOpen = true;
    }

    [RelayCommand]
    private void CloseSettings()
    {
        IsSettingsOpen = false;
    }

    [RelayCommand]
    private void SaveSettings()
    {
        try
        {
            _configManager ??= new ConfigManager(_configPath);
            var config = _configManager.LoadConfig();

            config.DefaultProvider = SelectedProvider;
            config.Proxy.Host = ProxyHost;
            config.Proxy.Port = int.TryParse(ProxyPortSetting, out var port) ? port : 12306;
            config.Monitor.BudgetLimit = decimal.TryParse(BudgetLimit, out var budget) ? budget : 10m;

            if (!config.Providers.ContainsKey(SelectedProvider))
            {
                config.Providers[SelectedProvider] = new ProviderConfig();
            }

            var providerConfig = config.Providers[SelectedProvider];
            providerConfig.ApiKey = ProviderApiKey;
            providerConfig.BaseUrl = ProviderBaseUrl;
            providerConfig.Models = ProviderModels.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

            _configManager.SaveConfig(config);
            IsSettingsOpen = false;
        }
        catch
        {
        }
    }

    [RelayCommand]
    private void AddProvider()
    {
        var name = $"provider_{Providers.Count + 1}";
        if (!Providers.Contains(name))
        {
            Providers.Add(name);
            SelectedProvider = name;
            ProviderApiKey = string.Empty;
            ProviderBaseUrl = string.Empty;
            ProviderModels = string.Empty;
        }
    }

    [RelayCommand]
    private void RemoveProvider()
    {
        if (Providers.Count > 1 && Providers.Contains(SelectedProvider))
        {
            Providers.Remove(SelectedProvider);
            SelectedProvider = Providers[0];
        }
    }

    [RelayCommand]
    private async Task CopyToolConfig(string? toolName)
    {
        var config = $@"{{
  ""mcpServers"": {{
    ""contextgate"": {{
      ""url"": ""http://{ProxyHost}:{ProxyPort}/v1""
    }}
  }}
}}";

        try
        {
            if (App.Current?.ApplicationLifetime is Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime desktop)
            {
                var window = desktop.MainWindow;
                var topLevel = TopLevel.GetTopLevel(window);
                if (topLevel?.Clipboard != null)
                {
                    await topLevel.Clipboard.SetTextAsync(config);
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Clipboard error: {ex.Message}");
        }
    }

    partial void OnSelectedProviderChanged(string value)
    {
        if (_configManager == null || string.IsNullOrEmpty(value)) return;

        try
        {
            var config = _configManager.LoadConfig();
            if (config.Providers.TryGetValue(value, out var providerConfig))
            {
                ProviderApiKey = providerConfig.ApiKey;
                ProviderBaseUrl = providerConfig.BaseUrl;
                ProviderModels = string.Join(", ", providerConfig.Models);
            }
        }
        catch
        {
        }
    }

    partial void OnIsProxyRunningChanged(bool value)
    {
        ProxyToggleText = value ? "停止代理" : "启动代理";
        ProxyRunStatusText = value ? "运行中" : "已停止";
        StatusColor = value ? "#27ae60" : "#e74c3c";
    }

    partial void OnIsProjectLoadedChanged(bool value)
    {
        ProjectStatusText = value ? "已加载" : "未选择";
        ProjectBadgeColor = value ? "#27ae60" : "#e74c3c";
    }

    partial void OnSettingsTabIndexChanged(int value)
    {
        IsTab0Visible = value == 0;
        IsTab1Visible = value == 1;
        IsTab2Visible = value == 2;
        IsTab3Visible = value == 3;
        IsTab4Visible = value == 4;
        IsTab5Visible = value == 5;
    }

    public void RefreshStats()
    {
        try
        {
            if (_tokenMonitor != null)
            {
                var summary = _tokenMonitor.GetSummary();
                if (summary.Today != null)
                {
                    TodayRequests = summary.Today.Requests.ToString();
                    TodayTokens = FormatNumber(summary.Today.Tokens);
                    TodaySavings = $"${summary.Today.Cost:F4}";
                    SavingsPercent = $"{summary.SavingsPercent}%";

                    var totalRequests = summary.Today.Requests;
                    var cacheHits = summary.Today.CacheHits;
                    CacheHitRate = totalRequests > 0 ? $"{(double)cacheHits / totalRequests * 100:F1}%" : "0%";
                }
            }

            if (_proxyService != null)
            {
                ConnectionStatus = $"http://{ProxyHost}:{ProxyPort} | 请求: {_proxyService.RequestCount}";
            }

            UpdateMemoryUsage();
            UpdateContextHash();
        }
        catch
        {
        }
    }

    private void UpdateContextHash()
    {
        try
        {
            if (_contextSignature != null)
            {
                ContextHash = _contextSignature.GetContextHash();
                if (ContextHash.Length > 16)
                {
                    ContextHash = ContextHash[..16] + "...";
                }
            }
            else if (File.Exists(_contextFile))
            {
                _contextSignature = new ContextSignatureService(_contextFile, ProjectPath);
                ContextHash = _contextSignature.GetContextHash();
                if (ContextHash.Length > 16)
                {
                    ContextHash = ContextHash[..16] + "...";
                }
            }
        }
        catch
        {
            ContextHash = "none";
        }
    }

    private void UpdateMemoryUsage()
    {
        try
        {
            var process = Process.GetCurrentProcess();
            var mb = process.WorkingSet64 / (1024.0 * 1024.0);
            MemoryUsage = $"{mb:F1} MB";
        }
        catch
        {
            MemoryUsage = "N/A";
        }
    }

    public void AddLogEntry(string method, string path, string model, string tokens, string cost, bool isCacheHit)
    {
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            LogEntries.Insert(0, new LogEntry
            {
                Time = DateTime.Now.ToString("HH:mm:ss"),
                Method = method,
                Path = path,
                Model = model,
                Tokens = tokens,
                Cost = cost,
                IsCacheHit = isCacheHit
            });

            if (LogEntries.Count > 100)
            {
                LogEntries.RemoveAt(LogEntries.Count - 1);
            }
        });
    }

    private static string FormatNumber(long num)
    {
        if (num >= 1_000_000) return $"{num / 1_000_000.0:F1}M";
        if (num >= 1_000) return $"{num / 1_000.0:F1}K";
        return num.ToString();
    }
}

public class ToolConfigItem
{
    public string Icon { get; set; } = "";
    public string Name { get; set; } = "";
}
