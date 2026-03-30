"""
货币适配模块
根据 API 站点自动识别结算货币
"""

import re
from typing import Optional, Tuple
from dataclasses import dataclass
from enum import Enum


class Currency(Enum):
    CNY = "CNY"
    USD = "USD"
    EUR = "EUR"


@dataclass
class CurrencyConfig:
    currency: Currency
    symbol: str
    rate_to_usd: float
    name: str


CURRENCY_CONFIGS = {
    Currency.CNY: CurrencyConfig(
        currency=Currency.CNY,
        symbol="￥",
        rate_to_usd=7.2,
        name="人民币"
    ),
    Currency.USD: CurrencyConfig(
        currency=Currency.USD,
        symbol="$",
        rate_to_usd=1.0,
        name="美元"
    ),
    Currency.EUR: CurrencyConfig(
        currency=Currency.EUR,
        symbol="€",
        rate_to_usd=0.92,
        name="欧元"
    ),
}

CN_DOMAINS = [
    'zhipu', 'bigmodel', 'kourichat', 'deepseek',
    '.cn', 'baidu', 'alibaba', 'tencent', 'qwen'
]

US_DOMAINS = [
    'openai', 'anthropic', 'api.openai', 'claude',
    '.com', '.io', 'google', 'azure'
]


class CurrencyDetector:
    """货币检测器"""
    
    def __init__(self, fixed_currency: Optional[Currency] = None, 
                 fixed_rate: Optional[float] = None,
                 exchange_rate_api: Optional[str] = None):
        self.fixed_currency = fixed_currency
        self.fixed_rate = fixed_rate
        self.exchange_rate_api = exchange_rate_api
        self._current_currency = Currency.USD
        self._current_rate = 1.0
    
    def detect_from_url(self, url: str) -> Currency:
        """从 URL 检测货币"""
        if self.fixed_currency:
            return self.fixed_currency
        
        if not url:
            return Currency.USD
        
        url_lower = url.lower()
        
        for domain in CN_DOMAINS:
            if domain in url_lower:
                self._current_currency = Currency.CNY
                self._current_rate = CURRENCY_CONFIGS[Currency.CNY].rate_to_usd
                return Currency.CNY
        
        for domain in US_DOMAINS:
            if domain in url_lower:
                self._current_currency = Currency.USD
                self._current_rate = 1.0
                return Currency.USD
        
        return Currency.USD
    
    def get_currency_config(self, currency: Optional[Currency] = None) -> CurrencyConfig:
        """获取货币配置"""
        curr = currency or self._current_currency
        return CURRENCY_CONFIGS.get(curr, CURRENCY_CONFIGS[Currency.USD])
    
    def format_cost(self, cost_usd: float, currency: Optional[Currency] = None) -> str:
        """格式化费用"""
        curr = currency or self._current_currency
        config = self.get_currency_config(curr)
        
        if curr == Currency.USD:
            return f"{config.symbol}{cost_usd:.4f}"
        else:
            converted = cost_usd * config.rate_to_usd
            return f"{config.symbol}{converted:.2f}"
    
    def get_current_currency(self) -> Currency:
        """获取当前货币"""
        return self._current_currency
    
    def get_current_symbol(self) -> str:
        """获取当前货币符号"""
        return self.get_currency_config().symbol
