"""
任务 5：报告生成模块
负责生成使用统计报告和费用分析
"""

from datetime import datetime, timedelta
from typing import Dict, Any, Optional, List

from app.monitor import TokenMonitor, UsageDatabase


class ReportGenerator:
    """报告生成器"""
    
    def __init__(self, db_path: str = "contextgate.db"):
        self.db = UsageDatabase(db_path)
        self.monitor = TokenMonitor(db_path=db_path)
    
    def generate_stats_report(self, period: str = "week") -> Dict[str, Any]:
        """生成统计报告"""
        now = datetime.now()
        
        if period == "week":
            start_date = now - timedelta(days=now.weekday())
            start_date = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
            period_name = "本周"
        elif period == "month":
            start_date = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            period_name = "本月"
        elif period == "year":
            start_date = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
            period_name = "本年"
        else:
            start_date = None
            period_name = "全部"
        
        stats = self.db.get_stats(start_date=start_date)
        model_breakdown = self.db.get_model_breakdown(start_date=start_date)
        daily_stats = self.db.get_daily_stats(start_date=start_date)
        
        total_cached_tokens = stats.get("total_cached_tokens", 0)
        avg_price_per_1k = 0.002
        estimated_savings = (total_cached_tokens / 1000) * avg_price_per_1k
        
        return {
            "period": period_name,
            "stats": stats,
            "model_breakdown": model_breakdown,
            "daily_stats": daily_stats[:7],
            "estimated_savings": estimated_savings
        }
    
    def format_report(self, report: Dict[str, Any]) -> str:
        """格式化报告为文本"""
        lines = []
        
        lines.append("=" * 60)
        lines.append(f"ContextGate 使用统计报告 - {report['period']}")
        lines.append("=" * 60)
        
        stats = report["stats"]
        lines.append("")
        lines.append("【总体统计】")
        lines.append(f"  总请求数: {stats['total_requests']:,}")
        lines.append(f"  总 Token: {stats['total_tokens']:,}")
        lines.append(f"  输入 Token: {stats['total_input_tokens']:,}")
        lines.append(f"  输出 Token: {stats['total_output_tokens']:,}")
        lines.append(f"  总费用: ${stats['total_cost']:.4f}")
        lines.append(f"  缓存命中: {stats['cache_hits']} ({stats['cache_hit_rate']:.1f}%)")
        
        lines.append("")
        lines.append("【节省分析】")
        lines.append(f"  缓存 Token: {stats['total_cached_tokens']:,}")
        lines.append(f"  预估节省: ${report['estimated_savings']:.4f}")
        
        breakdown = report["model_breakdown"]
        if breakdown:
            lines.append("")
            lines.append("【模型分布】")
            for key, data in list(breakdown.items())[:5]:
                lines.append(f"  {key}:")
                lines.append(f"    请求数: {data['requests']}, Token: {data['total_tokens']:,}, 费用: ${data['cost']:.4f}")
        
        daily = report["daily_stats"]
        if daily:
            lines.append("")
            lines.append("【每日趋势】")
            for day in daily[:7]:
                lines.append(f"  {day['date']}: {day['requests']} 请求, ${day['cost']:.4f}")
        
        lines.append("")
        lines.append("=" * 60)
        
        return "\n".join(lines)
    
    def print_stats(self, period: str = "week") -> None:
        """打印统计报告"""
        report = self.generate_stats_report(period)
        print(self.format_report(report))
    
    def get_savings_summary(self) -> Dict[str, Any]:
        """获取节省摘要"""
        weekly = self.generate_stats_report("week")
        monthly = self.generate_stats_report("month")
        
        return {
            "weekly_savings": weekly["estimated_savings"],
            "monthly_savings": monthly["estimated_savings"],
            "weekly_requests": weekly["stats"]["total_requests"],
            "monthly_requests": monthly["stats"]["total_requests"],
            "weekly_cost": weekly["stats"]["total_cost"],
            "monthly_cost": monthly["stats"]["total_cost"],
        }


def show_stats(period: str = "week", db_path: str = "contextgate.db") -> None:
    """显示统计信息"""
    generator = ReportGenerator(db_path)
    generator.print_stats(period)


def show_savings(db_path: str = "contextgate.db") -> None:
    """显示节省摘要"""
    generator = ReportGenerator(db_path)
    summary = generator.get_savings_summary()
    
    print("=" * 60)
    print("ContextGate 费用节省报告")
    print("=" * 60)
    print()
    print("【本周】")
    print(f"  请求数: {summary['weekly_requests']}")
    print(f"  总费用: ${summary['weekly_cost']:.4f}")
    print(f"  预估节省: ${summary['weekly_savings']:.4f}")
    print()
    print("【本月】")
    print(f"  请求数: {summary['monthly_requests']}")
    print(f"  总费用: ${summary['monthly_cost']:.4f}")
    print(f"  预估节省: ${summary['monthly_savings']:.4f}")
    print()
    print("=" * 60)
