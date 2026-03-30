"""
ContextGate GUI 模块
基于 PySide6 的现代化桌面界面
"""

from .main_window import MainWindow, run_gui
from .i18n import I18n, get_i18n
from .currency import CurrencyDetector, Currency
from .settings_dialog import SettingsDialog

__all__ = ['MainWindow', 'run_gui', 'I18n', 'get_i18n', 'CurrencyDetector', 'Currency', 'SettingsDialog']
