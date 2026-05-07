@echo off
echo Starting ContextGate Proxy Server...
echo.

cd /d "%~dp0"

set DOTNET_PATH=C:\Program Files\dotnet\dotnet.exe

if not exist "%DOTNET_PATH%" (
    echo Error: .NET SDK not found at %DOTNET_PATH%
    echo Please install .NET 8.0 SDK or update the path in this script.
    pause
    exit /b 1
)

if not exist "config.yaml" (
    echo Warning: config.yaml not found, using default configuration
)

if not exist "context.md" (
    echo Warning: context.md not found, creating empty file
    echo. > context.md
)

echo Configuration:
echo   Config: config.yaml
echo   Context: context.md
echo   Database: contextgate.db
echo.

"%DOTNET_PATH%" run --project ContextGate.Proxy

pause
