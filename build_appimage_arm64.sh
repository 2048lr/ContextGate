#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="3.0.1-beta"
APP_NAME="ContextGate"
APPIMAGE_NAME="ContextGate-${VERSION}-arm64.AppImage"

echo "========================================"
echo "  ContextGate AppImage Builder (ARM64)"
echo "  Version: $VERSION"
echo "  Architecture: arm64"
echo "========================================"
echo ""

VENV_DIR="$SCRIPT_DIR/.venv_arm64"
if [ ! -d "$VENV_DIR" ]; then
    echo "创建虚拟环境..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "[1/6] 检查依赖..."
if ! command -v pyinstaller >/dev/null 2>&1; then
    pip install pyinstaller
fi

echo "[2/6] 安装 Python 依赖..."
pip install -q PySide6 fastapi uvicorn httpx pyyaml watchdog rich

echo "[3/6] 清理旧构建..."
rm -rf build/ dist/ *.spec AppDir/

PYINSTALLER_OPTS=(
    --onedir
    --name contextgate
    --hidden-import PySide6
    --hidden-import PySide6.QtWidgets
    --hidden-import PySide6.QtCore
    --hidden-import PySide6.QtGui
    --hidden-import fastapi
    --hidden-import uvicorn
    --hidden-import httpx
    --hidden-import yaml
    --hidden-import watchdog
    --hidden-import rich
    --hidden-import app
    --hidden-import app.gui
    --hidden-import app.gui.main_window
    --hidden-import app.gui.i18n
    --hidden-import app.gui.currency
    --hidden-import app.gui.styles
    --hidden-import app.gui.settings_dialog
    --hidden-import app.scanner
    --hidden-import app.proxy
    --hidden-import app.monitor
    --hidden-import app.report
    --exclude-module tkinter
    --exclude-module matplotlib
    --exclude-module PIL
    --exclude-module scipy
    --exclude-module numpy
    --exclude-module pandas
    --exclude-module pytest
    --exclude-module unittest
    --exclude-module test
    --exclude-module tests
    --exclude-module IPython
    --exclude-module jupyter
    --exclude-module notebook
    --exclude-module sphinx
    --exclude-module docutils
    --exclude-module PySide6.Qt3D
    --exclude-module PySide6.QtBluetooth
    --exclude-module PySide6.QtCharts
    --exclude-module PySide6.QtDataVisualization
    --exclude-module PySide6.QtDesigner
    --exclude-module PySide6.QtHelp
    --exclude-module PySide6.QtLocation
    --exclude-module PySide6.QtMultimedia
    --exclude-module PySide6.QtMultimediaWidgets
    --exclude-module PySide6.QtNetwork
    --exclude-module PySide6.QtNfc
    --exclude-module PySide6.QtOpenGL
    --exclude-module PySide6.QtPositioning
    --exclude-module PySide6.QtQuick
    --exclude-module PySide6.QtQuickWidgets
    --exclude-module PySide6.QtRemoteObjects
    --exclude-module PySide6.QtScript
    --exclude-module PySide6.QtScriptTools
    --exclude-module PySide6.QtSensors
    --exclude-module PySide6.QtSerialPort
    --exclude-module PySide6.QtSql
    --exclude-module PySide6.QtSvg
    --exclude-module PySide6.QtTest
    --exclude-module PySide6.QtTextToSpeech
    --exclude-module PySide6.QtUiTools
    --exclude-module PySide6.QtWebChannel
    --exclude-module PySide6.QtWebEngine
    --exclude-module PySide6.QtWebSockets
    --exclude-module PySide6.QtXml
    --exclude-module PySide6.QtXmlPatterns
    --exclude-module PySide6.QtPdf
    --exclude-module PySide6.QtPdfWidgets
    --exclude-module PySide6.QtOpcUa
    --exclude-module PySide6.QtSpatialAudio
    --exclude-module PySide6.QtStateMachine
    --strip
    --noupx
    --clean
    --noconfirm
)

echo "[4/6] PyInstaller 打包..."
pyinstaller "${PYINSTALLER_OPTS[@]}" main.py

echo "[5/6] 创建 AppDir 结构..."
mkdir -p AppDir/usr/bin
mkdir -p AppDir/usr/share/applications
mkdir -p AppDir/usr/share/icons/hicolor/256x256/apps
mkdir -p AppDir/usr/share/contextgate
mkdir -p AppDir/etc/contextgate

cp -r dist/contextgate AppDir/usr/share/
ln -sf usr/share/contextgate/contextgate AppDir/usr/bin/contextgate
chmod 755 AppDir/usr/share/contextgate/contextgate

cp integration/contextgate.desktop AppDir/usr/share/applications/
cp integration/contextgate.desktop AppDir/contextgate.desktop

if [ -f "resources/icon.png" ]; then
    cp resources/icon.png AppDir/usr/share/icons/hicolor/256x256/apps/contextgate.png
    cp resources/icon.png AppDir/contextgate.png
fi

cp config.yaml.example AppDir/etc/contextgate/config.yaml

cat > AppDir/AppRun << 'EOF'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
export PATH="${HERE}/usr/bin:${PATH}"
export XDG_DATA_DIRS="${HERE}/usr/share:${XDG_DATA_DIRS}"
exec "${HERE}/usr/share/contextgate/contextgate" "$@"
EOF
chmod 755 AppDir/AppRun

echo "[6/6] 构建 AppImage..."
if ! command -v appimagetool >/dev/null 2>&1; then
    echo "下载 appimagetool (arm64)..."
    ARCH=arm_aarch64
    wget -q "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${ARCH}.AppImage" -O /tmp/appimagetool-arm64 || {
        echo "警告: arm64 appimagetool 下载失败，尝试使用系统版本..."
        APPIMAGETOOL="appimagetool"
    }
    if [ -f /tmp/appimagetool-arm64 ]; then
        chmod +x /tmp/appimagetool-arm64
        APPIMAGETOOL="/tmp/appimagetool-arm64"
    fi
else
    APPIMAGETOOL="appimagetool"
fi

ARCH=arm_aarch64 "$APPIMAGETOOL" AppDir "$APPIMAGE_NAME" || {
    echo "尝试使用 aarch64 架构标识..."
    ARCH=aarch64 "$APPIMAGETOOL" AppDir "$APPIMAGE_NAME"
}

APPIMAGE_SIZE=$(du -h "$APPIMAGE_NAME" | cut -f1)

echo ""
echo "========================================"
echo "  ARM64 AppImage 构建完成!"
echo "----------------------------------------"
echo "  文件大小: $APPIMAGE_SIZE"
echo "  输出文件: $APPIMAGE_NAME"
echo "========================================"
echo ""
echo "运行命令:"
echo "  chmod +x $APPIMAGE_NAME"
echo "  ./$APPIMAGE_NAME"
