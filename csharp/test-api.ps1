# ContextGate Proxy API 测试脚本

$baseUrl = "http://localhost:12306"

Write-Host "=== ContextGate Proxy API 测试 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 健康检查
Write-Host "1. 测试健康检查..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get
    Write-Host "   ✓ 健康检查成功" -ForegroundColor Green
    Write-Host "   状态: $($response.status)" -ForegroundColor Gray
    Write-Host "   版本: $($response.version)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ 健康检查失败: $_" -ForegroundColor Red
}
Write-Host ""

# 2. 获取统计信息
Write-Host "2. 测试统计信息..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/stats" -Method Get
    Write-Host "   ✓ 统计信息获取成功" -ForegroundColor Green
    Write-Host "   请求数: $($response.requestCount)" -ForegroundColor Gray
    Write-Host "   缓存数: $($response.cacheSize)" -ForegroundColor Gray
    Write-Host "   运行时间: $([math]::Round($response.uptime, 2))s" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ 统计信息获取失败: $_" -ForegroundColor Red
}
Write-Host ""

# 3. 获取上下文哈希
Write-Host "3. 测试上下文哈希..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/context/hash" -Method Get
    Write-Host "   ✓ 上下文哈希获取成功" -ForegroundColor Green
    Write-Host "   文件: $($response.contextFile)" -ForegroundColor Gray
    Write-Host "   哈希: $($response.hash)" -ForegroundColor Gray
    Write-Host "   文件数: $($response.fileCount)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ 上下文哈希获取失败: $_" -ForegroundColor Red
}
Write-Host ""

# 4. 获取上下文内容
Write-Host "4. 测试上下文内容..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/context" -Method Get
    Write-Host "   ✓ 上下文内容获取成功" -ForegroundColor Green
    $lines = $response -split "`n"
    Write-Host "   行数: $($lines.Count)" -ForegroundColor Gray
    Write-Host "   前 3 行:" -ForegroundColor Gray
    $lines[0..2] | ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
} catch {
    Write-Host "   ✗ 上下文内容获取失败: $_" -ForegroundColor Red
}
Write-Host ""

# 5. 测试缓存清除
Write-Host "5. 测试缓存清除..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/cache" -Method Delete
    Write-Host "   ✓ 缓存清除成功" -ForegroundColor Green
    Write-Host "   结果: $($response.success)" -ForegroundColor Gray
} catch {
    Write-Host "   ✗ 缓存清除失败: $_" -ForegroundColor Red
}
Write-Host ""

# 6. 测试聊天请求（需要有效的 API 密钥）
Write-Host "6. 测试聊天请求（模拟）..." -ForegroundColor Yellow
Write-Host "   ⚠ 需要在 config.yaml 中配置有效的 API 密钥" -ForegroundColor DarkYellow
Write-Host "   示例请求体:" -ForegroundColor Gray
$chatRequest = @{
    model = "gpt-3.5-turbo"
    messages = @(
        @{
            role = "user"
            content = "Hello, how are you?"
        }
    )
} | ConvertTo-Json -Depth 10
Write-Host $chatRequest -ForegroundColor DarkGray
Write-Host ""

Write-Host "=== 测试完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "提示:" -ForegroundColor Yellow
Write-Host "  - 确保代理服务器正在运行 (start-proxy.bat)" -ForegroundColor Gray
Write-Host "  - 配置有效的 API 密钥以测试聊天功能" -ForegroundColor Gray
Write-Host "  - 查看服务器日志了解详细信息" -ForegroundColor Gray
