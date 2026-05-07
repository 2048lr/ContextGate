@echo off
chcp 65001 >nul
echo ContextGate Proxy - API代理服务
echo.
echo 启动代理服务...
echo.
cd /d "%~dp0proxy"
ContextGate.Proxy.exe
