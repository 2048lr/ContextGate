@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "INSTALL_DIR=%~dp0"
set "CLI_PATH=%INSTALL_DIR%cli"

echo ========================================
echo   ContextGate 安装脚本
echo ========================================
echo.

set /p "ADD_PATH=是否将CLI添加到系统PATH? (y/n): "

if /i "%ADD_PATH%"=="y" (
    echo 正在添加CLI到用户PATH...
    setx PATH "%PATH%;%CLI_PATH%" >nul 2>&1
    if !errorlevel! equ 0 (
        echo 成功添加CLI到PATH
        echo 请重新打开命令行窗口以生效
    ) else (
        echo 添加PATH失败，请手动添加: %CLI_PATH%
    )
)

echo.
echo 安装完成!
echo.
echo 使用方式:
echo   - 双击 ContextGate.Desktop.exe 启动图形界面
echo   - 运行 cli.bat 使用命令行工具
echo   - 运行 proxy.bat 启动代理服务
echo.
pause
