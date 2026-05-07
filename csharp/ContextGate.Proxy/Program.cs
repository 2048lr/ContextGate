using ContextGate.Core.Services;
using ContextGate.Core.Services.Interfaces;

var builder = WebApplication.CreateBuilder(args);

// 配置 Kestrel
var proxyHost = builder.Configuration["Proxy:Host"] ?? "127.0.0.1";
var proxyPort = int.Parse(builder.Configuration["Proxy:Port"] ?? "12306");

builder.WebHost.ConfigureKestrel(options =>
{
    options.ListenAnyIP(proxyPort);
});

// 添加服务
builder.Services.AddControllers()
    .AddNewtonsoftJson(); // 使用 Newtonsoft.Json

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// 注册核心服务
var configPath = builder.Configuration["ConfigPath"] ?? "config.yaml";
var contextFile = builder.Configuration["ContextFile"] ?? "context.md";
var projectRoot = builder.Configuration["ProjectRoot"];

builder.Services.AddSingleton<IConfigManager>(sp => 
    new ConfigManager(configPath));

builder.Services.AddSingleton<ITokenMonitor>(sp =>
{
    var dbPath = builder.Configuration["DatabasePath"] ?? "contextgate.db";
    return new TokenMonitor(dbPath);
});

builder.Services.AddSingleton<IContextSignatureService>(sp =>
    new ContextSignatureService(contextFile, projectRoot));

builder.Services.AddSingleton<ProxyService>();

// 添加日志
builder.Logging.ClearProviders();
builder.Logging.AddConsole();

var app = builder.Build();

// 配置中间件
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// 请求日志中间件
app.Use(async (context, next) =>
{
    var logger = context.RequestServices.GetRequiredService<ILogger<Program>>();
    logger.LogInformation($"[{DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}] {context.Request.Method} {context.Request.Path}");
    await next();
});

app.MapControllers();

Console.WriteLine($"ContextGate Proxy Server starting on {proxyHost}:{proxyPort}");
Console.WriteLine($"Config: {configPath}");
Console.WriteLine($"Context: {contextFile}");

app.Run();
