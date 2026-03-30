"""
国际化支持模块 (i18n)
支持中英文切换，根据系统语言和 API 站点自动选择
"""

import locale
from typing import Dict, Optional
from dataclasses import dataclass


@dataclass
class Translations:
    zh_CN: Dict[str, str] = None
    en_US: Dict[str, str] = None
    
    def __post_init__(self):
        self.zh_CN = {
            "app_name": "ContextGate",
            "sidebar_title": "项目概览",
            "active_project": "当前项目",
            "total_tokens": "总 Token",
            "monthly_savings": "本月节省",
            "requests_log": "请求日志",
            "cache_hit": "缓存命中",
            "cache_miss": "缓存未命中",
            "proxy_port": "代理端口",
            "connection_status": "连接状态",
            "connected": "已连接",
            "disconnected": "已断开",
            "billing_currency": "计费币种",
            "select_project": "选择项目",
            "build_context": "构建上下文",
            "start_proxy": "启动代理",
            "stop_proxy": "停止代理",
            "settings": "设置",
            "about": "关于",
            "exit": "退出",
            "port_in_use": "端口 {} 已被占用",
            "port_redirect_question": "是否自动切换到端口 {}？",
            "yes": "是",
            "no": "否",
            "project_set": "已设置项目: {}",
            "context_built": "上下文已构建 ({} 文件, {} tokens)",
            "proxy_started": "代理已启动 (端口: {})",
            "proxy_stopped": "代理已停止",
            "tray_show": "显示主窗口",
            "tray_hide": "隐藏主窗口",
            "tray_quit": "退出",
            "file_count": "文件数",
            "last_update": "最后更新",
            "model": "模型",
            "tokens": "Tokens",
            "cost": "费用",
            "status": "状态",
            "hit": "命中",
            "miss": "未命中",
            "time": "时间",
            "provider": "提供商",
        }
        
        self.en_US = {
            "app_name": "ContextGate",
            "sidebar_title": "Project Overview",
            "active_project": "Active Project",
            "total_tokens": "Total Tokens",
            "monthly_savings": "Monthly Savings",
            "requests_log": "Request Log",
            "cache_hit": "Cache Hit",
            "cache_miss": "Cache Miss",
            "proxy_port": "Proxy Port",
            "connection_status": "Connection",
            "connected": "Connected",
            "disconnected": "Disconnected",
            "billing_currency": "Currency",
            "select_project": "Select Project",
            "build_context": "Build Context",
            "start_proxy": "Start Proxy",
            "stop_proxy": "Stop Proxy",
            "settings": "Settings",
            "about": "About",
            "exit": "Exit",
            "port_in_use": "Port {} is in use",
            "port_redirect_question": "Redirect to port {}?",
            "yes": "Yes",
            "no": "No",
            "project_set": "Project set: {}",
            "context_built": "Context built ({} files, {} tokens)",
            "proxy_started": "Proxy started (port: {})",
            "proxy_stopped": "Proxy stopped",
            "tray_show": "Show Window",
            "tray_hide": "Hide Window",
            "tray_quit": "Quit",
            "file_count": "Files",
            "last_update": "Last Update",
            "model": "Model",
            "tokens": "Tokens",
            "cost": "Cost",
            "status": "Status",
            "hit": "Hit",
            "miss": "Miss",
            "time": "Time",
            "provider": "Provider",
        }


class I18n:
    """国际化管理器"""
    
    _instance: Optional['I18n'] = None
    
    def __init__(self):
        self.translations = Translations()
        self._current_lang = self._detect_system_language()
    
    @classmethod
    def get_instance(cls) -> 'I18n':
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    def _detect_system_language(self) -> str:
        """检测系统语言"""
        try:
            lang = locale.getdefaultlocale()[0]
            if lang and lang.startswith('zh'):
                return 'zh_CN'
        except Exception:
            pass
        return 'en_US'
    
    def set_language(self, lang: str) -> None:
        """设置语言"""
        if lang in ('zh_CN', 'en_US'):
            self._current_lang = lang
    
    def get_language(self) -> str:
        """获取当前语言"""
        return self._current_lang
    
    def t(self, key: str, *args) -> str:
        """翻译文本"""
        translations = getattr(self.translations, self._current_lang, self.translations.en_US)
        text = translations.get(key, key)
        if args:
            try:
                text = text.format(*args)
            except (IndexError, KeyError):
                pass
        return text
    
    def update_language_by_api(self, api_url: str) -> None:
        """根据 API URL 更新语言"""
        if not api_url:
            return
        
        api_lower = api_url.lower()
        cn_domains = ['.cn', 'zhipu', 'bigmodel', 'kourichat', 'deepseek']
        
        for domain in cn_domains:
            if domain in api_lower:
                self._current_lang = 'zh_CN'
                return
        
        self._current_lang = 'en_US'


def get_i18n() -> I18n:
    """获取国际化实例"""
    return I18n.get_instance()
