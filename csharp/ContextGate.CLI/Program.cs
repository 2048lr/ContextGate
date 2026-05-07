using System.CommandLine;
using System.CommandLine.Parsing;
using System.Text;
using ContextGate.Core.Models;
using ContextGate.Core.Services;
using ContextGate.Core.Services.Interfaces;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Data.Sqlite;

namespace ContextGate.CLI;

internal static class AnsiColors
{
    public const string Reset = "\x1b[0m";
    public const string Bold = "\x1b[1m";
    public const string Dim = "\x1b[2m";
    public const string Red = "\x1b[31m";
    public const string Green = "\x1b[32m";
    public const string Yellow = "\x1b[33m";
    public const string Cyan = "\x1b[36m";

    public static string CyanBold(string text) => $"{Cyan}{Bold}{text}{Reset}";
    public static string GreenBold(string text) => $"{Green}{Bold}{text}{Reset}";
    public static string YellowBold(string text) => $"{Yellow}{Bold}{text}{Reset}";
    public static string RedBold(string text) => $"{Red}{Bold}{text}{Reset}";
    public static string GreenText(string text) => $"{Green}{text}{Reset}";
    public static string YellowText(string text) => $"{Yellow}{text}{Reset}";
    public static string RedText(string text) => $"{Red}{text}{Reset}";
    public static string CyanText(string text) => $"{Cyan}{text}{Reset}";
    public static string DimText(string text) => $"{Dim}{text}{Reset}";
    public static string BoldText(string text) => $"{Bold}{text}{Reset}";
}

internal static class ConsoleHelper
{
    public static string FormatSize(double size)
    {
        var units = new[] { "B", "KB", "MB", "GB" };
        foreach (var unit in units)
        {
            if (size < 1024)
                return $"{size:F2} {unit}";
            size /= 1024;
        }
        return $"{size:F2} TB";
    }

    public static string FormatTokens(long tokens)
    {
        if (tokens >= 1_000_000)
            return $"{tokens / 1_000_000.0:F2}M";
        if (tokens >= 1_000)
            return $"{tokens / 1_000.0:F1}K";
        return tokens.ToString("N0");
    }

    public static string FormatCost(decimal cost)
    {
        return $"${cost:F4}";
    }

    public static void PrintTableRow(string col1, string col2, int col1Width = 20, int col2Width = 40)
    {
        Console.WriteLine($"  {col1.PadRight(col1Width)} {col2}");
    }

    public static void PrintTableHeader(string col1, string col2, int col1Width = 20, int col2Width = 40)
    {
        Console.WriteLine($"  {AnsiColors.BoldText(col1.PadRight(col1Width))} {AnsiColors.BoldText(col2)}");
        Console.WriteLine($"  {new string('-', col1Width)} {new string('-', col2Width)}");
    }

    public static void PrintMultiColumnTable(string[] headers, int[] widths, List<string[]> rows)
    {
        var headerLine = "  ";
        for (int i = 0; i < headers.Length; i++)
            headerLine += AnsiColors.BoldText(headers[i].PadRight(widths[i])) + " ";
        Console.WriteLine(headerLine);

        var separatorLine = "  ";
        for (int i = 0; i < headers.Length; i++)
            separatorLine += new string('-', widths[i]) + " ";
        Console.WriteLine(separatorLine);

        foreach (var row in rows)
        {
            var rowLine = "  ";
            for (int i = 0; i < row.Length; i++)
                rowLine += row[i].PadRight(widths[i]) + " ";
            Console.WriteLine(rowLine);
        }
    }

    public static void CheckGoldenStandard(long size, long tokens)
    {
        Console.WriteLine($"\n{AnsiColors.CyanBold("黄金源码包标准检查:")}");

        var KB = 1024L;
        var MB = 1024L * KB;
        var checks = new List<(string Name, bool Passed, string Detail)>();

        if (size < 50 * KB)
            checks.Add(("文件大小 < 50KB", true, $"{FormatSize(size)} ✓"));
        else if (size < 100 * KB)
            checks.Add(("文件大小 < 100KB", true, $"{FormatSize(size)} ✓"));
        else if (size < 500 * KB)
            checks.Add(("文件大小 < 500KB", true, $"{FormatSize(size)} ✓"));
        else if (size < 1 * MB)
            checks.Add(("文件大小 < 1MB", true, $"{FormatSize(size)} ✓"));
        else
            checks.Add(("文件大小", false, $"{FormatSize(size)} - 建议精简"));

        if (tokens < 10000)
            checks.Add(("Token数 < 10K", true, $"{tokens:N0} tokens ✓"));
        else if (tokens < 50000)
            checks.Add(("Token数 < 50K", true, $"{tokens:N0} tokens ✓"));
        else if (tokens < 100000)
            checks.Add(("Token数 < 100K", true, $"{tokens:N0} tokens ✓"));
        else if (tokens < 200000)
            checks.Add(("Token数 < 200K", true, $"{tokens:N0} tokens ⚠️"));
        else
            checks.Add(("Token数", false, $"{tokens:N0} tokens - 建议精简"));

        var allPassed = true;
        foreach (var (name, passed, detail) in checks)
        {
            var status = passed ? AnsiColors.GreenText("✓ PASS") : AnsiColors.RedText("✗ FAIL");
            Console.WriteLine($"  [{status}] {name}: {detail}");
            if (!passed) allPassed = false;
        }

        if (allPassed)
            Console.WriteLine($"\n{AnsiColors.GreenBold("结论: 符合黄金源码包标准 ✓")}");
        else
            Console.WriteLine($"\n{AnsiColors.YellowBold("结论: 建议进一步精简代码")}");
    }

    public static string ResolveProjectPath(string? projectPath, IConfigManager configManager)
    {
        if (!string.IsNullOrEmpty(projectPath))
            return Path.GetFullPath(projectPath);

        var workspace = configManager.GetWorkspace();
        if (!string.IsNullOrEmpty(workspace))
            return Path.GetFullPath(workspace);

        Console.WriteLine(AnsiColors.YellowText("未指定项目路径，使用当前目录"));
        return Directory.GetCurrentDirectory();
    }
}

internal static class DailyStatsHelper
{
    public static List<DailyStats> GetDailyStats(string dbPath, int days)
    {
        var result = new List<DailyStats>();
        if (!File.Exists(dbPath))
            return result;

        try
        {
            using var connection = new SqliteConnection($"Data Source={dbPath}");
            connection.Open();

            var sql = @"
                SELECT 
                    date(timestamp) as date,
                    COUNT(*) as requests,
                    COALESCE(SUM(total_tokens), 0) as tokens,
                    COALESCE(SUM(cost), 0) as cost,
                    COALESCE(SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END), 0) as cache_hits
                FROM requests
                WHERE date(timestamp) >= date('now', '-' || @days || ' days')
                GROUP BY date(timestamp)
                ORDER BY date DESC
            ";

            using var command = new SqliteCommand(sql, connection);
            command.Parameters.AddWithValue("@days", days);
            using var reader = command.ExecuteReader();

            while (reader.Read())
            {
                result.Add(new DailyStats
                {
                    Date = reader.GetString(0),
                    TotalRequests = reader.GetInt32(1),
                    TotalTokens = reader.GetInt64(2),
                    TotalCost = (decimal)reader.GetDouble(3),
                    CacheHits = reader.GetInt32(4)
                });
            }
        }
        catch
        {
        }

        return result;
    }
}

internal static class CommandHandlers
{
    public static int HandleBuild(ParseResult parseResult,
        Argument<string?> pathArg, Option<string?> outputOpt, Option<string> configOpt)
    {
        var path = parseResult.GetValue(pathArg);
        var output = parseResult.GetValue(outputOpt);
        var configPath = parseResult.GetValue(configOpt);

        var configManager = new ConfigManager(configPath!);
        var targetPath = ConsoleHelper.ResolveProjectPath(path, configManager);
        var outputPath = output ?? Path.Combine(targetPath, "full_context.txt");

        Console.WriteLine(AnsiColors.CyanBold("\nContextGate Build\n"));
        Console.WriteLine($"{AnsiColors.GreenText("扫描目录:")} {targetPath}");
        Console.WriteLine($"{AnsiColors.GreenText("输出文件:")} {outputPath}\n");

        Console.WriteLine(AnsiColors.DimText("正在扫描文件..."));
        var scanner = new CodeScanner(new ScannerConfig());
        var files = scanner.ScanFiles(targetPath);
        Console.WriteLine(AnsiColors.GreenText($"✓ 发现 {files.Count} 个文件"));

        Console.WriteLine(AnsiColors.DimText("正在构建上下文..."));
        var result = scanner.BuildContext(targetPath, outputPath);
        Console.WriteLine(AnsiColors.GreenText("✓ 构建完成"));

        long outputSize = 0;
        if (File.Exists(result.OutputPath))
        {
            outputSize = new FileInfo(result.OutputPath).Length;
        }

        Console.WriteLine();
        Console.WriteLine(AnsiColors.BoldText("构建结果"));
        ConsoleHelper.PrintTableHeader("指标", "数值");
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("文件数量:"), result.FileCount.ToString("N0"));
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("总字符数:"), result.TotalChars.ToString("N0"));
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("预估Token:"), result.EstimatedTokens.ToString("N0"));
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("输出大小:"), ConsoleHelper.FormatSize(outputSize));
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("输出路径:"), result.OutputPath);

        ConsoleHelper.CheckGoldenStandard(outputSize, result.EstimatedTokens);

        return 0;
    }

    public static async Task<int> HandleServe(ParseResult parseResult,
        Argument<string?> pathArg, Option<string> hostOpt, Option<int> portOpt,
        Option<string?> baseUrlOpt, Option<string?> apiKeyOpt,
        Option<string?> contextOpt, Option<double?> budgetOpt, Option<string> configOpt)
    {
        var path = parseResult.GetValue(pathArg);
        var host = parseResult.GetValue(hostOpt);
        var port = parseResult.GetValue(portOpt);
        var baseUrl = parseResult.GetValue(baseUrlOpt);
        var apiKey = parseResult.GetValue(apiKeyOpt);
        var context = parseResult.GetValue(contextOpt);
        var budget = parseResult.GetValue(budgetOpt);
        var configPath = parseResult.GetValue(configOpt);

        var configManager = new ConfigManager(configPath!);
        var targetPath = ConsoleHelper.ResolveProjectPath(path, configManager);

        var contextFile = context ?? Path.Combine(targetPath, "full_context.txt");

        Console.WriteLine(AnsiColors.CyanBold("\nContextGate Proxy Server"));
        Console.WriteLine($"Version 4.0.7 | {DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}");
        Console.WriteLine();
        Console.WriteLine($"{AnsiColors.GreenText("项目路径:")} {AnsiColors.BoldText(targetPath)}");
        Console.WriteLine($"{AnsiColors.GreenText("上下文文件:")} {AnsiColors.BoldText(contextFile)}");
        Console.WriteLine($"{AnsiColors.GreenText("配置文件:")} {AnsiColors.BoldText(configPath!)}");
        Console.WriteLine($"{AnsiColors.GreenText("尝试端口:")} {AnsiColors.BoldText(port.ToString())} (若被占用将自动切换)");
        if (budget.HasValue)
            Console.WriteLine($"{AnsiColors.GreenText("预算上限:")} {AnsiColors.BoldText($"${budget.Value:F2}")}");
        Console.WriteLine();

        Console.WriteLine(AnsiColors.DimText("正在构建上下文..."));
        var scanner = new CodeScanner(new ScannerConfig());
        scanner.BuildContext(targetPath, contextFile);
        Console.WriteLine(AnsiColors.GreenText("✓ 上下文构建完成"));

        var dbPath = "contextgate.db";
        var actualPort = port;
        var maxRetries = 10;

        for (var attempt = 0; attempt < maxRetries; attempt++)
        {
            try
            {
                var builder = WebApplication.CreateBuilder();
                builder.WebHost.ConfigureKestrel(options =>
                {
                    options.ListenAnyIP(actualPort);
                });

                builder.Services.AddControllers()
                    .AddNewtonsoftJson();

                builder.Services.AddEndpointsApiExplorer();

                builder.Services.AddSingleton<IConfigManager>(sp => new ConfigManager(configPath!));
                builder.Services.AddSingleton<ITokenMonitor>(sp => new TokenMonitor(dbPath));
                builder.Services.AddSingleton<IContextSignatureService>(
                    sp => new ContextSignatureService(contextFile, targetPath));
                builder.Services.AddSingleton<ProxyService>();

                builder.Logging.ClearProviders();
                builder.Logging.AddConsole();

                var app = builder.Build();

                app.Use(async (ctx, next) =>
                {
                    var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
                    logger.LogInformation(
                        "[{Time}] {Method} {Path}",
                        DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss"),
                        ctx.Request.Method,
                        ctx.Request.Path);
                    await next();
                });

                app.MapControllers();

                Console.WriteLine(AnsiColors.GreenBold("\n代理服务器已启动!"));
                Console.WriteLine(AnsiColors.YellowBold($">>> 实际端口: {actualPort} <<<"));
                Console.WriteLine(AnsiColors.DimText($"Goose BaseURL: http://{host}:{actualPort}"));
                Console.WriteLine(AnsiColors.DimText("按 Ctrl+C 停止服务器\n"));

                await app.RunAsync();
                return 0;
            }
            catch (System.IO.IOException ex) when (ex.Message.Contains("already in use") ||
                                                    ex.Message.Contains("被占用") ||
                                                    ex.InnerException is System.Net.Sockets.SocketException)
            {
                Console.WriteLine(AnsiColors.YellowText(
                    $"端口 {actualPort} 被占用，尝试 {actualPort + 1}..."));
                actualPort++;
            }
            catch (System.Net.Sockets.SocketException)
            {
                Console.WriteLine(AnsiColors.YellowText(
                    $"端口 {actualPort} 被占用，尝试 {actualPort + 1}..."));
                actualPort++;
            }
        }

        Console.WriteLine(AnsiColors.RedText("错误: 无法找到可用端口"));
        return 1;
    }

    public static int HandleStats(ParseResult parseResult,
        Option<string> periodOpt, Option<string> dbOpt)
    {
        var period = parseResult.GetValue(periodOpt);
        var dbPath = parseResult.GetValue(dbOpt);

        if (!File.Exists(dbPath))
        {
            Console.WriteLine(AnsiColors.YellowText("数据库文件不存在，暂无统计数据。"));
            Console.WriteLine(AnsiColors.DimText($"路径: {dbPath}"));
            return 0;
        }

        using var monitor = new TokenMonitor(dbPath);
        var summary = monitor.GetSummary();

        Console.WriteLine(AnsiColors.CyanBold($"\nContextGate 使用统计 ({period})\n"));

        var total = summary.Total ?? new Statistics();
        var today = summary.Today ?? new Statistics();
        var month = summary.Month ?? new Statistics();

        Console.WriteLine(AnsiColors.BoldText("总览"));
        ConsoleHelper.PrintTableHeader("指标", "数值", 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("总请求数"), total.Requests.ToString("N0"), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("总 Token 数"), ConsoleHelper.FormatTokens(total.Tokens), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("总费用"), ConsoleHelper.FormatCost(total.Cost), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("缓存命中"), total.CacheHits.ToString("N0"), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("今日请求数"), today.Requests.ToString("N0"), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("今日 Token 数"), ConsoleHelper.FormatTokens(today.Tokens), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("今日费用"), ConsoleHelper.FormatCost(today.Cost), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("本月请求数"), month.Requests.ToString("N0"), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("本月 Token 数"), ConsoleHelper.FormatTokens(month.Tokens), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("本月费用"), ConsoleHelper.FormatCost(month.Cost), 25, 25);

        if (total.ByProvider.Count > 0)
        {
            Console.WriteLine(AnsiColors.CyanBold("\n按提供商统计:\n"));
            var providerRows = total.ByProvider.Select(p => new[]
            {
                p.Provider,
                p.Count.ToString("N0"),
                ConsoleHelper.FormatTokens(p.Tokens),
                ConsoleHelper.FormatCost(p.Cost)
            }).ToList();

            ConsoleHelper.PrintMultiColumnTable(
                new[] { "提供商", "请求数", "Token 数", "费用" },
                new[] { 20, 15, 15, 15 },
                providerRows);
        }

        var periodDays = period switch
        {
            "week" => 7,
            "month" => 30,
            "year" => 365,
            "all" => 999999,
            _ => 7
        };

        var dailyStats = DailyStatsHelper.GetDailyStats(dbPath, periodDays);
        if (dailyStats.Count > 0)
        {
            var displayDays = Math.Min(periodDays, dailyStats.Count);
            Console.WriteLine(AnsiColors.CyanBold($"\n每日统计 (最近 {displayDays} 天):\n"));

            var dailyRows = dailyStats.Select(d => new[]
            {
                d.Date,
                d.TotalRequests.ToString("N0"),
                ConsoleHelper.FormatTokens(d.TotalTokens),
                ConsoleHelper.FormatCost(d.TotalCost),
                d.CacheHits.ToString("N0")
            }).ToList();

            ConsoleHelper.PrintMultiColumnTable(
                new[] { "日期", "请求数", "Token 数", "费用", "缓存命中" },
                new[] { 15, 12, 15, 15, 12 },
                dailyRows);
        }

        Console.WriteLine(AnsiColors.CyanBold("\n缓存节省统计:\n"));

        var totalRequests = total.Requests;
        var cacheHits = total.CacheHits;
        var hitRate = totalRequests > 0 ? ((double)cacheHits / totalRequests * 100).ToString("F1") : "0.0";
        var totalCost = total.Cost;
        var estimatedSaved = cacheHits > 0 ? totalCost * ((decimal)cacheHits / totalRequests) : 0m;

        ConsoleHelper.PrintTableHeader("指标", "数值", 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("缓存命中率"), $"{hitRate}%", 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("缓存命中次数"), cacheHits.ToString("N0"), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("估算节省费用"), ConsoleHelper.FormatCost(estimatedSaved), 25, 25);
        ConsoleHelper.PrintTableRow(AnsiColors.GreenText("运行时间"), $"{Math.Floor(summary.Uptime / 60)} 分钟", 25, 25);

        return 0;
    }

    public static int HandleScan(ParseResult parseResult,
        Argument<string> pathArg, Option<string?> outputOpt)
    {
        var path = parseResult.GetValue(pathArg);
        var output = parseResult.GetValue(outputOpt);

        var targetPath = Path.GetFullPath(path!);

        Console.WriteLine(AnsiColors.CyanText($"正在扫描项目: {targetPath}"));

        var scanner = new CodeScanner(new ScannerConfig());
        var files = scanner.ScanFiles(targetPath);

        Console.WriteLine($"\n{AnsiColors.GreenText($"扫描完成，找到 {files.Count} 个文件:")}");
        var displayCount = Math.Min(files.Count, 30);
        for (var i = 0; i < displayCount; i++)
        {
            Console.WriteLine($"  {i + 1}. {files[i].RelativePath}");
        }

        if (files.Count > 30)
        {
            Console.WriteLine($"  ... 还有 {files.Count - 30} 个文件");
        }

        if (!string.IsNullOrEmpty(output))
        {
            var lines = files.Select(f => f.RelativePath);
            File.WriteAllText(output, string.Join("\n", lines), Encoding.UTF8);
            Console.WriteLine($"\n{AnsiColors.GreenText($"结果已保存到: {output}")}");
        }

        return 0;
    }
}

public class Program
{
    public static int Main(string[] args)
    {
        var buildPathArg = new Argument<string?>("path")
        {
            Description = "项目目录路径"
        };

        var buildOutputOpt = new Option<string?>("--output", "-o")
        {
            Description = "输出文件路径"
        };

        var buildConfigOpt = new Option<string>("--config", "-c")
        {
            Description = "配置文件路径",
            DefaultValueFactory = _ => "config.yaml"
        };

        var buildCommand = new Command("build", "构建完整上下文文件")
        {
            buildPathArg,
            buildOutputOpt,
            buildConfigOpt
        };

        buildCommand.SetAction(parseResult =>
            CommandHandlers.HandleBuild(parseResult, buildPathArg, buildOutputOpt, buildConfigOpt));

        var servePathArg = new Argument<string?>("path")
        {
            Description = "项目目录路径"
        };

        var serveHostOpt = new Option<string>("--host")
        {
            Description = "监听地址",
            DefaultValueFactory = _ => "127.0.0.1"
        };

        var servePortOpt = new Option<int>("--port")
        {
            Description = "监听端口",
            DefaultValueFactory = _ => 12306
        };

        var serveBaseUrlOpt = new Option<string?>("--base-url")
        {
            Description = "目标 API Base URL"
        };

        var serveApiKeyOpt = new Option<string?>("--api-key")
        {
            Description = "API Key"
        };

        var serveContextOpt = new Option<string?>("--context")
        {
            Description = "上下文文件路径"
        };

        var serveBudgetOpt = new Option<double?>("--budget")
        {
            Description = "预算上限 (美元)"
        };

        var serveConfigOpt = new Option<string>("--config", "-c")
        {
            Description = "配置文件路径",
            DefaultValueFactory = _ => "config.yaml"
        };

        var serveCommand = new Command("serve", "启动代理服务器")
        {
            servePathArg,
            serveHostOpt,
            servePortOpt,
            serveBaseUrlOpt,
            serveApiKeyOpt,
            serveContextOpt,
            serveBudgetOpt,
            serveConfigOpt
        };

        serveCommand.SetAction(async parseResult =>
            await CommandHandlers.HandleServe(parseResult, servePathArg, serveHostOpt, servePortOpt,
                serveBaseUrlOpt, serveApiKeyOpt, serveContextOpt, serveBudgetOpt, serveConfigOpt));

        var statsPeriodOpt = new Option<string>("--period")
        {
            Description = "统计周期 (week/month/year/all)",
            DefaultValueFactory = _ => "week"
        };

        var statsDbOpt = new Option<string>("--db")
        {
            Description = "数据库路径",
            DefaultValueFactory = _ => "contextgate.db"
        };

        var statsCommand = new Command("stats", "显示使用统计")
        {
            statsPeriodOpt,
            statsDbOpt
        };

        statsCommand.SetAction(parseResult =>
            CommandHandlers.HandleStats(parseResult, statsPeriodOpt, statsDbOpt));

        var scanPathArg = new Argument<string>("path")
        {
            Description = "项目目录路径"
        };

        var scanOutputOpt = new Option<string?>("--output", "-o")
        {
            Description = "输出文件路径"
        };

        var scanCommand = new Command("scan", "扫描项目代码")
        {
            scanPathArg,
            scanOutputOpt
        };

        scanCommand.SetAction(parseResult =>
            CommandHandlers.HandleScan(parseResult, scanPathArg, scanOutputOpt));

        var rootCommand = new RootCommand("ContextGate - AI Context Management & Proxy System");
        rootCommand.Subcommands.Add(buildCommand);
        rootCommand.Subcommands.Add(serveCommand);
        rootCommand.Subcommands.Add(statsCommand);
        rootCommand.Subcommands.Add(scanCommand);

        rootCommand.SetAction(parseResult =>
        {
            Console.WriteLine(AnsiColors.CyanBold("ContextGate") + " v4.0.7");
            Console.WriteLine("AI Context Management & Proxy System");
            Console.WriteLine();
            Console.WriteLine("使用 --help 查看可用命令");
            return 0;
        });

        return rootCommand.Parse(args).Invoke();
    }
}
