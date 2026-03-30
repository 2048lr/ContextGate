#!/bin/bash
set -e

# 创建 Debian 包
# ContextGate Debian Package Builder

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="3.0.0"
PACKAGE_NAME="contextgate"
ARCH="amd64"

echo "========================================"
echo "  ContextGate Debian Package Builder"
echo "  Version: $VERSION"
echo "========================================"
echo ""

# 使用虚拟环境
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "创建虚拟环境..."
    python3 -m venv "$VENV_DIR"
fi

# 激活虚拟环境
source "$VENV_DIR/bin/activate"

# 检查依赖
echo "[1/6] 检查依赖..."
if ! command -v pyinstaller >/dev/null 2>&1; then
    echo "安装 PyInstaller..."
    pip install pyinstaller
fi

# 安装 Python 依赖
echo "[2/6] 安装 Python 依赖..."
pip install -q PySide6 fastapi uvicorn httpx pyyaml watchdog rich

# 清理旧的构建文件
echo "[3/6] 清理旧构建..."
rm -rf build/ dist/ *.spec

# 使用 PyInstaller 打包 (优化版：onedir模式 + 排除模块)
echo "[4/6] PyInstaller 打包 (优化模式)..."
pyinstaller \
    --onedir \
    --name contextgate \
    --hidden-import PySide6 \
    --hidden-import PySide6.QtWidgets \
    --hidden-import PySide6.QtCore \
    --hidden-import PySide6.QtGui \
    --hidden-import fastapi \
    --hidden-import uvicorn \
    --hidden-import httpx \
    --hidden-import yaml \
    --hidden-import watchdog \
    --hidden-import rich \
    --hidden-import app \
    --hidden-import app.gui \
    --hidden-import app.gui.main_window \
    --hidden-import app.gui.i18n \
    --hidden-import app.gui.currency \
    --hidden-import app.gui.styles \
    --hidden-import app.scanner \
    --hidden-import app.proxy \
    --hidden-import app.monitor \
    --hidden-import app.report \
    --exclude-module tkinter \
    --exclude-module matplotlib \
    --exclude-module PIL \
    --exclude-module scipy \
    --exclude-module numpy \
    --exclude-module pandas \
    --exclude-module pytest \
    --exclude-module unittest \
    --exclude-module test \
    --exclude-module tests \
    --exclude-module PySide6.Qt3D \
    --exclude-module PySide6.QtBluetooth \
    --exclude-module PySide6.QtCharts \
    --exclude-module PySide6.QtDataVisualization \
    --exclude-module PySide6.QtDesigner \
    --exclude-module PySide6.QtHelp \
    --exclude-module PySide6.QtLocation \
    --exclude-module PySide6.QtMultimedia \
    --exclude-module PySide6.QtMultimediaWidgets \
    --exclude-module PySide6.QtNetwork \
    --exclude-module PySide6.QtNfc \
    --exclude-module PySide6.QtOpenGL \
    --exclude-module PySide6.QtPositioning \
    --exclude-module PySide6.QtQuick \
    --exclude-module PySide6.QtQuickWidgets \
    --exclude-module PySide6.QtRemoteObjects \
    --exclude-module PySide6.QtScript \
    --exclude-module PySide6.QtScriptTools \
    --exclude-module PySide6.QtSensors \
    --exclude-module PySide6.QtSerialPort \
    --exclude-module PySide6.QtSql \
    --exclude-module PySide6.QtSvg \
    --exclude-module PySide6.QtTest \
    --exclude-module PySide6.QtTextToSpeech \
    --exclude-module PySide6.QtUiTools \
    --exclude-module PySide6.QtWebChannel \
    --exclude-module PySide6.QtWebEngine \
    --exclude-module PySide6.QtWebSockets \
    --exclude-module PySide6.QtXml \
    --exclude-module PySide6.QtXmlPatterns \
    --noupx \
    --clean \
    --noconfirm \
    main.py

# 创建 Debian 包目录结构
echo "[5/6] 创建 Debian 包结构..."
DEB_DIR="debian/${PACKAGE_NAME}"
rm -rf "$DEB_DIR"

mkdir -p "$DEB_DIR/usr/bin"
mkdir -p "$DEB_DIR/usr/share/applications"
mkdir -p "$DEB_DIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$DEB_DIR/usr/share/contextgate"
mkdir -p "$DEB_DIR/etc/contextgate"
mkdir -p "$DEB_DIR/DEBIAN"

# 复制文件 (onedir模式)
cp -r dist/contextgate "$DEB_DIR/usr/share/"
ln -sf /usr/share/contextgate/contextgate "$DEB_DIR/usr/bin/contextgate"
chmod 755 "$DEB_DIR/usr/share/contextgate/contextgate"

cp integration/contextgate.desktop "$DEB_DIR/usr/share/applications/"

if [ -f "resources/icon.png" ]; then
    cp resources/icon.png "$DEB_DIR/usr/share/icons/hicolor/256x256/apps/contextgate.png"
fi

cp config.yaml.example "$DEB_DIR/etc/contextgate/config.yaml"
cp integration/contextgate-nautilus.py "$DEB_DIR/usr/share/contextgate/nautilus-extension.py"

# 创建控制文件
cat > "$DEB_DIR/DEBIAN/control" << EOF
Package: ${PACKAGE_NAME}
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Installed-Size: $(du -sk "$DEB_DIR" | cut -f1)
Maintainer: ContextGate Team <team@contextgate.dev>
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
EOF

# 复制维护脚本
cp debian/postinst "$DEB_DIR/DEBIAN/"
cp debian/postrm "$DEB_DIR/DEBIAN/"
chmod 755 "$DEB_DIR/DEBIAN/"*

# 构建 .deb 包
echo "[6/6] 构建 .deb 包..."
DEB_FILE="${PACKAGE_NAME}_${VERSION}_${ARCH}.deb"
dpkg-deb --build "$DEB_DIR" "$DEB_FILE"

echo ""
echo "========================================"
echo "  构建完成!"
echo "  输出: $DEB_FILE"
echo "  大小: $(du -h "$DEB_FILE" | cut -f1)"
echo "========================================"
echo ""
echo "安装命令:"
echo "  sudo dpkg -i $DEB_FILE"
echo ""
echo "或者添加到 apt 仓库:"
echo "  sudo apt install ./$DEB_FILE"
