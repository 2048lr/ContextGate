"""
ContextGate 主窗口
基于 PySide6 的现代化深色主题界面
"""

import sys
import os
import threading
import socket
import random
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any
from dataclasses import dataclass

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QFrame, QSplitter, QTextEdit, QPlainTextEdit,
    QStatusBar, QSystemTrayIcon, QMenu, QFileDialog, QMessageBox,
    QScrollArea, QListView, QAbstractItemView, QStyledItemDelegate,
    QStyle, QSizePolicy, QSpacerItem
)
from PySide6.QtCore import (
    Qt, QTimer, Signal, Slot, QThread, QMutex, QSettings,
    QSize, QRect, QPoint
)
from PySide6.QtGui import (
    QIcon, QFont, QColor, QPalette, QAction, QCursor,
    QTextCharFormat, QTextCursor, QBrush, QPen
)

from .i18n import get_i18n, I18n
from .currency import CurrencyDetector, Currency
from .styles import DARK_THEME


@dataclass
class RequestLogEntry:
    timestamp: datetime
    model: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost: float
    cache_hit: bool
    provider: str


class ProxyWorker(QThread):
    """代理服务器工作线程"""
    started_signal = Signal(int)
    error_signal = Signal(str)
    request_signal = Signal(dict)
    
    def __init__(self, host: str, port: int, config_path: str, context_file: str):
        super().__init__()
        self.host = host
        self.port = port
        self.config_path = config_path
        self.context_file = context_file
        self._running = False
        self._actual_port = port
        self._server = None
    
    def run(self):
        import asyncio
        import uvicorn
        from app.proxy import AIProxy, ProxyMonitor
        
        proxy = AIProxy(context_file=self.context_file, config_path=self.config_path)
        
        actual_port = proxy._find_available_port(self.host, self.port)
        self._actual_port = actual_port
        
        if actual_port != self.port:
            print(f"\n[Port] 端口 {self.port} 已被占用，自动切换到 {actual_port}\n")
        
        def on_request(data):
            self.request_signal.emit(data)
        
        ProxyMonitor.get_instance().on_request = on_request
        
        try:
            self._running = True
            self.started_signal.emit(actual_port)
            
            config = uvicorn.Config(
                proxy.app,
                host=self.host,
                port=actual_port,
                log_level="warning",
                access_log=False
            )
            self._server = uvicorn.Server(config)
            asyncio.run(self._server.serve())
        except Exception as e:
            self.error_signal.emit(str(e))
    
    def stop(self):
        if self._server:
            self._server.should_exit = True
        self._running = False
    
    def get_actual_port(self) -> int:
        return self._actual_port


class ScannerWorker(QThread):
    """上下文扫描工作线程"""
    finished_signal = Signal(int, int, int, str)
    error_signal = Signal(str)
    
    def __init__(self, project_path: str, output_path: str = None):
        super().__init__()
        self.project_path = project_path
        self.output_path = output_path
    
    def run(self):
        from app.scanner import CodeScanner
        
        try:
            scanner = CodeScanner(self.project_path)
            file_count, total_chars, tokens, actual_path = scanner.build_context(self.output_path)
            self.finished_signal.emit(file_count, total_chars, tokens, actual_path)
        except Exception as e:
            self.error_signal.emit(str(e))


class LogListView(QListView):
    """优化的日志列表视图"""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.setVerticalScrollMode(QAbstractItemView.ScrollPerPixel)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setStyleSheet("""
            QListView {
                background-color: #1e1e1e;
                border: none;
                color: #d4d4d4;
                font-family: 'Consolas', 'Monaco', monospace;
                font-size: 12px;
            }
            QListView::item {
                padding: 8px;
                border-bottom: 1px solid #333;
            }
            QListView::item:selected {
                background-color: #264f78;
            }
        """)


class SidebarWidget(QFrame):
    """侧边栏组件"""
    
    project_changed = Signal(str)
    build_clicked = Signal()
    
    def __init__(self, i18n: I18n, currency_detector: CurrencyDetector, parent=None):
        super().__init__(parent)
        self.i18n = i18n
        self.currency_detector = currency_detector
        self._setup_ui()
    
    def _setup_ui(self):
        self.setFixedWidth(280)
        self.setStyleSheet("""
            SidebarWidget {
                background-color: #252526;
                border-right: 1px solid #3c3c3c;
            }
            QLabel {
                color: #cccccc;
            }
            QPushButton {
                background-color: #0e639c;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #1177bb;
            }
            QPushButton:pressed {
                background-color: #0d5a8a;
            }
        """)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)
        
        title = QLabel(self.i18n.t("sidebar_title"))
        title.setStyleSheet("font-size: 16px; font-weight: bold; color: #569cd6;")
        layout.addWidget(title)
        
        layout.addWidget(self._create_separator())
        
        self.project_label = QLabel(f"{self.i18n.t('active_project')}: -")
        self.project_label.setWordWrap(True)
        self.project_label.setStyleSheet("font-size: 12px;")
        layout.addWidget(self.project_label)
        
        self.select_btn = QPushButton(self.i18n.t("select_project"))
        self.select_btn.clicked.connect(self._on_select_project)
        layout.addWidget(self.select_btn)
        
        layout.addWidget(self._create_separator())
        
        self.tokens_label = QLabel(f"{self.i18n.t('total_tokens')}: 0")
        self.tokens_label.setStyleSheet("font-size: 14px; font-weight: bold;")
        layout.addWidget(self.tokens_label)
        
        self.savings_label = QLabel(f"{self.i18n.t('monthly_savings')}: $0.00")
        self.savings_label.setStyleSheet("font-size: 14px; font-weight: bold; color: #4ec9b0;")
        layout.addWidget(self.savings_label)
        
        layout.addWidget(self._create_separator())
        
        self.build_btn = QPushButton(self.i18n.t("build_context"))
        self.build_btn.clicked.connect(self.build_clicked.emit)
        layout.addWidget(self.build_btn)
        
        layout.addStretch()
    
    def _create_separator(self) -> QFrame:
        line = QFrame()
        line.setFrameShape(QFrame.HLine)
        line.setStyleSheet("background-color: #3c3c3c;")
        line.setFixedHeight(1)
        return line
    
    def _on_select_project(self):
        folder = QFileDialog.getExistingDirectory(
            self, self.i18n.t("select_project"), "",
            QFileDialog.ShowDirsOnly
        )
        if folder:
            self.project_changed.emit(folder)
    
    def set_project(self, path: str):
        self.project_label.setText(f"{self.i18n.t('active_project')}:\n{path}")
    
    def set_tokens(self, tokens: int):
        self.tokens_label.setText(f"{self.i18n.t('total_tokens')}: {tokens:,}")
    
    def set_savings(self, savings_usd: float):
        formatted = self.currency_detector.format_cost(savings_usd)
        self.savings_label.setText(f"{self.i18n.t('monthly_savings')}: {formatted}")


class LogAreaWidget(QFrame):
    """中央日志区域"""
    
    def __init__(self, i18n: I18n, currency_detector: CurrencyDetector, parent=None):
        super().__init__(parent)
        self.i18n = i18n
        self.currency_detector = currency_detector
        self._entries: List[RequestLogEntry] = []
        self._setup_ui()
    
    def _setup_ui(self):
        self.setStyleSheet("""
            LogAreaWidget {
                background-color: #1e1e1e;
                border: none;
            }
            QPlainTextEdit {
                background-color: #1e1e1e;
                color: #d4d4d4;
                border: none;
                font-family: 'Consolas', 'Monaco', monospace;
                font-size: 12px;
            }
        """)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        
        header = QLabel(f"  {self.i18n.t('requests_log')}")
        header.setStyleSheet("""
            background-color: #2d2d2d;
            color: #cccccc;
            padding: 8px;
            font-weight: bold;
            border-bottom: 1px solid #3c3c3c;
        """)
        header.setFixedHeight(36)
        layout.addWidget(header)
        
        self.log_text = QPlainTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumBlockCount(1000)
        self.log_text.setLineWrapMode(QPlainTextEdit.NoWrap)
        layout.addWidget(self.log_text)
    
    def add_entry(self, entry: RequestLogEntry):
        self._entries.append(entry)
        if len(self._entries) > 1000:
            self._entries = self._entries[-500:]
        
        self._append_formatted_entry(entry)
    
    def _append_formatted_entry(self, entry: RequestLogEntry):
        cursor = self.log_text.textCursor()
        cursor.movePosition(QTextCursor.End)
        
        time_str = entry.timestamp.strftime("%H:%M:%S")
        cost_str = self.currency_detector.format_cost(entry.cost)
        
        if entry.cache_hit:
            status_str = f"[{self.i18n.t('cache_hit')}]"
            status_color = "#4ec9b0"
        else:
            status_str = f"[{self.i18n.t('cache_miss')}]"
            status_color = "#dcdcaa"
        
        line = f"{time_str} | {entry.model[:20]:<20} | {entry.total_tokens:>8,} | {cost_str:>10} | {status_str}\n"
        
        cursor.insertText(line)
        
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())


class BottomBarWidget(QFrame):
    """底部状态栏"""
    
    def __init__(self, i18n: I18n, currency_detector: CurrencyDetector, parent=None):
        super().__init__(parent)
        self.i18n = i18n
        self.currency_detector = currency_detector
        self._setup_ui()
    
    def _setup_ui(self):
        self.setFixedHeight(40)
        self.setStyleSheet("""
            BottomBarWidget {
                background-color: #007acc;
            }
            QLabel {
                color: white;
                font-size: 12px;
            }
        """)
        
        layout = QHBoxLayout(self)
        layout.setContentsMargins(16, 0, 16, 0)
        layout.setSpacing(24)
        
        self.port_label = QLabel(f"{self.i18n.t('proxy_port')}: 8000")
        self.port_label.setStyleSheet("font-weight: bold;")
        layout.addWidget(self.port_label)
        
        self.status_label = QLabel(f"{self.i18n.t('connection_status')}: {self.i18n.t('disconnected')}")
        layout.addWidget(self.status_label)
        
        layout.addStretch()
        
        self.currency_label = QLabel(f"{self.i18n.t('billing_currency')}: USD ($)")
        layout.addWidget(self.currency_label)
    
    def set_port(self, port: int):
        self.port_label.setText(f"{self.i18n.t('proxy_port')}: {port}")
    
    def set_connected(self, connected: bool):
        status = self.i18n.t("connected") if connected else self.i18n.t("disconnected")
        self.status_label.setText(f"{self.i18n.t('connection_status')}: {status}")
        if connected:
            self.status_label.setStyleSheet("color: #4ec9b0;")
        else:
            self.status_label.setStyleSheet("color: white;")
    
    def set_currency(self, currency: Currency):
        config = self.currency_detector.get_currency_config(currency)
        self.currency_label.setText(f"{self.i18n.t('billing_currency')}: {currency.value} ({config.symbol})")


class MainWindow(QMainWindow):
    """ContextGate 主窗口"""
    
    def __init__(self, config_path: str = "config.yaml"):
        super().__init__()
        
        self.config_path = config_path
        self.i18n = get_i18n()
        self.currency_detector = CurrencyDetector()
        
        self._current_project: Optional[str] = None
        self._proxy_worker: Optional[ProxyWorker] = None
        self._scanner_worker: Optional[ScannerWorker] = None
        self._total_tokens = 0
        self._monthly_savings = 0.0
        self._actual_port = 8000
        
        self._setup_ui()
        self._setup_tray()
        self._load_settings()
        self._detect_currency_from_config()
    
    def _setup_ui(self):
        self.setWindowTitle("ContextGate")
        self.setMinimumSize(1000, 700)
        self.resize(1200, 800)
        
        self.setStyleSheet(DARK_THEME)
        
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        main_layout = QHBoxLayout(central_widget)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        
        self.sidebar = SidebarWidget(self.i18n, self.currency_detector)
        self.sidebar.project_changed.connect(self._on_project_changed)
        self.sidebar.build_clicked.connect(self._on_build_context)
        main_layout.addWidget(self.sidebar)
        
        self.log_area = LogAreaWidget(self.i18n, self.currency_detector)
        main_layout.addWidget(self.log_area, 1)
        
        self.bottom_bar = BottomBarWidget(self.i18n, self.currency_detector)
        
        self._status_bar = QStatusBar()
        self._status_bar.addPermanentWidget(self.bottom_bar, 1)
        self.setStatusBar(self._status_bar)
        
        self._create_menu()
    
    def _create_menu(self):
        menubar = self.menuBar()
        menubar.setStyleSheet("""
            QMenuBar {
                background-color: #2d2d2d;
                color: #cccccc;
            }
            QMenuBar::item:selected {
                background-color: #094771;
            }
            QMenu {
                background-color: #252526;
                color: #cccccc;
                border: 1px solid #3c3c3c;
            }
            QMenu::item:selected {
                background-color: #094771;
            }
        """)
        
        file_menu = menubar.addMenu(self.i18n.t("settings"))
        
        select_action = QAction(self.i18n.t("select_project"), self)
        select_action.triggered.connect(self.sidebar._on_select_project)
        file_menu.addAction(select_action)
        
        file_menu.addSeparator()
        
        currency_menu = file_menu.addMenu(self.i18n.t("billing_currency"))
        
        usd_action = QAction("USD ($)", self)
        usd_action.triggered.connect(lambda: self._set_currency(Currency.USD))
        currency_menu.addAction(usd_action)
        
        cny_action = QAction("CNY (￥)", self)
        cny_action.triggered.connect(lambda: self._set_currency(Currency.CNY))
        currency_menu.addAction(cny_action)
        
        eur_action = QAction("EUR (€)", self)
        eur_action.triggered.connect(lambda: self._set_currency(Currency.EUR))
        currency_menu.addAction(eur_action)
        
        file_menu.addSeparator()
        
        about_action = QAction(self.i18n.t("about"), self)
        about_action.triggered.connect(self._show_about)
        file_menu.addAction(about_action)
        
        file_menu.addSeparator()
        
        exit_action = QAction(self.i18n.t("exit"), self)
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)
    
    def _set_currency(self, currency: Currency):
        self.currency_detector._current_currency = currency
        self.bottom_bar.set_currency(currency)
        self._save_settings()
    
    def _show_about(self):
        about_text = """
        <h2 style='color: #569cd6;'>ContextGate</h2>
        <p style='color: #cccccc;'>版本: 3.0.0</p>
        <p style='color: #cccccc;'>AI Context Management & Proxy System</p>
        <hr style='border-color: #3c3c3c;'>
        <p style='color: #9cdcfe;'>功能特性:</p>
        <ul style='color: #cccccc;'>
        <li>代码扫描与 .gitignore 支持</li>
        <li>FastAPI 代理与缓存管理</li>
        <li>Token 监控与费用追踪</li>
        <li>多后端 API 支持 (OpenAI, 智谱, DeepSeek)</li>
        <li>系统托盘集成</li>
        </ul>
        <hr style='border-color: #3c3c3c;'>
        <p style='color: #9cdcfe;'>项目地址:</p>
        <p style='color: #4ec9b0;'><a href='https://github.com/2048lr/ContextGate' style='color: #4ec9b0;'>https://github.com/2048lr/ContextGate</a></p>
        <hr style='border-color: #3c3c3c;'>
        <p style='color: #9cdcfe;'>Bug 反馈:</p>
        <p style='color: #cccccc;'>Email: liurun637@gmail.com</p>
        <p style='color: #cccccc;'>Issues: <a href='https://github.com/2048lr/ContextGate/issues' style='color: #4ec9b0;'>GitHub Issues</a></p>
        <hr style='border-color: #3c3c3c;'>
        <p style='color: #6a9955;'>© 2026 JerryLiu</p>
        """
        msg = QMessageBox(self)
        msg.setWindowTitle(self.i18n.t("about"))
        msg.setTextFormat(Qt.RichText)
        msg.setText(about_text)
        msg.setStyleSheet("""
            QMessageBox {
                background-color: #252526;
            }
            QMessageBox QLabel {
                color: #cccccc;
                font-size: 13px;
            }
            QPushButton {
                background-color: #0e639c;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
            }
            QPushButton:hover {
                background-color: #1177bb;
            }
        """)
        msg.exec()
    
    def _setup_tray(self):
        self.tray_icon = QSystemTrayIcon(self)
        
        icon_path = Path(__file__).parent.parent.parent / "resources" / "icon.png"
        if icon_path.exists():
            self.tray_icon.setIcon(QIcon(str(icon_path)))
        else:
            self.tray_icon.setIcon(self.style().standardIcon(QStyle.SP_ComputerIcon))
        
        tray_menu = QMenu()
        
        show_action = QAction(self.i18n.t("tray_show"), self)
        show_action.triggered.connect(self.show)
        show_action.triggered.connect(self.activateWindow)
        tray_menu.addAction(show_action)
        
        hide_action = QAction(self.i18n.t("tray_hide"), self)
        hide_action.triggered.connect(self.hide)
        tray_menu.addAction(hide_action)
        
        tray_menu.addSeparator()
        
        quit_action = QAction(self.i18n.t("tray_quit"), self)
        quit_action.triggered.connect(self._quit_app)
        tray_menu.addAction(quit_action)
        
        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.activated.connect(self._on_tray_activated)
        self.tray_icon.show()
    
    def _on_tray_activated(self, reason):
        if reason == QSystemTrayIcon.DoubleClick:
            if self.isVisible():
                self.hide()
            else:
                self.show()
                self.activateWindow()
    
    def _load_settings(self):
        settings = QSettings("ContextGate", "ContextGate")
        
        project = settings.value("current_project")
        if project and Path(project).exists():
            self._current_project = project
            self.sidebar.set_project(project)
        
        geometry = settings.value("geometry")
        if geometry:
            self.restoreGeometry(geometry)
    
    def _save_settings(self):
        settings = QSettings("ContextGate", "ContextGate")
        
        if self._current_project:
            settings.setValue("current_project", self._current_project)
        
        settings.setValue("geometry", self.saveGeometry())
    
    def _detect_currency_from_config(self):
        from app.proxy import ConfigManager
        
        try:
            config = ConfigManager(self.config_path)
            providers = config.config.get("providers", {})
            
            for name, provider in providers.items():
                base_url = provider.get("base_url", "")
                currency = self.currency_detector.detect_from_url(base_url)
                self.bottom_bar.set_currency(currency)
                
                if name == "zhipu" or ".cn" in base_url:
                    self.i18n.update_language_by_api(base_url)
                break
        except Exception:
            pass
    
    def _on_project_changed(self, path: str):
        self._current_project = path
        self.sidebar.set_project(path)
        
        from app.proxy import ConfigManager
        config = ConfigManager(self.config_path)
        config.set_workspace(path)
        
        self._save_settings()
    
    def _on_build_context(self):
        if not self._current_project:
            QMessageBox.warning(
                self, 
                self.i18n.t("select_project"),
                self.i18n.t("select_project")
            )
            return
        
        self._scanner_worker = ScannerWorker(self._current_project)
        self._scanner_worker.finished_signal.connect(self._on_context_built)
        self._scanner_worker.error_signal.connect(self._on_context_error)
        self._scanner_worker.start()
    
    def _on_context_built(self, file_count: int, total_chars: int, tokens: int, path: str):
        self.sidebar.set_tokens(tokens)
        self._total_tokens = tokens
        self.tray_icon.showMessage(
            "ContextGate",
            self.i18n.t("context_built", file_count, tokens),
            QSystemTrayIcon.Information,
            2000
        )
    
    def _on_context_error(self, error: str):
        QMessageBox.critical(self, "Error", error)
    
    def start_proxy(self, port: int = 8000):
        if self._proxy_worker and self._proxy_worker.isRunning():
            return
        
        context_file = None
        if self._current_project:
            context_file = str(Path(self._current_project) / "full_context.txt")
        
        self._proxy_worker = ProxyWorker(
            "127.0.0.1", port, self.config_path, context_file
        )
        self._proxy_worker.started_signal.connect(self._on_proxy_started)
        self._proxy_worker.error_signal.connect(self._on_proxy_error)
        self._proxy_worker.request_signal.connect(self._on_proxy_request)
        self._proxy_worker.start()
    
    def _on_proxy_started(self, port: int):
        self._actual_port = port
        self.bottom_bar.set_port(port)
        self.bottom_bar.set_connected(True)
        
        if port != 8000:
            self.tray_icon.showMessage(
                "ContextGate",
                self.i18n.t("proxy_started", port),
                QSystemTrayIcon.Information,
                3000
            )
    
    def _on_proxy_error(self, error: str):
        QMessageBox.critical(self, "Proxy Error", error)
    
    def _on_proxy_request(self, data: dict):
        entry = RequestLogEntry(
            timestamp=datetime.now(),
            model=data.get("model", "unknown"),
            input_tokens=data.get("input_tokens", 0),
            output_tokens=data.get("output_tokens", 0),
            total_tokens=data.get("total_tokens", 0),
            cost=data.get("cost", 0.0),
            cache_hit=data.get("cache_hit", False),
            provider=data.get("provider", "unknown")
        )
        
        self.log_area.add_entry(entry)
        self._total_tokens += entry.total_tokens
        self.sidebar.set_tokens(self._total_tokens)
    
    def stop_proxy(self):
        if self._proxy_worker:
            if hasattr(self._proxy_worker, 'stop'):
                self._proxy_worker.stop()
            self._proxy_worker.quit()
            self._proxy_worker.wait(2000)
            self._proxy_worker = None
        self.bottom_bar.set_connected(False)
    
    def closeEvent(self, event):
        self._save_settings()
        self.stop_proxy()
        
        if self.tray_icon:
            self.tray_icon.hide()
        
        event.accept()
    
    def _quit_app(self):
        self.close()
        QApplication.quit()


def run_gui(config_path: str = "config.yaml"):
    """启动 GUI 应用"""
    app = QApplication(sys.argv)
    app.setApplicationName("ContextGate")
    app.setOrganizationName("ContextGate")
    
    window = MainWindow(config_path)
    window.show()
    
    window.start_proxy()
    
    return app.exec()
