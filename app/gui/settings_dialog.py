"""
ContextGate 设置对话框
可视化配置管理界面
"""

import yaml
from pathlib import Path
from typing import Dict, Any, List, Optional

from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTabWidget, QWidget, QLineEdit, QSpinBox, QDoubleSpinBox,
    QCheckBox, QListWidget, QListWidgetItem, QGroupBox,
    QComboBox, QMessageBox, QScrollArea, QFrame, QSplitter,
    QPlainTextEdit, QFileDialog
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont

from .i18n import get_i18n


class ProviderEditor(QWidget):
    """单个提供商编辑器"""
    
    def __init__(self, name: str, config: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.name = name
        self.config = config
        self._setup_ui()
    
    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        
        api_key_label = QLabel("API 密钥:")
        self.api_key_input = QLineEdit()
        self.api_key_input.setEchoMode(QLineEdit.Password)
        self.api_key_input.setText(self.config.get("api_key", ""))
        self.api_key_input.setPlaceholderText("输入 API 密钥...")
        layout.addWidget(api_key_label)
        layout.addWidget(self.api_key_input)
        
        base_url_label = QLabel("基础 URL:")
        self.base_url_input = QLineEdit()
        self.base_url_input.setText(self.config.get("base_url", ""))
        self.base_url_input.setPlaceholderText("https://api.example.com/v1")
        layout.addWidget(base_url_label)
        layout.addWidget(self.base_url_input)
        
        models_label = QLabel("模型列表 (每行一个):")
        self.models_input = QPlainTextEdit()
        self.models_input.setPlaceholderText("gpt-4\ngpt-3.5-turbo\n...")
        models = self.config.get("models", [])
        self.models_input.setPlainText("\n".join(models))
        self.models_input.setMaximumHeight(120)
        layout.addWidget(models_label)
        layout.addWidget(self.models_input)
        
        layout.addStretch()
    
    def get_config(self) -> Dict[str, Any]:
        models_text = self.models_input.toPlainText().strip()
        models = [m.strip() for m in models_text.split("\n") if m.strip()]
        
        return {
            "api_key": self.api_key_input.text(),
            "base_url": self.base_url_input.text(),
            "models": models
        }


class ProvidersTab(QWidget):
    """提供商配置标签页"""
    
    def __init__(self, config: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.config = config
        self.providers: Dict[str, ProviderEditor] = {}
        self._setup_ui()
    
    def _setup_ui(self):
        layout = QHBoxLayout(self)
        
        self.provider_list = QListWidget()
        self.provider_list.setFixedWidth(150)
        self.provider_list.currentItemChanged.connect(self._on_provider_selected)
        
        providers_config = self.config.get("providers", {})
        for name in providers_config.keys():
            item = QListWidgetItem(name)
            self.provider_list.addItem(item)
        
        add_btn = QPushButton("+ 新增")
        add_btn.clicked.connect(self._add_provider)
        remove_btn = QPushButton("删除")
        remove_btn.clicked.connect(self._remove_provider)
        
        list_layout = QVBoxLayout()
        list_layout.addWidget(self.provider_list)
        list_layout.addWidget(add_btn)
        list_layout.addWidget(remove_btn)
        
        list_widget = QWidget()
        list_widget.setLayout(list_layout)
        
        self.editor_stack = QFrame()
        self.editor_layout = QVBoxLayout(self.editor_stack)
        self.editor_layout.setContentsMargins(0, 0, 0, 0)
        
        self._placeholder = QLabel("选择一个提供商进行编辑")
        self._placeholder.setAlignment(Qt.AlignCenter)
        self._placeholder.setStyleSheet("color: #666;")
        self.editor_layout.addWidget(self._placeholder)
        
        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(list_widget)
        splitter.addWidget(self.editor_stack)
        splitter.setSizes([150, 400])
        
        layout.addWidget(splitter)
        
        if self.provider_list.count() > 0:
            self.provider_list.setCurrentRow(0)
    
    def _on_provider_selected(self, current: QListWidgetItem, previous: QListWidgetItem):
        if current is None:
            return
        
        name = current.text()
        
        if self._placeholder:
            self._placeholder.hide()
            self.editor_layout.removeWidget(self._placeholder)
            self._placeholder = None
        
        for editor in self.providers.values():
            editor.hide()
        
        if name in self.providers:
            self.providers[name].show()
        else:
            providers_config = self.config.get("providers", {})
            provider_config = providers_config.get(name, {})
            editor = ProviderEditor(name, provider_config)
            self.providers[name] = editor
            self.editor_layout.addWidget(editor)
    
    def _add_provider(self):
        name = "新提供商"
        counter = 1
        while any(self.provider_list.item(i).text() == name for i in range(self.provider_list.count())):
            name = f"新提供商_{counter}"
            counter += 1
        
        item = QListWidgetItem(name)
        self.provider_list.addItem(item)
        self.provider_list.setCurrentItem(item)
        
        self.providers[name] = ProviderEditor(name, {})
        self.editor_layout.addWidget(self.providers[name])
    
    def _remove_provider(self):
        current = self.provider_list.currentItem()
        if current is None:
            return
        
        name = current.text()
        
        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除提供商 '{name}' 吗？",
            QMessageBox.Yes | QMessageBox.No
        )
        
        if reply == QMessageBox.Yes:
            if name in self.providers:
                self.providers[name].deleteLater()
                del self.providers[name]
            
            self.provider_list.takeItem(self.provider_list.row(current))
    
    def get_config(self) -> Dict[str, Any]:
        providers = {}
        for i in range(self.provider_list.count()):
            name = self.provider_list.item(i).text()
            if name in self.providers:
                providers[name] = self.providers[name].get_config()
        
        return {"providers": providers}


class ProxyTab(QWidget):
    """代理配置标签页"""
    
    def __init__(self, config: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.config = config
        self._setup_ui()
    
    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        
        proxy_config = self.config.get("proxy", {})
        
        host_group = QGroupBox("服务器配置")
        host_layout = QVBoxLayout(host_group)
        
        host_row = QHBoxLayout()
        host_label = QLabel("主机地址:")
        self.host_input = QLineEdit()
        self.host_input.setText(proxy_config.get("host", "127.0.0.1"))
        self.host_input.setPlaceholderText("127.0.0.1")
        host_row.addWidget(host_label)
        host_row.addWidget(self.host_input)
        host_layout.addLayout(host_row)
        
        port_row = QHBoxLayout()
        port_label = QLabel("端口:")
        self.port_input = QSpinBox()
        self.port_input.setRange(1, 65535)
        self.port_input.setValue(proxy_config.get("port", 8080))
        port_row.addWidget(port_label)
        port_row.addWidget(self.port_input)
        port_row.addStretch()
        host_layout.addLayout(port_row)
        
        layout.addWidget(host_group)
        
        sanitize_group = QGroupBox("请求处理")
        sanitize_layout = QVBoxLayout(sanitize_group)
        
        self.sanitize_check = QCheckBox("启用请求清洗")
        self.sanitize_check.setChecked(proxy_config.get("sanitize_requests", True))
        sanitize_layout.addWidget(self.sanitize_check)
        
        layout.addWidget(sanitize_group)
        
        default_group = QGroupBox("默认提供商")
        default_layout = QHBoxLayout(default_group)
        
        default_label = QLabel("默认后端:")
        self.default_provider_combo = QComboBox()
        self.default_provider_combo.addItems(["openai", "zhipu", "deepseek", "anthropic"])
        self.default_provider_combo.setEditable(True)
        
        current_default = self.config.get("default_provider", "openai")
        index = self.default_provider_combo.findText(current_default)
        if index >= 0:
            self.default_provider_combo.setCurrentIndex(index)
        else:
            self.default_provider_combo.setEditText(current_default)
        
        default_layout.addWidget(default_label)
        default_layout.addWidget(self.default_provider_combo)
        default_layout.addStretch()
        
        layout.addWidget(default_group)
        layout.addStretch()
    
    def get_config(self) -> Dict[str, Any]:
        return {
            "proxy": {
                "host": self.host_input.text(),
                "port": self.port_input.value(),
                "sanitize_requests": self.sanitize_check.isChecked()
            },
            "default_provider": self.default_provider_combo.currentText()
        }


class MonitorTab(QWidget):
    """监控配置标签页"""
    
    def __init__(self, config: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.config = config
        self._setup_ui()
    
    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        
        monitor_config = self.config.get("monitor", {})
        
        budget_group = QGroupBox("预算设置")
        budget_layout = QVBoxLayout(budget_group)
        
        budget_row = QHBoxLayout()
        budget_label = QLabel("预算限制 (美元):")
        self.budget_input = QDoubleSpinBox()
        self.budget_input.setRange(0, 10000)
        self.budget_input.setDecimals(2)
        self.budget_input.setValue(monitor_config.get("budget_limit", 10.0))
        self.budget_input.setPrefix("$ ")
        budget_row.addWidget(budget_label)
        budget_row.addWidget(self.budget_input)
        budget_row.addStretch()
        budget_layout.addLayout(budget_row)
        
        layout.addWidget(budget_group)
        
        threshold_group = QGroupBox("阈值设置")
        threshold_layout = QVBoxLayout(threshold_group)
        
        warning_row = QHBoxLayout()
        warning_label = QLabel("警告阈值 (%):")
        self.warning_input = QSpinBox()
        self.warning_input.setRange(1, 100)
        self.warning_input.setValue(monitor_config.get("warning_threshold", 75))
        self.warning_input.setSuffix("%")
        warning_row.addWidget(warning_label)
        warning_row.addWidget(self.warning_input)
        warning_row.addStretch()
        threshold_layout.addLayout(warning_row)
        
        critical_row = QHBoxLayout()
        critical_label = QLabel("临界阈值 (%):")
        self.critical_input = QSpinBox()
        self.critical_input.setRange(1, 100)
        self.critical_input.setValue(monitor_config.get("critical_threshold", 90))
        self.critical_input.setSuffix("%")
        critical_row.addWidget(critical_label)
        critical_row.addWidget(self.critical_input)
        critical_row.addStretch()
        threshold_layout.addLayout(critical_row)
        
        layout.addWidget(threshold_group)
        
        db_group = QGroupBox("数据库")
        db_layout = QHBoxLayout(db_group)
        
        db_label = QLabel("数据库路径:")
        self.db_input = QLineEdit()
        self.db_input.setText(monitor_config.get("db_path", "contextgate.db"))
        db_browse = QPushButton("浏览...")
        db_browse.clicked.connect(self._browse_db)
        
        db_layout.addWidget(db_label)
        db_layout.addWidget(self.db_input)
        db_layout.addWidget(db_browse)
        
        layout.addWidget(db_group)
        layout.addStretch()
    
    def _browse_db(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "选择数据库文件",
            self.db_input.text(),
            "SQLite 数据库 (*.db);;所有文件 (*)"
        )
        if path:
            self.db_input.setText(path)
    
    def get_config(self) -> Dict[str, Any]:
        return {
            "monitor": {
                "budget_limit": self.budget_input.value(),
                "warning_threshold": self.warning_input.value(),
                "critical_threshold": self.critical_input.value(),
                "db_path": self.db_input.text()
            }
        }


class ScannerTab(QWidget):
    """扫描配置标签页"""
    
    def __init__(self, config: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.config = config
        self._setup_ui()
    
    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        
        scanner_config = self.config.get("scanner", {})
        
        size_group = QGroupBox("文件大小限制")
        size_layout = QHBoxLayout(size_group)
        
        size_label = QLabel("最大文件大小 (字节):")
        self.size_input = QSpinBox()
        self.size_input.setRange(1024, 104857600)
        self.size_input.setValue(scanner_config.get("max_file_size", 1048576))
        size_layout.addWidget(size_label)
        size_layout.addWidget(self.size_input)
        size_layout.addStretch()
        
        layout.addWidget(size_group)
        
        ext_group = QGroupBox("文件扩展名")
        ext_layout = QVBoxLayout(ext_group)
        
        ext_hint = QLabel("包含的文件扩展名 (每行一个，如 .py, .js):")
        ext_layout.addWidget(ext_hint)
        
        self.extensions_input = QPlainTextEdit()
        extensions = scanner_config.get("include_extensions", [])
        self.extensions_input.setPlainText("\n".join(extensions))
        self.extensions_input.setMaximumHeight(200)
        ext_layout.addWidget(self.extensions_input)
        
        preset_row = QHBoxLayout()
        preset_label = QLabel("预设:")
        preset_py = QPushButton("Python")
        preset_py.clicked.connect(lambda: self._add_preset([".py", ".pyw"]))
        preset_web = QPushButton("Web前端")
        preset_web.clicked.connect(lambda: self._add_preset([".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json"]))
        preset_all = QPushButton("常用")
        preset_all.clicked.connect(lambda: self._add_preset([".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".md", ".txt", ".json", ".yaml", ".yml"]))
        
        preset_row.addWidget(preset_label)
        preset_row.addWidget(preset_py)
        preset_row.addWidget(preset_web)
        preset_row.addWidget(preset_all)
        preset_row.addStretch()
        ext_layout.addLayout(preset_row)
        
        layout.addWidget(ext_group)
        layout.addStretch()
    
    def _add_preset(self, extensions: List[str]):
        current = self.extensions_input.toPlainText()
        current_exts = set(e.strip() for e in current.split("\n") if e.strip())
        new_exts = current_exts.union(set(extensions))
        self.extensions_input.setPlainText("\n".join(sorted(new_exts)))
    
    def get_config(self) -> Dict[str, Any]:
        ext_text = self.extensions_input.toPlainText().strip()
        extensions = [e.strip() for e in ext_text.split("\n") if e.strip()]
        
        return {
            "scanner": {
                "max_file_size": self.size_input.value(),
                "include_extensions": extensions
            }
        }


class ContextTab(QWidget):
    """上下文配置标签页"""
    
    def __init__(self, config: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.config = config
        self._setup_ui()
    
    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        
        context_config = self.config.get("context", {})
        
        output_group = QGroupBox("输出设置")
        output_layout = QHBoxLayout(output_group)
        
        output_label = QLabel("输出文件名:")
        self.output_input = QLineEdit()
        self.output_input.setText(context_config.get("output_file", "full_context.txt"))
        output_layout.addWidget(output_label)
        output_layout.addWidget(self.output_input)
        
        layout.addWidget(output_group)
        
        watch_group = QGroupBox("文件监视")
        watch_layout = QVBoxLayout(watch_group)
        
        self.watch_check = QCheckBox("启用文件监视 (自动更新上下文)")
        self.watch_check.setChecked(context_config.get("watch_enabled", True))
        watch_layout.addWidget(self.watch_check)
        
        debounce_row = QHBoxLayout()
        debounce_label = QLabel("防抖延迟 (秒):")
        self.debounce_input = QDoubleSpinBox()
        self.debounce_input.setRange(0.1, 10.0)
        self.debounce_input.setDecimals(1)
        self.debounce_input.setValue(context_config.get("debounce_seconds", 1.0))
        debounce_row.addWidget(debounce_label)
        debounce_row.addWidget(self.debounce_input)
        debounce_row.addStretch()
        watch_layout.addLayout(debounce_row)
        
        layout.addWidget(watch_group)
        layout.addStretch()
    
    def get_config(self) -> Dict[str, Any]:
        return {
            "context": {
                "output_file": self.output_input.text(),
                "watch_enabled": self.watch_check.isChecked(),
                "debounce_seconds": self.debounce_input.value()
            }
        }


class CurrencyTab(QWidget):
    """货币配置标签页"""
    
    def __init__(self, config: Dict[str, Any], parent=None):
        super().__init__(parent)
        self.config = config
        self._setup_ui()
    
    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        
        currency_config = self.config.get("currency", {})
        
        basic_group = QGroupBox("基本设置")
        basic_layout = QVBoxLayout(basic_group)
        
        fixed_row = QHBoxLayout()
        fixed_label = QLabel("固定货币:")
        self.currency_combo = QComboBox()
        self.currency_combo.addItems(["自动检测", "人民币 (CNY)", "美元 (USD)", "欧元 (EUR)"])
        
        current_currency = currency_config.get("fixed_currency", "")
        if current_currency == "CNY":
            self.currency_combo.setCurrentIndex(1)
        elif current_currency == "USD":
            self.currency_combo.setCurrentIndex(2)
        elif current_currency == "EUR":
            self.currency_combo.setCurrentIndex(3)
        else:
            self.currency_combo.setCurrentIndex(0)
        
        fixed_row.addWidget(fixed_label)
        fixed_row.addWidget(self.currency_combo)
        fixed_row.addStretch()
        basic_layout.addLayout(fixed_row)
        
        rate_row = QHBoxLayout()
        rate_label = QLabel("固定汇率 (可选):")
        self.rate_input = QDoubleSpinBox()
        self.rate_input.setRange(0, 100)
        self.rate_input.setDecimals(4)
        self.rate_input.setSpecialValueText("自动")
        fixed_rate = currency_config.get("fixed_rate")
        if fixed_rate:
            self.rate_input.setValue(fixed_rate)
        rate_row.addWidget(rate_label)
        rate_row.addWidget(self.rate_input)
        rate_row.addStretch()
        basic_layout.addLayout(rate_row)
        
        layout.addWidget(basic_group)
        
        default_rates_group = QGroupBox("默认汇率 (相对于美元)")
        default_rates_layout = QVBoxLayout(default_rates_group)
        
        rates = currency_config.get("default_rates", {"CNY": 7.2, "EUR": 0.92})
        
        cny_row = QHBoxLayout()
        cny_label = QLabel("人民币 (CNY):")
        self.cny_rate = QDoubleSpinBox()
        self.cny_rate.setRange(0.01, 100)
        self.cny_rate.setDecimals(2)
        self.cny_rate.setValue(rates.get("CNY", 7.2))
        cny_row.addWidget(cny_label)
        cny_row.addWidget(self.cny_rate)
        cny_row.addStretch()
        default_rates_layout.addLayout(cny_row)
        
        eur_row = QHBoxLayout()
        eur_label = QLabel("欧元 (EUR):")
        self.eur_rate = QDoubleSpinBox()
        self.eur_rate.setRange(0.01, 100)
        self.eur_rate.setDecimals(2)
        self.eur_rate.setValue(rates.get("EUR", 0.92))
        eur_row.addWidget(eur_label)
        eur_row.addWidget(self.eur_rate)
        eur_row.addStretch()
        default_rates_layout.addLayout(eur_row)
        
        layout.addWidget(default_rates_group)
        layout.addStretch()
    
    def get_config(self) -> Dict[str, Any]:
        currency = {
            "default_rates": {
                "CNY": self.cny_rate.value(),
                "EUR": self.eur_rate.value()
            }
        }
        
        idx = self.currency_combo.currentIndex()
        if idx == 1:
            currency["fixed_currency"] = "CNY"
        elif idx == 2:
            currency["fixed_currency"] = "USD"
        elif idx == 3:
            currency["fixed_currency"] = "EUR"
        
        if self.rate_input.value() > 0:
            currency["fixed_rate"] = self.rate_input.value()
        
        return {"currency": currency}


class SettingsDialog(QDialog):
    """设置对话框"""
    
    config_saved = Signal()
    
    def __init__(self, config_path: str = "config.yaml", parent=None):
        super().__init__(parent)
        self.config_path = Path(config_path)
        self.config: Dict[str, Any] = {}
        self.i18n = get_i18n()
        
        self._load_config()
        self._setup_ui()
    
    def _load_config(self):
        if self.config_path.exists():
            with open(self.config_path, "r", encoding="utf-8") as f:
                self.config = yaml.safe_load(f) or {}
        else:
            self.config = {}
    
    def _setup_ui(self):
        self.setWindowTitle(self.i18n.t("settings"))
        self.setMinimumSize(700, 500)
        self.resize(800, 600)
        
        self.setStyleSheet("""
            QDialog {
                background-color: #1e1e1e;
            }
            QLabel {
                color: #cccccc;
            }
            QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox, QPlainTextEdit {
                background-color: #3c3c3c;
                color: #d4d4d4;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 6px;
            }
            QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus, QPlainTextEdit:focus {
                border-color: #007acc;
            }
            QGroupBox {
                color: #569cd6;
                border: 1px solid #3c3c3c;
                border-radius: 6px;
                margin-top: 12px;
                padding-top: 8px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px;
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
            QPushButton:pressed {
                background-color: #0d5a8a;
            }
            QTabWidget::pane {
                border: 1px solid #3c3c3c;
                background-color: #252526;
            }
            QTabBar::tab {
                background-color: #2d2d2d;
                color: #cccccc;
                padding: 8px 16px;
                border: 1px solid #3c3c3c;
            }
            QTabBar::tab:selected {
                background-color: #252526;
                border-bottom-color: #252526;
            }
            QTabBar::tab:hover {
                background-color: #3c3c3c;
            }
            QListWidget {
                background-color: #252526;
                color: #cccccc;
                border: 1px solid #3c3c3c;
            }
            QListWidget::item:selected {
                background-color: #094771;
            }
            QListWidget::item:hover {
                background-color: #2a2d2e;
            }
            QCheckBox {
                color: #cccccc;
            }
            QCheckBox::indicator {
                width: 16px;
                height: 16px;
            }
            QCheckBox::indicator:unchecked {
                background-color: #3c3c3c;
                border: 1px solid #555;
                border-radius: 3px;
            }
            QCheckBox::indicator:checked {
                background-color: #007acc;
                border: 1px solid #007acc;
                border-radius: 3px;
            }
            QScrollArea {
                background-color: transparent;
                border: none;
            }
        """)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)
        
        self.tab_widget = QTabWidget()
        
        self.providers_tab = ProvidersTab(self.config)
        self.tab_widget.addTab(self.providers_tab, "提供商")
        
        self.proxy_tab = ProxyTab(self.config)
        self.tab_widget.addTab(self.proxy_tab, "代理")
        
        self.monitor_tab = MonitorTab(self.config)
        self.tab_widget.addTab(self.monitor_tab, "监控")
        
        self.scanner_tab = ScannerTab(self.config)
        self.tab_widget.addTab(self.scanner_tab, "扫描器")
        
        self.context_tab = ContextTab(self.config)
        self.tab_widget.addTab(self.context_tab, "上下文")
        
        self.currency_tab = CurrencyTab(self.config)
        self.tab_widget.addTab(self.currency_tab, "货币")
        
        layout.addWidget(self.tab_widget)
        
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        save_btn = QPushButton(self.i18n.t("save"))
        save_btn.clicked.connect(self._save_config)
        button_layout.addWidget(save_btn)
        
        cancel_btn = QPushButton(self.i18n.t("cancel"))
        cancel_btn.clicked.connect(self.reject)
        button_layout.addWidget(cancel_btn)
        
        layout.addLayout(button_layout)
    
    def _save_config(self):
        try:
            providers_config = self.providers_tab.get_config()
            proxy_config = self.proxy_tab.get_config()
            monitor_config = self.monitor_tab.get_config()
            scanner_config = self.scanner_tab.get_config()
            context_config = self.context_tab.get_config()
            currency_config = self.currency_tab.get_config()
            
            self.config.update(providers_config)
            self.config.update(proxy_config)
            self.config.update(monitor_config)
            self.config.update(scanner_config)
            self.config.update(context_config)
            self.config.update(currency_config)
            
            with open(self.config_path, "w", encoding="utf-8") as f:
                yaml.dump(self.config, f, default_flow_style=False, allow_unicode=True)
            
            self.config_saved.emit()
            
            QMessageBox.information(
                self,
                self.i18n.t("save"),
                self.i18n.t("config_saved")
            )
            
            self.accept()
            
        except Exception as e:
            QMessageBox.critical(
                self,
                self.i18n.t("save"),
                f"保存失败: {str(e)}"
            )
