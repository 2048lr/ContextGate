#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="3.0.1"
RELEASE="1"
PACKAGE_NAME="contextgate"
ARCH="x86_64"
RPM_NAME="${PACKAGE_NAME}-${VERSION}-${RELEASE}.${ARCH}.rpm"

echo "========================================"
echo "  ContextGate RPM Builder"
echo "  Version: $VERSION"
echo "========================================"
echo ""

VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "创建虚拟环境..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "[1/6] 检查依赖..."
if ! command -v pyinstaller >/dev/null 2>&1; then
    pip install pyinstaller
fi

if ! command -v rpmbuild >/dev/null 2>&1; then
    echo "安装 rpm-build..."
    sudo apt-get install -y rpm-build rpm 2>/dev/null || sudo dnf install -y rpm-build 2>/dev/null || sudo yum install -y rpm-build 2>/dev/null
fi

echo "[2/6] 安装 Python 依赖..."
pip install -q PySide6 fastapi uvicorn httpx pyyaml watchdog rich

echo "[3/6] 清理旧构建..."
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
    --strip
    --noupx
    --clean
    --noconfirm
)

echo "[4/6] PyInstaller 打包..."
pyinstaller "${PYINSTALLER_OPTS[@]}" main.py

echo "[5/6] 创建 RPM 包结构..."
RPM_BUILD_DIR="$SCRIPT_DIR/rpmbuild"
rm -rf "$RPM_BUILD_DIR"
mkdir -p "$RPM_BUILD_DIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS,BUILDROOT}

BUILDROOT="$RPM_BUILD_DIR/BUILDROOT/${PACKAGE_NAME}-${VERSION}-${RELEASE}.${ARCH}"
mkdir -p "$BUILDROOT/usr/bin"
mkdir -p "$BUILDROOT/usr/share/applications"
mkdir -p "$BUILDROOT/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$BUILDROOT/usr/share/contextgate"
mkdir -p "$BUILDROOT/etc/contextgate"

cp -r dist/contextgate "$BUILDROOT/usr/share/"
ln -sf /usr/share/contextgate/contextgate "$BUILDROOT/usr/bin/contextgate"
chmod 755 "$BUILDROOT/usr/share/contextgate/contextgate"

cp integration/contextgate.desktop "$BUILDROOT/usr/share/applications/"

if [ -f "resources/icon.png" ]; then
    cp resources/icon.png "$BUILDROOT/usr/share/icons/hicolor/256x256/apps/contextgate.png"
fi

cp config.yaml.example "$BUILDROOT/etc/contextgate/config.yaml"

CHANGELOG_DATE=$(LC_TIME=C date '+%a %b %d %Y')

cat > "$RPM_BUILD_DIR/SPECS/${PACKAGE_NAME}.spec" << EOF
Name:           ${PACKAGE_NAME}
Version:        ${VERSION}
Release:        ${RELEASE}%{?dist}
Summary:        AI Context Management & Proxy System

License:        MIT
URL:            https://github.com/2048lr/ContextGate
BuildArch:      x86_64
Requires:       glibc >= 2.17

%description
ContextGate is a powerful tool for managing AI context and proxying
API requests with intelligent caching and token monitoring.

Features:
- Code scanning with .gitignore support
- FastAPI proxy with cache management
- Token monitoring and cost tracking
- Multi-backend API support (OpenAI, Zhipu, DeepSeek)
- Native GUI with PySide6
- System tray integration
- Visual configuration management

%files
%defattr(-,root,root,-)
/usr/bin/contextgate
/usr/share/contextgate
/usr/share/applications/contextgate.desktop
/usr/share/icons/hicolor/256x256/apps/contextgate.png
%config(noreplace) /etc/contextgate/config.yaml

%changelog
* ${CHANGELOG_DATE} JerryLiu <liurun637@gmail.com> - ${VERSION}-${RELEASE}
- Release v${VERSION}: Visual settings dialog and Chinese localization

EOF

echo "[6/6] 构建 RPM 包..."
rpmbuild --define "_topdir $RPM_BUILD_DIR" --define "_buildrootdir $BUILDROOT" -bb "$RPM_BUILD_DIR/SPECS/${PACKAGE_NAME}.spec"

cp "$RPM_BUILD_DIR/RPMS/${ARCH}/${RPM_NAME}" "$SCRIPT_DIR/"

RPM_SIZE=$(du -h "$RPM_NAME" | cut -f1)

echo ""
echo "========================================"
echo "  RPM 构建完成!"
echo "----------------------------------------"
echo "  文件大小: $RPM_SIZE"
echo "  输出文件: $RPM_NAME"
echo "========================================"
echo ""
echo "安装命令 (Fedora/RHEL/CentOS):"
echo "  sudo dnf install ./$RPM_NAME"
echo ""
echo "或使用 rpm:"
echo "  sudo rpm -i $RPM_NAME"
