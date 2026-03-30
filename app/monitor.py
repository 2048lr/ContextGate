"""
任务 3：Token 计算与财务预警逻辑
负责解析 API 返回的 usage 数据，计算缓存命中率和费用
支持 SQLite 持久化存储
"""

import json
import sqlite3
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path


@dataclass
class UsageRecord:
    """使用记录"""
    timestamp: datetime
    model: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost: float = 0.0
    cache_hit: bool = False
    cached_tokens: int = 0
    provider: str = "openai"


@dataclass
class PricingConfig:
    """定价配置 - 每千 tokens 价格 (美元)"""
    input_price_per_1k: float
    output_price_per_1k: float
    cached_input_price_per_1k: float = 0.0


class UsageDatabase:
    """SQLite 持久化存储"""
    
    def __init__(self, db_path: str = "contextgate.db"):
        self.db_path = db_path
        self._init_db()
    
    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn
    
    def _init_db(self) -> None:
        conn = self._get_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS usage_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                model TEXT NOT NULL,
                provider TEXT DEFAULT 'openai',
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                cost REAL NOT NULL,
                cache_hit INTEGER DEFAULT 0,
                cached_tokens INTEGER DEFAULT 0
            )
        ''')
        
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_records(timestamp)
        ''')
        
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_model ON usage_records(model)
        ''')
        
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_provider ON usage_records(provider)
        ''')
        
        conn.commit()
        conn.close()
    
    def insert_record(self, record: UsageRecord) -> int:
        conn = self._get_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO usage_records 
            (timestamp, model, provider, input_tokens, output_tokens, total_tokens, cost, cache_hit, cached_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            record.timestamp.isoformat(),
            record.model,
            record.provider,
            record.input_tokens,
            record.output_tokens,
            record.total_tokens,
            record.cost,
            1 if record.cache_hit else 0,
            record.cached_tokens
        ))
        
        record_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return record_id
    
    def get_records(
        self, 
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        limit: int = 1000
    ) -> List[UsageRecord]:
        conn = self._get_connection()
        cursor = conn.cursor()
        
        query = "SELECT * FROM usage_records WHERE 1=1"
        params = []
        
        if start_date:
            query += " AND timestamp >= ?"
            params.append(start_date.isoformat())
        
        if end_date:
            query += " AND timestamp <= ?"
            params.append(end_date.isoformat())
        
        if model:
            query += " AND model = ?"
            params.append(model)
        
        if provider:
            query += " AND provider = ?"
            params.append(provider)
        
        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        records = []
        for row in rows:
            records.append(UsageRecord(
                timestamp=datetime.fromisoformat(row['timestamp']),
                model=row['model'],
                provider=row['provider'],
                input_tokens=row['input_tokens'],
                output_tokens=row['output_tokens'],
                total_tokens=row['total_tokens'],
                cost=row['cost'],
                cache_hit=bool(row['cache_hit']),
                cached_tokens=row['cached_tokens']
            ))
        
        return records
    
    def get_stats(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        provider: Optional[str] = None
    ) -> Dict[str, Any]:
        conn = self._get_connection()
        cursor = conn.cursor()
        
        query = '''
            SELECT 
                COUNT(*) as total_requests,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost) as total_cost,
                SUM(cache_hit) as cache_hits,
                SUM(cached_tokens) as total_cached_tokens
            FROM usage_records WHERE 1=1
        '''
        params = []
        
        if start_date:
            query += " AND timestamp >= ?"
            params.append(start_date.isoformat())
        
        if end_date:
            query += " AND timestamp <= ?"
            params.append(end_date.isoformat())
        
        if provider:
            query += " AND provider = ?"
            params.append(provider)
        
        cursor.execute(query, params)
        row = cursor.fetchone()
        conn.close()
        
        total_requests = row['total_requests'] or 0
        cache_hits = row['cache_hits'] or 0
        
        return {
            "total_requests": total_requests,
            "total_input_tokens": row['total_input_tokens'] or 0,
            "total_output_tokens": row['total_output_tokens'] or 0,
            "total_tokens": row['total_tokens'] or 0,
            "total_cost": row['total_cost'] or 0.0,
            "cache_hits": cache_hits,
            "cache_hit_rate": (cache_hits / total_requests * 100) if total_requests > 0 else 0.0,
            "total_cached_tokens": row['total_cached_tokens'] or 0
        }
    
    def get_model_breakdown(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> Dict[str, Dict[str, Any]]:
        conn = self._get_connection()
        cursor = conn.cursor()
        
        query = '''
            SELECT 
                model,
                provider,
                COUNT(*) as requests,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost) as cost,
                SUM(cache_hit) as cache_hits
            FROM usage_records WHERE 1=1
        '''
        params = []
        
        if start_date:
            query += " AND timestamp >= ?"
            params.append(start_date.isoformat())
        
        if end_date:
            query += " AND timestamp <= ?"
            params.append(end_date.isoformat())
        
        query += " GROUP BY model, provider ORDER BY cost DESC"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        breakdown = {}
        for row in rows:
            key = f"{row['provider']}/{row['model']}"
            breakdown[key] = {
                "provider": row['provider'],
                "model": row['model'],
                "requests": row['requests'],
                "input_tokens": row['input_tokens'],
                "output_tokens": row['output_tokens'],
                "total_tokens": row['total_tokens'],
                "cost": row['cost'],
                "cache_hits": row['cache_hits']
            }
        
        return breakdown
    
    def get_daily_stats(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        conn = self._get_connection()
        cursor = conn.cursor()
        
        query = '''
            SELECT 
                DATE(timestamp) as date,
                COUNT(*) as requests,
                SUM(total_tokens) as total_tokens,
                SUM(cost) as cost,
                SUM(cache_hit) as cache_hits
            FROM usage_records WHERE 1=1
        '''
        params = []
        
        if start_date:
            query += " AND timestamp >= ?"
            params.append(start_date.isoformat())
        
        if end_date:
            query += " AND timestamp <= ?"
            params.append(end_date.isoformat())
        
        query += " GROUP BY DATE(timestamp) ORDER BY date DESC"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()
        
        return [dict(row) for row in rows]


class TokenMonitor:
    """Token 监控器 - 解析 usage 数据，计算缓存命中率和费用"""
    
    DEFAULT_PRICING: Dict[str, PricingConfig] = {
        "gpt-4": PricingConfig(0.03, 0.06, 0.015),
        "gpt-4-turbo": PricingConfig(0.01, 0.03, 0.005),
        "gpt-4-turbo-preview": PricingConfig(0.01, 0.03, 0.005),
        "gpt-4o": PricingConfig(0.0025, 0.01, 0.00125),
        "gpt-4o-mini": PricingConfig(0.00015, 0.0006, 0.000075),
        "gpt-3.5-turbo": PricingConfig(0.0005, 0.0015, 0.00025),
        "claude-3-opus": PricingConfig(0.015, 0.075, 0.0075),
        "claude-3-sonnet": PricingConfig(0.003, 0.015, 0.0015),
        "claude-3-haiku": PricingConfig(0.00025, 0.00125, 0.000125),
        "claude-3-5-sonnet": PricingConfig(0.003, 0.015, 0.0015),
        "glm-4": PricingConfig(0.0014, 0.0014, 0.0007),
        "glm-4-flash": PricingConfig(0.00001, 0.00001, 0.000005),
        "deepseek-chat": PricingConfig(0.00014, 0.00028, 0.00007),
        "deepseek-coder": PricingConfig(0.00014, 0.00028, 0.00007),
    }
    
    PROVIDER_MODEL_PREFIX = {
        "openai": ["gpt-", "o1-", "o3-"],
        "anthropic": ["claude-"],
        "zhipu": ["glm-", "chatglm"],
        "deepseek": ["deepseek-"],
    }
    
    def __init__(self, budget_limit: Optional[float] = None, db_path: str = "contextgate.db"):
        self.budget_limit = budget_limit
        self.usage_history: List[UsageRecord] = []
        self.session_start = datetime.now()
        self.db = UsageDatabase(db_path)
    
    def get_provider(self, model: str) -> str:
        """根据模型名称推断提供商"""
        model_lower = model.lower()
        for provider, prefixes in self.PROVIDER_MODEL_PREFIX.items():
            for prefix in prefixes:
                if model_lower.startswith(prefix):
                    return provider
        return "unknown"
    
    def get_pricing(self, model: str) -> PricingConfig:
        """获取模型定价"""
        model_lower = model.lower()
        for key, pricing in self.DEFAULT_PRICING.items():
            if key.lower() in model_lower:
                return pricing
        return PricingConfig(0.001, 0.002, 0.0005)
    
    def calculate_cost(
        self, 
        input_tokens: int, 
        output_tokens: int, 
        model: str,
        cache_hit: bool = False,
        cached_tokens: int = 0
    ) -> float:
        """计算 API 调用成本"""
        pricing = self.get_pricing(model)
        
        if cache_hit and cached_tokens > 0:
            non_cached_tokens = input_tokens - cached_tokens
            input_cost = (non_cached_tokens / 1000) * pricing.input_price_per_1k
            cached_cost = (cached_tokens / 1000) * pricing.cached_input_price_per_1k
            input_cost += cached_cost
        else:
            input_cost = (input_tokens / 1000) * pricing.input_price_per_1k
        
        output_cost = (output_tokens / 1000) * pricing.output_price_per_1k
        
        return input_cost + output_cost
    
    def record_usage(
        self, 
        input_tokens: int, 
        output_tokens: int, 
        model: str,
        cache_hit: bool = False,
        cached_tokens: int = 0,
        provider: Optional[str] = None
    ) -> UsageRecord:
        """记录 Token 使用情况"""
        cost = self.calculate_cost(
            input_tokens, 
            output_tokens, 
            model, 
            cache_hit, 
            cached_tokens
        )
        
        if provider is None:
            provider = self.get_provider(model)
        
        record = UsageRecord(
            timestamp=datetime.now(),
            model=model,
            provider=provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            cost=cost,
            cache_hit=cache_hit,
            cached_tokens=cached_tokens
        )
        
        self.usage_history.append(record)
        self.db.insert_record(record)
        
        return record
    
    def parse_api_response(self, response_data: Dict[str, Any], model: str) -> Optional[UsageRecord]:
        """解析 API 响应中的 usage 数据"""
        usage = response_data.get("usage", {})
        
        if not usage:
            return None
        
        input_tokens = usage.get("prompt_tokens", 0)
        output_tokens = usage.get("completion_tokens", 0)
        
        cached_tokens = usage.get("cached_tokens", 0)
        cache_hit = cached_tokens > 0 or usage.get("cache_hit", False)
        
        return self.record_usage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model,
            cache_hit=cache_hit,
            cached_tokens=cached_tokens
        )
    
    def get_cache_hit_rate(self) -> Dict[str, float]:
        """获取缓存命中率统计"""
        if not self.usage_history:
            return {
                "total_requests": 0,
                "cache_hits": 0,
                "hit_rate": 0.0,
                "tokens_saved": 0
            }
        
        total_requests = len(self.usage_history)
        cache_hits = sum(1 for r in self.usage_history if r.cache_hit)
        tokens_saved = sum(r.cached_tokens for r in self.usage_history)
        
        hit_rate = (cache_hits / total_requests * 100) if total_requests > 0 else 0.0
        
        return {
            "total_requests": total_requests,
            "cache_hits": cache_hits,
            "hit_rate": hit_rate,
            "tokens_saved": tokens_saved
        }
    
    def get_total_cost(self) -> float:
        """获取总成本"""
        return sum(record.cost for record in self.usage_history)
    
    def get_total_tokens(self) -> Dict[str, int]:
        """获取总 Token 使用量"""
        return {
            "input_tokens": sum(r.input_tokens for r in self.usage_history),
            "output_tokens": sum(r.output_tokens for r in self.usage_history),
            "total_tokens": sum(r.total_tokens for r in self.usage_history),
            "cached_tokens": sum(r.cached_tokens for r in self.usage_history)
        }
    
    def get_session_duration(self) -> str:
        """获取会话持续时间"""
        duration = datetime.now() - self.session_start
        hours, remainder = divmod(int(duration.total_seconds()), 3600)
        minutes, seconds = divmod(remainder, 60)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    
    def get_average_cost_per_request(self) -> float:
        """获取平均每次请求成本"""
        if not self.usage_history:
            return 0.0
        return self.get_total_cost() / len(self.usage_history)
    
    def get_model_breakdown(self) -> Dict[str, Dict[str, Any]]:
        """按模型分类统计"""
        breakdown: Dict[str, Dict[str, Any]] = {}
        
        for record in self.usage_history:
            model = record.model
            if model not in breakdown:
                breakdown[model] = {
                    "requests": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                    "cost": 0.0,
                    "cache_hits": 0
                }
            
            breakdown[model]["requests"] += 1
            breakdown[model]["input_tokens"] += record.input_tokens
            breakdown[model]["output_tokens"] += record.output_tokens
            breakdown[model]["total_tokens"] += record.total_tokens
            breakdown[model]["cost"] += record.cost
            if record.cache_hit:
                breakdown[model]["cache_hits"] += 1
        
        return breakdown
    
    def check_budget(self) -> Dict[str, Any]:
        """检查预算状态"""
        total_cost = self.get_total_cost()
        
        result = {
            "total_cost": total_cost,
            "budget_limit": self.budget_limit,
            "remaining_budget": None,
            "percentage_used": None,
            "warning_level": "none"
        }
        
        if self.budget_limit and self.budget_limit > 0:
            result["remaining_budget"] = self.budget_limit - total_cost
            result["percentage_used"] = (total_cost / self.budget_limit) * 100
            
            if result["percentage_used"] >= 100:
                result["warning_level"] = "exceeded"
            elif result["percentage_used"] >= 90:
                result["warning_level"] = "critical"
            elif result["percentage_used"] >= 75:
                result["warning_level"] = "warning"
        
        return result
    
    def get_summary(self) -> Dict[str, Any]:
        """获取完整摘要"""
        return {
            "session_duration": self.get_session_duration(),
            "total_requests": len(self.usage_history),
            "total_tokens": self.get_total_tokens(),
            "total_cost": self.get_total_cost(),
            "average_cost_per_request": self.get_average_cost_per_request(),
            "cache_stats": self.get_cache_hit_rate(),
            "budget_status": self.check_budget(),
            "model_breakdown": self.get_model_breakdown()
        }
    
    def get_weekly_stats(self) -> Dict[str, Any]:
        """获取本周统计"""
        now = datetime.now()
        start_of_week = now - timedelta(days=now.weekday())
        start_of_week = start_of_week.replace(hour=0, minute=0, second=0, microsecond=0)
        
        return self.db.get_stats(start_date=start_of_week)
    
    def get_monthly_stats(self) -> Dict[str, Any]:
        """获取本月统计"""
        now = datetime.now()
        start_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        
        return self.db.get_stats(start_date=start_of_month)
    
    def get_savings_report(self) -> Dict[str, Any]:
        """获取节省报告"""
        weekly = self.get_weekly_stats()
        monthly = self.get_monthly_stats()
        
        weekly_savings = weekly.get("total_cached_tokens", 0) * 0.001
        monthly_savings = monthly.get("total_cached_tokens", 0) * 0.001
        
        return {
            "weekly": {
                **weekly,
                "estimated_savings": weekly_savings
            },
            "monthly": {
                **monthly,
                "estimated_savings": monthly_savings
            }
        }
    
    def export_report(self, filepath: str) -> None:
        """导出使用报告"""
        report = {
            "summary": self.get_summary(),
            "weekly_stats": self.get_weekly_stats(),
            "monthly_stats": self.get_monthly_stats(),
            "savings_report": self.get_savings_report(),
            "history": [
                {
                    "timestamp": r.timestamp.isoformat(),
                    "model": r.model,
                    "provider": r.provider,
                    "input_tokens": r.input_tokens,
                    "output_tokens": r.output_tokens,
                    "total_tokens": r.total_tokens,
                    "cost": r.cost,
                    "cache_hit": r.cache_hit,
                    "cached_tokens": r.cached_tokens
                }
                for r in self.usage_history
            ]
        }
        
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
    
    def reset(self) -> None:
        """重置监控器"""
        self.usage_history = []
        self.session_start = datetime.now()
