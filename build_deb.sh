#!/bin/bash
set -e

# ContextGate Debian Package Builder
# 优化版：快速打包、低内存、小体积

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="3.0.1"
PACKAGE_NAME="contextgate"
ARCH="amd64"

DEBUG_MODE="${1:-release}"
if [ "$DEBUG_MODE" = "debug" ]; then
    echo "========================================"
    echo "  ContextGate Debian Builder (DEBUG)"
    echo "  Version: $VERSION"
    echo "========================================"
else
    echo "========================================"
    echo "  ContextGate Debian Builder (RELEASE)"
    echo "  Version: $VERSION"
    echo "========================================"
fi
echo ""

CPU_CORES=$(nproc)
echo "检测到 CPU 核心数: $CPU_CORES"
echo ""

VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "创建虚拟环境..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "[1/7] 检查依赖..."
if ! command -v pyinstaller >/dev/null 2>&1; then
    pip install pyinstaller
fi

echo "[2/7] 安装 Python 依赖..."
pip install -q PySide6 fastapi uvicorn httpx pyyaml watchdog rich

echo "[3/7] 清理旧构建..."
rm -rf build/ dist/ *.spec

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
    --noupx
    --clean
    --noconfirm
)

if [ "$DEBUG_MODE" = "debug" ]; then
    PYINSTALLER_OPTS+=(--debug all --log-level DEBUG)
    echo "[4/7] PyInstaller 打包 (DEBUG 模式)..."
else
    PYINSTALLER_OPTS+=(--strip)
    echo "[4/7] PyInstaller 打包 (RELEASE 模式)..."
fi

echo "    执行: pyinstaller ${PYINSTALLER_OPTS[*]} main.py"
pyinstaller "${PYINSTALLER_OPTS[@]}" main.py

echo "[5/7] 创建 Debian 包结构..."
DEB_DIR="debian/${PACKAGE_NAME}"
rm -rf "$DEB_DIR"

mkdir -p "$DEB_DIR/usr/bin"
mkdir -p "$DEB_DIR/usr/share/applications"
mkdir -p "$DEB_DIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$DEB_DIR/usr/share/contextgate"
mkdir -p "$DEB_DIR/etc/contextgate"
mkdir -p "$DEB_DIR/DEBIAN"

echo "[6/7] 复制文件..."
cp -r dist/contextgate "$DEB_DIR/usr/share/"
ln -sf /usr/share/contextgate/contextgate "$DEB_DIR/usr/bin/contextgate"
chmod 755 "$DEB_DIR/usr/share/contextgate/contextgate"

cp integration/contextgate.desktop "$DEB_DIR/usr/share/applications/"

if [ -f "resources/icon.png" ]; then
    cp resources/icon.png "$DEB_DIR/usr/share/icons/hicolor/256x256/apps/contextgate.png"
fi

cp config.yaml.example "$DEB_DIR/etc/contextgate/config.yaml"
cp integration/contextgate-nautilus.py "$DEB_DIR/usr/share/contextgate/nautilus-extension.py"

cat > "$DEB_DIR/DEBIAN/control" << EOF
Package: ${PACKAGE_NAME}
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Installed-Size: $(du -sk "$DEB_DIR" | cut -f1)
Maintainer: JerryLiu <liurun637@gmail.com>
Description: AI Context Management & Proxy System
 ContextGate is a powerful tool for managing AI context and proxying
 API requests with intelligent caching and token monitoring.
 .
 Features:
  - Code scanning with .gitignore support
  - FastAPI proxy with cache management
  - Token monitoring and cost tracking
  - Multi-backend API support (OpenAI, Zhipu, DeepSeek)
  - Native GUI with PySide6
  - System tray integration
  - Visual configuration management
EOF

cp debian/postinst "$DEB_DIR/DEBIAN/"
cp debian/postrm "$DEB_DIR/DEBIAN/"
chmod 755 "$DEB_DIR/DEBIAN/"*

echo "[7/7] 构建 .deb 包..."
if [ "$DEBUG_MODE" = "debug" ]; then
    DEB_FILE="${PACKAGE_NAME}_${VERSION}_${ARCH}_debug.deb"
else
    DEB_FILE="${PACKAGE_NAME}_${VERSION}_${ARCH}.deb"
fi
dpkg-deb --build "$DEB_DIR" "$DEB_FILE"

DIST_SIZE=$(du -sh dist/contextgate | cut -f1)
DEB_SIZE=$(du -h "$DEB_FILE" | cut -f1)
INSTALLED_SIZE=$(du -sh "$DEB_DIR" | cut -f1)

echo ""
echo "========================================"
echo "  构建完成!"
echo "  模式: $DEBUG_MODE"
echo "----------------------------------------"
echo "  dist/ 目录大小: $DIST_SIZE"
echo "  安装后大小:     $INSTALLED_SIZE"
echo "  .deb 包大小:    $DEB_SIZE"
echo "  输出文件:       $DEB_FILE"
echo "========================================"
echo ""
echo "安装命令:"
echo "  sudo dpkg -i $DEB_FILE"
echo ""
echo "或使用 apt:"
echo "  sudo apt install ./$DEB_FILE"
