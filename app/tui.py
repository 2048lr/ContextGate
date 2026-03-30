"""
任务 4：基于 Rich/Textual 的终端界面
提供终端用户界面
"""

from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.layout import Layout
from rich.live import Live
from rich.text import Text
from typing import Optional, Dict, Any, List
from pathlib import Path


class TUI:
    """终端用户界面"""
    
    def __init__(self):
        self.console = Console()
    
    def show_banner(self) -> None:
        """显示程序横幅"""
        banner = """
   ____                  __  __       _   _______             _   
  / ___|___  _ __  ___  |  \/  | __ _| |_|_   _|_   _  __ _| |  
 | |   / _ \| '_ \/ __| | |\/| |/ _` | __| | | | | | |/ _` | |  
 | |__| (_) | | | \__ \ | |  | | (_| | |_  | | | |_| | (_| | |  
  \____\___/|_| |_|___/ |_|  |_|\__,_|\__| |_|  \__,_|\__,_|_|  
                                                                
        Context Management & Proxy System v0.1.0
        """
        self.console.print(Panel(banner, style="bold blue"))
    
    def show_menu(self, options: List[str]) -> int:
        """显示菜单并获取用户选择"""
        table = Table(show_header=False, box=None)
        table.add_column("Option", style="cyan")
        table.add_column("Description")
        
        for i, option in enumerate(options, 1):
            table.add_row(f"[{i}]", option)
        
        self.console.print(table)
        
        while True:
            try:
                choice = self.console.input("\n[bold green]请选择:[/] ")
                choice_int = int(choice)
                if 1 <= choice_int <= len(options):
                    return choice_int
                self.console.print("[red]无效选择，请重试[/]")
            except ValueError:
                self.console.print("[red]请输入数字[/]")
    
    def show_file_list(self, files: List[Path], title: str = "扫描结果") -> None:
        """显示文件列表"""
        table = Table(title=title)
        table.add_column("序号", style="dim")
        table.add_column("文件路径", style="cyan")
        table.add_column("大小", justify="right")
        
        for i, file_path in enumerate(files, 1):
            size = file_path.stat().st_size if file_path.exists() else 0
            size_str = self._format_size(size)
            table.add_row(str(i), str(file_path), size_str)
        
        self.console.print(table)
    
    def show_token_stats(self, stats: Dict[str, Any]) -> None:
        """显示 Token 统计信息"""
        table = Table(title="Token 使用统计")
        table.add_column("指标", style="cyan")
        table.add_column("值", justify="right")
        
        table.add_row("输入 Tokens", f"{stats.get('input_tokens', 0):,}")
        table.add_row("输出 Tokens", f"{stats.get('output_tokens', 0):,}")
        table.add_row("总计 Tokens", f"{stats.get('total_tokens', 0):,}")
        
        self.console.print(table)
    
    def show_budget_status(self, status: Dict[str, Any]) -> None:
        """显示预算状态"""
        warning_level = status.get("warning_level", "none")
        
        if warning_level == "exceeded":
            style = "bold red"
            icon = "❌"
        elif warning_level == "critical":
            style = "bold yellow"
            icon = "⚠️"
        elif warning_level == "warning":
            style = "yellow"
            icon = "⚡"
        else:
            style = "green"
            icon = "✅"
        
        panel_content = f"""
{icon} 预算状态: {warning_level.upper()}

总成本: ${status.get('total_cost', 0):.4f}
预算上限: ${status.get('budget_limit', 'N/A')}
剩余预算: ${status.get('remaining_budget', 'N/A')}
使用比例: {status.get('percentage_used', 0):.1f}%
        """
        
        self.console.print(Panel(panel_content.strip(), style=style))
    
    def show_spinner(self, message: str = "处理中...") -> Progress:
        """显示加载动画"""
        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=self.console
        )
        task = progress.add_task(message, total=None)
        return progress
    
    def show_success(self, message: str) -> None:
        """显示成功消息"""
        self.console.print(f"[bold green]✓[/] {message}")
    
    def show_error(self, message: str) -> None:
        """显示错误消息"""
        self.console.print(f"[bold red]✗[/] {message}")
    
    def show_warning(self, message: str) -> None:
        """显示警告消息"""
        self.console.print(f"[bold yellow]![/] {message}")
    
    def show_info(self, message: str) -> None:
        """显示信息消息"""
        self.console.print(f"[bold blue]ℹ[/] {message}")
    
    def ask_input(self, prompt: str, default: Optional[str] = None) -> str:
        """获取用户输入"""
        if default:
            result = self.console.input(f"[bold cyan]{prompt}[/] [{default}]: ")
            return result if result else default
        return self.console.input(f"[bold cyan]{prompt}[/]: ")
    
    def ask_confirm(self, prompt: str, default: bool = False) -> bool:
        """获取用户确认"""
        default_str = "Y/n" if default else "y/N"
        result = self.console.input(f"[bold cyan]{prompt}[/] [{default_str}]: ")
        
        if not result:
            return default
        
        return result.lower() in ("y", "yes", "是")
    
    def _format_size(self, size: int) -> str:
        """格式化文件大小"""
        for unit in ["B", "KB", "MB", "GB"]:
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"
