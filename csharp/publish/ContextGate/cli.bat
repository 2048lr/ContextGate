@echo off
chcp 65001 >nul
echo ContextGate CLI - 命令行工具
echo.
echo 用法:
echo   ContextGate.CLI.exe build [path]     构建上下文文件
echo   ContextGate.CLI.exe serve [path]     启动代理服务
echo   ContextGate.CLI.exe stats            查看使用统计
echo   ContextGate.CLI.exe scan [path]      扫描项目文件
echo.
echo 运行 ContextGate.CLI.exe --help 查看完整帮助
echo.
cd /d "%~dp0cli"
ContextGate.CLI.exe %*
